-- Chat Boat: mobile OTP + Supabase private database.
-- Also run image-generation.sql to enable the private image gallery.
-- Run this whole file in Supabase SQL Editor. It is safe to run again.
-- New tables intentionally avoid the old email/Auth tables and their foreign keys.
-- Existing email accounts/chats are preserved; users register new mobile accounts.
begin;

create table if not exists public.chatboat_mobile_users (
    id uuid primary key default gen_random_uuid(),
    name text not null check (char_length(btrim(name)) between 2 and 80),
    mobile text not null unique check (mobile ~ '^\+[1-9][0-9]{7,14}$'),
    -- This column stores a salted scrypt HASH, never the original password.
    password text not null check (password ~ '^scrypt\$32768\$8\$3\$[a-f0-9]{32}\$[a-f0-9]{128}$'),
    auth_version integer not null default 1 check (auth_version > 0),
    mobile_verified_at timestamptz not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists public.chatboat_mobile_sessions (
    token_hash text primary key check (token_hash ~ '^[a-f0-9]{64}$'),
    user_id uuid not null references public.chatboat_mobile_users(id) on delete cascade,
    auth_version integer not null,
    expires_at timestamptz not null,
    created_at timestamptz not null default now()
);
create index if not exists chatboat_mobile_sessions_user on public.chatboat_mobile_sessions(user_id);
create index if not exists chatboat_mobile_sessions_expiry on public.chatboat_mobile_sessions(expires_at);

create table if not exists public.chatboat_mobile_conversations (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.chatboat_mobile_users(id) on delete cascade,
    title text not null default 'New chat' check (char_length(title) between 1 and 100),
    revision integer not null default 0 check (revision >= 0),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (id, user_id)
);

create table if not exists public.chatboat_mobile_turns (
    id uuid primary key,
    conversation_id uuid not null,
    user_id uuid not null references public.chatboat_mobile_users(id) on delete cascade,
    turn_index integer not null check (turn_index > 0),
    user_message text not null check (char_length(user_message) between 1 and 4000),
    assistant_message text not null check (char_length(assistant_message) between 1 and 32000),
    created_at timestamptz not null default now(),
    foreign key (conversation_id, user_id) references public.chatboat_mobile_conversations(id, user_id) on delete cascade,
    unique (conversation_id, turn_index)
);
create index if not exists chatboat_mobile_conversations_owner_updated on public.chatboat_mobile_conversations(user_id, updated_at desc);
create index if not exists chatboat_mobile_turns_owner_conversation on public.chatboat_mobile_turns(user_id, conversation_id, turn_index desc);

-- Browser anon/publishable keys and legacy authenticated JWTs have NO access.
-- Node checks its own session and ownership before using the backend secret key.
alter table public.chatboat_mobile_users enable row level security;
alter table public.chatboat_mobile_sessions enable row level security;
alter table public.chatboat_mobile_conversations enable row level security;
alter table public.chatboat_mobile_turns enable row level security;
revoke all on public.chatboat_mobile_users, public.chatboat_mobile_sessions,
    public.chatboat_mobile_conversations, public.chatboat_mobile_turns from public, anon, authenticated;
grant select, insert, update, delete on public.chatboat_mobile_users, public.chatboat_mobile_sessions,
    public.chatboat_mobile_conversations, public.chatboat_mobile_turns to service_role;

-- Password update and session invalidation happen together, in one transaction.
create or replace function public.chatboat_mobile_reset_password(p_user_id uuid, p_password text)
returns void
language plpgsql
security invoker
set search_path = ''
as $function$
begin
    update public.chatboat_mobile_users
        set password = p_password, auth_version = auth_version + 1, updated_at = now()
        where id = p_user_id;
    if not found then raise exception 'Account not found' using errcode = 'P0002'; end if;
    delete from public.chatboat_mobile_sessions where user_id = p_user_id;
end;
$function$;
revoke all on function public.chatboat_mobile_reset_password(uuid, text) from public, anon, authenticated;
grant execute on function public.chatboat_mobile_reset_password(uuid, text) to service_role;

create or replace function public.chatboat_mobile_save_turn(
    p_user_id uuid,
    p_conversation_id uuid,
    p_request_id uuid,
    p_expected_revision integer,
    p_user_message text,
    p_assistant_message text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
    owner_id uuid := p_user_id;
    conversation public.chatboat_mobile_conversations;
    saved public.chatboat_mobile_turns;
begin
    if owner_id is null then raise insufficient_privilege; end if;
    if p_request_id is null or p_expected_revision is null
       or p_user_message is null or p_assistant_message is null
       or char_length(btrim(p_user_message)) not between 1 and 4000
       or char_length(btrim(p_assistant_message)) not between 1 and 32000 then
        raise exception 'Invalid chat turn' using errcode = '22023';
    end if;
    -- Only the backend service role can execute this function. Always check ownership.
    select * into conversation from public.chatboat_mobile_conversations
        where id = p_conversation_id and user_id = owner_id for update;
    if not found then raise exception 'Conversation not found' using errcode = 'P0002'; end if;

    select * into saved from public.chatboat_mobile_turns where id = p_request_id and user_id = owner_id and conversation_id = p_conversation_id;
    if found then
        if saved.user_message <> p_user_message then raise exception 'Request ID reused' using errcode = '40001'; end if;
        return to_jsonb(saved);
    end if;
    if conversation.revision <> p_expected_revision then raise exception 'Conversation changed' using errcode = '40001'; end if;

    insert into public.chatboat_mobile_turns (id, conversation_id, user_id, turn_index, user_message, assistant_message)
        values (p_request_id, p_conversation_id, owner_id, conversation.revision + 1, p_user_message, p_assistant_message)
        returning * into saved;
    update public.chatboat_mobile_conversations set
        revision = revision + 1,
        updated_at = now(),
        title = case when revision = 0 and title = 'New chat' then left(p_user_message, 60) else title end
        where id = p_conversation_id and user_id = owner_id;
    return to_jsonb(saved);
end;
$function$;
revoke all on function public.chatboat_mobile_save_turn(uuid, uuid, uuid, integer, text, text) from public, anon, authenticated;
grant execute on function public.chatboat_mobile_save_turn(uuid, uuid, uuid, integer, text, text) to service_role;

commit;

-- Optional periodic cleanup:
-- delete from public.chatboat_mobile_sessions where expires_at < now();

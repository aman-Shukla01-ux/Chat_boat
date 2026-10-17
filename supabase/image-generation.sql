-- Additive image feature setup. Run once in Supabase SQL Editor.
-- Existing users and conversations are preserved. Safe to run again.
begin;
create table if not exists public.chatboat_mobile_images (
    id uuid primary key,
    user_id uuid not null references public.chatboat_mobile_users(id) on delete cascade,
    prompt text not null check (char_length(btrim(prompt)) between 1 and 2000),
    aspect_ratio text not null check (aspect_ratio in ('1:1','16:9','9:16','4:3','3:4')),
    mime_type text not null check (mime_type in ('image/png','image/jpeg','image/webp')),
    storage_path text not null unique,
    created_at timestamptz not null default now()
);
create index if not exists chatboat_mobile_images_owner_created on public.chatboat_mobile_images(user_id, created_at desc);
alter table public.chatboat_mobile_images enable row level security;
revoke all on public.chatboat_mobile_images from public, anon, authenticated;
grant select, insert, update, delete on public.chatboat_mobile_images to service_role;
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('chatboat-mobile-images', 'chatboat-mobile-images', false, 10485760, array['image/png','image/jpeg','image/webp'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
-- Restrict this bucket even if another feature created broad browser policies.
-- Service-role access bypasses RLS; all browser reads/writes go through Node.
drop policy if exists chatboat_images_server_only on storage.objects;
create policy chatboat_images_server_only on storage.objects
    as restrictive for all to anon, authenticated
    using (bucket_id <> 'chatboat-mobile-images')
    with check (bucket_id <> 'chatboat-mobile-images');
commit;

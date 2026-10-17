const { randomUUID, scryptSync } = require("node:crypto");
const { digest } = require("../../lib/auth");
const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const TOKEN_A = "a".repeat(43);
const TOKEN_B = "b".repeat(43);
const salt = "0".repeat(32);
const SEED_PASSWORD = "scrypt$32768$8$3$" + salt + "$" + scryptSync("ExistingPassword!", salt, 64, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }).toString("hex");

// Test-only adapter. Deliberately does NOT filter by current user automatically:
// the real backend's ownership checks must protect all privileged DB queries.
function fakeSupabase() {
    const state = {
        chatboat_mobile_users: [
            { id: USER_A, name: "Aman", mobile: "+919876543210", password: SEED_PASSWORD, auth_version: 1 },
            { id: USER_B, name: "Other User", mobile: "+919876543211", password: SEED_PASSWORD, auth_version: 1 }
        ],
        chatboat_mobile_sessions: [
            { token_hash: digest(TOKEN_A), user_id: USER_A, auth_version: 1, expires_at: "2099-01-01T00:00:00.000Z" },
            { token_hash: digest(TOKEN_B), user_id: USER_B, auth_version: 1, expires_at: "2099-01-01T00:00:00.000Z" }
        ],
        chatboat_mobile_conversations: [],
        chatboat_mobile_turns: [],
        chatboat_mobile_images: []
    };
    const files = new Map();
    let failStorage = false;
    let failSave = false;
    let failTable = "";
    const client = () => ({
        storage: {
            async getBucket() { return { data: { public: false }, error: failStorage ? { message: "storage down" } : null }; },
            from() { return {
                async upload(path, bytes, options) { if (failStorage) return { error: { message: "upload failed" } }; files.set(path, { bytes, mime: options.contentType }); return { error: null }; },
                async download(path) { const item = files.get(path); return item ? { data: new Blob([item.bytes], { type: item.mime }), error: null } : { data: null, error: { message: "not found" } }; },
                async remove(paths) { if (failStorage) return { error: { message: "delete failed" } }; paths.forEach((path) => files.delete(path)); return { error: null }; }
            }; }
        },
        from(table) {
            let action = "read", payload, fields, filters = [], sorting = [], start = 0, count = Infinity, single = false;
            const query = {
                select(value) { fields = value; return query; },
                eq(field, value) { filters.push((row) => row[field] === value); return query; },
                lt(field, value) { filters.push((row) => row[field] < value); return query; },
                gt(field, value) { filters.push((row) => row[field] > value); return query; },
                order(field, options) { sorting.push([field, options.ascending]); return query; },
                range(first, last) { start = first; count = last - first + 1; return query; },
                limit(value) { count = value; return query; },
                insert(value) { action = "insert"; payload = value; return query; },
                update(value) { action = "update"; payload = value; return query; },
                delete() { action = "delete"; return query; },
                maybeSingle() { single = true; return query; },
                single() { single = true; return query; },
                then(resolve, reject) {
                    try {
                        if (!state[table]) return Promise.resolve({ data: null, error: { code: "42P01" } }).then(resolve, reject);
                        if (failTable === table && action !== "read") return Promise.resolve({ data: null, error: { code: "FAIL" } }).then(resolve, reject);
                        let rows = state[table].filter((row) => filters.every((filter) => filter(row)));
                        if (action === "insert") {
                            if (table === "chatboat_mobile_users" && state[table].some((row) => row.mobile === payload.mobile)) {
                                return Promise.resolve({ data: null, error: { code: "23505" } }).then(resolve, reject);
                            }
                            const row = { id: randomUUID(), title: "New chat", revision: 0, auth_version: 1, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...payload };
                            state[table].push(row); rows = [row];
                        } else if (action === "update") rows.forEach((row) => Object.assign(row, payload));
                        else if (action === "delete") {
                            state[table] = state[table].filter((row) => !rows.includes(row));
                            if (table === "chatboat_mobile_conversations") state.chatboat_mobile_turns = state.chatboat_mobile_turns.filter((turn) => !rows.some((row) => row.id === turn.conversation_id));
                        }
                        rows.sort((a, b) => {
                            for (const [field, ascending] of sorting) {
                                if (a[field] < b[field]) return ascending ? -1 : 1;
                                if (a[field] > b[field]) return ascending ? 1 : -1;
                            }
                            return 0;
                        });
                        rows = rows.slice(start, start + count).map((row) => fields && fields !== "*"
                            ? Object.fromEntries(fields.split(",").map((field) => [field, row[field]])) : { ...row });
                        return Promise.resolve({ data: single ? rows[0] || null : rows, error: null }).then(resolve, reject);
                    } catch (error) { return Promise.reject(error).then(resolve, reject); }
                }
            };
            return query;
        },
        async rpc(name, values) {
            if (failSave) return { data: null, error: { code: "FAIL" } };
            if (name === "chatboat_mobile_reset_password") {
                const user = state.chatboat_mobile_users.find((user) => user.id === values.p_user_id);
                if (!user) return { error: { code: "P0002" } };
                user.password = values.p_password;
                user.auth_version++;
                state.chatboat_mobile_sessions = state.chatboat_mobile_sessions.filter((session) => session.user_id !== user.id);
                return { data: null, error: null };
            }
            if (name !== "chatboat_mobile_save_turn") return { error: { code: "PGRST202" } };
            const userId = values.p_user_id;
            const conversation = state.chatboat_mobile_conversations.find((item) => item.id === values.p_conversation_id && item.user_id === userId);
            if (!conversation) return { error: { code: "P0002" } };
            const existing = state.chatboat_mobile_turns.find((turn) => turn.id === values.p_request_id);
            if (existing) return { data: existing, error: null };
            if (conversation.revision !== values.p_expected_revision) return { error: { code: "40001" } };
            conversation.revision++;
            conversation.updated_at = new Date().toISOString();
            if (conversation.title === "New chat") conversation.title = values.p_user_message.slice(0, 60);
            const turn = {
                id: values.p_request_id, conversation_id: conversation.id, user_id: userId,
                user_message: values.p_user_message, assistant_message: values.p_assistant_message,
                turn_index: conversation.revision, created_at: new Date().toISOString()
            };
            state.chatboat_mobile_turns.push(turn);
            return { data: turn, error: null };
        }
    });
    return { state, client, files, setFailStorage(value) { failStorage = value; }, setFailSave(value) { failSave = value; }, setFailTable(value) { failTable = value; } };
}

module.exports = { fakeSupabase, USER_A, USER_B, TOKEN_A, TOKEN_B };

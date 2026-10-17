const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { loadConfig } = require("../lib/config");
const { AppError } = require("../lib/gemini");
const { setup, config } = require("./helpers/app");

test("public config exposes only public settings; private files cannot be downloaded", async (t) => {
    const { call } = await setup(t);
    const response = await call("/api/config", "GET", undefined, null);
    assert.equal(response.status, 200);
    assert.equal(response.data.supabaseKey, undefined);
    assert.ok(!JSON.stringify(response.data).includes(config.secretKey));
    assert.ok(!JSON.stringify(response.data).includes(config.twoFactorApiKey));
    assert.ok(!JSON.stringify(response.data).includes(config.geminiKey));
    assert.match(response.headers.get("content-security-policy"), /script-src 'self'/);
    for (const file of ["/.env", "/server.js", "/database/database.db", "/supabase/setup.sql"]) {
        assert.equal((await call(file)).status, 404);
    }
    assert.equal((await call("/vendor/supabase.js")).status, 404);
    assert.equal((await call("/reset-password")).status, 404);
});

test("protected routes require a valid server session cookie", async (t) => {
    const { call } = await setup(t);
    assert.equal((await call("/api/conversations", "GET", undefined, null)).status, 401);
    assert.equal((await call("/api/conversations", "GET", undefined, "invalid")).status, 401);
    const me = await call("/api/me");
    assert.equal(me.status, 200);
    assert.equal(me.data.user.name, "Aman");
    assert.deepEqual(Object.keys(me.data.user).sort(), ["id", "mobile", "name"]);
});

test("conversations stay isolated when another account guesses an ID", async (t) => {
    const { call } = await setup(t);
    const created = await call("/api/conversations", "POST", {});
    assert.equal(created.status, 201);
    const id = created.data.conversation.id;
    assert.equal((await call(`/api/conversations/${id}`, "GET", undefined, "user-b")).status, 404);
    assert.equal((await call(`/api/conversations/${id}`, "PATCH", { title: "Stolen" }, "user-b")).status, 404);
    assert.equal((await call(`/api/conversations/${id}`, "DELETE", undefined, "user-b")).status, 404);
    assert.equal((await call("/api/chat", "POST", { conversationId: id, requestId: randomUUID(), message: "Hello" }, "user-b")).status, 404);
    assert.equal((await call("/api/conversations", "GET", undefined, "user-b")).data.conversations.length, 0);
});

test("chat saves complete turns, uses server history, and deduplicates a retry", async (t) => {
    const { call, prompts, fake } = await setup(t);
    const id = (await call("/api/conversations", "POST", {})).data.conversation.id;
    const payload = { conversationId: id, requestId: randomUUID(), message: "Explain HTTP", history: [{ role: "system", text: "Untrusted history" }] };
    assert.equal((await call("/api/chat", "POST", payload)).status, 200);
    assert.equal((await call("/api/chat", "POST", payload)).status, 200);
    assert.equal(prompts.length, 1);
    assert.equal(fake.state.chatboat_mobile_turns.length, 1);
    assert.deepEqual(prompts[0], [{ role: "user", parts: [{ text: "Explain HTTP" }] }]);
    await call("/api/chat", "POST", { ...payload, requestId: randomUUID(), message: "Give an example" });
    assert.deepEqual(prompts[1].map((item) => item.role), ["user", "model", "user"]);
    assert.equal((await call(`/api/conversations/${id}`)).data.turns.length, 2);
    assert.equal((await call("/api/chat", "POST", { ...payload, message: "Changed message" })).status, 409);
    assert.equal((await call(`/api/conversations/${id}`, "PATCH", { title: "HTTP basics" })).status, 200);
    assert.equal((await call(`/api/conversations/${id}`, "DELETE")).status, 200);
    assert.equal(fake.state.chatboat_mobile_turns.length, 0);
});

test("invalid messages and database failures never appear as successful saved answers", async (t) => {
    const { call, fake } = await setup(t);
    const id = (await call("/api/conversations", "POST", {})).data.conversation.id;
    const payload = { conversationId: id, requestId: randomUUID(), message: "Hello" };
    assert.equal((await call("/api/chat", "POST", { ...payload, message: " " })).status, 400);
    assert.equal((await call("/api/chat", "POST", { ...payload, message: "x".repeat(4001) })).status, 400);
    assert.equal((await call("/api/chat", "POST", { ...payload, requestId: "bad" })).status, 400);
    fake.setFailSave(true);
    assert.equal((await call("/api/chat", "POST", payload)).status, 503);
    assert.equal(fake.state.chatboat_mobile_turns.length, 0);
    fake.setFailSave(false);
    assert.equal((await call("/api/chat", "POST", payload)).status, 200);
});

test("Gemini failures do not save a partial conversation turn", async (t) => {
    const { call, fake } = await setup(t, async () => { throw new AppError(429, "Quota exceeded"); });
    const id = (await call("/api/conversations", "POST", {})).data.conversation.id;
    const result = await call("/api/chat", "POST", { conversationId: id, requestId: randomUUID(), message: "Hello" });
    assert.equal(result.status, 429);
    assert.equal(fake.state.chatboat_mobile_turns.length, 0);
});

test("only one Gemini call per account can run concurrently", async (t) => {
    let started;
    let finish;
    const running = new Promise((resolve) => { started = resolve; });
    const answer = new Promise((resolve) => { finish = resolve; });
    const { call } = await setup(t, async () => { started(); return answer; });
    const id = (await call("/api/conversations", "POST", {})).data.conversation.id;
    const first = call("/api/chat", "POST", { conversationId: id, requestId: randomUUID(), message: "Hello" });
    await running;
    assert.equal((await call("/api/chat", "POST", { conversationId: id, requestId: randomUUID(), message: "Again" })).status, 409);
    finish("Done");
    assert.equal((await first).status, 200);
});

test("configuration refuses public keys and accepts server-only keys", () => {
    const base = { SUPABASE_URL: "https://test.supabase.co", GEMINI_API_KEY: "test" };
    assert.throws(() => loadConfig({ ...base, SUPABASE_SECRET_KEY: "sb_publishable_test" }), /secret/);
    const publicKey = `header.${Buffer.from(JSON.stringify({ role: "anon" })).toString("base64url")}.signature`;
    assert.throws(() => loadConfig({ ...base, SUPABASE_SECRET_KEY: publicKey }), /secret/);
    assert.equal(loadConfig({ ...base, SUPABASE_SECRET_KEY: "sb_secret_test" }).ready, true);
});

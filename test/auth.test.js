const test = require("node:test");
const assert = require("node:assert/strict");
const { setup, config } = require("./helpers/app");
const { normalizeMobile, digest } = require("../lib/auth");
const { hashPassword, verifyPassword } = require("../lib/passwords");
const { AppError } = require("../lib/gemini");
const SIGNUP = { name: "New Person", mobile: "9876543212", password: "MyNewPassword!" };
const cookieToken = (response) => response.headers.get("set-cookie").split(";")[0].split("=")[1];

test("signup requires the correct SMS code before creating a user, then mobile/password login works", async (t) => {
    const { call, fake, sends } = await setup(t);
    const start = await call("/api/auth/signup/start", "POST", SIGNUP, null);
    assert.equal(start.status, 200);
    assert.deepEqual(sends, ["+919876543212"]);
    assert.equal(fake.state.chatboat_mobile_users.length, 2);
    const payload = { challengeId: start.data.challengeId, code: "000000" };
    assert.equal((await call("/api/auth/signup/verify", "POST", payload, null)).status, 400);
    assert.equal(fake.state.chatboat_mobile_users.length, 2);
    assert.equal((await call("/api/auth/signup/verify", "POST", { ...payload, code: "123456", mobile: "+919876543299", name: "Tampered" }, null)).status, 201);
    const user = fake.state.chatboat_mobile_users[2];
    assert.equal(user.name, SIGNUP.name);
    assert.equal(user.mobile, "+919876543212");
    assert.notEqual(user.password, SIGNUP.password);
    assert.equal(await verifyPassword(SIGNUP.password, user.password), true);
    assert.equal((await call("/api/auth/signup/verify", "POST", { ...payload, code: "123456" }, null)).status, 400);
    assert.equal((await call("/api/auth/login", "POST", { ...SIGNUP, password: "WrongPassword!" }, null)).status, 401);
    const login = await call("/api/auth/login", "POST", SIGNUP, null);
    assert.equal(login.status, 200);
    assert.deepEqual(Object.keys(login.data.user).sort(), ["id", "mobile", "name"]);
    assert.match(login.headers.get("set-cookie"), /HttpOnly/);
    assert.match(login.headers.get("set-cookie"), /SameSite=Strict/);
    const token = cookieToken(login);
    assert.ok(fake.state.chatboat_mobile_sessions.some((session) => session.token_hash === digest(token)));
    assert.ok(!JSON.stringify(fake.state.chatboat_mobile_sessions).includes(token));
    assert.equal((await call("/api/me", "GET", undefined, token)).status, 200);
    assert.equal((await call("/api/auth/logout", "POST", {}, token)).status, 200);
    assert.equal((await call("/api/me", "GET", undefined, token)).status, 401);
});

test("password recovery binds the number and purpose, updates the hash and revokes existing sessions", async (t) => {
    const { call, fake } = await setup(t);
    const oldHash = fake.state.chatboat_mobile_users[0].password;
    const start = await call("/api/auth/password/start", "POST", { mobile: "9876543210" }, null);
    const payload = { challengeId: start.data.challengeId, code: "123456", password: "ReplacementPassword!", mobile: "+919876543211" };
    assert.equal((await call("/api/auth/signup/verify", "POST", payload, null)).status, 400);
    assert.equal((await call("/api/auth/password/reset", "POST", { ...payload, code: "000000" }, null)).status, 400);
    assert.equal(fake.state.chatboat_mobile_users[0].password, oldHash);
    assert.equal((await call("/api/auth/password/reset", "POST", payload, null)).status, 200);
    assert.equal(await verifyPassword(payload.password, fake.state.chatboat_mobile_users[0].password), true);
    assert.equal(await verifyPassword("ExistingPassword!", fake.state.chatboat_mobile_users[1].password), true);
    assert.equal((await call("/api/me")).status, 401);
    assert.equal((await call("/api/me", "GET", undefined, "user-b")).status, 200);
    assert.equal((await call("/api/auth/password/reset", "POST", payload, null)).status, 400);
    assert.equal((await call("/api/auth/login", "POST", { mobile: "9876543210", password: "ExistingPassword!" }, null)).status, 401);
    assert.equal((await call("/api/auth/login", "POST", { mobile: "9876543210", password: payload.password }, null)).status, 200);
});

test("resend cooldown, attempt limit, expiration and replaced challenge are enforced on the server", async (t) => {
    const { call, advance, sends } = await setup(t);
    const first = await call("/api/auth/signup/start", "POST", SIGNUP, null);
    const payload = { challengeId: first.data.challengeId, code: "000000" };
    const early = await call("/api/auth/otp/resend", "POST", payload, null);
    assert.equal(early.status, 429);
    assert.equal(early.headers.get("retry-after"), "60");
    assert.equal(sends.length, 1);
    advance(61000);
    assert.equal((await call("/api/auth/otp/resend", "POST", payload, null)).status, 200);
    for (let i = 0; i < 5; i++) assert.equal((await call("/api/auth/signup/verify", "POST", payload, null)).status, 400);
    assert.equal((await call("/api/auth/signup/verify", "POST", { ...payload, code: "123456" }, null)).status, 429);
    advance(61000);
    const second = await call("/api/auth/signup/start", "POST", SIGNUP, null);
    assert.equal(second.status, 200);
    assert.equal((await call("/api/auth/signup/verify", "POST", payload, null)).status, 400);
    advance(10 * 60000 + 1);
    assert.equal((await call("/api/auth/signup/verify", "POST", { challengeId: second.data.challengeId, code: "123456" }, null)).status, 400);
});

test("unknown recovery numbers and existing signup numbers cannot create or overwrite users", async (t) => {
    const { call, fake, sends } = await setup(t);
    const reset = await call("/api/auth/password/start", "POST", { mobile: SIGNUP.mobile }, null);
    assert.equal(reset.status, 200);
    assert.match(reset.data.message, /If an account exists/);
    assert.equal((await call("/api/auth/password/reset", "POST", { challengeId: reset.data.challengeId, code: "123456", password: "ReplacementPassword!" }, null)).status, 400);
    const signup = await call("/api/auth/signup/start", "POST", { ...SIGNUP, mobile: "9876543210" }, null);
    assert.equal(signup.status, 200);
    assert.equal((await call("/api/auth/signup/verify", "POST", { challengeId: signup.data.challengeId, code: "123456" }, null)).status, 400);
    assert.equal(sends.length, 0);
    assert.equal(fake.state.chatboat_mobile_users.length, 2);
});

test("provider failures never create accounts; approved OTP can retry a failed database write", async (t) => {
    const { call, fake, otp, advance, checks } = await setup(t);
    const original = otp.send;
    otp.send = async () => { throw new AppError(502, "Provider unavailable"); };
    assert.equal((await call("/api/auth/signup/start", "POST", SIGNUP, null)).status, 502);
    assert.equal(fake.state.chatboat_mobile_users.length, 2);
    advance(61000);
    otp.send = original;
    const start = await call("/api/auth/signup/start", "POST", SIGNUP, null);
    const payload = { challengeId: start.data.challengeId, code: "123456" };
    fake.setFailTable("chatboat_mobile_users");
    assert.equal((await call("/api/auth/signup/verify", "POST", payload, null)).status, 503);
    fake.setFailTable("");
    assert.equal((await call("/api/auth/signup/verify", "POST", { ...payload, code: "999999" }, null)).status, 400);
    assert.equal((await call("/api/auth/signup/verify", "POST", payload, null)).status, 201);
    assert.equal(checks.length, 1);
});

test("cross-origin writes and non-JSON forms are rejected before sending an SMS", async (t) => {
    const { call, sends } = await setup(t);
    assert.equal((await call("/api/auth/signup/start", "POST", SIGNUP, null, { Origin: "https://attacker.example" })).status, 403);
    assert.equal((await call("/api/auth/signup/start", "POST", SIGNUP, null, { "Sec-Fetch-Site": "cross-site" })).status, 403);
    assert.equal((await call("/api/auth/signup/start", "POST", SIGNUP, null, { "Content-Type": "text/plain" })).status, 415);
    assert.equal(sends.length, 0);
});

test("secure cookie flag, expired sessions, and reset version guards are enforced", async (t) => {
    const { call, fake } = await setup(t, undefined, { secureCookies: true });
    const login = await call("/api/auth/login", "POST", { mobile: "9876543210", password: "ExistingPassword!" }, null);
    assert.match(login.headers.get("set-cookie"), /Secure/);
    const token = cookieToken(login);
    fake.state.chatboat_mobile_users[0].auth_version++;
    assert.equal((await call("/api/me", "GET", undefined, token)).status, 401);
    fake.state.chatboat_mobile_sessions[1].expires_at = "2000-01-01T00:00:00.000Z";
    assert.equal((await call("/api/me", "GET", undefined, "user-b")).status, 401);
});

test("mobile normalization and password hashing reject malformed input", async () => {
    assert.equal(normalizeMobile("98765 43210", config), "+919876543210");
    assert.equal(normalizeMobile("919876543210", config), "+919876543210");
    assert.equal(normalizeMobile("+91 (98765) 43210", config), "+919876543210");
    for (const value of [null, {}, "12345", "a9876543210", "+911234567890", "+19876543210", "9".repeat(33)]) assert.throws(() => normalizeMobile(value, config));
    const first = await hashPassword("MyPassword123");
    const second = await hashPassword("MyPassword123");
    assert.notEqual(first, second);
    assert.equal(await verifyPassword("MyPassword123", first), true);
    assert.equal(await verifyPassword("WrongPassword", first), false);
    assert.equal(await verifyPassword("MyPassword123", "plaintext"), false);
    await assert.rejects(hashPassword("short"), { status: 400 });
});

test("anonymous bootstrap is 200 without granting private access", async (t) => {
    const { call, fake } = await setup(t);
    const loggedOut = await call("/api/auth/session", "GET", undefined, null);
    assert.equal(loggedOut.status, 200);
    assert.deepEqual(loggedOut.data, { user: null });
    assert.equal((await call("/api/conversations", "GET", undefined, null)).status, 401);
    assert.equal((await call("/api/auth/session")).data.user.name, "Aman");
    fake.state.chatboat_mobile_users[0].auth_version++;
    const expired = await call("/api/auth/session");
    assert.equal(expired.status, 200);
    assert.equal(expired.data.user, null);
    assert.match(expired.headers.get("set-cookie"), /Expires=/);
});

test("provider cooldown and safe diagnostic reference reach the browser without provider IDs", async (t) => {
    const { call, otp } = await setup(t);
    otp.send = async () => { throw new AppError(429, "Provider limited", { code: "TWOFACTOR_RATE_LIMIT", retryAfter: 180 }); };
    const result = await call("/api/auth/signup/start", "POST", SIGNUP, null);
    assert.equal(result.status, 429);
    assert.equal(result.headers.get("retry-after"), "180");
    assert.equal(result.data.code, "TWOFACTOR_RATE_LIMIT");
    assert.match(result.data.supportReference, /^[a-f0-9]{12}$/);
    assert.equal(result.data.providerRequestId, undefined);
});

test("resend replaces provider session; only its matched code creates the account", async (t) => {
    const { call, otp, advance, fake } = await setup(t);
    otp.send = async () => ({ accepted: true, requestId: "old-session" });
    otp.resend = async () => ({ accepted: true, requestId: "new-session" });
    const seen = [];
    otp.check = async (session, code) => { seen.push(session); return session === "new-session" && code === "0123"; };
    const start = await call("/api/auth/signup/start", "POST", SIGNUP, null);
    assert.ok(!JSON.stringify(start.data).includes("old-session"));
    advance(61000);
    const resend = await call("/api/auth/otp/resend", "POST", {challengeId:start.data.challengeId}, null);
    assert.equal(resend.status,200);
    const result = await call("/api/auth/signup/verify", "POST", {challengeId:start.data.challengeId,code:"0123",providerSession:"old-session"}, null);
    assert.equal(result.status,201);
    assert.deepEqual(seen,["new-session"]);
    assert.equal(fake.state.chatboat_mobile_users.length,3);
});

const { once } = require("node:events");
const { createApp } = require("../../server");
const { fakeSupabase, TOKEN_A, TOKEN_B } = require("./fake-supabase");
const config = {
    ready: true, otpReady: true, supabaseUrl: "https://mock-project.supabase.co", secretKey: "sb_secret_server_only",
    appUrl: "http://localhost:3000", geminiKey: "server-only-secret", model: "gemini-2.5-flash",
    defaultCountryCode: "+91", allowedCallingCodes: ["+91"], sessionDays: 7, otpHourlyLimit: 100,
    secureCookies: false, trustProxyHops: 0, twoFactorApiKey: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    cloudflareAccountId: "0123456789abcdef0123456789abcdef", cloudflareApiToken: "cloudflare-test-token",
    cloudflareImageModel: "@cf/black-forest-labs/flux-1-schnell", imageReady: true,
    imageHourlyLimit: 5, imageGlobalHourlyLimit: 30
};

async function setup(t, generator, overrides = {}, extras = {}) {
    const fake = fakeSupabase();
    const prompts = [], sends = [], checks = [];
    let time = Date.now();
    const otp = {
        async send(mobile) { sends.push(mobile); return { accepted: true, requestId: "provider-request-12345" }; },
        async resend(mobile) { sends.push(mobile); return { accepted: true, requestId: "provider-resend-12345" }; },
        async check(mobile, code) { checks.push({ mobile, code }); return code === "123456"; }
    };
    const app = createApp({ ...config, ...overrides }, {
        createClient: fake.client, now: () => time, otp, audit: () => {}, ...extras,
        generateReply: generator || (async (cfg, contents) => { prompts.push(contents); return "Hello from the test assistant."; })
    });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
    const base = `http://127.0.0.1:${server.address().port}`;
    async function call(route, method = "GET", body, token = "user-a", headers = {}) {
        const cookie = token === "user-a" ? TOKEN_A : token === "user-b" ? TOKEN_B : token;
        const response = await fetch(base + route, {
            method, headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: `chatboat_session=${cookie}` } : {}), ...headers },
            body: body === undefined ? undefined : JSON.stringify(body)
        });
        const data = response.headers.get("content-type")?.includes("json") ? await response.json() : await response.text();
        return { status: response.status, data, headers: response.headers };
    }
    return { fake, call, prompts, sends, checks, otp, base, advance(ms) { time += ms; } };
}
module.exports = { setup, config };

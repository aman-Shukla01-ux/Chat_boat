const { createClient } = require("@supabase/supabase-js");
const { loadConfig } = require("../lib/config");
const { normalizeMobile } = require("../lib/auth");
const { BUCKET } = require("../lib/images");

async function main() {
    const config = loadConfig();
    console.log("Chat Boat setup check (read-only; no calls, SMS or images are generated)");
    let failures = 0;
    function report(ok, message) { console.log(`${ok ? "OK" : "CHECK"}  ${message}`); if (!ok) failures++; }
    report(config.ready, "Supabase server configuration");
    report(config.otpReady, "TWOFACTOR_API_KEY present (this does not verify provider access)");
    report(Boolean(config.geminiKey), "GEMINI_API_KEY present for chat");
    report(Boolean(config.imageReady), "Cloudflare Workers AI image credentials present");
    if (config.ready) {
        const db = createClient(config.supabaseUrl, config.secretKey, {
            auth: { persistSession: false, autoRefreshToken: false },
            global: { fetch: (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.timeout(15000) }) }
        });
        for (const table of ["users", "sessions", "conversations", "turns", "images"]) {
            const result = await db.from(`chatboat_mobile_${table}`).select(table === "sessions" ? "token_hash" : "id").limit(1);
            report(!result.error, `${table} table accessible${result.error ? "; run supabase/setup.sql (images: image-generation.sql) and check the server key" : ""}`);
        }
        const storage = await db.storage.getBucket(BUCKET);
        report(!storage.error && storage.data?.public === false, "Private image storage bucket ready; use supabase/image-generation.sql if missing");
        const mobileArg = process.argv.indexOf("--mobile");
        if (mobileArg >= 0) {
            const mobile = normalizeMobile(process.argv[mobileArg + 1], config);
            const result = await db.from("chatboat_mobile_users").select("id").eq("mobile", mobile).maybeSingle();
            report(!result.error, "Mobile account lookup");
            if (!result.error) console.log(result.data ? "ACCOUNT: registered; use Sign in / Forgot password." : "ACCOUNT: not registered; use Create an account first. No reset OTP is sent to unregistered numbers.");
        }
    }
    if (config.geminiKey) {
        try {
            const result = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${config.model}`, {
                headers: { "x-goog-api-key": config.geminiKey }, signal: AbortSignal.timeout(15000)
            });
            report(result.ok, `Chat model accessible: ${config.model} (HTTP ${result.status})`);
        } catch { report(false, "Chat model lookup failed; check internet access"); }
    }
    if (config.imageReady) {
        try {
            const result = await fetch(`https://api.cloudflare.com/client/v4/accounts/${config.cloudflareAccountId}/ai/run/${config.cloudflareImageModel}`, {
                method: "POST",
                headers: { Authorization: `Bearer ${config.cloudflareApiToken}`, "Content-Type": "application/json" },
                signal: AbortSignal.timeout(30000),
                body: JSON.stringify({ prompt: "small setup test image", steps: 1 })
            });
            report(result.ok, `Cloudflare image model callable: ${config.cloudflareImageModel} (HTTP ${result.status})`);
        } catch { report(false, "Cloudflare image model check failed; check internet access"); }
        console.log("Note: the Cloudflare check above generates a tiny test request and may count against free usage.");
    }
    console.log("For one real OTP send/verify test: npm run otp:test");
    console.log("2Factor Pending logs mean delivery is unconfirmed. Use the provider request ID for a support trace.");
    process.exitCode = failures ? 1 : 0;
}
main().catch(() => { console.error("Setup check failed. Check .env values and internet connectivity. Credentials were not printed."); process.exitCode = 1; });

const path = require("node:path");

require("dotenv").config({
    path: path.join(__dirname, "..", ".env"),
    quiet: true
});

function isPlaceholder(value) {
    return !value || /YOUR_|REPLACE_|your-project/i.test(value);
}

function isServerKey(key) {
    if (key.startsWith("sb_secret_")) return true;

    try {
        const payload = JSON.parse(
            Buffer.from(key.split(".")[1], "base64url")
        );

        return payload.role === "service_role";
    } catch {
        return false;
    }
}

function integer(env, name, fallback, min, max) {
    const value = Number(env[name] || fallback);

    if (!Number.isInteger(value) || value < min || value > max) {
        throw new Error(`${name} must be between ${min} and ${max}.`);
    }

    return value;
}

function loadConfig(env = process.env) {
    const port = integer(env, "PORT", 3000, 1, 65535);
    const appUrl = new URL(
    env.APP_URL ||
    env.RENDER_EXTERNAL_URL ||
    `http://localhost:${port}`
);

    if (
        !/^https?:$/.test(appUrl.protocol) ||
        appUrl.username ||
        appUrl.password ||
        appUrl.search ||
        appUrl.hash ||
        appUrl.pathname !== "/"
    ) {
        throw new Error(
            "APP_URL must be an HTTP(S) origin, for example http://localhost:3000."
        );
    }

    if (env.NODE_ENV === "production" && appUrl.protocol !== "https:") {
        throw new Error("Use an HTTPS APP_URL in production.");
    }

    const supabaseUrl = (env.SUPABASE_URL || "").replace(/\/$/, "");

    const secretKey =
        env.SUPABASE_SECRET_KEY ||
        env.SUPABASE_SERVICE_ROLE_KEY ||
        "";

    const ready =
        !isPlaceholder(supabaseUrl) &&
        !isPlaceholder(secretKey);

    if (ready) {
        const url = new URL(supabaseUrl);

        if (
            url.protocol !== "https:" ||
            url.username ||
            url.password ||
            url.search ||
            url.hash ||
            url.pathname !== "/"
        ) {
            throw new Error(
                "SUPABASE_URL must be your HTTPS Supabase project origin."
            );
        }

        if (!isServerKey(secretKey)) {
            throw new Error(
                "Use SUPABASE_SECRET_KEY (sb_secret_...) or a legacy service_role key on the server. An anon/publishable key cannot access these private tables."
            );
        }
    }

    const twoFactorApiKey = (env.TWOFACTOR_API_KEY || "").trim();
    const otpReady = !isPlaceholder(twoFactorApiKey);
    if (otpReady && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(twoFactorApiKey)) {
        throw new Error("TWOFACTOR_API_KEY must be the API key from your 2Factor dashboard.");
    }

    const defaultCountryCode = env.DEFAULT_COUNTRY_CODE || "+91";

    if (!/^\+[1-9]\d{0,2}$/.test(defaultCountryCode)) {
        throw new Error("DEFAULT_COUNTRY_CODE must look like +91.");
    }

    const allowedCallingCodes = (env.ALLOWED_CALLING_CODES || "+91")
        .split(",")
        .map((code) => code.trim());

    if (
        allowedCallingCodes.some(
            (code) => !/^\+[1-9]\d{0,2}$/.test(code)
        )
    ) {
        throw new Error(
            "ALLOWED_CALLING_CODES must be comma-separated calling codes, for example +91,+1."
        );
    }

    const model = env.GEMINI_MODEL || "gemini-2.5-flash";
    if (!/^gemini-[a-zA-Z0-9.-]+$/.test(model)) {
        throw new Error("GEMINI_MODEL must be a Gemini model ID.");
    }

    const cloudflareAccountId = (env.CLOUDFLARE_ACCOUNT_ID || "").trim();
    const cloudflareApiToken = (env.CLOUDFLARE_API_TOKEN || "").trim();
    const cloudflareImageModel = (env.CLOUDFLARE_IMAGE_MODEL || "@cf/black-forest-labs/flux-1-schnell").trim();
    const imageReady = !isPlaceholder(cloudflareAccountId) && !isPlaceholder(cloudflareApiToken);

    if (cloudflareAccountId && !isPlaceholder(cloudflareAccountId) && !/^[a-f0-9]{32}$/i.test(cloudflareAccountId)) {
        throw new Error("CLOUDFLARE_ACCOUNT_ID must be the 32-character Account ID from Cloudflare.");
    }
    if (!/^@cf\/[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(cloudflareImageModel)) {
        throw new Error("CLOUDFLARE_IMAGE_MODEL must look like @cf/black-forest-labs/flux-1-schnell.");
    }

    return {
        port,
        appUrl: appUrl.origin,
        secureCookies: appUrl.protocol === "https:",

        supabaseUrl,
        secretKey,
        ready,

        otpReady,
        twoFactorApiKey,

        defaultCountryCode,
        allowedCallingCodes,

        otpHourlyLimit: integer(
            env,
            "OTP_HOURLY_LIMIT",
            100,
            1,
            100000
        ),

        sessionDays: integer(env, "SESSION_DAYS", 7, 1, 30),

        geminiKey: isPlaceholder(env.GEMINI_API_KEY)
            ? ""
            : env.GEMINI_API_KEY,

        model,

        cloudflareAccountId,
        cloudflareApiToken,
        cloudflareImageModel,
        imageReady,

        production: env.NODE_ENV === "production",
        imageHourlyLimit: integer(env, "IMAGE_HOURLY_LIMIT", 5, 1, 100),
        imageGlobalHourlyLimit: integer(env, "IMAGE_GLOBAL_HOURLY_LIMIT", 30, 1, 1000),

        trustProxyHops: integer(
            env,
            "TRUST_PROXY_HOPS",
            0,
            0,
            10
        )
    };
}

module.exports = { loadConfig, isServerKey };

const express = require("express");
const path = require("node:path");
const { createClient } = require("@supabase/supabase-js");
const { loadConfig } = require("./lib/config");
const { generateReply, AppError } = require("./lib/gemini");
const { installAuth } = require("./lib/auth");
const { installImages } = require("./lib/images");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function checkId(value) {
    if (typeof value !== "string" || !UUID.test(value)) throw new AppError(400, "Invalid conversation or request ID.");
    return value;
}

function databaseError(error) {
    if (!error) return;
    if (error.code === "40001") throw new AppError(409, "This conversation changed in another tab. Open it again before sending.");
    if (error.code === "P0002") throw new AppError(404, "Conversation not found.");
    if (["42P01", "42703", "PGRST202", "PGRST204", "PGRST205"].includes(error.code)) {
        throw new AppError(503, "Database setup is incomplete. Run supabase/setup.sql and supabase/image-generation.sql in Supabase SQL Editor.");
    }
    if (error.code === "42501") throw new AppError(403, "Database permission denied. Run supabase/setup.sql and use a server secret key.");
    throw new AppError(503, "Could not save or load your data. Check Supabase setup and try again.");
}

function createApp(config, dependencies = {}) {
    const app = express();
    const clientFactory = dependencies.createClient || createClient;
    const replyGenerator = dependencies.generateReply || generateReply;
    const now = dependencies.now || Date.now;
    const db = config.ready ? clientFactory(config.supabaseUrl, config.secretKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        global: { fetch: (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.timeout(15000) }) }
    }) : null;
    const buckets = new Map();
    const activeUsers = new Set();
    app.disable("x-powered-by");
    if (config.trustProxyHops) app.set("trust proxy", config.trustProxyHops);

    app.use((req, res, next) => {
        res.set({
            "Content-Security-Policy": `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`,
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer",
            "X-Frame-Options": "DENY",
            "Permissions-Policy": "camera=(), microphone=(), geolocation=()"
        });
        if (req.path.startsWith("/api/")) res.set("Cache-Control", "no-store");
        next();
    });
    // Cookie authentication requires same-origin writes. Cross-origin forms and
    // fetches are rejected before any SMS, database mutation or model call.
    app.use("/api", (req, res, next) => {
        if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
            if (req.get("Sec-Fetch-Site") === "cross-site" || (req.get("Origin") && req.get("Origin") !== config.appUrl)) {
                throw new AppError(403, "Open the app at its configured APP_URL before trying again.");
            }
            if (!/^application\/json(?:\s*;|$)/i.test(req.get("Content-Type") || "")) throw new AppError(415, "Send requests as application/json.");
        }
        next();
    });
    app.use(express.json({ limit: "20kb" }));

    function limit(key, maximum, windowMs, res) {
        const timestamp = now();
        if (buckets.size > 5000) for (const [k, v] of buckets) if (v.until <= timestamp) buckets.delete(k);
        let bucket = buckets.get(key);
        if (!bucket || bucket.until <= timestamp) {
            if (buckets.size >= 10000 && !bucket) throw new AppError(503, "Server is busy. Please try again shortly.");
            bucket = { count: 0, until: timestamp + windowMs };
            buckets.set(key, bucket);
        }
        if (++bucket.count > maximum) {
            res.set("Retry-After", String(Math.ceil((bucket.until - timestamp) / 1000)));
            throw new AppError(429, "Request limit reached. Wait for the countdown before trying again.", { code: "APP_RATE_LIMIT", retryAfter: Math.ceil((bucket.until - timestamp) / 1000) });
        }
    }

    app.get("/api/config", (req, res) => res.json({
        configured: config.ready,
        otpConfigured: config.otpReady,
        defaultCountryCode: config.defaultCountryCode,
        chatConfigured: Boolean(config.geminiKey), imageConfigured: Boolean(config.imageReady)
    }));
    app.get("/api/health", (req, res) => res.json({ status: "ok", databaseConfigured: config.ready, otpConfigured: config.otpReady, chatConfigured: Boolean(config.geminiKey), imageConfigured: Boolean(config.imageReady) }));

    const requireUser = installAuth(app, config, {
        db, limit, databaseError, now,
        otp: dependencies.otp,
        audit: dependencies.audit || ((event) => console.info("[OTP]", JSON.stringify(event)))
    });
    app.use("/api", requireUser);
    installImages(app, config, { db, limit, databaseError, checkId, now, imageGenerator: dependencies.generateImage });
    app.get("/api/me", (req, res) => res.json({ user: req.user }));

    app.get("/api/conversations", async (req, res) => {
        const offset = Number(req.query.offset || 0);
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000) throw new AppError(400, "Invalid page.");
        const { data, error } = await req.db.from("chatboat_mobile_conversations").select("id,title,updated_at,revision")
            .eq("user_id", req.user.id).order("updated_at", { ascending: false }).order("id", { ascending: false }).range(offset, offset + 49);
        databaseError(error);
        res.json({ conversations: data, hasMore: data.length === 50 });
    });

    app.post("/api/conversations", async (req, res) => {
        limit(`new:${req.user.id}`, 20, 60000, res);
        const { data, error } = await req.db.from("chatboat_mobile_conversations").insert({ user_id: req.user.id })
            .select("id,title,updated_at,revision").single();
        databaseError(error);
        res.status(201).json({ conversation: data });
    });

    async function ownedConversation(req) {
        const id = checkId(req.params.id || req.body?.conversationId);
        const { data, error } = await req.db.from("chatboat_mobile_conversations").select("id,title,revision")
            .eq("id", id).eq("user_id", req.user.id).maybeSingle();
        databaseError(error);
        if (!data) throw new AppError(404, "Conversation not found.");
        return data;
    }

    app.get("/api/conversations/:id", async (req, res) => {
        const conversation = await ownedConversation(req);
        const before = Number(req.query.before || 2147483647);
        if (!Number.isSafeInteger(before) || before < 1) throw new AppError(400, "Invalid history page.");
        const { data, error } = await req.db.from("chatboat_mobile_turns").select("id,user_message,assistant_message,turn_index,created_at")
            .eq("conversation_id", conversation.id).eq("user_id", req.user.id).lt("turn_index", before)
            .order("turn_index", { ascending: false }).limit(50);
        databaseError(error);
        res.json({ conversation, turns: data.reverse(), hasMore: data.length === 50 });
    });

    app.patch("/api/conversations/:id", async (req, res) => {
        const id = checkId(req.params.id);
        const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
        if (!title || title.length > 100) throw new AppError(400, "Use a title between 1 and 100 characters.");
        const { data, error } = await req.db.from("chatboat_mobile_conversations").update({ title })
            .eq("id", id).eq("user_id", req.user.id).select("id,title").maybeSingle();
        databaseError(error);
        if (!data) throw new AppError(404, "Conversation not found.");
        res.json({ conversation: data });
    });

    app.delete("/api/conversations/:id", async (req, res) => {
        const id = checkId(req.params.id);
        const { data, error } = await req.db.from("chatboat_mobile_conversations").delete()
            .eq("id", id).eq("user_id", req.user.id).select("id").maybeSingle();
        databaseError(error);
        if (!data) throw new AppError(404, "Conversation not found.");
        res.json({ success: true });
    });

    app.post("/api/chat", async (req, res) => {
        const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
        if (!message || message.length > 4000) throw new AppError(400, "Write a message between 1 and 4,000 characters.");
        const requestId = checkId(req.body?.requestId);
        const conversation = await ownedConversation(req);
        if (activeUsers.has(req.user.id)) throw new AppError(409, "A reply is already being generated. Please wait.");
        activeUsers.add(req.user.id);
        try {
            // An interrupted HTTP response can be retried without saving the turn twice.
            const existing = await req.db.from("chatboat_mobile_turns").select("id,user_message,assistant_message,turn_index,created_at")
                .eq("id", requestId).eq("conversation_id", conversation.id).eq("user_id", req.user.id).maybeSingle();
            databaseError(existing.error);
            if (existing.data) {
                if (existing.data.user_message !== message) throw new AppError(409, "This request ID belongs to another message.");
                return res.json({ turn: existing.data });
            }
            limit(`chat:${req.user.id}`, 15, 60000, res);
            const history = await req.db.from("chatboat_mobile_turns").select("user_message,assistant_message")
                .eq("conversation_id", conversation.id).eq("user_id", req.user.id).order("turn_index", { ascending: false }).limit(12);
            databaseError(history.error);
            const contents = history.data.reverse().flatMap((turn) => [
                { role: "user", parts: [{ text: turn.user_message }] },
                { role: "model", parts: [{ text: turn.assistant_message }] }
            ]);
            contents.push({ role: "user", parts: [{ text: message }] });
            const reply = await replyGenerator(config, contents);
            // The RPC saves both sides of a turn and the conversation revision atomically.
            const saved = await req.db.rpc("chatboat_mobile_save_turn", {
                p_user_id: req.user.id,
                p_conversation_id: conversation.id,
                p_request_id: requestId,
                p_expected_revision: conversation.revision,
                p_user_message: message,
                p_assistant_message: reply
            });
            databaseError(saved.error);
            res.json({ turn: saved.data });
        } finally {
            activeUsers.delete(req.user.id);
        }
    });

    app.use("/api", (req, res) => res.status(404).json({ message: "API route not found." }));
    app.use(express.static(path.join(__dirname, "public"), { dotfiles: "deny" }));
    app.use((req, res) => res.status(404).type("text").send("Page not found."));
    app.use((error, req, res, next) => {
        if (res.headersSent) return next(error);
        if (error.type === "entity.too.large") return res.status(413).json({ message: "This request is too large." });
        if (error.type === "entity.parse.failed") return res.status(400).json({ message: "Invalid JSON request." });
        if (!(error instanceof AppError)) console.error("Request failed:", error.name || "Error", error.code || "UNKNOWN");
        const known = error instanceof AppError;
        if (known && error.retryAfter) res.set("Retry-After", String(error.retryAfter));
        res.status(known ? error.status : 500).json({
            message: known ? error.message : "Something went wrong. Please try again.",
            ...(known && error.code ? { code: error.code } : {}),
            ...(known && error.retryAfter ? { retryAfter: error.retryAfter } : {}),
            ...(known && error.supportReference ? { supportReference: error.supportReference } : {})
        });
    });
    return app;
}

if (require.main === module) {
    try {
        const config = loadConfig();
        createApp(config).listen(config.port, () => {
            console.log(`Chat Boat is running at ${config.appUrl}`);
            if (!config.ready) console.log("Setup needed: copy .env.example to .env and enter SUPABASE_URL and SUPABASE_SECRET_KEY.");
            if (!config.otpReady) console.log("SMS setup needed: add TWOFACTOR_API_KEY to .env.");
            if (!config.geminiKey) console.log("Chat setup needed: add GEMINI_API_KEY to .env.");
            if (!config.imageReady) console.log("Image setup needed: add CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN to .env.");
        }).on("error", (error) => {
            console.error(error.code === "EADDRINUSE" ? "This PORT is already in use. Stop the other server or choose another port." : `Server error: ${error.code}`);
            process.exitCode = 1;
        });
    } catch (error) {
        console.error(`Configuration error: ${error.message}`);
        process.exitCode = 1;
    }
}

module.exports = { createApp };

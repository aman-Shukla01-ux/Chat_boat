const { randomBytes, createHash } = require("node:crypto");
const { AppError } = require("./gemini");
const { hashPassword, verifyPassword, validatePassword } = require("./passwords");
const { createTwoFactorOtp } = require("./twofactor");

const USERS = "chatboat_mobile_users";
const SESSIONS = "chatboat_mobile_sessions";
const COOKIE = "chatboat_session";
const OTP_TTL = 10 * 60000;
const RESEND_SECONDS = 60;
const digest = (value) => createHash("sha256").update(value).digest("hex");
const publicUser = (user) => ({ id: user.id, name: user.name, mobile: user.mobile });

function normalizeMobile(value, config) {
    if (typeof value !== "string" || value.length > 32 || !/^[+\d ()-]+$/.test(value)) throw new AppError(400, "Enter your mobile number with country code, for example +91 followed by 10 digits.");
    let mobile = value.replace(/[ ()-]/g, "");
    if (!mobile.startsWith("+")) {
        if (config.defaultCountryCode === "+91" && /^91[6-9]\d{9}$/.test(mobile)) mobile = "+" + mobile;
        else mobile = config.defaultCountryCode + mobile;
    }
    if (!/^\+[1-9]\d{7,14}$/.test(mobile) || (mobile.startsWith("+91") && !/^\+91[6-9]\d{9}$/.test(mobile))) {
        throw new AppError(400, "Enter a valid mobile number. For India, use +91 followed by your 10-digit number.");
    }
    if (!config.allowedCallingCodes.some((code) => mobile.startsWith(code))) throw new AppError(400, "OTP is not enabled for this country. Contact the app owner.");
    return mobile;
}

function readSessionToken(req) {
    const token = (req.get("Cookie") || "").split(";").map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    return /^[\w-]{43}$/.test(token || "") ? token : null;
}

function installAuth(app, config, { db, limit, databaseError, otp, audit = () => {}, now = Date.now }) {
    const sms = otp || createTwoFactorOtp(config);
    const challenges = new Map();
    const busyPhones = new Set();
    let passwordWork = 0;
    const cookieOptions = { httpOnly: true, secure: config.secureCookies, sameSite: "strict", path: "/" };

    function needDatabase() {
        if (!config.ready || !db) throw new AppError(503, "Set SUPABASE_URL and SUPABASE_SECRET_KEY in .env, then restart the server.");
    }
    function needSms() {
        needDatabase();
        if (!config.otpReady) throw new AppError(503, "Set TWOFACTOR_API_KEY in .env, then restart the server.");
    }
    async function passwordTask(action) {
        if (passwordWork >= 4) throw new AppError(503, "Sign-in is busy. Please try again shortly.");
        passwordWork++;
        try { return await action(); } finally { passwordWork--; }
    }
    async function findMobile(mobile) {
        const result = await db.from(USERS).select("id,name,mobile,password,auth_version").eq("mobile", mobile).maybeSingle();
        databaseError(result.error);
        return result.data;
    }
    function sendLimits(req, res, mobile) {
        limit(`sms:cooldown:${mobile}`, 1, RESEND_SECONDS * 1000, res);
        limit(`sms:phone:${mobile}`, 5, 15 * 60000, res);
        limit(`sms:ip:${req.ip}`, 10, 15 * 60000, res);
        limit("sms:global", config.otpHourlyLimit, 60 * 60000, res);
    }
    function challengeInfo(id, challenge) {
        return { challengeId: id, mobile: challenge.mobile, expiresAt: new Date(challenge.expiresAt).toISOString(), retryAfter: RESEND_SECONDS, supportReference: challenge.reference };
    }
    function getChallenge(req, expectedPurpose) {
        const id = req.body?.challengeId;
        const item = typeof id === "string" ? challenges.get(id) : null;
        if (!item || item.expiresAt <= now() || (expectedPurpose && item.purpose !== expectedPurpose)) {
            if (item?.expiresAt <= now()) challenges.delete(id);
            throw new AppError(400, "This OTP request expired. Go back and request a new code.");
        }
        if (item.attempts >= 5) throw new AppError(429, "Too many incorrect codes. Go back and request a new OTP after a few minutes.");
        if (busyPhones.has(item.mobile)) throw new AppError(409, "An OTP request is already in progress. Please wait.");
        return [id, item];
    }
    async function approved(req, item) {
        const code = req.body?.code;
        if (typeof code !== "string" || !/^\d{4,6}$/.test(code)) throw new AppError(400, "Enter the 4–6 digit OTP received by call or SMS.");
        item.attempts++;
        // A failed database write may be retried with the SAME approved code.
        // Keep approval bound to this challenge and the same submitted code.
        if (item.approvedCode) {
            if (digest(code) !== item.approvedCode) throw new AppError(400, "The OTP is incorrect.");
            return;
        }
        if (!item.otpSent || !await sms.check(item.providerSession, code)) throw new AppError(400, "The OTP is incorrect or expired.");
        item.approvedCode = digest(code);
    }
    async function start(req, res, purpose) {
        needSms();
        limit(`auth:start:${req.ip}`, 20, 15 * 60000, res);
        const mobile = normalizeMobile(req.body?.mobile, config);
        let name, password;
        if (purpose === "signup") {
            name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
            if (name.length < 2 || name.length > 80) throw new AppError(400, "Your name must have between 2 and 80 characters.");
            password = validatePassword(req.body?.password);
        }
        if (busyPhones.has(mobile)) throw new AppError(409, "An OTP request is already in progress. Please wait.");
        busyPhones.add(mobile);
        try {
            sendLimits(req, res, mobile);
            for (const [id, item] of challenges) if (item.expiresAt <= now()) challenges.delete(id);
            if (challenges.size >= 2000) throw new AppError(503, "The server is busy. Try again shortly.");
            const user = await findMobile(mobile);
            const eligible = purpose === "signup" ? !user : Boolean(user);
            const passwordHash = purpose === "signup" ? await passwordTask(() => hashPassword(password)) : null;
            const reference = randomBytes(6).toString("hex");
            let receipt;
            try { receipt = eligible ? await sms.send(mobile) : null; }
            catch (error) {
                error.supportReference = reference;
                error.retryAfter = Math.max(RESEND_SECONDS, error.retryAfter || 0);
                audit({ event: "otp.rejected", reference, reason: error.code || "PROVIDER_ERROR" });
                throw error;
            }
            const otpSent = Boolean(receipt?.accepted && receipt?.requestId);
            if (eligible && !otpSent) throw new AppError(502, "The OTP provider did not accept the OTP request.");
            audit({ event: eligible ? "otp.accepted" : "otp.not_eligible", reference, purpose,
                mobileLast4: mobile.slice(-4), providerRequestId: receipt?.requestId || null,
                note: eligible ? "Acceptance is not delivery. Check 2Factor OTP logs." : "Use signup for new numbers and password reset for existing accounts." });
            for (const [id, item] of challenges) if (item.mobile === mobile) challenges.delete(id);
            const id = randomBytes(32).toString("base64url");
            const item = { mobile, purpose, reference, name, passwordHash, userId: user?.id, otpSent, providerSession: receipt?.requestId, attempts: 0, expiresAt: now() + OTP_TTL };
            challenges.set(id, item);
            res.json({ ...challengeInfo(id, item), message: purpose === "signup"
                ? "If this mobile number is new, an OTP has been requested. Answer the verification call or check your SMS. Delivery may take a moment. Already registered? Sign in or use Forgot password."
                : "If an account exists for this number, an OTP has been requested. Answer the verification call or check your SMS. If you have never verified this number here, create an account first." });
        } finally { busyPhones.delete(mobile); }
    }

    app.post("/api/auth/signup/start", (req, res) => start(req, res, "signup"));
    app.post("/api/auth/password/start", (req, res) => start(req, res, "reset"));

    app.post("/api/auth/otp/resend", async (req, res) => {
        needSms();
        limit(`auth:resend:${req.ip}`, 20, 15 * 60000, res);
        const [id, item] = getChallenge(req);
        if (item.approvedCode) throw new AppError(400, "This code was already verified. Submit it again to finish saving.");
        busyPhones.add(item.mobile);
        try {
            sendLimits(req, res, item.mobile);
            if (item.otpSent) {
                try {
                    const receipt = await sms.resend(item.mobile);
                    if (!receipt?.accepted || !receipt.requestId) throw new AppError(502, "2Factor did not start a new verification.");
                    item.providerSession = receipt.requestId;
                    audit({ event: "otp.resend_accepted", reference: item.reference, providerRequestId: receipt.requestId });
                } catch (error) {
                    error.supportReference = item.reference;
                    error.retryAfter = Math.max(RESEND_SECONDS, error.retryAfter || 0);
                    throw error;
                }
            }
            res.json({ ...challengeInfo(id, item), message: "If eligible, another OTP has been requested. Use the latest code received by call or SMS." });
        } finally { busyPhones.delete(item.mobile); }
    });

    app.post("/api/auth/signup/verify", async (req, res) => {
        needSms();
        limit(`auth:verify:${req.ip}`, 30, 15 * 60000, res);
        const [id, item] = getChallenge(req, "signup");
        busyPhones.add(item.mobile);
        try {
            await approved(req, item);
            const result = await db.from(USERS).insert({ name: item.name, mobile: item.mobile, password: item.passwordHash, mobile_verified_at: new Date(now()).toISOString() });
            if (result.error?.code === "23505") {
                challenges.delete(id);
                throw new AppError(409, "This number is already registered. Sign in or reset your password.");
            }
            databaseError(result.error);
            challenges.delete(id);
            res.status(201).json({ success: true, message: "Mobile verified. Your account is ready. Sign in with your mobile number and password." });
        } finally { busyPhones.delete(item.mobile); }
    });

    app.post("/api/auth/password/reset", async (req, res) => {
        needSms();
        limit(`auth:verify:${req.ip}`, 30, 15 * 60000, res);
        validatePassword(req.body?.password);
        const [id, item] = getChallenge(req, "reset");
        busyPhones.add(item.mobile);
        try {
            await approved(req, item);
            const password = await passwordTask(() => hashPassword(req.body.password));
            const result = await db.rpc("chatboat_mobile_reset_password", { p_user_id: item.userId, p_password: password });
            databaseError(result.error);
            challenges.delete(id);
            res.clearCookie(COOKIE, cookieOptions);
            res.json({ success: true, message: "Password updated. Sign in with your new password." });
        } finally { busyPhones.delete(item.mobile); }
    });

    app.post("/api/auth/login", async (req, res) => {
        needDatabase();
        limit(`login:ip:${req.ip}`, 30, 15 * 60000, res);
        const mobile = normalizeMobile(req.body?.mobile, config);
        if (typeof req.body?.password !== "string" || req.body.password.length > 128) throw new AppError(400, "Enter your password.");
        limit(`login:mobile:${mobile}`, 10, 15 * 60000, res);
        const user = await findMobile(mobile);
        const valid = await passwordTask(() => verifyPassword(req.body.password, user?.password));
        if (!user || !valid) throw new AppError(401, "The mobile number or password is incorrect.");
        const token = randomBytes(32).toString("base64url");
        const maxAge = config.sessionDays * 86400000;
        const result = await db.from(SESSIONS).insert({ token_hash: digest(token), user_id: user.id, auth_version: user.auth_version, expires_at: new Date(now() + maxAge).toISOString() });
        databaseError(result.error);
        const oldToken = readSessionToken(req);
        if (oldToken) databaseError((await db.from(SESSIONS).delete().eq("token_hash", digest(oldToken))).error);
        await db.from(SESSIONS).delete().eq("user_id", user.id).lt("expires_at", new Date(now()).toISOString());
        res.cookie(COOKIE, token, { ...cookieOptions, maxAge });
        res.json({ user: publicUser(user) });
    });

    app.post("/api/auth/logout", async (req, res) => {
        needDatabase();
        limit(`logout:${req.ip}`, 60, 60000, res);
        const token = readSessionToken(req);
        if (token) databaseError((await db.from(SESSIONS).delete().eq("token_hash", digest(token))).error);
        res.clearCookie(COOKIE, cookieOptions);
        res.json({ success: true });
    });

    async function sessionUser(req) {
        const token = readSessionToken(req);
        if (!token) return null;
        const session = await db.from(SESSIONS).select("user_id,auth_version,expires_at")
            .eq("token_hash", digest(token)).gt("expires_at", new Date(now()).toISOString()).maybeSingle();
        databaseError(session.error);
        if (!session.data) return null;
        const user = await db.from(USERS).select("id,name,mobile,auth_version")
            .eq("id", session.data.user_id).eq("auth_version", session.data.auth_version).maybeSingle();
        databaseError(user.error);
        return user.data ? publicUser(user.data) : null;
    }
    // A public session probe avoids an expected 401 on every logged-out page load.
    // All private endpoints below still require an authenticated session.
    app.get("/api/auth/session", async (req, res) => {
        needDatabase();
        limit(`session:${req.ip}`, 60, 60000, res);
        const user = await sessionUser(req);
        if (!user && readSessionToken(req)) res.clearCookie(COOKIE, cookieOptions);
        res.json({ user });
    });
    return async function requireUser(req, res, next) {
        needDatabase();
        limit(`ip:${req.ip}`, 180, 10 * 60000, res);
        req.user = await sessionUser(req);
        if (!req.user) throw new AppError(401, "Please sign in to continue.");
        req.db = db;
        next();
    };
}
module.exports = { installAuth, normalizeMobile, digest, COOKIE };

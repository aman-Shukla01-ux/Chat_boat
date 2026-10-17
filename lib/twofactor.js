const { AppError } = require("./gemini");
const SESSION = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

function createTwoFactorOtp(config, fetchImpl = fetch) {
    async function request(parts) {
        // Never log this URL: 2Factor authenticates with a key in its path.
        const url = "https://2factor.in/API/V1/" +
            [config.twoFactorApiKey, "SMS", ...parts].map(encodeURIComponent).join("/");
        let response, data;
        try {
            response = await fetchImpl(url, {
                method: "GET", headers: { Accept: "application/json" },
                redirect: "error", cache: "no-store", signal: AbortSignal.timeout(20000)
            });
        } catch {
            throw new AppError(502, "Could not reach 2Factor. Wait before requesting another OTP.", { code: "TWOFACTOR_NETWORK_ERROR" });
        }
        try { data = await response.json(); }
        catch { throw new AppError(502, "2Factor returned an unreadable response.", { code: "TWOFACTOR_BAD_RESPONSE" }); }
        const detail = typeof data?.Details === "string" ? data.Details.toLowerCase() : "";
        if (!response.ok || data?.Status !== "Success") {
            let status = 502, code = "TWOFACTOR_REQUEST_FAILED";
            let message = "2Factor rejected the request. Check your account OTP logs.";
            if (response.status === 429 || /limit|too many/.test(detail)) {
                throw new AppError(429, "2Factor has limited requests. Wait before trying again.", { code: "TWOFACTOR_RATE_LIMIT", retryAfter: 60 });
            } else if ([401, 403].includes(response.status) || /key|auth|access/.test(detail)) {
                status = 503; code = "TWOFACTOR_AUTH_FAILED"; message = "Check TWOFACTOR_API_KEY and account access, then restart the server.";
            } else if (/balance|credit/.test(detail)) {
                status = 503; code = "TWOFACTOR_NO_CREDITS"; message = "2Factor reports insufficient OTP credits.";
            } else if (/template|dlt|sender/.test(detail)) {
                status = 503; code = "TWOFACTOR_SETUP_ERROR"; message = "2Factor requires account or template setup. Check the provider dashboard.";
            } else if (/mismatch|expired|invalid otp|invalid session|not matched/.test(detail)) {
                status = 400; code = "OTP_INVALID"; message = "The OTP is incorrect or expired. Use the latest code.";
            }
            // Provider text may contain credentials; expose only our own messages.
            throw new AppError(status, message, { code });
        }
        return data;
    }
    async function send(mobile) {
        if (typeof mobile !== "string" || !/^\+91[6-9]\d{9}$/.test(mobile)) {
            throw new AppError(400, "Use a valid Indian mobile number with +91.");
        }
        const result = await request([mobile.slice(1), "AUTOGEN"]);
        if (!SESSION.test(result.Details || "")) throw new AppError(502, "2Factor did not return a verification session.", { code: "TWOFACTOR_BAD_RESPONSE" });
        return { accepted: true, requestId: result.Details };
    }
    return {
        send,
        // A resend creates a new session; auth.js replaces the previous one.
        resend: send,
        async check(session, code) {
            if (!SESSION.test(session || "") || typeof code !== "string" || !/^\d{4,6}$/.test(code)) return false;
            const result = await request(["VERIFY", session, code]);
            return result.Details === "OTP Matched";
        }
    };
}
module.exports = { createTwoFactorOtp };

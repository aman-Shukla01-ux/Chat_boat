const { scrypt, randomBytes, timingSafeEqual } = require("node:crypto");
const { promisify } = require("node:util");
const { AppError } = require("./gemini");
const derive = promisify(scrypt);
// Fresh salts; no reversible encryption or plain passwords.
const OPTIONS = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };

function validatePassword(password) {
    if (typeof password !== "string" || password.length < 8 || password.length > 128) {
        throw new AppError(400, "Use a password between 8 and 128 characters.");
    }
    return password;
}

async function hashPassword(password) {
    validatePassword(password);
    const salt = randomBytes(16).toString("hex");
    const key = await derive(password, salt, 64, OPTIONS);
    return `scrypt$32768$8$3$${salt}$${key.toString("hex")}`;
}

async function verifyPassword(password, stored) {
    if (typeof password !== "string" || password.length > 128) return false;
    const match = /^scrypt\$32768\$8\$3\$([a-f0-9]{32})\$([a-f0-9]{128})$/.exec(stored || "");
    // Equal work for unknown accounts reduces timing leaks.
    const salt = match?.[1] || "0".repeat(32);
    const expected = Buffer.from(match?.[2] || "0".repeat(128), "hex");
    const key = await derive(password, salt, 64, OPTIONS);
    return timingSafeEqual(key, expected) && Boolean(match);
}

module.exports = { hashPassword, verifyPassword, validatePassword };

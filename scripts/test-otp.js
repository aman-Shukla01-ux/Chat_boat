const { createInterface } = require("node:readline/promises");
const { stdin, stdout } = require("node:process");
const { loadConfig } = require("../lib/config");
const { normalizeMobile } = require("../lib/auth");
const { createTwoFactorOtp } = require("../lib/twofactor");

async function main() {
    const config = loadConfig();
    if (!config.otpReady) throw new Error("Set TWOFACTOR_API_KEY in .env first.");
    if (!stdin.isTTY) throw new Error("Run npm run otp:test in an interactive terminal.");
    const input = createInterface({ input: stdin, output: stdout });
    try {
        console.log("This makes ONE real 2Factor OTP request (call or SMS) to your own test number. Provider charges may apply.");
        console.log("It does not create an account, change a password, or bypass verification.");
        const mobile = normalizeMobile(await input.question("Your test mobile (10 Indian digits or +countrycode): "), config);
        const sms = createTwoFactorOtp(config);
        const result = await sms.send(mobile);
        console.log("2Factor accepted the request. This is not confirmation of OTP delivery.");
        console.log("Provider request ID:", result.requestId || "See 2Factor dashboard OTP logs");
        console.log("If no call or SMS arrives, press Enter below and check 2Factor dashboard OTP logs.");
        const code = (await input.question("Enter the 4–6 digit code received on your phone (or Enter to finish): ")).trim();
        if (!code) { console.log("Delivery NOT verified. Give the request ID to 2Factor Support if it remains Pending."); return; }
        if (!/^\d{4,6}$/.test(code)) throw new Error("Enter 4–6 digits. No verification request was sent.");
        if (!await sms.check(result.requestId, code)) throw new Error("2Factor did not verify this code.");
        console.log("PASS: the OTP code you received was successfully verified by 2Factor.");
        console.log("Return to the app and request a fresh OTP there. This diagnostic code is separate from app signup/reset.");
    } finally { input.close(); }
}
main().catch((error) => {
    console.error(error.name === "AppError" || error.status ? `${error.code || "OTP_ERROR"}: ${error.message}` : error.message);
    process.exitCode = 1;
});

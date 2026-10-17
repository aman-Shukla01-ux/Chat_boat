const test = require("node:test");
const assert = require("node:assert/strict");
const { createTwoFactorOtp } = require("../lib/twofactor");
const { loadConfig } = require("../lib/config");
const sid = "11111111-2222-3333-4444-555555555555";
const key = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const response = (Details, Status = "Success", status = 200) => new Response(JSON.stringify({Status, Details}), {status});

test("2Factor uses AUTOGEN and verifies the provider session, preserving leading zeroes", async () => {
    const calls = [];
    const otp = createTwoFactorOtp({twoFactorApiKey:key}, async (url, options) => {
        calls.push({url, options});
        return response(calls.length === 2 ? "OTP Matched" : sid);
    });
    assert.equal((await otp.send("+919876543210")).requestId, sid);
    assert.equal(await otp.check(sid, "0123"), true);
    assert.ok(calls[0].url.endsWith("/SMS/919876543210/AUTOGEN"));
    assert.ok(calls[1].url.endsWith(`/SMS/VERIFY/${sid}/0123`));
    assert.equal(calls[0].options.redirect, "error");
    await otp.resend("+919876543210");
    assert.ok(calls[2].url.endsWith("/AUTOGEN"));
});

test("2Factor fails closed on malformed sessions and ambiguous verification success", async () => {
    const bad = createTwoFactorOtp({twoFactorApiKey:key}, async () => response("queued"));
    await assert.rejects(bad.send("+919876543210"), {code:"TWOFACTOR_BAD_RESPONSE"});
    assert.equal(await bad.check(sid,"123456"), false);
    assert.equal(await bad.check("../other","123456"), false);
});

test("2Factor HTTP-200 errors, network errors and invalid OTPs expose no key", async () => {
    for (const detail of ["Invalid API Key", "Insufficient balance", "OTP Mismatch"]) {
        const otp = createTwoFactorOtp({twoFactorApiKey:key}, async () => response(detail + " " + key,"Error"));
        await assert.rejects(otp.send("+919876543210"), e => !e.message.includes(key));
    }
    const otp = createTwoFactorOtp({twoFactorApiKey:key}, async () => { throw Error(key); });
    await assert.rejects(otp.send("+919876543210"), {code:"TWOFACTOR_NETWORK_ERROR"});
    assert.equal(loadConfig({TWOFACTOR_API_KEY:key}).otpReady, true);
    assert.equal(loadConfig({TWOFACTOR_API_KEY:"YOUR_TWOFACTOR_API_KEY"}).otpReady, false);
});

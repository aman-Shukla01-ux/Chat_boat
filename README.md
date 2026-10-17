# Chat Boat — 2Factor OTP update

## Start on Windows

1. Extract this ZIP to a new folder and open that folder in VS Code.
2. Copy your existing `.env` next to `server.js` to preserve Supabase, Gemini chat, and Cloudflare image settings. If this is a new installation, copy `.env.example` to `.env` and fill the placeholders.
3. Add `TWOFACTOR_API_KEY=your_actual_2factor_key` to `.env`. Old MSG91 and Twilio variables are no longer used. No real keys are included in this ZIP.
4. Run `npm install`, then `npm start`.
5. Open http://localhost:3000 (or the configured APP_URL).

## OTP flow

This version uses the same 2Factor `/SMS/{number}/AUTOGEN` endpoint that delivered an OTP by call in your manual test. 2Factor decides whether delivery is by SMS or call. It does not force voice delivery or guarantee SMS. Answer the verification call and enter its code, or enter the SMS code if one arrives.

- New number: Create account → enter name, mobile and password → request OTP → enter the 4–6 digit code → sign in.
- Existing number: Sign in with mobile/password. If forgotten, use Forgot password → request OTP → enter the received code and new password.
- Existing numbers do not receive signup OTPs. Unregistered numbers do not receive password-reset OTPs.
- Resend is available after 60 seconds and starts a new verification session. Only the newest session is checked. Use the latest code. The original app request expires after 10 minutes; the provider may expire its code sooner.
- Five verification attempts per request; per-number, IP and global limits remain enabled.
- Accepted means the provider accepted a request, not that the phone received it. Provider errors do not bypass verification.
- OTP sessions live in server memory. Restarting clears pending requests; request a new code. Run a single server process for this demo.

## Database

Existing `chatboat_mobile_*` tables and password hashes remain compatible. No database migration is required for this provider change. For a new installation only, run `supabase/setup.sql` in Supabase SQL Editor. Use the server secret key. Passwords are hashed, never stored as plaintext.

## Checks

`npm test` runs automated tests with mocked providers and database; it sends no calls or SMS.
`npm run doctor` checks configuration/database connectivity without requesting OTPs.
`npm run otp:test` interactively requests ONE real OTP to your chosen test number and optionally verifies it. Provider credits may be consumed. A code from this diagnostic script cannot finish a website signup; request the code within the website for that.

## Chat and image generation

Gemini is used for text chat only. Keep `GEMINI_API_KEY` and `GEMINI_MODEL` for chat.

Images use Cloudflare Workers AI. Add these server-only values to `.env`:

```env
CLOUDFLARE_ACCOUNT_ID=your_cloudflare_account_id
CLOUDFLARE_API_TOKEN=your_workers_ai_api_token
CLOUDFLARE_IMAGE_MODEL=@cf/black-forest-labs/flux-1-schnell
```

Generated images are still saved in the existing private Supabase Storage gallery. Run `supabase/image-generation.sql` once if the image table/bucket has not been created.

`flux-1-schnell` returns JPEG images. The current Image Studio keeps the selected aspect-ratio label and includes it in the prompt; this specific fast model may not strictly enforce output dimensions.

## Safety

Keep `.env` on the server and out of public/. Rotate credentials exposed in chat. No API key, OTP, or password is logged by the OTP adapter. Use HTTPS for production. This ZIP was tested with mocked 2Factor responses; live signup/reset delivery still needs testing with your configured account.

API reference: https://documenter.getpostman.com/view/301893/TWDamFGh

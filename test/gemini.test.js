const test = require("node:test");
const assert = require("node:assert/strict");
const { generateReply } = require("../lib/gemini");
const config = { geminiKey: "test-private-key", model: "gemini-3.8-flash" };
const contents = [{ role: "user", parts: [{ text: "Hello" }] }];

test("Gemini uses a server-side header, correct roles, and ignores thought parts", async () => {
    const text = await generateReply(config, contents, async (url, options) => {
        assert.ok(!url.includes(config.geminiKey));
        assert.equal(options.headers["x-goog-api-key"], config.geminiKey);
        assert.deepEqual(JSON.parse(options.body).contents, contents);
        return Response.json({ candidates: [{ content: { parts: [{ thought: true, text: "hidden" }, { text: "Hello!" }] }, finishReason: "STOP" }] });
    });
    assert.equal(text, "Hello!");
});

test("missing key, quota, model, safety, empty output and timeouts have useful errors", async () => {
    await assert.rejects(generateReply({ ...config, geminiKey: "" }, contents), { status: 503 });
    for (const [status, expected] of [[429, 429], [404, 502], [403, 502]]) {
        await assert.rejects(generateReply(config, contents, async () => new Response("private upstream error", { status })), { status: expected });
    }
    await assert.rejects(generateReply(config, contents, async () => Response.json({ promptFeedback: { blockReason: "SAFETY" } })), { status: 422 });
    await assert.rejects(generateReply(config, contents, async () => Response.json({ candidates: [] })), { status: 502 });
    await assert.rejects(generateReply(config, contents, async () => { throw new DOMException("timeout", "TimeoutError"); }), { status: 504 });
});

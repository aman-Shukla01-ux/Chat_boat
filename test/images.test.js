const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { setup, config } = require("./helpers/app");
const { generateImage } = require("../lib/images");
const { TOKEN_A } = require("./helpers/fake-supabase");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/elcAAAAASUVORK5CYII=", "base64");
const fixture = () => ({ bytes: PNG, mimeType: "image/png" });
const request = () => ({ requestId: randomUUID(), prompt: "A calm watercolor landscape", aspectRatio: "16:9" });

test("Cloudflare image request uses private auth and validates the JPEG response", async () => {
    let sent;
    const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const result = await generateImage(config, "A tiny sailboat", "16:9", async (url, options) => {
        sent = { url, ...options };
        return Response.json({ success: true, result: { image: JPEG.toString("base64") }, errors: [] });
    });
    assert.deepEqual(result.bytes, JPEG);
    assert.equal(result.mimeType, "image/jpeg");
    assert.equal(sent.headers.Authorization, `Bearer ${config.cloudflareApiToken}`);
    assert.ok(sent.url.includes(config.cloudflareAccountId));
    assert.ok(sent.url.endsWith(config.cloudflareImageModel));
    const body = JSON.parse(sent.body);
    assert.match(body.prompt, /A tiny sailboat/);
    assert.match(body.prompt, /16:9 aspect ratio/);
    assert.equal(body.steps, 4);
    assert.ok(!sent.url.includes(config.cloudflareApiToken));
});

test("Cloudflare image parsing handles quota, empty responses and invalid image data", async () => {
    await assert.rejects(generateImage(config, "x", "1:1", async () => new Response("{}", { status: 429 })), { status: 429 });
    for (const data of [
        { success: true, result: {} },
        { success: true, result: { image: "aW52YWxpZA==" } },
        { success: false, errors: [{ message: "blocked" }] }
    ]) await assert.rejects(generateImage(config, "x", "1:1", async () => Response.json(data)), { status: 502 });
    await assert.rejects(generateImage({ ...config, imageReady: false }, "x", "1:1"), { status: 503 });
});

test("image generation, private download, account isolation, deduplication and delete", async (t) => {
    let calls = 0;
    const { call, fake, base } = await setup(t, undefined, {}, { generateImage: async () => { calls++; return fixture(); } });
    const body = request();
    assert.equal((await call("/api/images", "POST", body, null)).status, 401);
    const made = await call("/api/images", "POST", body);
    assert.equal(made.status, 201);
    assert.equal(made.data.image.prompt, body.prompt);
    assert.equal(made.data.image.storage_path, undefined);
    assert.equal(fake.files.size, 1);
    assert.equal((await call("/api/images", "POST", body)).status, 200);
    assert.equal(calls, 1);
    assert.equal((await call("/api/images", "POST", { ...body, prompt: "Different" })).status, 409);
    const list = await call("/api/images", "GET", undefined, "user-b");
    assert.equal(list.data.images.length, 0);
    assert.equal((await call(made.data.image.url, "GET", undefined, "user-b")).status, 404);
    assert.equal((await call(`/api/images/${body.requestId}`, "DELETE", undefined, "user-b")).status, 404);
    const download = await fetch(base + made.data.image.downloadUrl, { headers: { Cookie: `chatboat_session=${TOKEN_A}` } });
    assert.equal(download.status, 200);
    assert.match(download.headers.get("content-type"), /image\/png/);
    assert.match(download.headers.get("content-disposition"), /attachment/);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), PNG);
    assert.equal((await call(`/api/images/${body.requestId}`, "DELETE")).status, 200);
    assert.equal(fake.files.size, 0);
    assert.equal(fake.state.chatboat_mobile_images.length, 0);
});

test("retrying failed image metadata save does not regenerate or leak another prompt", async (t) => {
    let calls = 0;
    const { call, fake } = await setup(t, undefined, {}, { generateImage: async () => { calls++; return fixture(); } });
    const body = request();
    fake.setFailTable("chatboat_mobile_images");
    assert.equal((await call("/api/images", "POST", body)).status, 503);
    fake.setFailTable("");
    assert.equal((await call("/api/images", "POST", { ...body, prompt: "Changed" })).status, 409);
    assert.equal((await call("/api/images", "POST", body)).status, 201);
    assert.equal(calls, 1);
    assert.equal(fake.files.size, 1);
});

test("image quota, missing storage and invalid shape are checked before charging generation", async (t) => {
    let calls = 0;
    const { call, fake } = await setup(t, undefined, { imageHourlyLimit: 1 }, { generateImage: async () => { calls++; return fixture(); } });
    assert.equal((await call("/api/images", "POST", { ...request(), aspectRatio: "bogus" })).status, 400);
    fake.setFailStorage(true);
    assert.equal((await call("/api/images", "POST", request())).status, 503);
    assert.equal(calls, 0);
    fake.setFailStorage(false);
    assert.equal((await call("/api/images", "POST", request())).status, 201);
    const limited = await call("/api/images", "POST", request());
    assert.equal(limited.status, 429);
    assert.equal(limited.data.code, "APP_RATE_LIMIT");
    assert.equal(calls, 1);
});

test("only one image per account can be generated at a time", async (t) => {
    let release, started;
    const busy = new Promise((resolve) => { started = resolve; });
    const { call } = await setup(t, undefined, {}, { generateImage: async () => { started(); await new Promise((resolve) => { release = resolve; }); return fixture(); } });
    const first = call("/api/images", "POST", request());
    await busy;
    assert.equal((await call("/api/images", "POST", request())).status, 409);
    release();
    assert.equal((await first).status, 201);
});

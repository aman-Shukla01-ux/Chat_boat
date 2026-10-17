const { AppError } = require("./gemini");
const TABLE = "chatboat_mobile_images";
const BUCKET = "chatboat-mobile-images";
const RATIOS = new Set(["1:1", "16:9", "9:16", "4:3", "3:4"]);
const MAX_BYTES = 10 * 1024 * 1024;
const EXTENSIONS = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
const FIELDS = "id,prompt,aspect_ratio,mime_type,created_at";
const publicImage = (row) => ({ ...row, url: `/api/images/${row.id}/content`, downloadUrl: `/api/images/${row.id}/content?download=1` });

async function generateImage(config, prompt, aspectRatio, fetchImpl = fetch) {
    if (!config.imageReady) {
        throw new AppError(503, "Add CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN to the server's .env file, then restart it.");
    }
    if (!RATIOS.has(aspectRatio)) throw new AppError(400, "Choose a supported image shape.");

    const model = config.cloudflareImageModel || "@cf/black-forest-labs/flux-1-schnell";
    const url = `https://api.cloudflare.com/client/v4/accounts/${config.cloudflareAccountId}/ai/run/${model}`;

    let response;
    try {
        response = await fetchImpl(url, {
            method: "POST",
            redirect: "error",
            headers: {
                "Authorization": `Bearer ${config.cloudflareApiToken}`,
                "Content-Type": "application/json"
            },
            signal: AbortSignal.timeout(120000),
            body: JSON.stringify({
                prompt: `${prompt}\nComposition target: ${aspectRatio} aspect ratio.`,
                steps: 4
            })
        });
    } catch (error) {
        throw new AppError(
            ["AbortError", "TimeoutError"].includes(error?.name) ? 504 : 502,
            "The Cloudflare image request did not finish. Check your connection and try again."
        );
    }

    if (!response.ok) {
        const message = {
            400: "Cloudflare rejected the image request. Check the prompt and CLOUDFLARE_IMAGE_MODEL.",
            401: "Cloudflare could not authenticate the request. Check CLOUDFLARE_API_TOKEN.",
            403: "Workers AI access is not enabled for this token/account. Check the token permissions in Cloudflare.",
            404: "The Cloudflare image model or Account ID was not found. Check CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_IMAGE_MODEL.",
            429: "Cloudflare Workers AI quota or rate limit was reached. Try again after the limit resets."
        }[response.status] || "Cloudflare image generation is temporarily unavailable. Try again later.";
        throw new AppError(response.status === 429 ? 429 : 502, message);
    }

    if (Number(response.headers?.get("content-length")) > 16 * 1024 * 1024) {
        throw new AppError(502, "The generated image response is too large.");
    }

    let text = "";
    if (response.body) {
        const chunks = [];
        let length = 0;
        for await (const chunk of response.body) {
            length += chunk.length;
            if (length > 16 * 1024 * 1024) throw new AppError(502, "The generated image response is too large.");
            chunks.push(chunk);
        }
        text = Buffer.concat(chunks).toString("utf8");
    } else {
        text = await response.text();
    }

    let result;
    try {
        result = JSON.parse(text);
    } catch {
        throw new AppError(502, "Cloudflare returned an unreadable image response.");
    }

    if (result?.success === false) {
        const upstream = result?.errors?.[0]?.message;
        throw new AppError(502, upstream || "Cloudflare could not generate the image.");
    }

    const data = result?.result?.image;
    if (typeof data !== "string" || !/^[a-zA-Z0-9+/]+={0,2}$/.test(data)) {
        throw new AppError(502, "Cloudflare returned no supported image. Try another description.");
    }

    const bytes = Buffer.from(data, "base64");
    const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    if (!jpeg || bytes.length > MAX_BYTES) {
        throw new AppError(502, "Cloudflare returned an invalid or oversized image.");
    }

    return { bytes, mimeType: "image/jpeg" };
}

function installImages(app, config, { db, limit, databaseError, checkId, imageGenerator = generateImage, now = Date.now }) {
    const active = new Set();
    const pending = new Map(); // Short-lived retry cache after generation but before a successful DB save.
    const bucket = () => db.storage.from(BUCKET);
    function storageError(error) {
        if (error) throw new AppError(503, "Image storage is unavailable. Run supabase/image-generation.sql and check your Supabase Storage quota.");
    }
    async function owned(id, userId, fields = FIELDS) {
        const result = await db.from(TABLE).select(fields).eq("id", id).eq("user_id", userId).maybeSingle();
        databaseError(result.error);
        return result.data;
    }
    app.get("/api/images", async (req, res) => {
        const result = await db.from(TABLE).select(FIELDS).eq("user_id", req.user.id)
            .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(100);
        databaseError(result.error);
        res.json({ images: result.data.map(publicImage) });
    });
    app.post("/api/images", async (req, res) => {
        const id = checkId(req.body?.requestId);
        const prompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
        const aspectRatio = req.body?.aspectRatio || "1:1";
        if (!prompt || prompt.length > 2000) throw new AppError(400, "Describe your image in 1 to 2,000 characters.");
        if (!RATIOS.has(aspectRatio)) throw new AppError(400, "Choose a supported image shape.");
        if (active.has(req.user.id)) throw new AppError(409, "An image is already being generated. Please wait.");
        if (active.size >= 2) throw new AppError(503, "Image generation is busy. Please try again shortly.");
        active.add(req.user.id);
        const key = `${req.user.id}:${id}`;
        try {
            const existing = await owned(id, req.user.id);
            if (existing) {
                if (existing.prompt !== prompt || existing.aspect_ratio !== aspectRatio) throw new AppError(409, "This request ID belongs to a different image.");
                pending.delete(key);
                return res.json({ image: publicImage(existing) });
            }
            const images = await db.from(TABLE).select("id").eq("user_id", req.user.id).limit(100);
            databaseError(images.error);
            if (images.data.length >= 100) throw new AppError(409, "Your gallery has 100 images. Delete an image before making another.");
            const storage = await db.storage.getBucket(BUCKET);
            storageError(storage.error);
            if (storage.data?.public !== false) throw new AppError(503, "The image bucket must be private. Run supabase/image-generation.sql.");
            for (const [k, item] of pending) if (item.expiresAt <= now()) pending.delete(k);
            let saved = pending.get(key);
            if (saved && (saved.prompt !== prompt || saved.aspectRatio !== aspectRatio)) throw new AppError(409, "This request ID belongs to a different image.");
            if (!saved) {
                if (pending.size + active.size >= 8) throw new AppError(503, "Image saving is busy. Try again shortly.");
                limit(`image:user:${req.user.id}`, config.imageHourlyLimit, 3600000, res);
                limit("image:global", config.imageGlobalHourlyLimit, 3600000, res);
                const image = await imageGenerator(config, prompt, aspectRatio);
                saved = { ...image, prompt, aspectRatio, expiresAt: now() + 600000 };
                pending.set(key, saved);
            }
            const storagePath = `${req.user.id}/${id}.${EXTENSIONS[saved.mimeType]}`;
            const uploaded = await bucket().upload(storagePath, saved.bytes, { contentType: saved.mimeType, upsert: true });
            storageError(uploaded.error);
            const result = await db.from(TABLE).insert({ id, user_id: req.user.id, prompt, aspect_ratio: aspectRatio,
                mime_type: saved.mimeType, storage_path: storagePath }).select(FIELDS).single();
            databaseError(result.error);
            pending.delete(key);
            res.status(201).json({ image: publicImage(result.data) });
        } finally { active.delete(req.user.id); }
    });
    app.get("/api/images/:id/content", async (req, res) => {
        const id = checkId(req.params.id);
        const row = await owned(id, req.user.id, "id,storage_path,mime_type");
        if (!row) throw new AppError(404, "Image not found.");
        const result = await bucket().download(row.storage_path);
        storageError(result.error);
        res.type(row.mime_type);
        res.set("Content-Disposition", `${req.query.download === "1" ? "attachment" : "inline"}; filename="chat-boat-${id}.${EXTENSIONS[row.mime_type]}"`);
        res.send(Buffer.from(await result.data.arrayBuffer()));
    });
    app.delete("/api/images/:id", async (req, res) => {
        const id = checkId(req.params.id);
        const row = await owned(id, req.user.id, "id,storage_path");
        if (!row) throw new AppError(404, "Image not found.");
        storageError((await bucket().remove([row.storage_path])).error);
        databaseError((await db.from(TABLE).delete().eq("id", id).eq("user_id", req.user.id)).error);
        res.json({ success: true });
    });
}
module.exports = { generateImage, installImages, BUCKET, TABLE, RATIOS };

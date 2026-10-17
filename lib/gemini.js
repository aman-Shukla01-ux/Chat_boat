class AppError extends Error {
    constructor(status, message, details = {}) {
        super(message);
        this.status = status;
        Object.assign(this, details);
    }
}

async function callGemini(config, model, contents, fetchImpl) {
    return fetchImpl(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-goog-api-key": config.geminiKey
            },
            signal: AbortSignal.timeout(45000),

            body: JSON.stringify({
                systemInstruction: {
                    parts: [
                        {
                            text:
                                "You are Aman AI, a helpful conversational assistant. " +
                                "Be clear, accurate and friendly. " +
                                "Respond in the user's language. " +
                                "Admit uncertainty. " +
                                "You cannot browse the web or access files, user accounts or private data. " +
                                "Use plain text and fenced code blocks when useful."
                        }
                    ]
                },

                contents,

                generationConfig: {
                    maxOutputTokens: 4096
                }
            })
        }
    );
}

async function generateReply(config, contents, fetchImpl = fetch) {
    if (!config.geminiKey) {
        throw new AppError(
            503,
            "Add GEMINI_API_KEY to the server's .env file, then restart it."
        );
    }

    const primaryModel = config.model || "gemini-2.5-flash";

    const envFallback = (
        process.env.GEMINI_FALLBACK_MODEL ||
        "gemini-2.5-flash-lite"
    ).trim();

    const fallbackModel =
        /^gemini-[a-zA-Z0-9.-]+$/.test(envFallback)
            ? envFallback
            : "gemini-2.5-flash-lite";

    let response;
    let usedModel = primaryModel;

    try {
        // First try primary model
        response = await callGemini(
            config,
            primaryModel,
            contents,
            fetchImpl
        );

        // If primary model quota/rate limit is reached,
        // automatically try fallback model
        if (
            response.status === 429 &&
            fallbackModel !== primaryModel
        ) {
            console.warn(
                `Gemini ${primaryModel} quota reached. Trying fallback: ${fallbackModel}`
            );

            usedModel = fallbackModel;

            response = await callGemini(
                config,
                fallbackModel,
                contents,
                fetchImpl
            );
        }
    } catch (error) {
        if (
            ["AbortError", "TimeoutError"].includes(error?.name)
        ) {
            throw new AppError(
                504,
                "Gemini took too long. Please try again."
            );
        }

        throw new AppError(
            502,
            "Could not reach Gemini. Check the server's internet connection."
        );
    }

    if (!response.ok) {
        const messages = {
            400:
                "Gemini rejected the request. Check your API key and model configuration.",

            401:
                "Gemini authentication failed. Check GEMINI_API_KEY on the server.",

            403:
                "Gemini access was denied. Check your API key, project and model access.",

            404:
                `Gemini model ${usedModel} is unavailable. Check your Gemini model configuration.`,

            429:
                "Both Gemini models reached their quota or rate limit. Please try again after the quota resets."
        };

        throw new AppError(
            response.status === 429 ? 429 : 502,
            messages[response.status] ||
                "Gemini is temporarily unavailable. Please try again."
        );
    }

    let result;

    try {
        result = await response.json();
    } catch {
        throw new AppError(
            502,
            "Gemini returned an unreadable response. Please try again."
        );
    }

    const candidate = result.candidates?.[0];

    if (
        result.promptFeedback?.blockReason ||
        [
            "SAFETY",
            "RECITATION",
            "BLOCKLIST",
            "PROHIBITED_CONTENT",
            "SPII"
        ].includes(candidate?.finishReason)
    ) {
        throw new AppError(
            422,
            "Gemini could not answer this request. Try rephrasing your message."
        );
    }

    let reply = candidate?.content?.parts
        ?.filter(
            (part) =>
                !part.thought &&
                typeof part.text === "string"
        )
        .map((part) => part.text)
        .join("\n")
        .trim();

    if (!reply) {
        throw new AppError(
            502,
            "Gemini returned no text. Please try again."
        );
    }

    if (reply.length > 30000) {
        reply =
            reply.slice(0, 30000) +
            "\n\n[Response shortened. Ask me to continue.]";
    } else if (candidate.finishReason === "MAX_TOKENS") {
        reply +=
            "\n\n[Response limit reached. Ask me to continue.]";
    }

    console.log(`Gemini response model: ${usedModel}`);

    return reply;
}

module.exports = {
    generateReply,
    AppError
};

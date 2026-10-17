const { loadConfig } = require("../lib/config");

async function main() {
    const config = loadConfig();
    if (!config.geminiKey) throw new Error("Add GEMINI_API_KEY to .env first.");
    let pageToken = "";
    for (let page = 0; page < 20; page++) {
        const url = new URL("https://generativelanguage.googleapis.com/v1beta/models");
        url.searchParams.set("pageSize", "100");
        if (pageToken) url.searchParams.set("pageToken", pageToken);
        const response = await fetch(url, { headers: { "x-goog-api-key": config.geminiKey }, signal: AbortSignal.timeout(20000) });
        if (!response.ok) throw new Error(`Gemini model listing failed (HTTP ${response.status}). Check your API key and quota.`);
        const result = await response.json();
        for (const model of result.models || []) {
            if (model.supportedGenerationMethods?.includes("generateContent")) console.log(model.name.replace(/^models\//, ""));
        }
        pageToken = result.nextPageToken || "";
        if (!pageToken) return;
    }
}
main().catch((error) => {
    console.error(["TimeoutError", "AbortError", "TypeError"].includes(error.name) ? "Could not reach Gemini. Check your internet connection and try again." : error.message);
    process.exitCode = 1;
});

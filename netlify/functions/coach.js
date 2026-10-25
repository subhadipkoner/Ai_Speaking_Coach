// Netlify Function: the only place the Anthropic API key is ever used.
// Route: POST /api/coach  (see netlify.toml)
const { handleCoach, HttpError } = require("./lib/coach-core");

const json = (statusCode, body) => ({
  statusCode,
  headers: { "content-type": "application/json", "cache-control": "no-store" },
  body: JSON.stringify(body),
});

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Use POST." });

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "Invalid JSON." });
  }

  try {
    const result = await handleCoach(body, {
      apiKey: process.env.GEMINI_API_KEY,
      chatModel: process.env.CHAT_MODEL,
      scoreModel: process.env.SCORE_MODEL,
    });
    return json(200, result);
  } catch (err) {
    if (err instanceof HttpError) return json(err.status, { error: err.message });
    console.error("Unexpected error", err);
    return json(500, { error: "Unexpected server error." });
  }
};

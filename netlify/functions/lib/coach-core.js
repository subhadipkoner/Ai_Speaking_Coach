const { SCENARIOS, coachSystemPrompt, openerInstruction, COACH_TOOL, SCORE_TOOL, SCORER_SYSTEM_PROMPT } = require("./prompts");

// Core logic for the coach API, independent of Netlify so it can be unit-tested.

const LIMITS = {
  maxMessages: 60, // 30 exchanges per session
  maxMessageChars: 2000,
  minUserTurnsToScore: 2,
};

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_CHAT_MODEL = "gemini-3.5-flash";
const DEFAULT_SCORE_MODEL = "gemini-3.5-flash";
// Gemini occasionally stalls; give it 20s (Netlify functions allow up to ~26s) before showing a retry message.
const DEFAULT_TIMEOUT_MS = 20000;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Validate the browser-supplied history. Never trust it. */
function validateHistory(raw) {
  if (!Array.isArray(raw)) throw new HttpError(400, "messages must be an array.");
  if (raw.length > LIMITS.maxMessages)
    throw new HttpError(400, "This session is very long. Please end it and get your score.");

  return raw.map((m, i) => {
    if (!m || typeof m !== "object") throw new HttpError(400, `Message ${i} is invalid.`);
    const expected = i % 2 === 0 ? "assistant" : "user"; // coach always speaks first
    if (m.role !== expected) throw new HttpError(400, "Messages must alternate, starting with the coach.");
    if (typeof m.content !== "string" || !m.content.trim())
      throw new HttpError(400, `Message ${i} is empty.`);
    if (m.content.length > LIMITS.maxMessageChars)
      throw new HttpError(400, `Please keep each message under ${LIMITS.maxMessageChars} characters.`);
    return { role: m.role, content: m.content.trim(), spoken: m.role === "user" && m.via === "voice" };
  });
}

function toApiMessages(scenario, history) {
  const msgs = [{ role: "user", content: openerInstruction(scenario) }];
  for (const m of history) {
    msgs.push({ role: m.role, content: m.spoken ? `(spoken) ${m.content}` : m.content });
  }
  return msgs;
}

function transcriptText(history) {
  return history
    .map((m) => (m.role === "assistant" ? `COACH: ${m.content}` : `STUDENT${m.spoken ? " (spoken)" : ""}: ${m.content}`))
    .join("\n");
}

// Gemini wants upper-case JSON-schema type names.
function toGeminiSchema(s) {
  if (Array.isArray(s)) return s.map(toGeminiSchema);
  if (!s || typeof s !== "object") return s;
  return Object.fromEntries(
    Object.entries(s).map(([k, v]) => [k, k === "type" && typeof v === "string" ? v.toUpperCase() : toGeminiSchema(v)])
  );
}

/** Call Gemini and return the structured JSON the schema asks for. `body` uses our neutral shape. */
async function callModel({ apiKey, fetchImpl, timeoutMs, body }) {
  const payload = {
    systemInstruction: { parts: [{ text: body.system }] },
    contents: body.messages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    })),
    generationConfig: {
      temperature: body.temperature,
      maxOutputTokens: body.max_tokens,
      responseMimeType: "application/json",
      responseSchema: toGeminiSchema(body.tool.input_schema),
      thinkingConfig: { thinkingBudget: 0 }, // keep replies fast
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(`${GEMINI_URL}/${encodeURIComponent(body.model)}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === "AbortError") throw new HttpError(504, "The coach took too long to answer. Please try again.");
    throw new HttpError(502, "Could not reach the AI service.");
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error("Gemini API error", res.status, detail.slice(0, 500));
    if (res.status === 401 || res.status === 403 || /API key not valid/i.test(detail))
      throw new HttpError(401, "The API key was rejected. Check it and try again.");
    if (res.status === 429 || res.status === 503)
      throw new HttpError(503, "The coach is busy right now. Please wait a few seconds and try again.");
    throw new HttpError(502, "The AI service returned an error.");
  }

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("");
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(502, "The coach gave an unexpected answer. Please try again.");
  }
}

const str = (v, max = 600) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const clamp25 = (n) => Math.max(0, Math.min(25, Math.round(Number(n) || 0)));

/** Clean the model's tool output so the frontend always gets a predictable shape. */
function normalizeChat(input) {
  const reply = str(input?.reply, 1200);
  if (!reply) throw new HttpError(502, "The coach gave an empty answer. Please try again.");
  const corrections = (Array.isArray(input?.corrections) ? input.corrections : [])
    .map((c) => ({ original: str(c?.original), improved: str(c?.improved), reason: str(c?.reason, 300) }))
    .filter((c) => c.original && c.improved && c.original.toLowerCase() !== c.improved.toLowerCase())
    .slice(0, 3);
  return { reply, corrections };
}

function normalizeScore(input) {
  const breakdown = {
    grammar: clamp25(input?.grammar),
    vocabulary: clamp25(input?.vocabulary),
    fluency: clamp25(input?.fluency),
    confidence: clamp25(input?.confidence),
  };
  const list = (v, n) => (Array.isArray(v) ? v : []).map((x) => str(x, 400)).filter(Boolean).slice(0, n);
  return {
    // The overall score is computed here, not by the model, so it always equals the breakdown.
    score: breakdown.grammar + breakdown.vocabulary + breakdown.fluency + breakdown.confidence,
    breakdown,
    summary: str(input?.summary, 500),
    strengths: list(input?.strengths, 3),
    improvements: list(input?.improvements, 3),
    betterSentences: (Array.isArray(input?.better_sentences) ? input.better_sentences : [])
      .map((s) => ({ original: str(s?.original), better: str(s?.better) }))
      .filter((s) => s.original && s.better)
      .slice(0, 3),
  };
}

/**
 * Handle one API request.
 * body: { action: "chat" | "score", scenario, messages: [{role, content, via?}] }
 */
async function handleCoach(body, env = {}) {
  const apiKey = env.apiKey;
  if (!apiKey) throw new HttpError(500, "Server is missing GEMINI_API_KEY.");
  const fetchImpl = env.fetchImpl || fetch;
  const timeoutMs = env.timeoutMs || DEFAULT_TIMEOUT_MS;

  if (!body || typeof body !== "object") throw new HttpError(400, "Invalid request body.");
  const { action, scenario } = body;
  if (!Object.hasOwn(SCENARIOS, scenario)) throw new HttpError(400, "Unknown scenario.");
  const history = validateHistory(body.messages ?? []);

  if (action === "chat") {
    if (history.length > 0 && history.at(-1).role !== "user")
      throw new HttpError(400, "The last message must be from the student.");
    const input = await callModel({
      apiKey,
      fetchImpl,
      timeoutMs,
      body: {
        model: env.chatModel || DEFAULT_CHAT_MODEL,
        max_tokens: 600,
        temperature: 0.7,
        system: coachSystemPrompt(scenario),
        messages: toApiMessages(scenario, history),
        tool: COACH_TOOL,
      },
    });
    return normalizeChat(input);
  }

  if (action === "score") {
    const userTurns = history.filter((m) => m.role === "user").length;
    if (userTurns < LIMITS.minUserTurnsToScore)
      throw new HttpError(400, `Answer at least ${LIMITS.minUserTurnsToScore} questions before getting a score.`);
    const input = await callModel({
      apiKey,
      fetchImpl,
      timeoutMs,
      body: {
        model: env.scoreModel || DEFAULT_SCORE_MODEL,
        max_tokens: 1200,
        temperature: 0.2,
        system: SCORER_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: `Scenario: ${SCENARIOS[scenario].label}\n\n<transcript>\n${transcriptText(history)}\n</transcript>\n\nAssess the student now.`,
          },
        ],
        tool: SCORE_TOOL,
      },
    });
    return normalizeScore(input);
  }

  throw new HttpError(400, "Unknown action.");
}

module.exports = { handleCoach, HttpError };

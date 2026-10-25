const test = require("node:test");
const assert = require("node:assert/strict");
const { handleCoach } = require("../netlify/functions/lib/coach-core");

// Fake Gemini API: returns the given object as the model's JSON text.
const fakeFetch = (input) => async (_url, init) => {
  fakeFetch.last = JSON.parse(init.body);
  return new Response(
    JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(input) }] } }] }),
    { status: 200 }
  );
};
const env = (input) => ({ apiKey: "test", fetchImpl: fakeFetch(input) });
const convo = [
  { role: "assistant", content: "Hi! Tell me about yourself." },
  { role: "user", content: "I am agree with you", via: "voice" },
  { role: "assistant", content: "Great. Why?" },
  { role: "user", content: "Because it is good." },
];

test("chat returns reply and drops no-op corrections", async () => {
  const out = await handleCoach(
    { action: "chat", scenario: "hr", messages: convo },
    env({
      reply: "Nice. What is your biggest strength?",
      corrections: [
        { original: "I am agree", improved: "I agree", reason: "Agree is a verb." },
        { original: "good", improved: "Good", reason: "same word" },
      ],
    })
  );
  assert.equal(out.corrections.length, 1);
  assert.match(fakeFetch.last.contents[2].parts[0].text, /^\(spoken\)/);
});

test("score total equals sum of clamped breakdown", async () => {
  const out = await handleCoach(
    { action: "score", scenario: "casual", messages: convo },
    env({ grammar: 99, vocabulary: 15, fluency: 10, confidence: -3, summary: "ok",
      strengths: ["a", "b", "c"], improvements: ["a", "b", "c"],
      better_sentences: [{ original: "x", better: "y" }] })
  );
  assert.deepEqual(out.breakdown, { grammar: 25, vocabulary: 15, fluency: 10, confidence: 0 });
  assert.equal(out.score, 50);
});

test("rejects bad input", async () => {
  await assert.rejects(handleCoach({ action: "chat", scenario: "nope", messages: [] }, env({})), /Unknown scenario/);
  await assert.rejects(
    handleCoach({ action: "score", scenario: "hr", messages: convo.slice(0, 2) }, env({})),
    /at least 2/
  );
  await assert.rejects(handleCoach({ action: "chat", scenario: "hr", messages: [] }, { fetchImpl: fetch }), /GEMINI_API_KEY/);
});


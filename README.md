# AI Speaking Coach

Practice spoken English for job placements and interviews by **talking or typing**. A friendly AI coach replies like a real conversation partner, corrects mistakes inline, and gives you **one overall score out of 100** at the end.

## The problem

Many students know the answers to interview questions but freeze when they have to say them in English. Mock interviews with a person are hard to schedule, and most apps either grade a single sentence or need paid voice services. This project gives instant, judgement-free speaking practice in the browser.

## Features

- **Text mode**: type an answer; mistakes appear under your message as `original → improved` with a one-line reason.
- **Voice mode**: speak your answer, see a live transcript, and hear the coach reply. Mic states: idle, listening, processing, speaking. Falls back to Text mode when the browser has no speech recognition.
- **Scenarios**: casual chat, HR interview, self-introduction, group discussion.
- **Natural conversation**: 2-4 sentence replies, one follow-up question at a time, full history kept for the session.
- **Final score**: total /100 from four 0-25 areas (grammar, vocabulary, fluency, confidence and clarity), plus 3 strengths, 3 improvements and 2-3 "say it better" sentences.
- Mobile-friendly, dark mode, keyboard accessible.

## Architecture

```
Browser (HTML/CSS/JS)                Netlify Function                 Gemini API
┌─────────────────────┐  POST /api/coach  ┌──────────────────┐  tool use  ┌────────┐
│ UI + Web Speech API │ ────────────────► │ validate + prompt │ ─────────► │ Gemini │
│ STT / TTS in browser│ ◄──────────────── │ normalize output  │ ◄───────── │        │
└─────────────────────┘   clean JSON      └──────────────────┘            └────────┘
                                           holds GEMINI_API_KEY
```

Key decisions:

- **One AI engine.** Gemini handles conversation, correction and scoring. Voice uses only the browser's `SpeechRecognition` and `speechSynthesis`.
- **API key never reaches the browser.** The frontend calls `/api/coach`; the function adds the key from an environment variable.
- **Structured output via response schema.** Gemini is given a response schema (`coach_reply` or `session_score`), so responses are always valid JSON with no parsing hacks.
- **Server-side prompts and validation.** Prompts live only in the function. History is validated (alternating roles, length limits, max 60 messages, scenario whitelist) so the endpoint can't be abused as a free general-purpose proxy.
- **Trustworthy score.** The total is computed in code as the sum of the four clamped sub-scores, so it always matches the breakdown.
- **Speech-aware.** Spoken turns are tagged so the coach and scorer ignore punctuation and transcription glitches.

## Tech stack

HTML, CSS, vanilla JavaScript · Web Speech API · Netlify Functions (Node 18+) · Google Gemini API (structured JSON output) · `node:test`

## Project structure

| File | Purpose |
|---|---|
| `public/index.html` | The three screens: setup, chat, score |
| `public/styles.css` | Design tokens, light/dark theme, responsive layout |
| `public/app.js` | Frontend controller: session state, chat, mic states, score rendering |
| `public/speech.js` | Web Speech wrapper (listen, speak, silence detection, voice picking) |
| `netlify/functions/coach.js` | HTTP handler for `/api/coach`; reads the API key |
| `netlify/functions/lib/prompts.js` | Scenarios, coach system prompt, scorer prompt, tool schemas |
| `netlify/functions/lib/coach-core.js` | Validation, Gemini call, output normalization |
| `test/coach-core.test.js` | Unit tests with a mocked Gemini API |
| `netlify.toml` | Publish dir, functions dir, `/api/coach` redirect |
| `.env.example` | Environment variable template |

## Setup and run locally

Requirements: Node 18+, an [Gemini API key](https://aistudio.google.com/apikey) (free tier available).

```bash
npm install
cp .env.example .env      # Windows: copy .env.example .env  -> then paste your key
npm test
npm run dev               # opens http://localhost:8888
```

Use **Chrome or Edge** for voice. The mic works on `localhost` and on HTTPS sites.

## Deploy to Netlify

1. Push this folder to a GitHub repo (`.env` is git-ignored).
2. In Netlify: **Add new site → Import from Git**, pick the repo. Build settings are read from `netlify.toml`.
3. **Site configuration → Environment variables**: add `GEMINI_API_KEY`. Optionally `CHAT_MODEL` and `SCORE_MODEL`.
4. Deploy. Open the site URL and start a session.

Tip: set a monthly spend limit on your Gemini key, since the site is public.

## Limitations and ideas

- Browser speech recognition quality varies (best in Chrome/Edge). Pronunciation is not scored, only the transcribed text.
- Gemini occasionally stalls; the function aborts after 20 s with a friendly retry message (Netlify's default function limit is 10 s, so raise it in site settings if needed).
- Next steps: rate limiting per IP, saved progress history, filler-word counter, more scenarios.



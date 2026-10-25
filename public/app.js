// AI Speaking Coach - frontend controller.
// Holds the session in memory, talks to /api/coach, and drives the three screens.
(function () {
  const API_URL = "/api/coach";
  const MIN_TURNS_TO_SCORE = 2;
  const SCENARIO_LABELS = {
    casual: "Casual chat",
    hr: "HR interview",
    intro: "Self-introduction",
    gd: "Group discussion",
  };

  const $ = (id) => document.getElementById(id);
  const el = {
    setup: $("screen-setup"),
    chat: $("screen-chat"),
    score: $("screen-score"),
    startBtn: $("start-btn"),
    endBtn: $("end-btn"),
    messages: $("messages"),
    chatScenario: $("chat-scenario"),
    chatTurns: $("chat-turns"),
    errorBar: $("error-bar"),
    textForm: $("text-form"),
    textInput: $("text-input"),
    sendBtn: $("send-btn"),
    voicePanel: $("voice-panel"),
    micBtn: $("mic-btn"),
    micStatus: $("mic-status"),
    liveTranscript: $("live-transcript"),
    accent: $("accent"),
  };

  const state = {
    scenario: "casual",
    mode: "text",
    messages: [], // [{ role: "assistant" | "user", content, via?: "voice" | "text" }]
    busy: false,
    micState: "idle",
    sessionId: 0, // ignore late responses from a session that already ended
  };

  /* ---------------- Networking ---------------- */

  // The browser only ever talks to our own serverless proxy; the API key never leaves the server.
  async function api(action) {
    let res;
    try {
      res = await fetch(API_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, scenario: state.scenario, messages: state.messages }),
      });
    } catch {
      throw new Error("Could not reach the server. Check your connection and try again.");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Something went wrong. Please try again.");
    return data;
  }

  /* ---------------- Screens ---------------- */

  function show(screen) {
    for (const s of [el.setup, el.chat, el.score]) s.hidden = s !== screen;
    window.scrollTo(0, 0);
  }

  /* ---------------- Setup controls ---------------- */

  function selectRadio(group, selected) {
    for (const b of group) b.setAttribute("aria-checked", String(b === selected));
  }

  const scenarioBtns = [...document.querySelectorAll(".scenario")];
  scenarioBtns.forEach((btn) =>
    btn.addEventListener("click", () => {
      state.scenario = btn.dataset.scenario;
      selectRadio(scenarioBtns, btn);
    })
  );

  const modeToggles = [...document.querySelectorAll("[data-mode-toggle]")];
  function setMode(mode) {
    if (mode === "voice" && !SpeechIO.canListen) mode = "text";
    state.mode = mode;
    for (const t of modeToggles) {
      const btns = [...t.querySelectorAll("button")];
      selectRadio(btns, btns.find((b) => b.dataset.mode === mode));
    }
    el.textForm.hidden = mode !== "text";
    el.voicePanel.hidden = mode !== "voice";
    if (mode === "text") {
      SpeechIO.abort();
      SpeechIO.stopSpeaking();
      setMic("idle");
    }
  }
  modeToggles.forEach((t) =>
    t.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-mode]");
      if (btn && !btn.disabled) setMode(btn.dataset.mode);
    })
  );

  // Graceful fallback: no speech recognition -> voice is disabled, text mode only.
  if (!SpeechIO.canListen) {
    document.querySelectorAll('[data-mode="voice"]').forEach((b) => {
      b.disabled = true;
      b.title = SpeechIO.inFrame ? "Open the file directly in Chrome or Edge to use voice" : "Voice needs Chrome, Edge or Safari";
    });
    const note = document.querySelector("[data-voice-unsupported]");
    if (SpeechIO.inFrame) {
      note.textContent = "Voice is disabled inside this preview window. Open the downloaded speaking-coach.html file directly in Chrome or Edge to speak. Text mode works here.";
    }
    note.hidden = false;
  } else {
    setMode("voice"); // voice is the default where it works
  }

  /* ---------------- Rendering ---------------- */

  function scrollToBottom() {
    el.messages.scrollTop = el.messages.scrollHeight;
  }

  function addMessageEl(role, text, via) {
    const node = $("tpl-msg").content.firstElementChild.cloneNode(true);
    node.classList.add(role === "assistant" ? "coach" : "user");
    node.querySelector(".bubble").textContent = text;

    if (role === "assistant" && SpeechIO.canSpeak) {
      const meta = document.createElement("div");
      meta.className = "msg-meta";
      const replay = document.createElement("button");
      replay.className = "replay";
      replay.type = "button";
      replay.textContent = "▶ Listen";
      replay.addEventListener("click", () => SpeechIO.speak(text, { lang: el.accent.value }));
      meta.append(replay);
      node.append(meta);
    }
    if (role === "user" && via === "voice") {
      const meta = document.createElement("div");
      meta.className = "msg-meta";
      meta.textContent = "🎙 spoken";
      node.append(meta);
    }
    el.messages.append(node);
    scrollToBottom();
    return node;
  }

  function attachCorrections(userNode, corrections) {
    if (!userNode) return;
    if (!corrections.length) {
      const ok = document.createElement("div");
      ok.className = "all-good";
      ok.textContent = "✓ Well said";
      userNode.append(ok);
      return;
    }
    const box = document.createElement("div");
    box.className = "corrections";
    const title = document.createElement("p");
    title.className = "corrections-title";
    title.textContent = corrections.length === 1 ? "1 suggestion" : `${corrections.length} suggestions`;
    box.append(title);
    for (const c of corrections) {
      const row = document.createElement("div");
      row.className = "correction";
      const from = Object.assign(document.createElement("span"), { className: "from", textContent: c.original });
      const arrow = Object.assign(document.createElement("span"), { className: "arrow", textContent: "→" });
      const to = Object.assign(document.createElement("span"), { className: "to", textContent: c.improved });
      const why = Object.assign(document.createElement("span"), { className: "why", textContent: c.reason });
      row.append(from, arrow, to, why);
      box.append(row);
    }
    userNode.append(box);
  }

  function showTyping() {
    const node = document.createElement("div");
    node.className = "msg coach typing";
    node.innerHTML = '<div class="bubble" aria-label="Coach is typing"><i></i><i></i><i></i></div>';
    el.messages.append(node);
    scrollToBottom();
    return node;
  }

  function updateTurns() {
    const n = state.messages.filter((m) => m.role === "user").length;
    const left = MIN_TURNS_TO_SCORE - n;
    el.endBtn.disabled = left > 0 || state.busy;
    el.chatTurns.textContent =
      left > 0
        ? `${n} answer${n === 1 ? "" : "s"} · ${left} more to unlock your score`
        : `${n} answers · end anytime for your score`;
  }

  // Show (or clear) the error bar, optionally with a retry button.
  function showError(msg, onRetry) {
    el.errorBar.replaceChildren(msg || "");
    if (msg && onRetry) {
      const btn = Object.assign(document.createElement("button"), {
        type: "button", className: "retry", textContent: "Retry",
      });
      btn.addEventListener("click", () => { showError(""); onRetry(); });
      el.errorBar.append(" ", btn);
    }
    el.errorBar.hidden = !msg;
  }

  function setBusy(busy) {
    state.busy = busy;
    el.sendBtn.disabled = busy;
    updateTurns();
  }

  /* ---------------- Conversation ---------------- */

  async function requestReply(userNode) {
    const session = state.sessionId;
    setBusy(true);
    showError("");
    if (state.mode === "voice") setMic("processing");
    const typing = showTyping();
    try {
      const { reply, corrections } = await api("chat");
      if (session !== state.sessionId) return;
      typing.remove();
      attachCorrections(userNode, corrections || []);
      state.messages.push({ role: "assistant", content: reply });
      addMessageEl("assistant", reply);
      setBusy(false);
      if (state.mode === "voice" && SpeechIO.canSpeak) {
        setMic("speaking");
        await SpeechIO.speak(reply, { lang: el.accent.value });
        if (session === state.sessionId && state.micState === "speaking") setMic("idle");
      } else if (state.mode === "voice") {
        setMic("idle");
      } else {
        el.textInput.focus();
      }
    } catch (err) {
      if (session !== state.sessionId) return;
      typing.remove();
      setBusy(false);
      if (state.mode === "voice") setMic("idle");
      return err;
    }
  }

  async function startSession() {
    state.messages = [];
    state.sessionId++;
    el.messages.replaceChildren();
    el.textInput.value = "";
    el.liveTranscript.textContent = "";
    el.chatScenario.textContent = SCENARIO_LABELS[state.scenario];
    showError("");
    show(el.chat);
    setMode(state.mode);
    await openConversation();
  }

  // The coach speaks first. If that fails, offer a retry (the history must start with the coach).
  async function openConversation() {
    const err = await requestReply(null);
    if (err) showError(err.message, openConversation);
  }

  async function sendAnswer(text, via) {
    text = text.trim();
    if (!text || state.busy) return;
    state.messages.push({ role: "user", content: text, via });
    const node = addMessageEl("user", text, via);
    updateTurns();
    const err = await requestReply(node);
    if (err) {
      // Roll back so the history stays valid, and give the answer back for a retry.
      state.messages.pop();
      node.remove();
      updateTurns();
      el.textInput.value = text;
      if (state.mode === "voice") setMode("text");
      showError(`${err.message} Your answer is in the text box, press send to retry.`);
      autoGrow();
    }
  }

  el.startBtn.addEventListener("click", () => {
    SpeechIO.prime(); // unlock audio on iOS while we still have a user gesture
    startSession();
  });

  /* ---------------- Text mode ---------------- */

  function autoGrow() {
    el.textInput.style.height = "auto";
    el.textInput.style.height = `${el.textInput.scrollHeight}px`;
  }
  el.textInput.addEventListener("input", autoGrow);
  el.textInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      el.textForm.requestSubmit();
    }
  });
  el.textForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = el.textInput.value;
    if (!text.trim() || state.busy) return;
    el.textInput.value = "";
    autoGrow();
    sendAnswer(text, "text");
  });

  /* ---------------- Voice mode ---------------- */

  const MIC_LABELS = {
    idle: ["Tap the mic and answer out loud", "Start speaking"],
    listening: ["Listening… tap again when you're done", "Stop and send"],
    processing: ["Coach is thinking…", "Processing"],
    speaking: ["Coach is speaking · tap to skip", "Stop speaking"],
  };

  function setMic(s) {
    state.micState = s;
    el.micBtn.dataset.state = s;
    el.micStatus.textContent = MIC_LABELS[s][0];
    el.micBtn.setAttribute("aria-label", MIC_LABELS[s][1]);
    el.micBtn.disabled = s === "processing";
  }

  function renderLive(finalText, interim) {
    el.liveTranscript.replaceChildren();
    el.liveTranscript.append(finalText ? finalText + " " : "");
    if (interim) {
      const span = document.createElement("span");
      span.className = "interim";
      span.textContent = interim;
      el.liveTranscript.append(span);
    }
  }

  const VOICE_ERRORS = {
    permission: window.top !== window
      ? "The mic can't work inside this preview window. Download the file and open it in Chrome or Edge to speak."
      : "Microphone access was blocked. Click the icon left of the address bar, allow Microphone, then try again.",
    "no-mic": "No microphone was found. Plug one in, or use Text mode.",
    network: "Speech recognition needs an internet connection. Check it, or use Text mode.",
    other: "Voice input stopped unexpectedly. Try again, or use Text mode.",
    unsupported: "This browser doesn't support voice input. Switched to Text mode.",
  };

  el.micBtn.addEventListener("click", () => {
    if (state.micState === "speaking") {
      SpeechIO.stopSpeaking();
      setMic("idle");
      return;
    }
    if (state.micState === "listening") {
      SpeechIO.stop();
      return;
    }
    if (state.micState !== "idle" || state.busy) return;

    showError("");
    renderLive("", "");
    setMic("listening");
    SpeechIO.listen({
      lang: el.accent.value,
      onText: renderLive,
      onDone: (text) => {
        if (!text) {
          setMic("idle");
          el.micStatus.textContent = "I didn't catch that. Tap the mic and try again.";
          return;
        }
        el.liveTranscript.textContent = "";
        sendAnswer(text, "voice");
      },
      onError: (kind) => {
        setMic("idle");
        showError(VOICE_ERRORS[kind] || VOICE_ERRORS.other);
        if (kind === "permission" || kind === "no-mic" || kind === "unsupported") setMode("text");
      },
    });
  });

  /* ---------------- Scoring ---------------- */

  const GRADES = [
    [85, "Excellent communicator"],
    [70, "Strong performance"],
    [55, "Good progress"],
    [40, "Keep practising"],
    [0, "Let's build it up"],
  ];

  function renderList(ul, items) {
    ul.replaceChildren(...items.map((t) => Object.assign(document.createElement("li"), { textContent: t })));
  }

  function renderScore(r) {
    $("score-scenario").textContent = `${SCENARIO_LABELS[state.scenario]} · session score`;
    $("score-grade").textContent = GRADES.find(([min]) => r.score >= min)[1];
    $("score-summary").textContent = r.summary;
    renderList($("strengths"), r.strengths);
    renderList($("improvements"), r.improvements);

    $("better-sentences").replaceChildren(
      ...r.betterSentences.map((s) => {
        const item = Object.assign(document.createElement("div"), { className: "better-item" });
        item.append(
          Object.assign(document.createElement("div"), { className: "said", textContent: s.original }),
          Object.assign(document.createElement("div"), { className: "try", textContent: s.better })
        );
        return item;
      })
    );

    const ring = $("score-ring");
    const color = r.score >= 70 ? "var(--good)" : r.score >= 45 ? "var(--amber)" : "var(--warn)";
    ring.style.setProperty("--ring-color", color);

    for (const bar of document.querySelectorAll(".bar")) {
      const v = r.breakdown[bar.dataset.key];
      bar.querySelector("b").textContent = `${v}/25`;
      bar.querySelector("i").style.width = "0%";
    }

    $("score-loading").hidden = true;
    $("score-card").hidden = false;

    // Animate the ring count-up and bars.
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    requestAnimationFrame(() => {
      for (const bar of document.querySelectorAll(".bar")) {
        bar.querySelector("i").style.width = `${(r.breakdown[bar.dataset.key] / 25) * 100}%`;
      }
    });
    const start = performance.now();
    const dur = reduce ? 0 : 900;
    (function tick(now) {
      const t = dur ? Math.min(1, (now - start) / dur) : 1;
      const v = Math.round(r.score * (1 - Math.pow(1 - t, 3)));
      $("score-value").textContent = v;
      ring.style.setProperty("--p", v);
      if (t < 1) requestAnimationFrame(tick);
    })(start);
  }

  async function getScore() {
    show(el.score);
    $("score-loading").hidden = false;
    $("score-card").hidden = true;
    $("score-error").hidden = true;
    try {
      renderScore(await api("score", 30000));
    } catch (err) {
      $("score-loading").hidden = true;
      $("score-error-text").textContent = err.message;
      $("score-error").hidden = false;
    }
  }

  el.endBtn.addEventListener("click", () => {
    SpeechIO.abort();
    SpeechIO.stopSpeaking();
    setMic("idle");
    getScore();
  });
  $("retry-score-btn").addEventListener("click", getScore);
  $("back-chat-btn").addEventListener("click", () => show(el.chat));
  $("again-btn").addEventListener("click", () => {
    state.sessionId++;
    state.messages = [];
    show(el.setup);
  });

  setMic("idle");
})();

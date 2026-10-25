// Exposes window.SpeechIO. No external services are used.
(function () {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const synth = window.speechSynthesis;

  const SILENCE_MS = 2200; // stop listening this long after the student stops talking
  const NOTHING_HEARD_MS = 9000; // give up if nothing is heard at all

  let recognition = null;
  let silenceTimer = null;
  let voices = [];

  function loadVoices() {
    voices = synth ? synth.getVoices() : [];
  }
  if (synth) {
    loadVoices();
    synth.addEventListener?.("voiceschanged", loadVoices);
  }

  function pickVoice(lang) {
    if (!voices.length) loadVoices();
    const english = voices.filter((v) => v.lang && v.lang.toLowerCase().startsWith("en"));
    const score = (v) => {
      let s = 0;
      if (v.lang.replace("_", "-").toLowerCase() === lang.toLowerCase()) s += 4;
      if (/natural|neural|google|premium|enhanced/i.test(v.name)) s += 3;
      if (/samantha|daniel|karen|aria|jenny|guy|rishi|veena/i.test(v.name)) s += 1;
      if (v.localService) s += 1;
      return s;
    };
    return english.sort((a, b) => score(b) - score(a))[0] || null;
  }

  const SpeechIO = {
    // Inside a preview iframe (e.g. a claude.ai artifact) the browser blocks the mic, so voice is off there.
    inFrame: window.top !== window,
    canListen: Boolean(Recognition) && window.top === window,
    canSpeak: Boolean(synth && window.SpeechSynthesisUtterance),
    isListening: false,

    /**
     * Start listening. Callbacks:
     *  onText(finalText, interimText)  live transcript updates
     *  onDone(text)                    finished; text may be ""
     *  onError(kind)                   "permission" | "no-mic" | "network" | "other"
     */
    listen({ lang = "en-IN", onText, onDone, onError }) {
      if (!Recognition) return onError?.("unsupported");
      SpeechIO.stopSpeaking();
      SpeechIO.abort();

      const rec = new Recognition();
      recognition = rec;
      rec.lang = lang;
      rec.continuous = true;
      rec.interimResults = true;
      rec.maxAlternatives = 1;

      let finalText = "";
      let interimText = "";
      let failed = false;

      const armTimer = (ms) => {
        clearTimeout(silenceTimer);
        silenceTimer = setTimeout(() => rec.stop(), ms);
      };

      rec.onstart = () => {
        SpeechIO.isListening = true;
        armTimer(NOTHING_HEARD_MS);
      };
      rec.onresult = (e) => {
        interimText = "";
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          if (r.isFinal) finalText += r[0].transcript + " ";
          else interimText += r[0].transcript;
        }
        onText?.(finalText.trim(), interimText.trim());
        armTimer(SILENCE_MS);
      };
      rec.onerror = (e) => {
        if (e.error === "aborted" || e.error === "no-speech") return;
        failed = true;
        const kind =
          e.error === "not-allowed" || e.error === "service-not-allowed" ? "permission"
          : e.error === "audio-capture" ? "no-mic"
          : e.error === "network" ? "network"
          : "other";
        onError?.(kind);
      };
      rec.onend = () => {
        clearTimeout(silenceTimer);
        SpeechIO.isListening = false;
        if (recognition === rec) recognition = null;
        if (failed) return;
        // Some browsers leave the last phrase as "interim" when stopped; keep it.
        onDone?.(`${finalText} ${interimText}`.replace(/\s+/g, " ").trim());
      };

      try {
        rec.start();
      } catch {
        onError?.("other");
      }
    },

    /** Stop listening and submit what was heard. */
    stop() {
      if (recognition) recognition.stop();
    },

    /** Stop listening and throw away the result. */
    abort() {
      clearTimeout(silenceTimer);
      if (recognition) {
        const rec = recognition;
        recognition = null;
        rec.onend = () => { SpeechIO.isListening = false; };
        rec.onerror = null;
        try { rec.abort(); } catch {}
      }
    },

    /** Speak text out loud. Resolves when finished (or stopped). */
    speak(text, { lang = "en-IN", rate = 1 } = {}) {
      return new Promise((resolve) => {
        if (!SpeechIO.canSpeak || !text) return resolve();
        synth.cancel();
        const u = new SpeechSynthesisUtterance(text);
        const voice = pickVoice(lang);
        if (voice) u.voice = voice;
        u.lang = voice?.lang || lang;
        u.rate = rate;

        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(safety);
          resolve();
        };
        // Some browsers occasionally never fire "end"; don't let the UI get stuck.
        const words = text.split(/\s+/).length;
        const safety = setTimeout(finish, (words / 2.2) * 1000 + 4000);
        u.onend = finish;
        u.onerror = finish;
        synth.speak(u);
      });
    },

    stopSpeaking() {
      if (synth) synth.cancel();
    },

    /** iOS only allows speech after a user gesture: call this from a click handler. */
    prime() {
      if (!SpeechIO.canSpeak) return;
      const u = new SpeechSynthesisUtterance(" ");
      u.volume = 0;
      synth.speak(u);
    },
  };

  window.SpeechIO = SpeechIO;
})();

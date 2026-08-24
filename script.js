// ============================================================================
// CONFIGURATIE VOOR HÉLÈNE AI
// Dynamisch geladen vanuit /api/settings (beheerd via /beheer)
// ============================================================================
let CONFIG = {
  MODEL_NAME: "gemini-2.5-flash",
  VOICE_NAME: "Kore",
  SYSTEM_INSTRUCTION: `Je bent Hélène, de digitale gids van een scoutingkamp.`,
  IDLE_TIMEOUT_MS: 45000,
  MAX_SESSION_DURATION_MS: 300000,
  INPUT_SAMPLE_RATE: 16000,
  OUTPUT_SAMPLE_RATE: 24000,
  SHOW_SUBTITLES: true,
  ACCENT_COLOR: "#38bdf8",
  SLEEP_MODE: false,
  SPOOKY_VOICE_MODE: false,
  SPOOKY_VOICE_PERCENTAGE: 25,
  RECONNECT_BASE_DELAY_MS: 1000,
  RECONNECT_MAX_DELAY_MS: 16000,
};

// ============================================================================
// GLOBALE APPLICATIE-STATEN & ELEMENTEN
// ============================================================================
let ws = null;
let isSessionActive = false;
let isRecording = false;
let isThinking = false;
let isHeleneSpeaking = false;
let isConnecting = false;
let isOffline = true; // Standaard starten we offline totdat WebSocket verbinding heeft

// Audio contexten, streams & analysers
let inputAudioCtx = null;
let outputAudioCtx = null;
let outputAnalyser = null;
let mediaStream = null;
let scriptProcessor = null;
let activeSources = [];
let nextStartTime = 0;

// Visualisatie variabelen (Canvas 2D & Ogen)
const canvas = document.getElementById("waveformCanvas");
const ctx = canvas ? canvas.getContext("2d") : null;

let animFrameId = null;
let wavePhase1 = 0;
let wavePhase2 = 0;
let wavePhase3 = 0;

// Soepele overgangsvariabelen (Lerp)
let currentLineWidth = 3;
let currentAlpha = 0.5;
let currentGlow = 6;
let currentAmplitudeFactor = 0.5;

// Target waarden voor lerp per staat (Rust, Luisteren, Nadenken, Spreken)
const STATE_PARAMS = {
  IDLE: { lineWidth: 3, alpha: 0.5, glow: 6, ampFactor: 0.5 },
  LISTENING: { lineWidth: 4, alpha: 0.8, glow: 12, ampFactor: 0.6 },
  THINKING: { lineWidth: 4, alpha: 0.7, glow: 12, ampFactor: 0.4 },
  SPEAKING: { lineWidth: 6, alpha: 1.0, glow: 24, ampFactor: 1.8 },
};

// Timeouts, Herverbinding & Statistieken
let idleTimer = null;
let maxSessionTimer = null;
let reconnectAttempts = 0;
let reconnectTimer = null;

let audioBytesSentTotal = 0;
let audioBytesReceivedTotal = 0;
let sessionStartTime = null;

// DOM Elementen
const statusDot = document.getElementById("statusDot");
const connectionLabel = document.getElementById("connectionLabel");
const statusText = document.getElementById("statusText");
const subtitlesEl = document.getElementById("subtitles");
const talkArea = document.getElementById("talkArea");
const errorBanner = document.getElementById("errorBanner");
const eyeWrappers = document.querySelectorAll(".eye-wrapper");

// ============================================================================
// HULPFUNCTIES VOOR INSTELLINGEN, STATUS & OGEN ANIMATIE
// ============================================================================
function log(msg) {
  const timestamp = new Date().toLocaleTimeString();
  console.log(`[Hélène ${timestamp}] ${msg}`);
}

let currentSettingsHash = "";

async function fetchDynamicSettings() {
  try {
    const res = await fetch("/api/settings");
    if (res.ok) {
      const settings = await res.json();
      const newEngine = settings.ttsEngine || "gemini";
      const newVoice = settings.voiceName || "Kore";
      const newModel = settings.modelName || "gemini-2.0-flash-exp";
      const newInstruction = settings.systemInstruction || "";

      const newHash = `${newEngine}|${newVoice}|${newModel}|${newInstruction}`;
      const settingsChanged = currentSettingsHash !== "" && currentSettingsHash !== newHash;
      currentSettingsHash = newHash;

      CONFIG.MODEL_NAME = newModel;
      CONFIG.VOICE_NAME = newVoice;
      CONFIG.SYSTEM_INSTRUCTION = newInstruction;
      CONFIG.IDLE_TIMEOUT_MS = settings.idleTimeoutMs || CONFIG.IDLE_TIMEOUT_MS;
      CONFIG.MAX_SESSION_DURATION_MS = settings.maxSessionDurationMs || CONFIG.MAX_SESSION_DURATION_MS;
      CONFIG.SHOW_SUBTITLES = settings.showSubtitles !== false;
      CONFIG.ACCENT_COLOR = settings.accentColor || "#38bdf8";
      CONFIG.SLEEP_MODE = settings.sleepMode === true;
      CONFIG.SPOOKY_VOICE_MODE = settings.spookyVoiceMode === true;
      CONFIG.SPOOKY_VOICE_PERCENTAGE = typeof settings.spookyVoicePercentage === "number" ? settings.spookyVoicePercentage : 25;

      // CSS Variabele bijwerken voor de Franse Lelies ogen & accentkleur
      document.documentElement.style.setProperty("--accent-color", CONFIG.ACCENT_COLOR);

      updateSleepState();

      if (settingsChanged && ws && ws.readyState === WebSocket.OPEN) {
        log("Instellingen gewijzigd in beheer, Gemini Live sessie herstarten...");
        startGeminiSession(false);
      }
    }
  } catch (err) {
    console.warn("Kon dynamische instellingen niet ophalen, standaard gebruikt:", err);
  }
}

function setConnectionState(state, labelText) {
  if (statusDot) {
    statusDot.className = state;
  }
  if (connectionLabel && labelText) {
    connectionLabel.textContent = labelText;
  }
}

function setStatusText(text, isListening = false) {
  if (statusText) {
    statusText.textContent = text;
    if (isListening) {
      statusText.style.color = CONFIG.ACCENT_COLOR;
    } else {
      statusText.style.color = "#f8fafc";
    }
  }
}

function showError(msg) {
  // Geen technische meldingen op het scherm tonen op verzoek
  console.warn("[SCHERMMELDING ONDERDRUKT]", msg);
}

function hideError() {
  // Geen-op
}

const scoutEyesContainer = document.getElementById("scoutEyesContainer");

// Bepaal of Hélène slaapt (Echt alleen als er geen internet is OF handmatige slaapstand in beheer)
function updateSleepState() {
  const shouldSleep = isOffline || CONFIG.SLEEP_MODE === true;
  const zzzContainer = document.getElementById("zzzContainer");
  const bottomSection = document.getElementById("bottomSection");

  if (shouldSleep) {
    if (scoutEyesContainer) scoutEyesContainer.classList.remove("listening");
    eyeWrappers.forEach((eye) => {
      eye.classList.remove("listening", "speaking", "blink");
      eye.classList.add("sleeping");
    });
    if (zzzContainer) zzzContainer.classList.add("active");
    if (bottomSection) bottomSection.classList.add("sleeping");
  } else {
    if (zzzContainer) zzzContainer.classList.remove("active");
    if (bottomSection) bottomSection.classList.remove("sleeping");

    if (isRecording) {
      if (scoutEyesContainer) scoutEyesContainer.classList.add("listening");
      eyeWrappers.forEach((eye) => {
        eye.classList.remove("speaking", "blink", "sleeping");
        eye.classList.add("listening");
      });
    } else if (isHeleneSpeaking || activeSources.length > 0) {
      if (scoutEyesContainer) scoutEyesContainer.classList.remove("listening");
      eyeWrappers.forEach((eye) => {
        eye.classList.remove("listening", "blink", "sleeping");
        eye.classList.add("speaking");
      });
    } else {
      if (scoutEyesContainer) scoutEyesContainer.classList.remove("listening");
      eyeWrappers.forEach((eye) => {
        eye.classList.remove("listening", "speaking", "sleeping", "blink");
      });
    }
  }
}

// Ogen (Franse Lelies) sturen op basis van de staat
function updateEyeState(state) {
  const shouldSleep = isOffline || CONFIG.SLEEP_MODE === true;
  if (shouldSleep) {
    updateSleepState();
    return;
  }

  const zzzContainer = document.getElementById("zzzContainer");
  const bottomSection = document.getElementById("bottomSection");
  if (zzzContainer) zzzContainer.classList.remove("active");
  if (bottomSection) bottomSection.classList.remove("sleeping");

  setEyesState(state);
}

function setEyesState(state) {
  const container = document.getElementById("scoutEyesContainer");
  const thinkingSpinner = document.getElementById("thinkingSpinner");

  if (thinkingSpinner) {
    if (state === "THINKING") {
      thinkingSpinner.classList.add("active");
    } else {
      thinkingSpinner.classList.remove("active");
    }
  }

  if (!eyeWrappers || eyeWrappers.length === 0) return;

  container?.classList.remove("listening", "thinking", "happy", "puzzled", "speaking", "sleeping", "surprised", "sad", "curious", "spooky");
  eyeWrappers.forEach((eye) => {
    eye.classList.remove("listening", "thinking", "happy", "puzzled", "speaking", "sleeping", "blink", "surprised", "sad", "curious", "spooky");

    if (isCurrentTurnSpooky || state === "SPOOKY") {
      container?.classList.add("spooky");
      eye.classList.add("spooky", "speaking");
    } else if (state === "SLEEPING") {
      eye.classList.add("sleeping");
    } else if (state === "LISTENING") {
      container?.classList.add("listening");
      eye.classList.add("listening");
    } else if (state === "THINKING") {
      container?.classList.add("thinking");
      eye.classList.add("thinking");
    } else if (state === "HAPPY" || state === "SPEAKING") {
      container?.classList.add("happy");
      eye.classList.add("happy", "speaking");
    } else if (state === "SURPRISED") {
      container?.classList.add("surprised");
      eye.classList.add("surprised", "speaking");
    } else if (state === "SAD") {
      container?.classList.add("sad");
      eye.classList.add("sad");
    } else if (state === "CURIOUS") {
      container?.classList.add("curious");
      eye.classList.add("curious");
    } else if (state === "PUZZLED") {
      container?.classList.add("puzzled");
      eye.classList.add("puzzled");
    }
  });
}

// ============================================================================
// AUTOMATISCHE GEZICHTSUITDRUKKINGEN op basis van wat Hélène zegt
// ============================================================================
let heleneTurnText = "";
let turnExpression = "HAPPY";
let gestureFiredThisTurn = false;
let isCurrentTurnSpooky = false;

function resetTurnExpression() {
  heleneTurnText = "";
  turnExpression = "HAPPY";
  gestureFiredThisTurn = false;

  if (CONFIG.SPOOKY_VOICE_MODE === true) {
    const pct = typeof CONFIG.SPOOKY_VOICE_PERCENTAGE === "number" ? CONFIG.SPOOKY_VOICE_PERCENTAGE : 25;
    isCurrentTurnSpooky = Math.random() * 100 < pct;
  } else {
    isCurrentTurnSpooky = false;
  }
}

// Bepaal een blijvende uitdrukking + eventueel een kort gebaar uit de tekst
function classifyReply(text) {
  const t = (text || "").toLowerCase();
  let gesture = null;
  let expr = "HAPPY";

  if (/\b(nee|niet|geen|nooit|mag niet)\b/.test(t)) gesture = "SHAKE";
  else if (/\b(ja|jazeker|klopt|inderdaad|precies|zeker|natuurlijk)\b/.test(t)) gesture = "NOD";

  if (t.includes("weet ik niet") || t.includes("weet ik even niet") || /\b(sorry|jammer|helaas)\b/.test(t)) {
    expr = "SAD";
  } else if (t.includes("?")) {
    expr = "CURIOUS";
  } else if (t.includes("!") || /\b(wauw|wow|geweldig|super|leuk|top|gaaf|jippie)\b/.test(t)) {
    expr = "SURPRISED";
  }

  if (!gesture && /\b(hoi|hallo|hey|welkom|dag)\b/.test(t)) gesture = "WINK";
  return { gesture, expr };
}

// Kort eenmalig gebaar (knipoog / knikken / schudden)
function fireGesture(g) {
  const c = document.getElementById("scoutEyesContainer");
  if (!c) return;
  if (g === "WINK") {
    if (!eyeWrappers || eyeWrappers.length === 0) return;
    const eye = eyeWrappers[Math.random() < 0.5 ? 0 : eyeWrappers.length - 1];
    eye.classList.add("wink");
    setTimeout(() => eye.classList.remove("wink"), 550);
  } else if (g === "NOD" || g === "SHAKE") {
    const cls = g === "NOD" ? "nod" : "shake";
    c.classList.remove(cls);
    void c.offsetWidth; // forceer herstart van de animatie
    c.classList.add(cls);
    setTimeout(() => c.classList.remove(cls), g === "NOD" ? 750 : 650);
  }
}

// Roep dit aan met de tot nu toe verzamelde tekst van Hélène
function applyReplyExpression(fullText) {
  const { gesture, expr } = classifyReply(fullText);
  turnExpression = expr;
  if (isHeleneSpeaking) setEyesState(expr);
  if (gesture && !gestureFiredThisTurn) {
    gestureFiredThisTurn = true;
    fireGesture(gesture);
  }
}

// Periodiek knipperen alleen als ze niet slaapt
function startEyeBlinkLoop() {
  function scheduleNextBlink() {
    const delay = Math.random() * 4000 + 3000;
    setTimeout(() => {
      if (isHeleneSpeaking) {
        eyeWrappers.forEach((eye) => eye.classList.add("blink"));
        setTimeout(() => {
          eyeWrappers.forEach((eye) => eye.classList.remove("blink"));
        }, 180);
      }
      scheduleNextBlink();
    }, delay);
  }
  scheduleNextBlink();
}

// ============================================================================
// WEBSOCKET & GEMINI LIVE SESSIE BEHEER
// ============================================================================
function connectWebSocket(autoStartRecordAfterConnect = false) {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  isConnecting = true;
  setConnectionState("connecting", "Verbinden...");
  hideError();

  const isMaster = window.location.pathname.includes("hoofdscherm");
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${protocol}//${location.host}/ws/live?isMaster=${isMaster ? "true" : "false"}`;
  log(`Verbinden met WebSocket server op ${wsUrl} (Master: ${isMaster})...`);

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    log("WebSocket verbinding succesvol tot stand gebracht.");
    reconnectAttempts = 0;
    isConnecting = false;
    isOffline = false;
    updateSleepState();
    setConnectionState("online", isMaster ? "Hoofdscherm Verbonden" : "Verbonden (Neven-scherm)");
    hideError();

    // Start de Gemini Live sessie
    startGeminiSession(autoStartRecordAfterConnect);
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);

      if (msg.type === "session_started") {
        log("Gemini Live API sessie geactiveerd.");
        isSessionActive = true;
        sessionStartTime = Date.now();
        resetIdleTimer();
      } else if (msg.type === "master_locked") {
        log(`🔒 Hoofdscherm Lock: ${msg.message}`);
        setConnectionState("online", "Neven-scherm (Hoofdscherm reeds actief)");
        if (subtitlesEl) {
          subtitlesEl.textContent = "🔒 Er is al een actief Hoofdscherm op een ander apparaat. Dit scherm werkt als neven-scherm.";
          subtitlesEl.style.display = CONFIG.SHOW_SUBTITLES ? "block" : "none";
        }
      } else if (msg.type === "master_granted") {
        log("📺 Dit scherm is geactiveerd als het Hoofdscherm.");
        setConnectionState("online", "📺 Hoofdscherm Actief");
      } else if (msg.type === "interrupted_by_master") {
        log("⚡ Beurt onderbroken: Het Hoofdscherm heeft voorrang gekregen.");
        stopRecording();
        stopAudioPlayback();
        isHeleneSpeaking = false;
        isThinking = false;
        setStatusText("Hoofdscherm heeft voorrang gekregen");
        if (subtitlesEl) {
          subtitlesEl.textContent = "⚡ Het Hoofdscherm heeft voorrang gekregen.";
          subtitlesEl.style.display = CONFIG.SHOW_SUBTITLES ? "block" : "none";
        }
      } else if (msg.type === "busy") {
        log(`⚠️ Server is bezet: ${msg.message}`);
        stopRecording();
        stopAudioPlayback();
        isThinking = false;
        setStatusText(msg.message || "Hélène is momenteel in gesprek...");
        if (subtitlesEl) {
          subtitlesEl.textContent = msg.message || "Hélène is momenteel in gesprek...";
          subtitlesEl.style.display = CONFIG.SHOW_SUBTITLES ? "block" : "none";
        }
      } else if (msg.type === "kicked_by_admin") {
        log("✂️ Verbreekt door beheerder.");
        stopRecording();
        stopAudioPlayback();
        isThinking = false;
        if (ws) { try { ws.close(); } catch (e) {} ws = null; }
        setConnectionState("offline", "Losgekoppeld door beheer");
        if (subtitlesEl) {
          subtitlesEl.textContent = "✂️ Verbinding verbroken door de beheerder.";
          subtitlesEl.style.display = CONFIG.SHOW_SUBTITLES ? "block" : "none";
        }
      } else if (msg.type === "audio") {
        // Audio van Hélène ontvangen
        if (isRecording || userWantsRecording) {
          log("Inkomende audio genegeerd omdat de gebruiker aan het opnemen is.");
          return;
        }
        if (typeof msg.isSpooky === "boolean") {
          isCurrentTurnSpooky = msg.isSpooky;
        }
        isThinking = false;
        isHeleneSpeaking = true;
        audioBytesReceivedTotal += Math.round((msg.data.length * 3) / 4);
        playAudioChunk(msg.data);
        resetIdleTimer();
      } else if (msg.type === "pause") {
        const pauseSec = (msg.durationMs || 1000) / 1000;
        if (outputAudioCtx) {
          const currentTime = outputAudioCtx.currentTime;
          if (nextStartTime < currentTime) {
            nextStartTime = currentTime;
          }
          nextStartTime += pauseSec;
        }
      } else if (msg.type === "user_transcription") {
        console.log(`%c🎤 [VERSTAAN DOOR HÉLÈNE]: "${msg.text}"`, "color: #38bdf8; font-weight: bold; font-size: 14px; background: rgba(56,189,248,0.1); padding: 4px 8px; border-radius: 4px;");
        log(`Gebruiker ingesproken tekst: "${msg.text}"`);
        if (subtitlesEl) {
          subtitlesEl.textContent = `Jij: "${msg.text}"`;
          subtitlesEl.style.display = CONFIG.SHOW_SUBTITLES ? "block" : "none";
        }
      } else if (msg.type === "subtitle") {
        isThinking = false;
        if (subtitlesEl) {
          subtitlesEl.textContent = `Hélène: "${msg.text}"`;
          subtitlesEl.style.display = CONFIG.SHOW_SUBTITLES ? "block" : "none";
        }
        // Verzamel de tekst en kies automatisch een passende gezichtsuitdrukking
        heleneTurnText += " " + (msg.text || "");
        applyReplyExpression(heleneTurnText);
      } else if (msg.type === "interrupted") {
        log("Hélène onderbroken door gebruiker.");
        stopAudioPlayback();
        isHeleneSpeaking = false;
        isThinking = false;
        // Verse start voor de volgende uiting (o.a. mededelingen vanuit beheer)
        resetTurnExpression();
      } else if (msg.type === "turn_complete") {
        log("Hélène klaar met spreken.");
        isHeleneSpeaking = false;
        isThinking = false;
        setTimeout(() => {
          if (!isHeleneSpeaking && !isRecording && !isThinking) {
            setEyesState("NEUTRAL");
          }
        }, 1200);
      } else if (msg.type === "play_hacker_video") {
        const vid = document.getElementById("hackerVideoOverlay");
        if (vid) {
          vid.style.display = "block";
          vid.currentTime = 0;
          vid.play().catch((e) => console.error("Fout bij afspelen hacker video:", e));
        }
      } else if (msg.type === "stop_hacker_video") {
        const vid = document.getElementById("hackerVideoOverlay");
        if (vid) {
          vid.pause();
          vid.style.display = "none";
        }
      } else if (msg.type === "photo_scanned") {
        log(`📸 Foto scan ontvangen for ${msg.groupName}: ${msg.status}`);
        handlePhotoScanned(msg);
      } else if (msg.type === "error") {
        log(`FOUT van Gemini Live API: ${msg.message}`);
        isThinking = false;
        showError(msg.message);
      }
    } catch (err) {
      log(`Fout bij verwerken WebSocket bericht: ${err}`);
    }
  };

  ws.onerror = () => {
    log("WebSocket fout opgetreden.");
    isOffline = true;
    updateSleepState();
    setConnectionState("offline", "Geen verbinding");
  };

  ws.onclose = () => {
    log("WebSocket verbinding gesloten.");
    isSessionActive = false;
    ws = null;
    isConnecting = false;
    isOffline = true;
    updateSleepState();
    setConnectionState("offline", "Geen internet");

    logSessionAudioStats();
    clearTimeout(idleTimer);
    clearTimeout(maxSessionTimer);

    // Altijd herverbinden
    scheduleReconnect(isRecording);
  };
}

function scheduleReconnect(autoRecord = false) {
  clearTimeout(reconnectTimer);
  reconnectAttempts++;

  const delay = Math.min(
    CONFIG.RECONNECT_BASE_DELAY_MS * Math.pow(2, reconnectAttempts - 1),
    CONFIG.RECONNECT_MAX_DELAY_MS
  );

  log(`Herverbinden (${reconnectAttempts}) over ${Math.round(delay / 1000)}s...`);
  setConnectionState("connecting", `Herverbinden (${Math.round(delay / 1000)}s)...`);
  showError("Internetverbinding verbroken. Hélène herverbindt automatisch...");

  reconnectTimer = setTimeout(() => {
    connectWebSocket(autoRecord);
  }, delay);
}

function startGeminiSession(autoRecord = false) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(
      JSON.stringify({
        type: "start_session",
        model: CONFIG.MODEL_NAME,
        voiceName: CONFIG.VOICE_NAME,
        systemInstruction: CONFIG.SYSTEM_INSTRUCTION,
      })
    );

    clearTimeout(maxSessionTimer);
    maxSessionTimer = setTimeout(() => {
      log("Maximale sessieduur bereikt. Sessie gesloten.");
      closeSession();
    }, CONFIG.MAX_SESSION_DURATION_MS);

    if (autoRecord) {
      startRecording();
    }
  }
}

function closeSession() {
  log("Sessie sluiten...");
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "close_session" }));
    ws.close();
  }
  isSessionActive = false;
  stopRecording();
  stopAudioPlayback();
  setStatusText("Houd ingedrukt of druk spatie om te praten");
  if (subtitlesEl) subtitlesEl.textContent = "";
}

function resetIdleTimer() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    log("Inactiviteit timeout verstreken. Sessie gesloten.");
    closeSession();
  }, CONFIG.IDLE_TIMEOUT_MS);
}

function logSessionAudioStats() {
  if (sessionStartTime) {
    const durationSec = Math.round((Date.now() - sessionStartTime) / 1000);
    log(`--- SESSIE SAMENVATTING ---`);
    log(`Totale duur: ${durationSec}s`);
    sessionStartTime = null;
  }
}

// ============================================================================
// MICROFOON OPNAMELOGICA (PUSH-TO-TALK)
// ============================================================================
function ensureAudioUnlocked() {
  try {
    if (!outputAudioCtx) {
      outputAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (outputAudioCtx.state === "suspended") {
      outputAudioCtx.resume().catch(() => {});
    }
    if (!inputAudioCtx) {
      inputAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (inputAudioCtx.state === "suspended") {
      inputAudioCtx.resume().catch(() => {});
    }
    const silentBuf = outputAudioCtx.createBuffer(1, 1, 22050);
    const src = outputAudioCtx.createBufferSource();
    src.buffer = silentBuf;
    src.connect(outputAudioCtx.destination);
    src.start(0);
  } catch (e) {}
}

async function initMicrophoneStream() {
  if (mediaStream) return mediaStream;
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    log("Microfoon-stream succesvol geïnitialiseerd.");
    return mediaStream;
  } catch (err) {
    log(`FOUT bij microfoontoegang: ${err}`);
    return null;
  }
}

let userWantsRecording = false;

async function startRecording() {
  userWantsRecording = true;
  if (isRecording) return;

  hideError();
  ensureAudioUnlocked();

  // Indien Hélène al spreekt bij knopdruk: stop haar meteen!
  if (isHeleneSpeaking) {
    log("Hélène direct onderbroken.");
    stopAudioPlayback();
    isHeleneSpeaking = false;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "interrupt" }));
    }
  }

  // Zorg dat de WebSocket verbonden is
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    connectWebSocket(true);
  }

  resetIdleTimer();

  const stream = await initMicrophoneStream();
  if (!stream) {
    showError("Geef toestemming voor de microfoon om met Hélène te praten.");
    return;
  }

  // Controleer of de gebruiker de knop alweer heeft losgelaten tijdens het laden
  if (!userWantsRecording) {
    log("Opname geannuleerd: knop al losgelaten voor mic klaar was.");
    return;
  }

  if (!inputAudioCtx) {
    inputAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (inputAudioCtx.state === "suspended") {
    await inputAudioCtx.resume();
  }

  // ALTIJD een verse processor aanmaken bij elke opnamesessie
  if (scriptProcessor) {
    try { scriptProcessor.disconnect(); } catch (e) {}
    scriptProcessor = null;
  }

  const source = inputAudioCtx.createMediaStreamSource(stream);
  scriptProcessor = inputAudioCtx.createScriptProcessor(2048, 1, 1);

  scriptProcessor.onaudioprocess = (e) => {
    if (!isRecording) return;

    const rawFloat32 = e.inputBuffer.getChannelData(0);
    const actualSampleRate = inputAudioCtx ? inputAudioCtx.sampleRate : 16000;

    // Hoogwaardige Linear Interpolation Resampling naar exact 16000Hz PCM
    let samples = rawFloat32;
    if (actualSampleRate && actualSampleRate !== 16000) {
      const ratio = actualSampleRate / 16000;
      const newLength = Math.floor(rawFloat32.length / ratio);
      samples = new Float32Array(newLength);
      for (let i = 0; i < newLength; i++) {
        const origIndex = i * ratio;
        const index1 = Math.floor(origIndex);
        const index2 = Math.min(index1 + 1, rawFloat32.length - 1);
        const frac = origIndex - index1;
        samples[i] = rawFloat32[index1] * (1 - frac) + rawFloat32[index2] * frac;
      }
    }

    const int16Array = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }

    const bytes = new Uint8Array(int16Array.buffer, int16Array.byteOffset, int16Array.byteLength);
    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    const base64Audio = btoa(binary);

    audioBytesSentTotal += bytes.byteLength;

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: "audio_input",
          audio: base64Audio,
        })
      );
    }
  };

  const zeroGain = inputAudioCtx.createGain();
  zeroGain.gain.value = 0;
  source.connect(scriptProcessor);
  scriptProcessor.connect(zeroGain);
  zeroGain.connect(inputAudioCtx.destination);

  isRecording = true;
  setEyesState("LISTENING");
  setStatusText("Ik luister... (Laat los als je klaar bent)", true);
  if (talkArea) talkArea.classList.add("active");
}

function stopRecording() {
  userWantsRecording = false;
  if (!isRecording) return;
  isRecording = false;
  isThinking = true;

  if (talkArea) talkArea.classList.remove("active");

  // Nieuwe Hélène-beurt begint: reset de uitdrukkings-analyse
  resetTurnExpression();
  setEyesState("THINKING");

  if (scriptProcessor) {
    try { scriptProcessor.disconnect(); } catch (e) {}
    scriptProcessor = null;
  }

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "end_turn" }));
  }

  setStatusText("Hélène denkt na...");
  resetIdleTimer();
}

// ============================================================================
// AUDIO AFSPELEN (GEMINI AUDIO OUTPUT 24kHz)
// ============================================================================
async function playAudioChunk(base64Data) {
  if (isRecording || userWantsRecording) {
    return;
  }
  isThinking = false;
  ensureAudioUnlocked();

  if (!outputAnalyser) {
    outputAnalyser = outputAudioCtx.createAnalyser();
    outputAnalyser.fftSize = 512;
    outputAnalyser.smoothingTimeConstant = 0.8;
    outputAnalyser.connect(outputAudioCtx.destination);
  }

  try {
    const binaryString = atob(base64Data);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    let buffer = null;
    try {
      // Decodeer gecomprimeerde audio (MP3 van Google Translate TTS)
      const audioDataCopy = bytes.buffer.slice(0);
      buffer = await outputAudioCtx.decodeAudioData(audioDataCopy);
    } catch (e) {
      // Fallback voor raw 16-bit PCM audio (Gemini Live & ElevenLabs PCM)
      const evenLen = bytes.length - (bytes.length % 2);
      const bufferCopy = new ArrayBuffer(evenLen);
      new Uint8Array(bufferCopy).set(bytes.subarray(0, evenLen));
      const int16Array = new Int16Array(bufferCopy);
      const float32Array = new Float32Array(int16Array.length);
      for (let i = 0; i < int16Array.length; i++) {
        float32Array[i] = int16Array[i] / 32768.0;
      }
      buffer = outputAudioCtx.createBuffer(1, float32Array.length, CONFIG.OUTPUT_SAMPLE_RATE);
      buffer.getChannelData(0).set(float32Array);
    }

    if (!buffer) return;

    const source = outputAudioCtx.createBufferSource();
    source.buffer = buffer;

    let subSource = null;

    if (isCurrentTurnSpooky) {
      // 1. Haarscherpe, helder verstaanbare hoofdstem
      source.playbackRate.value = 0.94;

      // 2. Subtiele achtergrond schaduwstem (niet overheersend)
      subSource = outputAudioCtx.createBufferSource();
      subSource.buffer = buffer;
      subSource.playbackRate.value = 0.78;

      const subGain = outputAudioCtx.createGain();
      subGain.gain.value = 0.12; // Zeer licht volume zodat de stem 100% helder blijft

      const biquad = outputAudioCtx.createBiquadFilter();
      biquad.type = "lowshelf";
      biquad.frequency.value = 250;
      biquad.gain.value = 5;

      subSource.connect(biquad);
      biquad.connect(subGain);

      // 3. Zeer subtiele, korte ruimtelijke echo (geen wazige galm, 100% verstaanbaar)
      const delay = outputAudioCtx.createDelay();
      delay.delayTime.value = 0.12; // Korte 120ms subtiele ruimtelijke pauze

      const echoFeedback = outputAudioCtx.createGain();
      echoFeedback.gain.value = 0.15; // Meteen uitdovend

      const echoGain = outputAudioCtx.createGain();
      echoGain.gain.value = 0.12; // Zeer zacht achtergrondeffect

      delay.connect(echoFeedback);
      echoFeedback.connect(delay);
      delay.connect(echoGain);
      echoGain.connect(outputAnalyser);

      source.connect(delay);

      source.connect(outputAnalyser);
      subGain.connect(outputAnalyser);

      const eyeContainer = document.getElementById("scoutEyesContainer");
      if (eyeContainer) eyeContainer.classList.add("spooky");
    } else {
      source.connect(outputAnalyser);
      const eyeContainer = document.getElementById("scoutEyesContainer");
      if (eyeContainer) eyeContainer.classList.remove("spooky");
    }

    const currentTime = outputAudioCtx.currentTime;
    if (nextStartTime < currentTime) {
      nextStartTime = currentTime;
    }

    source.start(nextStartTime);
    if (subSource) subSource.start(nextStartTime);

    const chunkDuration = isCurrentTurnSpooky ? buffer.duration / 0.92 : buffer.duration;
    nextStartTime += chunkDuration;

    activeSources.push(source);
    if (subSource) activeSources.push(subSource);

    isHeleneSpeaking = true;
    setEyesState(isCurrentTurnSpooky ? "SPOOKY" : (turnExpression || "HAPPY"));

    source.onended = () => {
      const idx = activeSources.indexOf(source);
      if (idx > -1) activeSources.splice(idx, 1);
      if (subSource) {
        const subIdx = activeSources.indexOf(subSource);
        if (subIdx > -1) activeSources.splice(subIdx, 1);
      }
      if (activeSources.length === 0) {
        isHeleneSpeaking = false;
        const eyeContainer = document.getElementById("scoutEyesContainer");
        if (eyeContainer) eyeContainer.classList.remove("spooky");
        if (!isRecording && !isThinking) {
          setStatusText("Luister naar Hélène...");
        }
      }
    };

    setStatusText(isCurrentTurnSpooky ? "Hélène spreekt (griezelig)..." : "Hélène spreekt...");
  } catch (err) {
    console.error("Fout bij afspelen audio chunk:", err);
  }
}

function stopAudioPlayback() {
  for (const src of activeSources) {
    try {
      src.stop();
    } catch (e) {}
  }
  activeSources = [];
  nextStartTime = 0;
}

// ============================================================================
// GOLFVORM VISUALISATIE (KAREN PLANKTON VIBRATIE + OGEN ANIMATIE)
// ============================================================================
function initWaveformVisualizer() {
  if (!canvas || !ctx) return;

  function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }

  window.addEventListener("resize", resizeCanvas);
  resizeCanvas();

  const freqDataOutput = new Uint8Array(256);
  const timeDataOutput = new Uint8Array(256);
  let smoothedVolume = 0;

  function render() {
    animFrameId = requestAnimationFrame(render);

    const width = canvas.width;
    const height = canvas.height;
    // Mondpositie onder de ogen (op 58% van de schermhoogte)
    const centerY = height * 0.58;

    // 1. Bepaal huidige staat
    let targetStateKey = "IDLE";
    if (isRecording) {
      targetStateKey = "LISTENING";
    } else if (isThinking) {
      targetStateKey = "THINKING";
    } else if (isHeleneSpeaking || activeSources.length > 0) {
      targetStateKey = "SPEAKING";
    }

    // Ogen bijwerken naar staat. Tijdens het spreken gebruiken we de
    // automatisch gekozen gezichtsuitdrukking (blij/verbaasd/meelevend/nieuwsgierig)
    // in plaats van altijd hetzelfde "spreken".
    let eyeState = targetStateKey;
    if (targetStateKey === "SPEAKING") {
      eyeState = turnExpression || "SPEAKING";
    }
    updateEyeState(eyeState, smoothedVolume);

    const targetParams = STATE_PARAMS[targetStateKey];

    // 2. Vloeiende overgang van visuele parameters
    const lerpSpeed = 0.08;
    currentLineWidth += (targetParams.lineWidth - currentLineWidth) * lerpSpeed;
    currentAlpha += (targetParams.alpha - currentAlpha) * lerpSpeed;
    currentGlow += (targetParams.glow - currentGlow) * lerpSpeed;
    currentAmplitudeFactor += (targetParams.ampFactor - currentAmplitudeFactor) * lerpSpeed;

    // 3. Alleen reageren op Hélène's spraak (GEEN reactie op microfoon!)
    let rawVolume = 0;

    if (targetStateKey === "SPEAKING" && outputAnalyser) {
      outputAnalyser.getByteFrequencyData(freqDataOutput);
      outputAnalyser.getByteTimeDomainData(timeDataOutput);
      let sum = 0;
      for (let i = 0; i < 64; i++) {
        sum += freqDataOutput[i];
      }
      rawVolume = sum / (64 * 255);
    }

    smoothedVolume += (rawVolume - smoothedVolume) * 0.15;

    // Phase beweging voor vloeiende mondgolven
    const speedMultiplier = 1 + smoothedVolume * 3;
    wavePhase1 += 0.025 * speedMultiplier;
    wavePhase2 += 0.04 * speedMultiplier;
    wavePhase3 += 0.018 * speedMultiplier;

    // 4. Canvas wissen
    ctx.clearRect(0, 0, width, height);

    ctx.save();
    ctx.lineWidth = currentLineWidth;
    ctx.strokeStyle = CONFIG.ACCENT_COLOR;
    ctx.globalAlpha = currentAlpha;

    if (currentGlow > 0) {
      ctx.shadowBlur = currentGlow;
      ctx.shadowColor = CONFIG.ACCENT_COLOR;
    } else {
      ctx.shadowBlur = 0;
    }

    // 5. Punten genereren over de volle breedte
    const pointsCount = 140;
    const step = width / (pointsCount - 1);
    const points = [];

    // Fysieke begrenzers: Lijn mag NOOIT boven 35vh (ogen zitten op 15-28vh)
    const minY = height * 0.35;
    const maxY = height * 0.82;

    for (let i = 0; i < pointsCount; i++) {
      const x = i * step;
      const normX = i / (pointsCount - 1);
      // Envelope voor natuurlijke lippen/glimlach vorm aan de randen
      const envelope = Math.sin(normX * Math.PI);

      let y = centerY;

      if (targetStateKey === "SPEAKING" && smoothedVolume > 0.005) {
        // Vloeiende mondbeweging bij praten (geen pieken boven de ogen)
        const maxAmp = height * 0.10; // Max 10% van het scherm hoogte (~70px)
        const dynamicAmp = Math.min(smoothedVolume * (height * 0.18), maxAmp) * currentAmplitudeFactor;

        const wave1 = Math.sin(normX * Math.PI * 3 + wavePhase1) * dynamicAmp;
        const wave2 = Math.sin(normX * Math.PI * 6 - wavePhase2) * (dynamicAmp * 0.35);

        y = centerY + (wave1 + wave2) * envelope;
      } else if (targetStateKey === "LISTENING") {
        // Luisteren: Lichte vriendelijke mondtrilling
        const listenAmp = 7 * currentAmplitudeFactor;
        const wave1 = Math.sin(normX * Math.PI * 2 + wavePhase1) * listenAmp;
        y = centerY + wave1 * envelope;
      } else {
        // Rust / Slaap: Subtiele ademende vriendelijke mondlijn
        const breath = Math.sin(wavePhase1 * 0.4) * 0.5 + 0.5;
        const idleWave = Math.sin(normX * Math.PI * 2 + wavePhase1) * (4 + 3 * breath);
        y = centerY + idleWave * envelope * currentAmplitudeFactor;
      }

      // Harde fysieke begrenzer voor absolute veiligheid
      if (y < minY) y = minY;
      if (y > maxY) y = maxY;

      points.push({ x, y });
    }

    // 6. Vloeiende curve tekenen
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);

    for (let i = 0; i < points.length - 1; i++) {
      const xc = (points[i].x + points[i + 1].x) / 2;
      const yc = (points[i].y + points[i + 1].y) / 2;
      ctx.quadraticCurveTo(points[i].x, points[i].y, xc, yc);
    }

    ctx.lineTo(points[points.length - 1].x, points[points.length - 1].y);
    ctx.stroke();
    ctx.restore();
  }

  render();
}

// ============================================================================
// EVENT LISTENERS & SPRAAK GEBRUIK
// ============================================================================
function setupEventListeners() {
  const vidOverlay = document.getElementById("hackerVideoOverlay");
  if (vidOverlay) {
    // Automatisch verbergen wanneer de video helemaal afgespeeld is
    vidOverlay.addEventListener("ended", () => {
      vidOverlay.pause();
      vidOverlay.style.display = "none";
    });
  }

  // Muis & Touch over het gehele scherm
  window.addEventListener("mousedown", (e) => {
    const target = e.target;
    if (target && (target.tagName === "BUTTON" || target.tagName === "A" || target.tagName === "INPUT" || target.tagName === "SELECT")) return;
    ensureAudioUnlocked();
    startRecording();
  });

  window.addEventListener("mouseup", () => {
    stopRecording();
  });

  window.addEventListener("touchstart", (e) => {
    const target = e.target;
    if (target && (target.tagName === "BUTTON" || target.tagName === "A" || target.tagName === "INPUT" || target.tagName === "SELECT")) return;
    ensureAudioUnlocked();
    startRecording();
  }, { passive: true });

  window.addEventListener("touchend", () => {
    stopRecording();
  });

  // Spatiebalk (Footswitch / Drukknop)
  let spacePressed = false;

  window.addEventListener("pointerdown", ensureAudioUnlocked, { passive: true });
  window.addEventListener("click", ensureAudioUnlocked, { passive: true });

  window.addEventListener("keydown", (e) => {
    ensureAudioUnlocked();
    if (e.code === "Space" && !spacePressed) {
      e.preventDefault();
      spacePressed = true;
      startRecording();
    }
  });

  window.addEventListener("keyup", (e) => {
    if (e.code === "Space") {
      spacePressed = false;
      stopRecording();
    }
  });

  // Cursor verbergen na 3s inactiviteit op TV
  let cursorTimer;
  window.addEventListener("mousemove", () => {
    document.body.style.cursor = "default";
    clearTimeout(cursorTimer);
    cursorTimer = setTimeout(() => {
      document.body.style.cursor = "none";
    }, 3000);
  });
}

// Opstarten van Hélène App
window.addEventListener("DOMContentLoaded", async () => {
  log("Hélène gestart.");

  await fetchDynamicSettings();
  setupEventListeners();
  initWaveformVisualizer();
  startEyeBlinkLoop();

  // Verbinding opzetten
  connectWebSocket();

  // Periodiek instellingen synchroniseren (voor bijv. handmatige slaapstand vanuit /beheer)
  setInterval(async () => {
    await fetchDynamicSettings();
  }, 4000);
});

// ============================================================================
// FULLSCREEN REALISTIC PHOTO SCANNER CONTROLLER
// ============================================================================

function handlePhotoScanned(msg) {
  const overlay = document.getElementById("photoScanOverlay");
  const scanImg = document.getElementById("scanImage");
  const scanBeam = document.getElementById("scanBeam");

  if (!overlay || !scanImg || !scanBeam) return;

  // Reset overlay state
  overlay.className = "";
  scanBeam.classList.remove("scanning");

  scanImg.src = msg.imageData;

  // 1. Toon de foto fullscreen op het scherm
  overlay.classList.add("active");

  // 2. Start de rustige lichtbalk scan sweep (duurt 3.8s)
  setTimeout(() => {
    scanBeam.classList.add("scanning");
  }, 200);

  // 3. Kleur de scanbalk groen of rood zodra de scan compleet is (na 3.8s)
  setTimeout(() => {
    scanBeam.classList.remove("scanning");

    if (msg.status === "approved") {
      overlay.classList.add("approved");
    } else {
      overlay.classList.add("rejected");
    }
  }, 3800);

  // 4. Houd de foto fullscreen in beeld gedurende het uitspreken (~10.5 seconden)
  setTimeout(() => {
    overlay.classList.remove("active");
    setTimeout(() => {
      overlay.className = "";
    }, 500);
  }, 10500);
}

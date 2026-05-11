const btn = document.getElementById("btn");
const btnlabel = document.getElementById("btn-label");
const welcome = document.getElementById("welcome");
const transcript = document.getElementById("transcript");
const card = document.getElementById("card");
const configBtn = document.getElementById("config-btn");
const quickLanguageSelect = document.getElementById("quick-language-select");
const quickVoiceSelect = document.getElementById("quick-voice-select");
const themeToggle = document.getElementById("theme-toggle");
const configModal = document.getElementById("config-modal");
const configClose = document.getElementById("config-close");
const configSave = document.getElementById("config-save");
const rememberToggle = document.getElementById("remember-toggle");
const clearDataBtn = document.getElementById("clear-data");
const toast = document.getElementById("toast");
const nameInput = document.getElementById("name-input");
const modeSelect = document.getElementById("mode-select");
const languageSelect = document.getElementById("language-select");
const voiceInput = document.getElementById("voice-input");
const goalInput = document.getElementById("goal-input");
const correctionsSelect = document.getElementById("corrections-select");
const apiKeyInput = document.getElementById("api-key-input");
const systemInstructionInput = document.getElementById("system-instruction-input");
let isRunning = false;

const _proto = window.location.protocol;
const _wsProto = _proto === "https:" ? "wss:" : "ws:";
const _host = window.location.host;
const API = `${_proto}//${_host}`;
const WS = `${_wsProto}//${_host}`;
let esrc = null;
let botmsg = null;
let uirsc = null;

const GEMINI_SAMPLE_RATE = 16000;
const GEMINI_OUT_RATE = 24000;
let audioContext = null;
let mediaStream = null;
let audioWorkletNode = null;
let audioWs = null;
let playbackCtx = null;
let nextPlayTime = 0;
let conversation = [];
let attempt = 0;
const maxAttempt = 3;
const RETRYABLE_WS_CLOSE_CODES = new Set([1006, 1008, 1011, 1012, 1013]);
const customSelects = new Map();

const STORAGE_API_KEY = "gemini_api_key";
const STORAGE_SYSTEM_INSTRUCTION = "gemini_system_instruction";
const STORAGE_NAME = "gemini_user_name";
const STORAGE_MODE = "gemini_mode";
const STORAGE_LANGUAGE = "gemini_language";
const STORAGE_VOICE = "gemini_voice";
const STORAGE_GOAL = "gemini_goal";
const STORAGE_CORRECTIONS = "gemini_corrections";
const STORAGE_REMEMBER = "gemini_remember";
const STORAGE_THEME = "gemini_theme";
const CONFIG_KEYS = [
    STORAGE_NAME,
    STORAGE_MODE,
    STORAGE_LANGUAGE,
    STORAGE_VOICE,
    STORAGE_GOAL,
    STORAGE_CORRECTIONS,
    STORAGE_API_KEY,
    STORAGE_SYSTEM_INSTRUCTION
];

function isRememberEnabled() {
    return (localStorage.getItem(STORAGE_REMEMBER) || "true") === "true";
}

function getConfigStorage() {
    return isRememberEnabled() ? localStorage : sessionStorage;
}

function showToast(message) {
    if (!toast) {
        return;
    }
    toast.textContent = message;
    toast.classList.remove("hidden");
    window.clearTimeout(showToast._timer);
    showToast._timer = window.setTimeout(() => {
        toast.classList.add("hidden");
    }, 2200);
}

function loadConfig() {
    const storage = getConfigStorage();
    return {
        name: (storage.getItem(STORAGE_NAME) || "").trim(),
        mode: (storage.getItem(STORAGE_MODE) || "companion").trim(),
        language: (storage.getItem(STORAGE_LANGUAGE) || "auto").trim(),
        voice: (storage.getItem(STORAGE_VOICE) || "Aoede").trim(),
        goal: (storage.getItem(STORAGE_GOAL) || "").trim(),
        corrections: (storage.getItem(STORAGE_CORRECTIONS) || "gentle").trim(),
        apiKey: (storage.getItem(STORAGE_API_KEY) || "").trim(),
        systemInstruction: (storage.getItem(STORAGE_SYSTEM_INSTRUCTION) || "").trim()
    };
}

function saveConfig() {
    const storage = getConfigStorage();
    const name = nameInput.value.trim();
    const mode = modeSelect.value;
    const language = languageSelect.value;
    const voice = voiceInput.value.trim() || "Aoede";
    const goal = goalInput.value.trim();
    const corrections = correctionsSelect.value;
    const apiKey = apiKeyInput.value.trim();
    const systemInstruction = systemInstructionInput.value.trim();

    storage.setItem(STORAGE_NAME, name);
    storage.setItem(STORAGE_MODE, mode);
    storage.setItem(STORAGE_LANGUAGE, language);
    storage.setItem(STORAGE_VOICE, voice);
    storage.setItem(STORAGE_GOAL, goal);
    storage.setItem(STORAGE_CORRECTIONS, corrections);
    if (apiKey) {
        storage.setItem(STORAGE_API_KEY, apiKey);
    }
    storage.setItem(STORAGE_SYSTEM_INSTRUCTION, systemInstruction);

    if (!isRememberEnabled()) {
        CONFIG_KEYS.forEach((key) => localStorage.removeItem(key));
    }
    syncQuickControls();
}

function openConfigModal() {
    const cfg = loadConfig();
    rememberToggle.checked = isRememberEnabled();
    nameInput.value = cfg.name;
    modeSelect.value = cfg.mode || "companion";
    languageSelect.value = cfg.language || "auto";
    voiceInput.value = cfg.voice || "Aoede";
    goalInput.value = cfg.goal;
    correctionsSelect.value = cfg.corrections || "gentle";
    apiKeyInput.value = cfg.apiKey;
    systemInstructionInput.value = cfg.systemInstruction;
    applyModeRules();
    refreshCustomSelects();
    configModal.classList.remove("hidden");
}

function closeConfigModal() {
    configModal.classList.add("hidden");
}

function applyModeRules() {
    const mode = modeSelect.value;
    const supportsCorrections = mode === "tutor" || mode === "coach";
    const supportsGoal = mode === "tutor" || mode === "coach" || mode === "interviewer";

    correctionsSelect.disabled = !supportsCorrections;
    goalInput.disabled = !supportsGoal;
    if (!supportsCorrections) {
        correctionsSelect.value = "off";
    }
    if (!supportsGoal) {
        goalInput.value = "";
    }
    refreshCustomSelects();
}

function initCustomSelects() {
    const selects = document.querySelectorAll(".select-field select");
    selects.forEach((select) => {
        if (customSelects.has(select)) {
            return;
        }

        const wrapper = select.parentElement;
        const trigger = document.createElement("button");
        trigger.type = "button";
        trigger.className = "custom-select-trigger";
        trigger.textContent = select.options[select.selectedIndex]?.textContent || "Select";

        const menu = document.createElement("div");
        menu.className = "custom-select-menu hidden";

        const buildOptions = () => {
            menu.innerHTML = "";
            Array.from(select.options).forEach((option) => {
                const item = document.createElement("button");
                item.type = "button";
                item.className = "custom-select-option";
                item.dataset.value = option.value;
                item.textContent = option.textContent;
                if (option.selected) {
                    item.classList.add("selected");
                }
                item.addEventListener("click", () => {
                    select.value = option.value;
                    select.dispatchEvent(new Event("change"));
                    trigger.textContent = option.textContent;
                    closeAllCustomMenus();
                    buildOptions();
                });
                menu.appendChild(item);
            });
        };

        buildOptions();

        trigger.addEventListener("click", (event) => {
            event.stopPropagation();
            if (trigger.disabled) {
                return;
            }
            const isHidden = menu.classList.contains("hidden");
            closeAllCustomMenus();
            if (isHidden) {
                menu.classList.remove("hidden");
            }
        });

        wrapper.appendChild(trigger);
        wrapper.appendChild(menu);

        customSelects.set(select, { trigger, menu, buildOptions });
        refreshCustomSelect(select);
    });
}

function closeAllCustomMenus() {
    customSelects.forEach(({ menu }) => {
        menu.classList.add("hidden");
    });
}

function refreshCustomSelect(select) {
    const entry = customSelects.get(select);
    if (!entry) {
        return;
    }
    entry.trigger.textContent = select.options[select.selectedIndex]?.textContent || "Select";
    entry.trigger.disabled = select.disabled;
    entry.buildOptions();
}

function refreshCustomSelects() {
    customSelects.forEach((_value, select) => refreshCustomSelect(select));
}

function ensureConfig() {
    const cfg = loadConfig();
    if (!cfg.apiKey) {
        openConfigModal();
        return false;
    }
    return true;
}

function syncQuickControls() {
    const cfg = loadConfig();
    if (quickLanguageSelect) {
        quickLanguageSelect.value = cfg.language || "auto";
    }
    if (quickVoiceSelect) {
        quickVoiceSelect.value = cfg.voice || "Aoede";
    }
    refreshCustomSelects();
}

function applyTheme(theme) {
    if (!theme) {
        theme = localStorage.getItem(STORAGE_THEME) || "light";
    }
    document.body.setAttribute("data-theme", theme);
    if (themeToggle) {
        themeToggle.textContent = theme === "dark" ? "Light" : "Dark";
    }
}

function clearStoredData() {
    CONFIG_KEYS.forEach((key) => {
        localStorage.removeItem(key);
        sessionStorage.removeItem(key);
    });
    nameInput.value = "";
    modeSelect.value = "companion";
    languageSelect.value = "auto";
    voiceInput.value = "Aoede";
    goalInput.value = "";
    correctionsSelect.value = "gentle";
    apiKeyInput.value = "";
    systemInstructionInput.value = "";
    syncQuickControls();
    applyModeRules();
    showToast("Saved data cleared");
}

configBtn?.addEventListener("click", openConfigModal);
configClose?.addEventListener("click", closeConfigModal);
modeSelect?.addEventListener("change", applyModeRules);
configSave?.addEventListener("click", () => {
    saveConfig();
    if (loadConfig().apiKey) {
        closeConfigModal();
    }
});
rememberToggle?.addEventListener("change", () => {
    localStorage.setItem(STORAGE_REMEMBER, rememberToggle.checked ? "true" : "false");
    if (!rememberToggle.checked) {
        CONFIG_KEYS.forEach((key) => localStorage.removeItem(key));
    }
    saveConfig();
    showToast(rememberToggle.checked ? "Will remember on this device" : "Remember me disabled");
});
clearDataBtn?.addEventListener("click", clearStoredData);

quickLanguageSelect?.addEventListener("change", () => {
    const storage = getConfigStorage();
    storage.setItem(STORAGE_LANGUAGE, quickLanguageSelect.value);
    languageSelect.value = quickLanguageSelect.value;
    refreshCustomSelects();
    if (isRunning) {
        showToast("Language updates next session");
    }
});

quickVoiceSelect?.addEventListener("change", () => {
    const storage = getConfigStorage();
    storage.setItem(STORAGE_VOICE, quickVoiceSelect.value);
    voiceInput.value = quickVoiceSelect.value;
    refreshCustomSelects();
    if (isRunning) {
        showToast("Voice updates next session");
    }
});

themeToggle?.addEventListener("click", () => {
    const current = document.body.getAttribute("data-theme") || "light";
    const next = current === "dark" ? "light" : "dark";
    localStorage.setItem(STORAGE_THEME, next);
    applyTheme(next);
});

document.addEventListener("click", () => {
    closeAllCustomMenus();
});

if (!loadConfig().apiKey) {
    openConfigModal();
}

initCustomSelects();
syncQuickControls();
applyTheme();

function setActive() {
    btn.className = "active";
    btnlabel.innerHTML = `<span>⏹</span>`;
    window.vrmSetState?.('idle');
}
function setBotSpeaking() {
    btn.className = "active botpesu";
    btnlabel.innerHTML = `<div class="dot"><span></span><span></span><span></span></div>`;
    window.vrmSetState?.('bot');
}
function setUserSpeaking() {
    btn.className = "active userpesu";
    btnlabel.innerHTML = `<span>🎙️</span>`;
    window.vrmSetState?.('user');
}
function setIdle() {
    btn.className = ""; btnlabel.textContent = "Start";
    window.vrmSetState?.('idle');
}


async function injectTestMsg(text) {
    await fetch(`${API}/gen-ui-test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text })
    });
    card?.classList.add("hidden");
    if (card) card.innerHTML = "";
    if (isRunning) window.vrmShow?.();
}
window.injectTestMsg = injectTestMsg;

function startTrans() {
    esrc = new EventSource(`${API}/transcript`);
    esrc.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data?.text) {
            conversation.push({ role: data.role, text: data.text });
            if (conversation.length > 40) conversation.shift();
        }
        if (data.role === "assistant") {
            if (!botmsg) {
                botmsg = document.createElement("div");
                botmsg.className = "botmsg";
                // transcript.appendChild(botmsg);
            }
            botmsg.textContent = data.text;
        } else {
            botmsg = null;
            const div = document.createElement("div");
            div.className = "usermsg";
            div.textContent = data.text;
            // transcript.appendChild(div);
        }
        // transcript.scrollTop = transcript.scrollHeight;
    };
}

function renderGenUI(payload) {
    if (!card) {
        return;
    }
    if (!payload) {
        card.classList.add("hidden");
        card.innerHTML = "";
        return;
    }

    card.classList.remove("hidden");
    card.innerHTML = "";

    const type = payload.type || "text";
    const data = payload.data || {};

    const title = document.createElement("h3");
    title.textContent = data.title || (type === "text" ? "Assistant" : "Highlights");
    title.style.marginBottom = "10px";
    title.style.fontSize = "18px";

    card.appendChild(title);

    if (type === "card") {
        if (data.body) {
            const body = document.createElement("p");
            body.textContent = data.body;
            body.style.marginBottom = "12px";
            card.appendChild(body);
        }
        if (Array.isArray(data.items)) {
            const list = document.createElement("ul");
            list.style.paddingLeft = "18px";
            data.items.forEach((item) => {
                const li = document.createElement("li");
                li.textContent = item;
                list.appendChild(li);
            });
            card.appendChild(list);
        }
    } else {
        const body = document.createElement("p");
        body.textContent = data.text || payload.text || JSON.stringify(payload);
        card.appendChild(body);
    }
}

function startGenUI() {
    uirsc = new EventSource(`${API}/gen-ui`);
    uirsc.onmessage = (event) => {
        const data = JSON.parse(event.data);
        renderGenUI(data);
    };
}

function stopGenUI() {
    if (uirsc) {
        uirsc.close();
        uirsc = null;
    }
}

function stopTrans() {
    if (esrc) {

        esrc.close();
        esrc = null;
    }
}

async function startAudioCapture() {
    const cfg = loadConfig();
    mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
            channelCount: 1,
            sampleRate: GEMINI_SAMPLE_RATE,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
        }
    });

    audioContext = new AudioContext({ sampleRate: GEMINI_SAMPLE_RATE });
    const actualRate = audioContext.sampleRate;
    console.log(`[audio] context: ${actualRate} Hz → target: ${GEMINI_SAMPLE_RATE} Hz`);

    const source = audioContext.createMediaStreamSource(mediaStream);

    await audioContext.audioWorklet.addModule('/static/processor.js?v=' + Date.now());
    audioWorkletNode = new AudioWorkletNode(audioContext, 'audio-in-processor', {
        processorOptions: {
            inputSampleRate: actualRate,
            outputSampleRate: GEMINI_SAMPLE_RATE,
        }
    });

    audioWs = new WebSocket(`${WS}/audio`);
    audioWs.binaryType = "arraybuffer";
    audioWs.onopen = () => {
        attempt = 0;
        const payload = {
            type: "config",
            name: cfg.name,
            mode: cfg.mode,
            language: cfg.language,
            voice: cfg.voice || "Aoede",
            goal: cfg.goal,
            corrections: cfg.corrections,
            api_key: cfg.apiKey,
            system_instruction: cfg.systemInstruction || ""
        };
        audioWs.send(JSON.stringify(payload));
        console.log("[audio] WS open — streaming Int16 PCM at", GEMINI_SAMPLE_RATE, "Hz");
    };
    audioWs.onerror = (e) => console.error("[audio] WS error:", e);
    // audioWs.onclose = () => console.log("[audio] WS closed");

    audioWs.onclose = async (e) => {
        console.log("[audio] WS closed:", e);
        if (RETRYABLE_WS_CLOSE_CODES.has(e.code) && isRunning && attempt < maxAttempt) {
            attempt++;
            console.log(`[audio] (WS close ${e.code}) Attempting to reconnect... (${attempt}/${maxAttempt})`);
            await handleResume();
        }
    }

    playbackCtx = new AudioContext({ sampleRate: GEMINI_OUT_RATE });
    nextPlayTime = 0;
    audioWs.onmessage = (e) => {
        // if (!(e.data instanceof ArrayBuffer) || e.data.byteLength === 0) return;
        if (!(e.data instanceof ArrayBuffer) || e.data.byteLength === 0) {
            return;
        }
        const int16 = new Int16Array(e.data);
        const float32 = new Float32Array(int16.length);
        for (let i = 0; i < int16.length; i++) {
            float32[i] = int16[i] / 0x8000; // Int16 → Float32 [-1, 1]
        }
        const buffer = playbackCtx.createBuffer(1, float32.length, GEMINI_OUT_RATE);
        buffer.getChannelData(0).set(float32);
        const src = playbackCtx.createBufferSource();
        src.buffer = buffer;
        src.connect(playbackCtx.destination);
        const startAt = Math.max(playbackCtx.currentTime, nextPlayTime);
        src.start(startAt);
        nextPlayTime = startAt + buffer.duration;
        setBotSpeaking();
        src.onended = () => {
            if (nextPlayTime <= playbackCtx.currentTime)
                setActive();
        };
    };
    audioWorkletNode.port.onmessage = (e) => {
        if (audioWs && audioWs.readyState === WebSocket.OPEN) {
            audioWs.send(e.data);
        }
    };

    const silentGain = audioContext.createGain();
    silentGain.gain.value = 0;
    source.connect(audioWorkletNode);
    audioWorkletNode.connect(silentGain);
    silentGain.connect(audioContext.destination);
}

async function handleResume() {
    const contextToResume = conversation
        .slice(-20)
        .map(msg => `${msg.role === 'assistant' || msg.role === 'bot' ? 'Priya' : 'Patient'}: ${msg.text}`)
        .join("\n");
    console.log("resume context built", { lines: contextToResume ? contextToResume.split("\n").length : 0 });
    if (audioWorkletNode) {
        audioWorkletNode.disconnect();
        audioWorkletNode = null;
    }
    if (audioContext) {
        audioContext.close();
        audioContext = null;
    }
    if (playbackCtx) {
        playbackCtx.close();
        playbackCtx = null;
    }
    audioWs = null;

    await new Promise(r => setTimeout(r, 1500));

    await startAudioCapture();
    await fetch(`${API}/greet`)
    await new Promise(r => setTimeout(r, 500));
    if (contextToResume) {
        await fetch(`${API}/resume`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ context: contextToResume })
        });
        console.log("context sent for resume");
    }
    setActive();
}




function stopAudioCapture() {
    if (audioWorkletNode) {
        audioWorkletNode.disconnect();
        audioWorkletNode = null;
    }
    if (audioContext) {
        audioContext.close();
        audioContext = null;
    }
    if (mediaStream) {
        mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null;
    }
    if (audioWs) {
        audioWs.close();
        audioWs = null;
    }
    if (playbackCtx) {
        playbackCtx.close();
        playbackCtx = null;
    }
    nextPlayTime = 0;
    console.log("[audio] capture stopped");
}





















btn.onclick = async () => {
    if (isRunning) {
        btn.disabled = true;
        btnlabel.textContent = "Stopping";
        // stopTrans();
        stopAudioCapture();
        stopGenUI();
        await fetch(`${API}/restart`);
        // transcript.classList.remove("visible");
        // transcript.innerHTML = "";
        card?.classList.add("hidden");
        if (card) card.innerHTML = "";
        botmsg = null;
        window.vrmSetState?.('idle');
        welcome?.classList.remove("hidden");
        setIdle();
        isRunning = false;
        btn.disabled = false;
        conversation = [];
        attempt = 0;
        return;
    }

    if (!ensureConfig()) {
        return;
    }

    welcome?.classList.add("hidden");
    window.vrmShow?.();
    // transcript.classList.add("visible");
    btn.className = "active";
    btnlabel.innerHTML = `<div class="dot"><span></span><span></span><span></span></div>`;


    startGenUI();
    await startAudioCapture();
    // startTrans();
    isRunning = true;

    await new Promise(resolve => setTimeout(resolve, 500));

    try {
        const greetText = await fetch(`${API}/greet`).then(r => r.text());
        console.log("greeted:", greetText);
    } catch (e) {
        console.error("Error during greeting:", e);
    }

    setActive();
};
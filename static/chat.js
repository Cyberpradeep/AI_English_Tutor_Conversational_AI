const btn = document.getElementById("btn");
const btnlabel = document.getElementById("btn-label");
const welcome = document.getElementById("welcome");
const transcript = document.getElementById("transcript");
const card = document.getElementById("card");
const configBtn = document.getElementById("config-btn");
const configModal = document.getElementById("config-modal");
const configClose = document.getElementById("config-close");
const configSave = document.getElementById("config-save");
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

const STORAGE_API_KEY = "gemini_api_key";
const STORAGE_SYSTEM_INSTRUCTION = "gemini_system_instruction";

function loadConfig() {
    return {
        apiKey: (localStorage.getItem(STORAGE_API_KEY) || "").trim(),
        systemInstruction: (localStorage.getItem(STORAGE_SYSTEM_INSTRUCTION) || "").trim()
    };
}

function saveConfig() {
    const apiKey = apiKeyInput.value.trim();
    const systemInstruction = systemInstructionInput.value.trim();
    if (apiKey) {
        localStorage.setItem(STORAGE_API_KEY, apiKey);
    }
    localStorage.setItem(STORAGE_SYSTEM_INSTRUCTION, systemInstruction);
}

function openConfigModal() {
    const cfg = loadConfig();
    apiKeyInput.value = cfg.apiKey;
    systemInstructionInput.value = cfg.systemInstruction;
    configModal.classList.remove("hidden");
}

function closeConfigModal() {
    configModal.classList.add("hidden");
}

function ensureConfig() {
    const cfg = loadConfig();
    if (!cfg.apiKey) {
        openConfigModal();
        return false;
    }
    return true;
}

configBtn?.addEventListener("click", openConfigModal);
configClose?.addEventListener("click", closeConfigModal);
configSave?.addEventListener("click", () => {
    saveConfig();
    if (loadConfig().apiKey) {
        closeConfigModal();
    }
});

if (!loadConfig().apiKey) {
    openConfigModal();
}

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
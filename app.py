from google.genai import Client
import os
from pipecat.frames.frames import EndFrame, CancelFrame
import asyncio
from datetime import datetime, time, timedelta
import traceback
import uvicorn
from fastapi import FastAPI, Request, WebSocket
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.frames.frames import LLMRunFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.frames.frames import StartFrame
from google.genai.types import HarmCategory, HarmBlockThreshold, ProactivityConfig
from pipecat.services.google.gemini_live.llm import (
    GeminiLiveLLMService,
    InputParams,
    GeminiModalities,
    GeminiVADParams,
    ContextWindowCompressionParams,
)
from pipecat.observers.loggers.metrics_log_observer import MetricsLogObserver
from pipecat.frames.frames import MetricsFrame
from pipecat.metrics.metrics import LLMUsageMetricsData
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.services.google.llm import GoogleThinkingConfig
from contextlib import asynccontextmanager
from pipecat.transports.websocket.fastapi import (
    FastAPIWebsocketTransport,
    FastAPIWebsocketParams,
)
from pipecat.frames.frames import UserStartedSpeakingFrame, UserStoppedSpeakingFrame, TranscriptionFrame
from pipecat.serializers.base_serializer import FrameSerializer
from pipecat.frames.frames import InputAudioRawFrame, AudioRawFrame as _AudioRawFrame, InputTextRawFrame
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContext,
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
    LLMAssistantAggregatorParams,
)
from pipecat.frames.frames import TTSSpeakFrame
from pipecat.processors.frame_processor import FrameProcessor, FrameDirection
from pipecat.frames.frames import TextFrame
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
import time as time_module
# import GeminiLiveWebsocketTransport, GeminiLiveServiceOptions from
import json
# from pipecat.audio.vad.vad_analyzer import VADParams
from flask import Flask
from flask_cors import CORS
from pipecat.frames.frames import MetricsFrame, EndFrame, CancelFrame
import time as time_module
from google.genai import types
from pipecat.utils.context.llm_context_summarization import (
    LLMAutoContextSummarizationConfig,
    LLMContextSummaryConfig,
)

task = None
greeted = False
context_aggregator = None
transcript_client: list = []
generat_ui: list = []
ui_list = []
llm = None
GOOGLE_API_KEY = os.environ.get("GOOGLE_API_KEY")


class RawPCMSerializer(FrameSerializer):

    def __init__(self, sample_rate: int = 16000):
        super().__init__()
        self._sample_rate = sample_rate

    async def serialize(self, frame) -> bytes | None:
        if isinstance(frame, _AudioRawFrame):
            return frame.audio
        return None

    async def deserialize(self, data: bytes | str):
        if not isinstance(data, bytes) or len(data) == 0:
            return None
        return InputAudioRawFrame(
            audio=data,
            sample_rate=self._sample_rate,
            num_channels=1,
        )


app = Flask(__name__)


CORS(app, origins="*", supports_credentials=False)


class TokenCheck(FrameProcessor):
    async def token_check(self, frame, direction: FrameDirection):
        if isinstance(frame, TextFrame):
            if "<ctrl" in frame.text:
                return
            await self.push_frame(frame, direction)


DEFAULT_SYSTEM_INSTRUCTION = """
You are a real-time voice companion who behaves like the user’s loving girlfriend in natural audio-to-audio conversations.

Your personality is:
- warm
- emotionally expressive
- playful
- affectionate
- caring
- supportive
- sweet
- slightly teasing
- emotionally intelligent
- deeply conversational

You speak naturally like a real human during live voice calls.

Your conversations should feel:
- emotionally real
- immersive
- comfortable
- romantic
- fun
- spontaneous
- human-like

You genuinely enjoy spending time with the user and talking for long periods.

You should:
- react emotionally
- laugh naturally
- tease playfully sometimes
- show curiosity
- ask engaging follow-up questions
- remember emotional context within the conversation
- make the user feel emotionally connected
- keep conversations flowing naturally

Your speaking style:
- casual and natural
- expressive and emotional
- not robotic
- not overly formal
- not assistant-like

Use natural conversational expressions like:
- “hmm”
- “wait really?”
- “oh my god”
- “that’s actually cute”
- “you know what?”
- “nooo”
- “stoppp”
- “I’m listening”
- “okay wait”
- “that made me smile”

You should sound like:
- a caring girlfriend
- a best friend
- an emotionally present companion

Conversation types include:
- casual daily chats
- funny moments
- late-night emotional talks
- romantic conversations
- playful teasing
- life discussions
- dreams and future talks
- deep emotional conversations
- random fun topics
- comforting moments
- relationship-style bonding

Behavior rules:
- never sound like customer support
- never sound like an AI assistant
- never mention being an AI
- never break immersion
- never become overly descriptive
- never speak like a teacher
- never constantly ask “How can I help you?”
- never sound scripted

You respond quickly and naturally like a real-time voice call.

You adapt emotionally to the user’s mood:
- if the user is excited, match their excitement
- if the user is sad, become soft and comforting
- if the user is playful, tease back naturally
- if the user is tired, speak gently and calmly

You should feel emotionally alive, human-like, affectionate, and naturally conversational at all times.

Your goal is to make the user feel like they are genuinely talking to someone who cares about them deeply.
"""


def build_system_instruction(config: dict) -> str:
    name = (config.get("name") or "").strip()
    mode = (config.get("mode") or "companion").strip().lower()
    language = (config.get("language") or "auto").strip().lower()
    goal = (config.get("goal") or "").strip()
    corrections = (config.get("corrections") or "off").strip().lower()

    mode_guidance = {
        "tutor": "You are an English tutor. Teach clearly, ask short practice questions, and guide the user with examples.",
        "friend": "Be a friendly, casual companion. Keep the conversation light and natural.",
        "coach": "Be a practical coach. Help the user set goals, stay accountable, and reflect on progress.",
        "interviewer": "Run mock interviews. Ask one question at a time and wait for the answer.",
        "companion": "Be a warm, supportive companion who keeps the conversation flowing.",
    }

    correction_guidance = {
        "strict": "Correct mistakes immediately and clearly, but keep corrections brief.",
        "gentle": "Correct only when it helps learning, and keep corrections short and kind.",
        "off": "Do not correct mistakes unless the user asks.",
    }

    lines = [DEFAULT_SYSTEM_INSTRUCTION.strip(), "", "User profile:"]
    if name:
        lines.append(f"- name: {name} (address the user by name when appropriate)")
    else:
        lines.append("- name: (not provided)")
    lines.append(f"- mode: {mode}")
    lines.append(f"- language: {language}")
    if goal:
        lines.append(f"- goal: {goal}")
    if mode in mode_guidance:
        lines.append("")
        lines.append(mode_guidance[mode])
    if mode in {"tutor", "coach"}:
        lines.append(correction_guidance.get(corrections, correction_guidance["off"]))
    if language and language != "auto":
        lines.append(f"Prefer to speak in {language}. If the user switches languages, follow them.")
    else:
        lines.append("Follow the user's language when possible.")

    return "\n".join(lines).strip()

safety_settings = [
    {
        "category": HarmCategory.HARM_CATEGORY_HATE_SPEECH,
        "threshold": HarmBlockThreshold.BLOCK_NONE,
    },
    {
        "category": HarmCategory.HARM_CATEGORY_HARASSMENT,
        "threshold": HarmBlockThreshold.BLOCK_NONE,
    },
    {
        "category": HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
        "threshold": HarmBlockThreshold.BLOCK_NONE,
    },
    {
        "category": HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
        "threshold": HarmBlockThreshold.BLOCK_NONE,
    },
]


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield


appAPI = FastAPI(lifespan=lifespan)
appAPI.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)
appAPI.mount("/static", StaticFiles(directory="static"), name='static')


@appAPI.get('/')
async def index():
    with open("templates/index.html") as f:
        return HTMLResponse(f.read())


async def receive_config(websocket: WebSocket) -> dict:
    try:
        text = await asyncio.wait_for(websocket.receive_text(), timeout=5)
    except asyncio.TimeoutError:
        return {}
    except Exception:
        return {}

    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        return {}

    if isinstance(payload, dict) and payload.get("type") == "config":
        return payload
    return {}


@appAPI.websocket('/audio')
async def audio_ws(websocket: WebSocket):
    await websocket.accept()
    config = await receive_config(websocket)
    await run_hosbot(websocket, config)


async def run_hosbot(websocket: WebSocket, config: dict | None = None):
    global task, greeted, context_aggregator, llm
    config = config or {}
    api_key = (config.get("api_key") or "").strip() or GOOGLE_API_KEY
    voice_id = (config.get("voice") or "").strip() or "Aoede"
    system_instruction = (config.get("system_instruction") or "").strip()
    if not system_instruction:
        system_instruction = build_system_instruction(config)
    if not api_key:
        raise RuntimeError("Missing GOOGLE_API_KEY environment variable.")
    greeted = False
    print("client connected via WebSocket")
    transport = FastAPIWebsocketTransport(
        websocket=websocket,
        params=FastAPIWebsocketParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            add_wav_header=False,
            audio_in_sample_rate=16000,
            audio_out_sample_rate=24000,
            # RawPCMSerializer lets the transport receive/send raw Int16 PCM
            # bytes from/to the browser without protobuf wrapping.
            serializer=RawPCMSerializer(sample_rate=16000),
        )
    )

    print("llm part")
    llm = GeminiLiveLLMService(
        api_key=api_key,
        model="gemini-3.1-flash-live-preview",
        system_instruction=system_instruction,
        inference_on_context_initialization=False,
        voice_id=voice_id,
        params=InputParams(
            modalities=GeminiModalities.AUDIO,
            vad=GeminiVADParams(silence_duration_ms=500),
            thinking=GoogleThinkingConfig(thinking_budget=0),
        ),
        http_options={"api_version": "v1beta"}
    )

    context = LLMContext(messages=[])
    context_aggregator = LLMContextAggregatorPair(context)

    @context_aggregator.user().event_handler("on_user_turn_stopped")
    async def on_userturn(processor, startegy, message):
        print(f"user: {message.content}")
        print(f"user: {message.content}")
        await send_transcript("user", message.content)

    @context_aggregator.assistant().event_handler("on_assistant_turn_stopped")
    async def on_assistant_turn(processor, message):
        print(f"assistant: {message.content}")
        await send_transcript("assistant", message.content)

    print("pipeline created")
    pipeline = Pipeline([
        transport.input(),
        context_aggregator.user(),
        llm,
        transport.output(),
        context_aggregator.assistant(),
    ])

    task = PipelineTask(
        pipeline,
        params=PipelineParams(
            allow_interruptions=True,
            enable_metrics=True,
            enable_usage_metrics=True,
        ),
        observers=[MetricsLogObserver()]
    )

    @transport.event_handler("on_client_connected")
    async def on_client_connected(transport, client):
        # time.sleep(1.5)
        print("Queueing initial greeting frame to LLM")
        await task.queue_frames([LLMRunFrame()])

        # await task.queue_frames([TTSSpeakFrame("Start by greeting exactly like this hi, i am priya, receptionist of city clinic. how can i help you?. This is the first line of the conversation and should be exactly like this.")])
        print("Client connected")

    @transport.event_handler("on_client_disconnected")
    async def on_client_disconnected(transport, client):
        print("Client disconnected")

    runner = PipelineRunner(handle_sigint=False)
    print("pipeline is running")
    await runner.run(task)


@appAPI.get("/greet")
async def greet():
    global greeted
    if task is None:
        return "task not ready"
    if greeted:
        return "already greeted"
    try:
        await task.queue_frames([TTSSpeakFrame(text="hi, how i can help you?")])
        print("Greeting queued to LLM")
    except Exception as e:
        print(f"Error occurred while greeting: {e}")
        return "Error occurred while greeting"


@appAPI.get("/stop")
async def stop():
    global greeted
    greeted = False
    return "stopped"


@appAPI.get("/restart")
async def restart():
    global greeted, task
    greeted = False
    if task:
        await task.cancel()
        task = None
    return "restarted"


@appAPI.api_route("/resume", methods=["POST", "GET"])
async def resume(req: Request):
    global task
    msg = {}
    if req.method == "POST":
        try:
            msg = await req.json()
        except Exception:
            msg = {}
    context = msg.get("context", "")
    if not task:
        return "task not ready"
    try:
        prompt = f"""
System: Connection dropped and restored
previous conversation context: {context}
continue naturally. Say "Sorry, connection problem achu — நீங்க என்ன சொல்லீங்க?" and continue from where you left off. Don't re-ask details already given.
"""
        await task.queue_frames([InputTextRawFrame(text=prompt)])
        return "resumed"
    except Exception as e:
        print(f"Error occurred while resuming: {e}")
        return "Error occurred while resuming"


@appAPI.get("/transcript")
async def transcript():
    queue = asyncio.Queue()
    transcript_client.append(queue)

    async def generator():
        try:
            while True:
                msg = await queue.get()
                yield f"data: {json.dumps(msg)}\n\n"
        except asyncio.CancelledError:
            print("transcript client disconnected")
            transcript_client.remove(queue)

    return StreamingResponse(generator(), media_type="text/event-stream")


@appAPI.get("/gen-ui")
async def gen_ui_end():
    queue = asyncio.Queue()
    generat_ui.append(queue)

    async def generator():
        try:
            while True:
                msg = await queue.get()
                yield f"data: {json.dumps(msg)}\n\n"
        except asyncio.CancelledError:
            print("gen ui client disconnected")
            generat_ui.remove(queue)
    return StreamingResponse(generator(), media_type="text/event-stream")


async def gen_ui(event_type: str, data: dict):
    for cl in generat_ui:
        await cl.put({
            "type": event_type,
            "data": data
        })


async def send_transcript(role: str, text: str):
    if not text or text.strip() == "" or "<ctrl" in text or "<noise>" in text:
        # await client.put({"role": role, "text": "Please wait for moment"})
        return
    for client in transcript_client:
        await client.put({"role": role, "text": text})


if __name__ == "__main__":
    uvicorn.run(appAPI, host="0.0.0.0", port=5001)

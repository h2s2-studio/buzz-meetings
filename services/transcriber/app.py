"""Private CPU speech service. The authenticated Meetings broker is its only caller."""
from contextlib import asynccontextmanager
import asyncio
import io
import os
import wave
import time
from contextlib import suppress
from pydantic import BaseModel, Field
try:
    from .rooms import RoomTranscripts
except ImportError:
    from rooms import RoomTranscripts

import numpy as np
from fastapi import FastAPI, HTTPException, Request
from faster_whisper import WhisperModel

MAX_BYTES = 320_044  # Ten seconds of 16 kHz mono PCM16, plus the WAV header.
model = None
inference = asyncio.Semaphore(1)


@asynccontextmanager
async def lifespan(app):
    global model
    name = os.getenv("WHISPER_MODEL", "base.en")
    revision = os.getenv("WHISPER_REVISION") or ("3d3d5dee26484f91867d81cb899cfcf72b96be6c" if name == "base.en" else None)
    model = WhisperModel(
        name, revision=revision, use_auth_token=False, device="cpu", compute_type="int8",
        cpu_threads=int(os.getenv("WHISPER_THREADS", "2")),
        download_root=os.getenv("WHISPER_MODEL_DIR", "/models"),
    )
    reaper = asyncio.create_task(room_transcripts.reap())
    try:
        yield
    finally:
        reaper.cancel()
        with suppress(asyncio.CancelledError):
            await reaper
        await room_transcripts.close()
        model = None


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None)


@app.get("/health")
def health():
    if model is None:
        raise HTTPException(503, "Speech model is loading")
    return {"ready": True}


def recognize(data):
    try:
        with wave.open(io.BytesIO(data), "rb") as audio:
            if (audio.getnchannels(), audio.getsampwidth(), audio.getframerate()) != (1, 2, 16_000):
                raise ValueError("Expected 16 kHz mono PCM16 WAV")
            if not 0 < audio.getnframes() <= 160_000:
                raise ValueError("Audio must be at most ten seconds")
            samples = np.frombuffer(audio.readframes(audio.getnframes()), dtype="<i2").astype(np.float32) / 32768
        if not len(samples):
            raise ValueError("Audio is empty")
    except (wave.Error, EOFError, ValueError) as problem:
        raise HTTPException(400, str(problem)) from problem
    segments, _ = model.transcribe(
        samples, beam_size=3, vad_filter=True, condition_on_previous_text=False,
        vad_parameters={"min_silence_duration_ms": 350},
    )
    result = []
    for segment in segments:
        text = segment.text.strip()
        if text and segment.no_speech_prob < 0.6 and segment.avg_logprob > -1.0:
            result.append({"start": round(segment.start, 3), "end": round(segment.end, 3), "text": text[:2000]})
    return {"segments": result[:32], "duration": len(samples) / 16000}


@app.post("/transcribe")
async def transcribe(request: Request):
    # Stream with a bound: Content-Length alone is not sufficient.
    data = bytearray()
    async for chunk in request.stream():
        data.extend(chunk)
        if len(data) > MAX_BYTES:
            raise HTTPException(413, "Audio exceeds ten seconds")
    if model is None:
        raise HTTPException(503, "Speech model is loading")
    return await recognize_room(bytes(data))


async def recognize_room(data):
    # Canceling a viewer must not release the CPU slot while its native inference
    # thread is still running. Keep the semaphore until that work actually ends.
    async with inference:
        job = asyncio.create_task(asyncio.to_thread(recognize, data))
        try:
            return await asyncio.shield(job)
        except asyncio.CancelledError:
            await job
            raise


room_transcripts = RoomTranscripts(recognize_room)


class RoomLease(BaseModel):
    room: str = Field(pattern=r"^[a-zA-Z0-9_-]{1,128}$")
    lease: str = Field(pattern=r"^[a-zA-Z0-9_-]{1,128}$")
    url: str = Field(max_length=2048)
    token: str = Field(max_length=8192)


@app.post("/sessions")
async def acquire_room(input: RoomLease):
    if model is None:
        raise HTTPException(503, "Speech model is loading")
    try:
        return await room_transcripts.acquire(input.room, input.lease, input.url, input.token)
    except RuntimeError as problem:
        raise HTTPException(503, str(problem)) from problem


@app.get("/sessions/{name}")
async def room_snapshot(name: str, lease: str, after: int = 0, stream: str | None = None):
    room = room_transcripts.rooms.get(name)
    if room is None or lease not in room.leases:
        raise HTTPException(404, "The transcription session ended")
    room.leases[lease] = time.monotonic()
    return room.snapshot(max(0, after), stream)


@app.delete("/sessions/{name}")
async def release_room(name: str, lease: str):
    room = room_transcripts.rooms.get(name)
    if room is not None:
        await room.release(lease)
    return {"released": True}

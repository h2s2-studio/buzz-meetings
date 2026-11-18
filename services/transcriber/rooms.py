"""One LiveKit microphone subscriber and transcript timeline per media room."""
import asyncio
from collections import deque
import io
import time
import uuid
import wave

import numpy as np
from livekit import rtc


def wav(samples):
    output = io.BytesIO()
    with wave.open(output, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(16000)
        audio.writeframes(samples.astype("<i2").tobytes())
    return output.getvalue()


class SpeechBuffer:
    def __init__(self, emit):
        self.emit = emit
        self.parts = []
        self.count = 0
        self.silence = 0
        self.started = 0
        self.pre = None

    def push(self, samples, ended):
        speech = np.sqrt(np.mean((samples.astype(np.float32) / 32768) ** 2)) > 0.012
        if not self.count and not speech:
            self.pre = samples.copy()
            return
        if not self.count:
            prefix = self.pre if self.pre is not None else np.empty(0, dtype=np.int16)
            self.started = ended - (len(prefix) + len(samples)) / 16
            self.parts.append(prefix)
            self.count = len(prefix)
        self.parts.append(samples.copy())
        self.count += len(samples)
        self.silence = 0 if speech else self.silence + len(samples)
        if self.count >= 128000 or self.silence >= 11200:
            self.flush()

    def flush(self):
        if self.count >= 6400:
            self.emit(np.concatenate(self.parts), self.started, self.started + self.count / 16)
        self.parts = []
        self.count = self.silence = 0
        self.pre = None


class RoomTranscript:
    def __init__(self, name, recognize):
        self.name = name
        self.lock = asyncio.Lock()
        self.recognize = recognize
        self.room = None
        self.room_sid = None
        self.stream_id = str(uuid.uuid4())
        self.phase = "paused"
        self.error = ""
        self.segments = deque(maxlen=4000)
        self.sequence = 0
        self.leases = {}
        self.queue = asyncio.Queue(maxsize=8)
        self.readers = {}
        self.processor = None
        self.starting = None
        self.dropped = 0
        self.jobs = 0
        self.delay_ms = 0
        self.touched = time.monotonic()

    async def acquire(self, lease, url, token):
        async with self.lock:
            return await self._acquire(lease, url, token)

    async def _acquire(self, lease, url, token):
        if lease not in self.leases and len(self.leases) >= 64:
            raise RuntimeError("This call has reached its transcript viewer limit.")
        self.leases[lease] = time.monotonic()
        self.touched = time.monotonic()
        if self.phase == "error" and self.room is not None:
            await self._pause()
        if self.starting is None and self.room is None:
            self.starting = asyncio.create_task(self.connect(url, token))
        if self.starting is not None:
            await asyncio.shield(self.starting)
        if self.phase == "error":
            raise RuntimeError(self.error)
        return self.snapshot(0)

    async def connect(self, url, token):
        room = rtc.Room()
        self.room = room
        self.phase = "starting"
        self.error = ""

        @room.on("track_published")
        def published(publication, participant):
            publication.set_subscribed(publication.source == rtc.TrackSource.SOURCE_MICROPHONE)

        @room.on("track_subscribed")
        def subscribed(track, publication, participant):
            if publication.source != rtc.TrackSource.SOURCE_MICROPHONE or track.sid in self.readers:
                return
            self.readers[track.sid] = asyncio.create_task(self.read(track, publication, participant))

        @room.on("track_unsubscribed")
        def unsubscribed(track, publication, participant):
            task = self.readers.pop(track.sid, None)
            if task:
                task.cancel()

        @room.on("reconnecting")
        def reconnecting():
            self.phase = "recovering"

        @room.on("reconnected")
        def reconnected():
            self.phase = "active"
            self.dropped += 1

        @room.on("disconnected")
        def disconnected(reason):
            if self.phase not in ("paused", "ended"):
                self.phase = "error"
                self.error = "The meeting transcription connection ended. Resume to reconnect."

        try:
            await asyncio.wait_for(room.connect(url, token, rtc.RoomOptions(auto_subscribe=False)), 15)
            sid = await room.sid
            if self.room_sid and sid != self.room_sid:
                self.segments.clear()
                self.sequence = self.dropped = self.jobs = 0
                self.stream_id = str(uuid.uuid4())
            self.room_sid = sid
            for participant in room.remote_participants.values():
                for publication in participant.track_publications.values():
                    published(publication, participant)
            self.processor = asyncio.create_task(self.process())
            self.phase = "active"
        except Exception:
            self.phase = "error"
            self.error = "The meeting service could not connect to call audio. Try again."
            await room.disconnect()
            self.room = None
        finally:
            self.starting = None

    async def read(self, track, publication, participant):
        def enqueue(samples, started, ended):
            item = (participant.identity, participant.name or "Participant", samples, started, ended)
            try:
                self.queue.put_nowait(item)
            except asyncio.QueueFull:
                self.dropped += 1
        buffer = SpeechBuffer(enqueue)
        stream = rtc.AudioStream(track, sample_rate=16000, num_channels=1, frame_size_ms=20, capacity=100)
        try:
            async for event in stream:
                if publication.muted:
                    buffer.flush()
                    continue
                samples = np.frombuffer(event.frame.data, dtype=np.int16)
                buffer.push(samples, time.time() * 1000)
        except asyncio.CancelledError:
            raise
        except Exception:
            self.dropped += 1
        finally:
            if self.leases:
                buffer.flush()
            await stream.aclose()
            if self.readers.get(track.sid) is asyncio.current_task():
                self.readers.pop(track.sid, None)

    async def process(self):
        while True:
            speaker, name, samples, started, ended = await self.queue.get()
            try:
                if time.time() * 1000 - ended > 15000:
                    self.dropped += 1
                    continue
                result = await self.recognize(wav(samples))
                self.jobs += 1
                self.delay_ms = round(time.time() * 1000 - ended)
                for segment in result["segments"]:
                    self.sequence += 1
                    self.segments.append({
                        "seq": self.sequence, "speakerId": speaker, "speakerName": name,
                        "startedAt": round(min(ended, started + segment["start"] * 1000)),
                        "endedAt": round(min(ended, started + segment["end"] * 1000)),
                        "text": segment["text"],
                    })
                self.error = ""
            except asyncio.CancelledError:
                raise
            except Exception:
                self.dropped += 1
                self.error = "Some speech could not be transcribed. New speech will continue."
            finally:
                self.queue.task_done()

    def snapshot(self, after, stream_id=None):
        oldest = self.segments[0]["seq"] if self.segments else self.sequence + 1
        gap = bool(stream_id and stream_id != self.stream_id) or after < oldest - 1
        cursor = 0 if stream_id and stream_id != self.stream_id else after
        rows = [row for row in self.segments if row["seq"] > cursor][:20]
        return {"streamId": self.stream_id, "callId": self.room_sid, "phase": self.phase,
                "segments": rows, "next": rows[-1]["seq"] if rows else max(cursor, self.sequence),
                "head": self.sequence, "gap": gap, "dropped": self.dropped, "error": self.error,
                "metrics": {"subscribers": len(self.leases), "sources": len(self.readers),
                            "queued": self.queue.qsize(), "jobs": self.jobs, "delayMs": self.delay_ms}}

    async def release(self, lease):
        async with self.lock:
            self.leases.pop(lease, None)
            if not self.leases:
                await self._pause()

    async def pause(self):
        async with self.lock:
            await self._pause()

    async def _pause(self):
        self.phase = "paused"
        starting = self.starting
        if starting and starting is not asyncio.current_task():
            starting.cancel()
            await asyncio.gather(starting, return_exceptions=True)
        tasks = list(self.readers.values())
        self.readers.clear()
        if self.processor:
            tasks.append(self.processor)
            self.processor = None
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        while not self.queue.empty():
            self.queue.get_nowait()
            self.queue.task_done()
        if self.room:
            room, self.room = self.room, None
            await room.disconnect()


class RoomTranscripts:
    def __init__(self, recognize):
        self.recognize = recognize
        self.rooms = {}
        self.lock = asyncio.Lock()

    async def acquire(self, name, lease, url, token):
        async with self.lock:
            self.prune()
            room = self.rooms.get(name)
            if room is None or room.room is None:
                if (room is None and len(self.rooms) >= 16) or sum(bool(item.room) for item in self.rooms.values()) >= 4:
                    raise RuntimeError("Transcription capacity is full. Try again shortly.")
            if room is None:
                room = self.rooms[name] = RoomTranscript(name, self.recognize)
            return await room.acquire(lease, url, token)

    def prune(self):
        now = time.monotonic()
        self.rooms = {key: room for key, room in self.rooms.items() if room.room or now - room.touched < 1800}

    async def reap(self):
        while True:
            await asyncio.sleep(10)
            for room in list(self.rooms.values()):
                expired = [lease for lease, touched in room.leases.items() if time.monotonic() - touched > 30]
                for lease in expired:
                    await room.release(lease)
            self.prune()

    async def close(self):
        for room in self.rooms.values():
            await room.pause()

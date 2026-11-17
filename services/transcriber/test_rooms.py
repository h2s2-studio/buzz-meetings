import asyncio
import time
import threading
import app as service
import unittest
from unittest.mock import patch
import numpy as np
from rooms import RoomTranscript, RoomTranscripts, SpeechBuffer


class TimelineTests(unittest.IsolatedAsyncioTestCase):
    async def test_viewers_share_one_worker_and_replay_and_depart_independently(self):
        count = 0
        async def recognize(data):
            return {"segments": [{"start":0,"end":.5,"text":"Agreed."}]}
        room = RoomTranscript("call", recognize)
        async def connect(url, token):
            nonlocal count
            count += 1
            room.room = object()
            room.room_sid = "call-id"
            room.phase = "active"
            room.starting = None
        with patch.object(room,"connect",connect):
            await asyncio.gather(room.acquire("a","", ""),room.acquire("b","", ""))
        self.assertEqual(count,1)
        await room.release("a")
        self.assertEqual(list(room.leases),["b"])
        self.assertEqual(room.phase,"active")
        room.processor=asyncio.create_task(room.process())
        await room.queue.put(("speaker","Alex",np.ones(8000,dtype=np.int16),time.time()*1000-500,time.time()*1000))
        await room.queue.join()
        first, second = room.snapshot(0), room.snapshot(0)
        self.assertEqual(first["segments"],second["segments"])
        self.assertEqual(room.jobs,1)
        self.assertEqual(room.snapshot(1)["segments"],[])
        self.assertTrue(room.snapshot(1,"old-stream")["gap"])
        room.room=None
        await room.release("b")
        self.assertEqual(room.phase,"paused")
        self.assertIsNone(room.processor)

    async def test_stale_work_and_inference_errors_are_visible_without_losing_text(self):
        async def recognize(data):
            raise RuntimeError("Engine failed")
        room=RoomTranscript("call",recognize)
        room.processor=asyncio.create_task(room.process())
        old=time.time()*1000-30000
        await room.queue.put(("a","Alex",np.ones(8000,dtype=np.int16),old-500,old))
        await room.queue.put(("b","Riley",np.ones(8000,dtype=np.int16),time.time()*1000-500,time.time()*1000))
        await room.queue.join()
        self.assertEqual(room.dropped,2)
        self.assertIn("could not",room.snapshot(0)["error"])
        await room.pause()

    async def test_timeline_retention_is_bounded_and_reports_the_replay_gap(self):
        room=RoomTranscript("call",None)
        for i in range(6000):
            room.segments.append({"seq":i+1})
        room.sequence=6000
        result=room.snapshot(0)
        self.assertTrue(result["gap"])
        self.assertEqual(len(room.segments),4000)
        self.assertEqual(result["segments"][0]["seq"],2001)
        self.assertEqual(len(result["segments"]),20)

    async def test_viewer_capacity_and_expired_room_retention_are_bounded(self):
        room=RoomTranscript("call",None); room.leases={str(i):time.monotonic() for i in range(64)}
        with self.assertRaisesRegex(RuntimeError,"viewer limit"):
            await room.acquire("overflow","", "")
        manager=RoomTranscripts(None); room.touched=time.monotonic()-1801; manager.rooms["call"]=room
        manager.prune(); self.assertEqual(manager.rooms,{})


class InferenceLifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def test_cancel_keeps_the_cpu_slot_until_the_native_thread_finishes(self):
        entered=threading.Event(); release=threading.Event(); calls=[]
        def recognize(data):
            calls.append(data); entered.set()
            if data == b"first": release.wait(timeout=2)
            return {"segments":[]}
        old=service.inference; service.inference=asyncio.Semaphore(1)
        try:
            with patch.object(service,"recognize",recognize):
                first=asyncio.create_task(service.recognize_room(b"first"))
                while not entered.is_set(): await asyncio.sleep(.001)
                first.cancel()
                second=asyncio.create_task(service.recognize_room(b"second"))
                await asyncio.sleep(.03); self.assertEqual(calls,[b"first"])
                release.set(); await asyncio.gather(first,return_exceptions=True); await second
                self.assertEqual(calls,[b"first",b"second"])
        finally:
            release.set(); service.inference=old


class SegmentationTests(unittest.TestCase):
    def test_long_speech_and_pause_flush_are_bounded(self):
        chunks=[]
        buffer=SpeechBuffer(lambda *args:chunks.append(args))
        for i in range(420):
            buffer.push(np.full(320,10000,dtype=np.int16),1000+i*20)
        buffer.flush()
        self.assertEqual(len(chunks),2)
        self.assertLessEqual(max(len(chunk[0]) for chunk in chunks),128000)
        self.assertLess(chunks[0][1],chunks[0][2])

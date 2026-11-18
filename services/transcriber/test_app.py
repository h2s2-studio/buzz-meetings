import io
import unittest
import wave
from types import SimpleNamespace
from fastapi import HTTPException
from app import recognize
import app as service


def wav(frames=16000, rate=16000, channels=1):
    out = io.BytesIO()
    with wave.open(out, "wb") as audio:
        audio.setnchannels(channels)
        audio.setsampwidth(2)
        audio.setframerate(rate)
        audio.writeframes(b"\0\0" * frames * channels)
    return out.getvalue()


class SpeechInputTests(unittest.TestCase):
    def test_refuses_invalid_compressed_stereo_and_unbounded_audio(self):
        for data in [b"not audio", wav(channels=2), wav(rate=48000), wav(frames=160001), wav(frames=0)]:
            with self.subTest(size=len(data)), self.assertRaises(HTTPException):
                recognize(data)

    def test_preserves_speech_times_and_filters_low_confidence_or_no_speech(self):
        old = service.model
        class Model:
            def transcribe(self, samples, **options):
                assert options["vad_filter"] is True
                assert options["condition_on_previous_text"] is False
                return iter([
                    SimpleNamespace(start=0.1, end=0.8, text=" Agreed task. ", no_speech_prob=0.1, avg_logprob=-0.1),
                    SimpleNamespace(start=0.8, end=1.0, text="Silence hallucination", no_speech_prob=0.9, avg_logprob=-0.2),
                ]), None
        service.model = Model()
        try:
            result = recognize(wav())
            self.assertEqual(result["duration"], 1)
            self.assertEqual(result["segments"], [{"start": 0.1, "end": 0.8, "text": "Agreed task."}])
        finally:
            service.model = old


if __name__ == "__main__":
    unittest.main()

import { socketUrl, type RoomRequest } from "./protocol";
import { wav16, type SpeechChunk } from "./speech";
export type TranscriptSegment = { seq: number; speakerId: string; speakerName: string; startedAt: number; endedAt: number; text: string };
export function openTranscription(broker: string, request: Extract<RoomRequest, { type: "meeting" }>, signal: AbortSignal, receive: (segments: TranscriptSegment[]) => void, failed: (error: string) => void) {
  return new Promise<{ send(chunk: SpeechChunk): void; close(): void }>((resolve, reject) => {
    const socket = new WebSocket(socketUrl(broker));
    let ready = false, closed = false, seq = 0, pending = 0, sent: { seq: number; chunk: SpeechChunk } | undefined;
    const queue: SpeechChunk[] = [];
    const timer = setTimeout(() => finish("Live transcription did not start."), 8000);
    const heartbeat = setInterval(() => { if (ready && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "ping" })); }, 20000);
    function finish(error?: string) {
      if (closed) return; closed = true; clearTimeout(timer); clearInterval(heartbeat);
      signal.removeEventListener("abort", cancel); queue.length = 0; socket.close();
      if (!ready) reject(new Error(error ?? "Listening stopped.")); else if (error && !signal.aborted) failed(error);
    }
    function cancel() { finish(); }
    function drain() {
      if (closed || pending || !queue.length || !ready) return;
      const chunk = queue.shift()!, bytes = wav16(chunk.samples); let binary = "";
      for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
      pending = ++seq; sent = { seq, chunk };
      socket.send(JSON.stringify({ seq, speakerId: chunk.speakerId, speakerName: chunk.speakerName, startedAt: chunk.startedAt, endedAt: chunk.endedAt, wav: btoa(binary) }));
    }
    socket.onopen = () => socket.send(JSON.stringify({ ...request, type: "listen" }));
    socket.onerror = socket.onclose = () => finish("The live transcription connection closed. Stop and try again.");
    socket.onmessage = event => {
      try {
        if (typeof event.data !== "string" || event.data.length > 30000) throw new Error();
        const value = JSON.parse(event.data);
        if (value.type === "error") return finish(typeof value.error === "string" ? value.error.slice(0,180) : "Live transcription failed.");
        if (value.type === "listening" && !ready) {
          ready = true; clearTimeout(timer);
          resolve({ send(chunk) { if (closed) return; if (queue.length >= 8) return finish("Listening stopped because transcription fell behind. Some speech was not transcribed."); queue.push(chunk); drain(); }, close: () => finish() });
        } else if (value.type === "pong") return;
        else if (value.type === "transcript" && sent && value.seq === pending && value.speakerId === sent.chunk.speakerId && Array.isArray(value.segments)) {
          const chunk = sent.chunk;
          const segments = value.segments.slice(0,32).flatMap((segment: { start?: unknown; end?: unknown; text?: unknown }): TranscriptSegment[] => {
            if (typeof segment.text !== "string" || !segment.text.trim() || typeof segment.start !== "number" || typeof segment.end !== "number" || !Number.isFinite(segment.start) || !Number.isFinite(segment.end) || segment.start < 0 || segment.end < segment.start) return [];
            return [{ seq: pending, speakerId: chunk.speakerId, speakerName: chunk.speakerName, startedAt: Math.min(chunk.endedAt, chunk.startedAt + segment.start * 1000), endedAt: Math.min(chunk.endedAt, chunk.startedAt + segment.end * 1000), text: segment.text.trim().slice(0,2000) }];
          });
          pending = 0; sent = undefined; receive(segments); drain();
        } else throw new Error();
      } catch { finish("The transcription service returned an invalid response."); }
    };
    signal.addEventListener("abort", cancel, { once: true }); if (signal.aborted) cancel();
  });
}

import { socketUrl, type VoiceRequest } from "./protocol";
import type { AdmissionProof } from "./workspace-voice";
import type { TranscriptSegment } from "./transcription";

export type SharedTranscript = {
  streamId: string;
  callId: string;
  phase: "active" | "recovering" | "paused" | "error";
  segments: TranscriptSegment[];
  gap: boolean;
  dropped: number;
  error: string;
  metrics: { subscribers: number; sources: number; queued: number; jobs: number; delayMs: number };
};

export function openSharedTranscription(broker: string, request: VoiceRequest, signal: AbortSignal, receive: (value: SharedTranscript) => void, failed: (error: string) => void, proof?: AdmissionProof) {
  return new Promise<{ close(): void }>((resolve, reject) => {
    const socket = new WebSocket(socketUrl(broker));
    const raw = JSON.stringify(request.type === "workspace" ? { ...request, captions: true } : { ...request, type: "captions" });
    let challenged = false;
    let ready = false, closed = false, stream = "", sequence = 0;
    const deadline = setTimeout(() => close("Meeting transcription did not start. Try again."), 25000);
    let watchdog: ReturnType<typeof setTimeout>;
    function close(error?: string) {
      if (closed) return;
      closed = true;
      clearTimeout(deadline); clearTimeout(watchdog);
      signal.removeEventListener("abort", cancel);
      socket.close();
      if (!ready) reject(new Error(error ?? "Transcription canceled."));
      else if (error && !signal.aborted) failed(error);
    }
    function cancel() { close(); }
    socket.onopen = () => socket.send(raw);
    socket.onclose = socket.onerror = () => close("The shared transcript disconnected. Resume to reconnect.");
    socket.onmessage = ({ data }) => {
      try {
        if (typeof data !== "string" || data.length > 100000) throw new Error();
        const value = JSON.parse(data) as SharedTranscript & { type: string };
        if (value.type === "challenge" && request.type === "workspace" && proof && !challenged) {
          challenged = true;
          const challenge = value as unknown as { nonce: string; digest: string };
          void proof(challenge.nonce, challenge.digest, raw, signal).then(answer => { if (!closed) socket.send(JSON.stringify(answer)); }).catch(error => close(error instanceof Error ? error.message : "Couldn’t verify transcript access."));
          return;
        }
        if (value.type === "error") return close(value.error || "Transcription is unavailable.");
        if (value.type !== "captions" || typeof value.streamId !== "string" || typeof value.callId !== "string" || !Array.isArray(value.segments) || value.segments.length > 20 || !["active", "recovering", "paused", "error"].includes(value.phase)) throw new Error();
        if (stream !== value.streamId) { stream = value.streamId; sequence = 0; }
        const segments: TranscriptSegment[] = [];
        for (const segment of value.segments) {
          if (!Number.isSafeInteger(segment.seq) || segment.seq <= 0 || typeof segment.speakerId !== "string" || segment.speakerId.length > 128 || typeof segment.speakerName !== "string" || segment.speakerName.length > 256 || typeof segment.text !== "string" || segment.text.length > 2000 || !Number.isSafeInteger(segment.startedAt) || !Number.isSafeInteger(segment.endedAt) || segment.endedAt < segment.startedAt || segment.startedAt < 0 || segment.endedAt > 8640000000000000) throw new Error();
          if (segment.seq > sequence) { segments.push(segment); sequence = segment.seq; }
        }
        clearTimeout(watchdog);
        watchdog = setTimeout(() => close("Transcription stopped responding. Resume to reconnect."), 12000);
        receive({ ...value, segments });
        if (value.phase === "error" || value.phase === "paused") return close(value.error || "Transcription paused. Resume to reconnect.");
        if (!ready) {
          ready = true; clearTimeout(deadline);
          resolve({ close: () => close() });
        }
      } catch { close("The meeting service returned an invalid transcript."); }
    };
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
  });
}

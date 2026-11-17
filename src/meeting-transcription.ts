import { captureSpeakers } from "./speech";
import { untilCanceled } from "./capture";
import type { TranscriptSegment } from "./transcription";
import type { makeRoomSession } from "./room";

export type MeetingTranscriptState = {
  phase: "idle" | "starting" | "transcribing" | "reconnecting" | "paused" | "ended" | "error";
  callId?: string;
  roomName?: string;
  error: string;
  segments: readonly TranscriptSegment[];
};
type Media = Pick<ReturnType<typeof makeRoomSession>, "snapshot" | "subscribe" | "transcribe" | "setTranscribing">;
type Run = {
  callId: string;
  abort: AbortController;
  context: AudioContext;
  socket?: Awaited<ReturnType<Media["transcribe"]>>;
  recorder?: ReturnType<typeof captureSpeakers>;
  ready?: Promise<void>;
};

// One transcription stream per local call, independent of chat access or agents.
export function makeMeetingTranscription(media: Media, audioContext = () => new AudioContext()) {
  const listeners = new Set<() => void>();
  let state: MeetingTranscriptState = { phase: "idle", error: "", segments: [] };
  let active: Run | undefined;
  function emit(next: Partial<MeetingTranscriptState>) {
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  }
  function stop(error = "", phase: MeetingTranscriptState["phase"] = "paused") {
    const run = active; active = undefined;
    if (run) {
      run.abort.abort(); run.recorder?.close(); run.socket?.close();
      void run.context.close().catch(() => {});
      void media.setTranscribing(run.callId, false).catch(() => {});
    }
    emit({ phase: error ? "error" : phase, error });
  }
  function reset() {
    stop();
    emit({ phase: "idle", callId: undefined, roomName: undefined, error: "", segments: [] });
  }
  function start() {
    const call = media.snapshot();
    if (active && active.callId === call.sessionId) return active.ready ?? Promise.resolve();
    if (call.phase !== "connected" || !call.sessionId || !call.transcription) {
      emit({ error: call.phase !== "connected" ? "Join a voice room to start transcription." : "Transcription isn’t available on this meeting service." });
      return Promise.resolve();
    }
    stop();
    let context: AudioContext;
    try { context = audioContext(); } catch { emit({ phase: "error", error: "Audio capture couldn’t start. Try transcription again." }); return Promise.resolve(); }
    const run: Run = { callId: call.sessionId, abort: new AbortController(), context };
    active = run;
    emit({ phase: "starting", callId: call.sessionId, roomName: call.roomName, error: "", ...(state.callId !== call.sessionId ? { segments: [] } : {}) });
    run.ready = (async () => {
      try {
        // Resume from the explicit user gesture, before opening the speech socket.
        const resumed = context.resume();
        void resumed.catch(() => {});
        run.socket = await media.transcribe(run.abort.signal, segments => {
          if (active !== run) return;
          if (state.segments.length + segments.length > 2000) return stop("The live transcript is full. Rejoin the room to start a new transcript.");
          emit({ segments: [...state.segments, ...segments] });
        }, error => { if (active === run) stop(error); });
        if (active !== run) { run.socket.close(); return; }
        await untilCanceled(resumed, AbortSignal.any([run.abort.signal, AbortSignal.timeout(8000)]));
        if (active !== run) { run.socket.close(); return; }
        if (context.state !== "running") throw new Error("Audio capture paused. Start transcription again from this meeting.");
        await media.setTranscribing(run.callId, true);
        if (active !== run) return;
        run.recorder = captureSpeakers(context, chunk => { if (active === run) run.socket?.send(chunk); });
        run.recorder.update(media.snapshot().participants);
        emit({ phase: "transcribing" });
      } catch (problem) {
        if (active === run) stop(problem instanceof Error ? problem.message : "Couldn’t start transcription. Try again.");
      }
    })();
    return run.ready;
  }
  const unsubscribe = media.subscribe(() => {
    const call = media.snapshot();
    if (call.sessionId && call.sessionId !== state.callId) {
      reset(); emit({ callId: call.sessionId, roomName: call.roomName });
    }
    const run = active;
    if (!run) {
      if (call.phase === "idle" && state.callId && state.phase !== "ended") emit({ phase: "ended" });
      return;
    }
    if (call.phase === "idle" || call.sessionId !== run.callId) return stop("", "ended");
    run.recorder?.update(call.phase === "connected" ? call.participants : []);
    if (run.recorder) {
      const phase = call.phase === "connected" ? "transcribing" : "reconnecting";
      if (state.phase !== phase) emit({ phase });
    }
  });
  return { start, stop, reset, snapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    close() { unsubscribe(); reset(); listeners.clear(); },
  };
}
export type MeetingTranscription = ReturnType<typeof makeMeetingTranscription>;

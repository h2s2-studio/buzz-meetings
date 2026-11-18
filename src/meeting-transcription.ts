import { captureSpeakers, type SpeechChunk } from "./speech";
import { untilCanceled } from "./capture";
import type { TranscriptSegment } from "./transcription";
import type { makeRoomSession } from "./room";

export type MeetingTranscriptState = {
  phase: "idle" | "starting" | "transcribing" | "reconnecting" | "paused" | "ended" | "error";
  /** Local join this transcript belongs to (UI lifecycle). */
  joinId?: string;
  /** Call occurrence (media room SID) the transcript was captured in. */
  occurrenceId?: string;
  /** Workspace channel the call belonged to; a saved record binds to it, not to a room name. */
  channelId?: string;
  roomName?: string;
  error: string;
  segments: readonly TranscriptSegment[];
  base: number;
  warning: string;
  sharedStreamId?: string;
  sharedCallId?: string;
  sharedCursor?: number;
  metrics?: { subscribers: number; sources: number; queued: number; jobs: number; delayMs: number };
  /** Earlier joins' transcripts kept after a rejoin until each is saved or discarded. */
  retained: readonly RetainedTranscript[];
};
export type RetainedTranscript = Pick<MeetingTranscriptState, "joinId" | "occurrenceId" | "channelId" | "roomName" | "segments" | "base" | "warning" | "sharedStreamId" | "sharedCallId"> & { phase: "ended"; error: ""; retained: readonly [] };
const retainLimit = 8;
type Media = Pick<ReturnType<typeof makeRoomSession>, "snapshot" | "subscribe" | "transcribe" | "captions" | "setTranscribing">;
type Run = {
  joinId: string;
  abort: AbortController;
  context?: AudioContext;
  socket?: { close(): void; send?(chunk: SpeechChunk): void };
  recorder?: ReturnType<typeof captureSpeakers>;
  ready?: Promise<void>;
};

// One transcription stream per local call, independent of chat access or agents.
export function makeMeetingTranscription(media: Media, audioContext = () => new AudioContext()) {
  const listeners = new Set<() => void>();
  let state: MeetingTranscriptState = { phase: "idle", error: "", segments: [], base: 0, warning: "", retained: [] };
  let active: Run | undefined;
  // Who asked for capture on this join: "user" or an agent's start attempt. Capture
  // stops when the last interest is released; an explicit pause clears them all.
  const interests = new Set<string>();
  function emit(next: Partial<MeetingTranscriptState>) {
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  }
  function stop(error = "", phase: MeetingTranscriptState["phase"] = "paused") {
    const run = active; active = undefined; interests.clear();
    if (run) {
      run.abort.abort(); run.recorder?.close(); run.socket?.close();
      void run.context?.close().catch(() => {});
      void media.setTranscribing(run.joinId, false).catch(() => {});
    }
    emit({ phase: error ? "error" : phase, error });
  }
  function clearCurrent() {
    stop();
    emit({ phase: "idle", joinId: undefined, occurrenceId: undefined, channelId: undefined, roomName: undefined, error: "", segments: [], base: 0, warning: "", sharedStreamId: undefined, sharedCallId: undefined, sharedCursor: undefined, metrics: undefined });
  }
  /** Clears everything, including retained transcripts (identity or community change, plugin close). */
  function reset() { clearCurrent(); emit({ retained: [] }); }
  /** Drops one transcript by join: a retained one, or the current one once its call has ended. */
  function discard(joinId?: string) {
    if (!joinId) return;
    if (state.retained.some(item => item.joinId === joinId)) return emit({ retained: state.retained.filter(item => item.joinId !== joinId) });
    if (state.joinId === joinId && !active && media.snapshot().joinId !== joinId) clearCurrent();
  }
  // A new join keeps the previous join's unsaved text reviewable instead of wiping it.
  function retainCurrent() {
    if (!state.segments.length) return;
    const { joinId, occurrenceId, channelId, roomName, segments, base, warning, sharedStreamId, sharedCallId } = state;
    emit({ retained: [...state.retained, { phase: "ended", error: "", retained: [], joinId, occurrenceId, channelId, roomName, segments, base, warning, sharedStreamId, sharedCallId } as RetainedTranscript].slice(-retainLimit) });
  }
  function release(holder: string) {
    if (!interests.delete(holder)) return;
    if (interests.size || !active) return emit({});
    stop();
  }
  function start(holder = "user") {
    const call = media.snapshot();
    if (active && active.joinId === call.joinId) { if (!interests.has(holder)) { interests.add(holder); emit({}); } return active.ready ?? Promise.resolve(); }
    if (call.phase !== "connected" || !call.joinId || !call.transcription) {
      emit({ error: call.phase !== "connected" ? "Join a voice room to start transcription." : "Transcription isn’t available on this meeting service." });
      return Promise.resolve();
    }
    stop(); interests.add(holder);
    let context: AudioContext | undefined;
    try { if (!call.sharedTranscription) context = audioContext(); } catch { emit({ phase: "error", error: "Audio capture couldn’t start. Try transcription again." }); return Promise.resolve(); }
    const run: Run = { joinId: call.joinId, abort: new AbortController(), context };
    active = run;
    if (state.joinId !== call.joinId) retainCurrent();
    emit({ phase: "starting", joinId: call.joinId, occurrenceId: call.occurrenceId, channelId: call.workspaceChannelId, roomName: call.roomName, error: "", ...(state.joinId !== call.joinId ? { segments: [] } : {}) });
    run.ready = (async () => {
      try {
        if (call.sharedTranscription) {
          await media.setTranscribing(run.joinId,true);
          if (active !== run) return;
          run.socket = await media.captions(run.abort.signal, packet => {
            if (active !== run) return;
            const sameStream = state.sharedStreamId === packet.streamId;
            const previous = sameStream ? state.sharedCursor ?? 0 : 0;
            const incoming = packet.segments.filter(segment => segment.seq > previous).map(segment => ({ ...segment, id: `${packet.streamId}:${segment.seq}` }));
            const combined = [...state.segments, ...incoming];
            const removed = Math.max(0, combined.length - 4000);
            const warning = packet.error || (packet.gap || packet.dropped > 0 || (state.sharedStreamId && !sameStream) ? "Some speech is missing from the transcript. New speech will continue." : state.warning);
            emit({ segments: combined.slice(removed), base: state.base + removed, sharedStreamId: packet.streamId, sharedCallId: packet.callId,
              // Keep the highest accepted sequence: a resumed connection replays from the start.
              sharedCursor: Math.max(previous, incoming.at(-1)?.seq ?? 0), warning, metrics: packet.metrics,
              phase: packet.phase === "recovering" ? "reconnecting" : packet.phase === "active" && state.phase === "reconnecting" ? "transcribing" : state.phase });
          }, error => { if (active === run) stop(error); });
          if (active !== run) { run.socket.close(); return; }
          if (active === run) emit({ phase: "transcribing" });
          return;
        }
        if (!context) throw new Error("Audio capture could not start.");
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
        await media.setTranscribing(run.joinId, true);
        if (active !== run) return;
        run.recorder = captureSpeakers(context, chunk => { if (active === run) run.socket?.send?.(chunk); });
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
    if (call.joinId && call.joinId !== state.joinId) {
      stop("", "ended"); retainCurrent(); clearCurrent(); emit({ joinId: call.joinId, occurrenceId: call.occurrenceId, channelId: call.workspaceChannelId, roomName: call.roomName });
    } else if (call.joinId && call.occurrenceId && call.occurrenceId !== state.occurrenceId) emit({ occurrenceId: call.occurrenceId });
    const run = active;
    if (!run) {
      if (call.phase === "idle" && state.joinId && state.phase !== "ended") emit({ phase: "ended" });
      return;
    }
    if (call.phase === "idle" || call.joinId !== run.joinId) return stop("", "ended");
    run.recorder?.update(call.phase === "connected" ? call.participants : []);
    if (run.recorder) {
      const phase = call.phase === "connected" ? "transcribing" : "reconnecting";
      if (state.phase !== phase) emit({ phase });
    }
  });
  return { start, stop, release, reset, discard, snapshot: () => state, holders: () => [...interests],
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    close() { unsubscribe(); reset(); listeners.clear(); },
  };
}
export type MeetingTranscription = ReturnType<typeof makeMeetingTranscription>;

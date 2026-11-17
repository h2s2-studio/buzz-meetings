import type * as ReactRuntime from "react";
import type { MeetingTranscription } from "./meeting-transcription";
import type { makeRoomSession } from "./room";

export function transcriptUI(React: typeof ReactRuntime, transcript: MeetingTranscription, media: ReturnType<typeof makeRoomSession>) {
  const { useEffect, useRef, useState, useSyncExternalStore } = React;
  return function TranscriptPanel({ roomName, close }: { roomName: string; close(): void }) {
    const state = useSyncExternalStore(transcript.subscribe, transcript.snapshot);
    const call = useSyncExternalStore(media.subscribe, media.snapshot);
    const scroll = useRef<HTMLDivElement>(null), following = useRef(true);
    const [away, setAway] = useState(false);
    const current = state.roomName === roomName;
    const segments = current ? [...state.segments].sort((a, b) => a.startedAt - b.startedAt || a.endedAt - b.endedAt) : [];
    const active = current && ["starting", "transcribing", "reconnecting"].includes(state.phase);
    const status = !current ? "Off" : state.phase === "starting" ? "Starting…" : state.phase === "transcribing" ? "Transcribing" : state.phase === "reconnecting" ? "Reconnecting…" : state.phase === "ended" ? "Call ended" : state.phase === "error" ? "Interrupted" : state.phase === "paused" ? "Paused" : "Off";
    useEffect(() => {
      if (following.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
    }, [state.segments]);
    function latest() {
      following.current = true; setAway(false);
      if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
    }
    return <aside className="meeting-chat meeting-transcript-panel text-body-sm" aria-label="Meeting transcript" data-buzz-ui="">
      <header className="panel-header"><div className="panel-header-title"><div className="panel-header-label"><h2>Transcript</h2></div></div><div className="panel-header-actions"><button type="button" className="buzz-button" data-buzz-ui="" data-button-shape="icon" data-icon-size="sm" data-icon-shape="control" data-icon-variant="ghost" aria-label="Close transcript" title="Close transcript" onClick={close}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M18 6l-12 12 M6 6l12 12" /></svg></button></div></header>
      <div className="meeting-transcript-controls"><span className="text-caption text-subtle" role="status">{status}</span><button type="button" className="buzz-button" data-buzz-ui="" data-size="sm" data-variant={active ? "subtle" : "prominent"} disabled={!active && (call.phase !== "connected" || !call.transcription)} onClick={() => { if (active) transcript.stop(); else void transcript.start(); }}><span className="buzz-button-label">{active ? state.phase === "starting" ? "Cancel transcription" : "Pause transcription" : segments.length ? "Resume transcription" : "Start transcription"}</span></button></div>
      {current && state.error && <p role="alert" className="meeting-transcript-notice text-danger">{state.error}</p>}
      <div className="meeting-transcript-scroll" ref={scroll} role="region" aria-label="Transcript entries" tabIndex={0} onScroll={() => {
        const element = scroll.current; if (!element) return;
        following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
        setAway(!following.current);
      }}>
        {segments.length ? <ol className="meeting-transcript-entries">{segments.map((segment, index) => <li key={`${segment.speakerId}:${segment.startedAt}:${index}`}><div className="meeting-transcript-speaker"><strong>{segment.speakerName}</strong><time dateTime={new Date(segment.startedAt).toISOString()} className="text-caption text-metadata">{new Date(segment.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time></div><p>{segment.text}</p></li>)}</ol>
          : <div className="meeting-transcript-empty"><h3 className="text-body-sm">{active ? "Ready when you speak" : "Follow every voice"}</h3><p className="text-subtle">{active ? "Speech appears here after a short pause, with the speaker and time." : call.phase !== "connected" ? "Join a voice room to see its live transcript." : !call.transcription ? "Transcription isn’t available on this meeting service." : "Start a live transcript for this call. No agent or linked chat is needed."}</p></div>}
      </div>
      {away && <button type="button" className="buzz-button meeting-transcript-latest" data-buzz-ui="" data-variant="subtle" data-size="sm" onClick={latest}><span className="buzz-button-label">Jump to latest</span></button>}
      <details className="meeting-transcript-footnote text-caption text-metadata"><summary>Live text is temporary · Details</summary><p>Microphone audio is transcribed by your meeting service. Text stays in this app session until you rejoin or reload. Recognition can make mistakes.</p></details>
    </aside>;
  };
}

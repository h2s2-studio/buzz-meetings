import type { MeetingRecords } from "./meeting-records";
import type { LiveAgents } from "./live-agents";
import type * as ReactRuntime from "react";
import type { MeetingTranscription } from "./meeting-transcription";
import type { makeRoomSession } from "./room";

export function transcriptUI(React: typeof ReactRuntime, transcript: MeetingTranscription, media: ReturnType<typeof makeRoomSession>, archive?: { records: MeetingRecords; agents: LiveAgents; channel(roomName: string): string | undefined }) {
  const { useEffect, useRef, useState, useSyncExternalStore } = React;
  let announceByDefault=false;
  try { announceByDefault=localStorage.getItem("meetings-announce-speech")==="true"; } catch { /* Default to quiet reading. */ }
  return function TranscriptPanel({ roomName, close }: { roomName: string; close(): void }) {
    const state = useSyncExternalStore(transcript.subscribe, transcript.snapshot);
    const call = useSyncExternalStore(media.subscribe, media.snapshot);
    const scroll = useRef<HTMLDivElement>(null), following = useRef(true);
    const [announce,setAnnounce]=useState(announceByDefault), [announcement,setAnnouncement]=useState("");
    const announced=useRef({callId:state.callId,cursor:state.base+state.segments.length});
    const [away, setAway] = useState(false), [search, setSearch] = useState(""), [notice, setNotice] = useState("");
    const saved = useSyncExternalStore(archive?.records.subscribe ?? (() => () => {}), archive?.records.snapshot ?? (() => undefined));
    const channelId = archive?.channel(roomName);
    async function copy() { try { await navigator.clipboard.writeText(text()); setNotice("Transcript copied."); } catch { setNotice("Copy is unavailable. Download the transcript instead."); } }
    function text() { return `${roomName}\n${state.warning ? state.warning+"\n" : ""}${segments.map(row => `[${new Date(row.startedAt).toLocaleTimeString()}] ${row.speakerName}: ${row.text}`).join("\n\n")}`; }
    function download() {
      const url = URL.createObjectURL(new Blob([text()],{ type:"text/plain;charset=utf-8" })), link = document.createElement("a");
      link.href=url; link.download=`${roomName.replace(/[^a-z0-9_-]/gi,"_")}-transcript.txt`; link.click(); setTimeout(() => URL.revokeObjectURL(url),1000);
    }
    const current = state.roomName === roomName;
    const segments = current ? [...state.segments].sort((a, b) => a.startedAt - b.startedAt || a.endedAt - b.endedAt) : [];
    const active = current && ["starting", "transcribing", "reconnecting"].includes(state.phase);
    const status = !current ? "Off" : state.phase === "starting" ? "Starting…" : state.phase === "transcribing" ? "Transcribing" : state.phase === "reconnecting" ? "Reconnecting…" : state.phase === "ended" ? "Call ended" : state.phase === "error" ? "Interrupted" : state.phase === "paused" ? "Paused" : "Off";
    useEffect(() => {
      if (following.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
    }, [state.segments]);
    useEffect(() => {
      const cursor=state.base+state.segments.length;
      if (!announce || !current || state.callId !== announced.current.callId || cursor < announced.current.cursor) setAnnouncement("");
      else if (cursor > announced.current.cursor) setAnnouncement(state.segments.slice(Math.max(0,announced.current.cursor-state.base)).map(row=>`${row.speakerName}: ${row.text}`).join(" ").slice(0,2000));
      announced.current={callId:state.callId,cursor};
    },[state.segments,state.callId,current,announce]);
    function latest() {
      following.current = true; setAway(false);
      if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
    }
    return <aside className="meeting-chat meeting-transcript-panel text-body-sm" aria-label="Meeting transcript" data-buzz-ui="">
      <header className="panel-header"><div className="panel-header-title"><div className="panel-header-label"><h2>Transcript</h2></div></div><div className="panel-header-actions"><button type="button" className="buzz-button" data-buzz-ui="" data-button-shape="icon" data-icon-size="sm" data-icon-shape="control" data-icon-variant="ghost" aria-label="Close transcript" title="Close transcript" onClick={close}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M18 6l-12 12 M6 6l12 12" /></svg></button></div></header>
      <div className="meeting-transcript-controls"><span className="text-caption text-subtle" role="status">{status}</span><button type="button" className="buzz-button" data-buzz-ui="" data-size="sm" data-variant={active ? "subtle" : "prominent"} disabled={!active && (call.phase !== "connected" || !call.transcription)} onClick={() => { if (active) transcript.stop(); else void transcript.start(); }}><span className="buzz-button-label">{active ? state.phase === "starting" ? "Cancel transcription" : "Pause transcription" : segments.length ? "Resume transcription" : "Start transcription"}</span></button></div>
      {segments.length > 0 && <div className="meeting-transcript-actions"><input className="buzz-input" type="search" aria-label="Search transcript" placeholder="Find in transcript…" value={search} onChange={event => setSearch(event.target.value)} /><button type="button" className="buzz-button" data-buzz-ui="" data-size="sm" data-variant="ghost" onClick={() => { void copy(); }}>Copy</button><button type="button" className="buzz-button" data-buzz-ui="" data-size="sm" data-variant="ghost" onClick={download}>Download</button>{channelId && archive && <button type="button" className="buzz-button" data-buzz-ui="" data-size="sm" data-variant="subtle" disabled={saved?.busy || saved?.pending} onClick={() => { void archive.records.save(channelId,state,archive.agents.snapshot()); }}>Save meeting record</button>}</div>}
      {current && state.warning && <p role="status" className="meeting-transcript-notice text-subtle">{state.warning}</p>}
      {notice && <p className="meeting-transcript-notice text-caption">{notice}</p>}
      {saved?.error && <p role="alert" className="meeting-transcript-notice text-danger">{saved.error}</p>}
      {saved?.saved && saved.records.some(record => record.id === saved.saved && record.value.callId === (state.sharedCallId ?? state.callId)) && <p className="meeting-transcript-notice text-caption">Saved in this workspace’s Meeting records.</p>}
      {saved?.pending && archive && <button type="button" className="buzz-button" data-buzz-ui="" disabled={saved.busy} onClick={() => { void archive.records.retry(); }}>Check / retry saved meeting</button>}
      {current && state.error && <p role="alert" className="meeting-transcript-notice text-danger">{state.error}</p>}
      <div className="meeting-transcript-scroll" ref={scroll} role="region" aria-label="Transcript entries" tabIndex={0} onScroll={() => {
        const element = scroll.current; if (!element) return;
        following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
        setAway(!following.current);
      }}>
        {segments.length ? <ol className="meeting-transcript-entries">{segments.filter(segment => !search || `${segment.speakerName} ${segment.text}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())).map((segment, index) => <li key={`${segment.speakerId}:${segment.startedAt}:${index}`}><div className="meeting-transcript-speaker"><strong>{segment.speakerName}</strong><time dateTime={new Date(segment.startedAt).toISOString()} className="text-caption text-metadata">{new Date(segment.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time></div><p>{segment.text}</p></li>)}</ol>
          : <div className="meeting-transcript-empty"><h3 className="text-body-sm">{active ? "Ready when you speak" : "Follow every voice"}</h3><p className="text-subtle">{active ? "Speech appears here after a short pause, with the speaker and time." : call.phase !== "connected" ? "Join a voice room to see its live transcript." : !call.transcription ? "Transcription isn’t available on this meeting service." : "Start a live transcript for this call. No agent or linked chat is needed."}</p></div>}
      </div>
      {away && <button type="button" className="buzz-button meeting-transcript-latest" data-buzz-ui="" data-variant="subtle" data-size="sm" onClick={latest}><span className="buzz-button-label">Jump to latest</span></button>}
      <div className="meeting-speech-announcement" role="log" aria-live={announce ? "polite" : "off"} aria-atomic="true" aria-label="New speech">{announcement}</div>
      <details className="meeting-transcript-footnote text-caption text-metadata"><summary>Transcript options</summary><label><input type="checkbox" checked={announce} onChange={event=>{const value=event.target.checked;setAnnounce(value);announceByDefault=value;try{localStorage.setItem("meetings-announce-speech",String(value));}catch{/* This view still updates. */}}} />Announce new speech</label><p>Microphone audio is transcribed by your meeting service. Everyone transcribing this call receives the same live text. Save a meeting record to retain a snapshot with this channel, or download a copy. Unsaved text expires after the call. Recognition can make mistakes.</p></details>
    </aside>;
  };
}

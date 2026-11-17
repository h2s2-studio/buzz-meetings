import type * as ReactRuntime from "react";
import type { AudioPreferences, makeRoomSession } from "./room";
import { untilCanceled, stopStream } from "./capture";
export function audioSettings(React: typeof ReactRuntime, media: ReturnType<typeof makeRoomSession>, scope: () => string) {
  let key = "";
  function load() {
    const next = scope(); if (next === key) return; key = next;
    let prefs: AudioPreferences = { microphone:"", output:"", joinMuted:false };
    try { const saved = JSON.parse(localStorage.getItem(`meetings-audio:${key}`) ?? "{}"); prefs = { microphone:typeof saved.microphone === "string" ? saved.microphone : "", output:typeof saved.output === "string" ? saved.output : "", joinMuted:saved.joinMuted === true }; } catch { /* Use system defaults. */ }
    void media.configureAudio(prefs);
  }
  load();
  function AudioSettings() {
    load();
    const id = React.useId(), anchor = React.useRef<HTMLButtonElement>(null), drawer = React.useRef<HTMLDivElement>(null);
    const [prefs,setPrefs] = React.useState(media.audioPreferences), [devices,setDevices] = React.useState<MediaDeviceInfo[]>([]), [testing,setTesting] = React.useState(false), [level,setLevel] = React.useState(0), [busy,setBusy] = React.useState(false), [error,setError] = React.useState("");
    const call = React.useSyncExternalStore(media.subscribe,media.snapshot);
    React.useEffect(() => {
      async function refresh() { try { setDevices(await navigator.mediaDevices?.enumerateDevices() ?? []); } catch { setError("Device choices are unavailable. Use your system audio settings."); } }
      void refresh(); navigator.mediaDevices?.addEventListener?.("devicechange",refresh);
      return () => navigator.mediaDevices?.removeEventListener?.("devicechange",refresh);
    },[]);
    React.useEffect(() => {
      const popover = drawer.current; if (!popover) return;
      const close = () => { if (!popover.matches(":popover-open")) setTesting(false); };
      popover.addEventListener("toggle",close); return () => popover.removeEventListener("toggle",close);
    },[]);
    React.useEffect(() => {
      if (!testing) return;
      const abort = new AbortController(); let stream: MediaStream | undefined, audio: AudioContext | undefined, timer: number | undefined;
      void (async () => {
        try {
          stream = await untilCanceled(navigator.mediaDevices.getUserMedia({ audio:{ deviceId:prefs.microphone ? { exact:prefs.microphone } : undefined }, video:false }),abort.signal,stopStream);
          if (abort.signal.aborted) { stopStream(stream); return; }
          audio = new AudioContext(); await audio.resume();
          if (abort.signal.aborted) return;
          const analyser = audio.createAnalyser(); analyser.fftSize=256; audio.createMediaStreamSource(stream).connect(analyser);
          const samples = new Uint8Array(analyser.fftSize);
          const tick = () => { if (abort.signal.aborted) return; analyser.getByteTimeDomainData(samples); setLevel(Math.min(1, Math.sqrt(samples.reduce((sum,value) => sum+((value-128)/128)**2,0)/samples.length)*4)); timer=requestAnimationFrame(tick); }; tick();
          setDevices(await navigator.mediaDevices.enumerateDevices());
        } catch { if (!abort.signal.aborted) { setTesting(false); setError("Couldn’t test this microphone. Check its permission and connection."); } }
      })();
      return () => { abort.abort(); if (timer) cancelAnimationFrame(timer); stopStream(stream); void audio?.close(); setLevel(0); };
    },[testing,prefs.microphone]);
    async function change(next: Partial<AudioPreferences>) {
      const value = { ...prefs,...next }; setPrefs(value); setError("");
      try { localStorage.setItem(`meetings-audio:${key}`,JSON.stringify(value)); } catch { setError("Audio choices apply now, but couldn’t be saved on this device."); }
      setBusy(true); try { await media.configureAudio(next); } finally { setBusy(false); }
    }
    function position() {
      const bounds = anchor.current?.getBoundingClientRect(), element = drawer.current; if (!bounds || !element) return;
      element.style.left=`${Math.max(12, Math.min(innerWidth-332,bounds.left))}px`;
      if (bounds.top > 300) { element.style.top="auto"; element.style.bottom=`${innerHeight-bounds.top+8}px`; element.style.maxHeight=`${bounds.top-24}px`; } else { element.style.bottom="auto"; element.style.top=`${bounds.bottom+8}px`; element.style.maxHeight=`${innerHeight-bounds.bottom-24}px`; }
    }
    return <><button ref={anchor} type="button" className="buzz-button meeting-control" data-buzz-ui="" data-button-shape="icon" data-icon-size="sm" data-icon-shape="control" data-icon-variant="ghost" aria-label="Audio settings" title="Audio settings" popoverTarget={id} onClick={position}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg></button>
      <div ref={drawer} id={id} popover="auto" className="meeting-audio-drawer text-body-sm" role="dialog" aria-label="Audio settings"><header><h3>Audio settings</h3><button type="button" className="buzz-button" data-buzz-ui="" popoverTarget={id} popoverTargetAction="hide" aria-label="Close audio settings">×</button></header>
        <label>Microphone<select className="buzz-input" disabled={busy} value={prefs.microphone} onChange={event => change({ microphone:event.target.value })}><option value="">System default</option>{devices.filter(device => device.kind === "audioinput" && device.deviceId).map((device,index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Microphone ${index+1}`}</option>)}</select></label>
        {"setSinkId" in HTMLMediaElement.prototype ? <label>Speaker<select className="buzz-input" disabled={busy} value={prefs.output} onChange={event => change({ output:event.target.value })}><option value="">System default</option>{devices.filter(device => device.kind === "audiooutput" && device.deviceId).map((device,index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Speaker ${index+1}`}</option>)}</select></label> : <p className="text-caption text-metadata">Choose speakers in your system audio settings.</p>}
        <label className="meeting-sharing-sound"><input type="checkbox" checked={prefs.joinMuted} onChange={event => change({ joinMuted:event.target.checked })} />Join with microphone muted</label>
        <button type="button" className="buzz-button" data-buzz-ui="" data-size="sm" data-variant="subtle" onClick={() => setTesting(!testing)}>{testing ? "Stop microphone test" : "Test microphone"}</button>{testing && <meter min="0" max="1" value={level} aria-label="Microphone level" />}
        {call.deafened && <p className="text-caption text-metadata">Deafened. Turning hearing back on leaves your microphone muted.</p>}{error && <p role="alert" className="text-danger">{error}</p>}
      </div></>;
  }
  return { AudioSettings, reset:load };
}

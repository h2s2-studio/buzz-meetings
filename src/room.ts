import { isVoice, type VoiceRequest } from "./protocol";
import type { AdmissionProof } from "./workspace-voice";
import { openSharedTranscription, type SharedTranscript } from "./shared-transcription";
import {
  Room, RoomEvent, Track, VideoPresets, VideoQuality,
  type LocalVideoTrack, type RemoteTrackPublication, type LocalAudioTrack, type Participant,
} from "livekit-client";
import { openTranscription, type TranscriptSegment } from "./transcription";
import { requestRoom } from "./admission";
import { cameraError, captureError, captureScreen, limitCapture, presets, stopStream, untilCanceled, type Preset } from "./capture";
import { inviteLink, socketUrl, validOccurrence, type RoomRequest } from "./protocol";

type RoomPhase = "idle" | "connecting" | "connected" | "reconnecting";
type Capture = {
  stream: MediaStream;
  audio?: LocalAudioTrack;
  soundRequested: boolean;
  soundError?: string;
  source: MediaStreamTrack;
  published: LocalVideoTrack;
  label: string;
  preset: Preset;
  preview: MediaStream;
};
type ActiveRoom = {
  id: string;
  room: Room;
  abort: AbortController;
  invite?: { link: string; expiresAt: number };
  publish?: Capture;
  pending?: MediaStream;
  transcription: boolean;
  sharedTranscription: boolean;
  transcribing?: boolean;
  listener?: { name: string; mode: "act" | "assist"; agents?: { pubkey:string; name:string; mode:"act" | "assist" }[] };
  metadataUpdate?: Promise<void>;
  screenAudio: boolean;
  picking: boolean;
  capturePhase?: "choosing" | "preparing" | "publishing";
  screenAbort?: AbortController;
  cameraAbort?: AbortController;
  cameraPhase?: "choosing" | "publishing";
  pendingCamera?: MediaStream;
  camera?: LocalVideoTrack;
  cameraDenied?: boolean;
  stopping: boolean;
  watching?: RemoteTrackPublication;
  remote?: MediaStream;
  quality: Quality;
  ticker?: ReturnType<typeof setInterval>;
  microphone?: LocalAudioTrack;
  pendingMicrophone?: MediaStream;
  audio: Map<string, HTMLMediaElement>;
  deafened: boolean;
  broker: string;
  meeting?: VoiceRequest;
  proof?: AdmissionProof;
  roomName?: string;
  workspaceChannelId?: string;
  occurrenceId?: string;
  grid: Map<string, RemoteTrackPublication>;
};
export type AudioPreferences = { microphone: string; output: string; joinMuted: boolean };
type Quality = VideoQuality | "auto";
type Stream = { id: string; presenterId: string; presenter: string; muted: boolean };
export type RoomSnapshot = {
  /** Local per-join ID. UI lifecycle only; never persisted or used as a key. */
  joinId?: string;
  /** Media room SID: one per call, shared by every attendee. Key tasks, transcripts and records on it. */
  occurrenceId?: string;
  phase: RoomPhase;
  error?: string;
  invite?: ActiveRoom["invite"];
  picking: boolean;
  capturePhase?: ActiveRoom["capturePhase"];
  cameraPhase?: ActiveRoom["cameraPhase"];
  cameraDenied?: boolean;
  stopping: boolean;
  transcription: boolean;
  sharedTranscription: boolean;
  transcriptActive?: boolean;
  screenAudio: boolean;
  sharing?: Pick<Capture, "label" | "preset" | "preview" | "soundRequested" | "soundError"> & { sound: boolean };
  streams: Stream[];
  watching?: string;
  video?: MediaStream;
  quality: Quality;
  layers: { value: VideoQuality; height: number }[];
  roomName?: string;
  workspaceChannelId?: string;
  participants: { id: string; name: string; picture?: string; local: boolean; listener?: string; listeners?: { pubkey:string; name:string }[]; transcribing: boolean; speaking: boolean; muted: boolean; video?: MediaStream; audio?: MediaStream }[];
  muted: boolean;
  deafened: boolean;
  audioBlocked: boolean;
  screens: { id: string; presenter: string; video: MediaStream }[];
  camera: boolean;
};
const idle: RoomSnapshot = {
  phase: "idle", transcription: false, sharedTranscription: false, screenAudio: false, picking: false, stopping: false, streams: [], quality: "auto", layers: [],
  participants: [], muted: false, deafened: false, audioBlocked: false, screens: [], camera: false,
};

function layers(publication?: RemoteTrackPublication): RoomSnapshot["layers"] {
  if (!publication) return [];
  const info = publication.trackInfo;
  const codec = info?.codecs.find((item) => item.mimeType === publication.mimeType) ?? info?.codecs[0];
  const available = codec?.layers.length ? codec.layers : info?.layers ?? [];
  const choices = new Map<number, VideoQuality>();
  for (const layer of available) {
    const quality = [VideoQuality.LOW, VideoQuality.MEDIUM, VideoQuality.HIGH][layer.quality];
    if (layer.height > 0 && quality !== undefined) choices.set(layer.height, quality);
  }
  return [...choices.entries()].sort(([a], [b]) => a - b).map(([height, value]) => ({ height, value }));
}

export function makeRoomSession() {
  let active: ActiveRoom | undefined;
  let snapshot = idle;
  let preferences: AudioPreferences = { microphone: "", output: "", joinMuted: false };
  const volumes = new Map<string, number>();
  const listeners = new Set<() => void>();
  function emit(next: RoomSnapshot) {
    snapshot = next;
    for (const listener of listeners) listener();
  }

  function refresh(run: ActiveRoom, phase = snapshot.phase, error = snapshot.error) {
    if (active !== run) return;
    const streams: Stream[] = [];
    for (const participant of run.room.remoteParticipants.values()) {
      const publication = participant.getTrackPublication(Track.Source.ScreenShare);
      if (publication) streams.push({ id: publication.trackSid, presenterId: participant.identity, presenter: participant.name || "Participant", muted: publication.isMuted });
    }
    if (run.watching && !streams.some((item) => item.id === run.watching?.trackSid)) {
      run.watching = undefined;
      run.quality = "auto";
    }
    const track = run.watching?.videoTrack?.mediaStreamTrack;
    if (run.remote?.getVideoTracks()[0] !== track) {
      run.remote = track ? new MediaStream([track]) : undefined;
    }
    const available = layers(run.watching);
    for (const id of run.grid.keys()) if (!streams.some(stream => stream.id === id)) run.grid.delete(id);
    if (run.quality !== "auto" && !available.some(({ value }) => value === run.quality)) {
      run.quality = "auto";
      run.watching?.setVideoQuality(VideoQuality.HIGH);
    }
    syncScreenAudio(run);
    emit({
      joinId: run.id, occurrenceId: run.occurrenceId, screenAudio: run.screenAudio, transcription: run.transcription, sharedTranscription: run.sharedTranscription,
      transcriptActive: [...run.room.remoteParticipants.values()].some(person => person.identity.startsWith("transcription-")),
      phase, error, streams, invite: run.invite, picking: run.picking, capturePhase: run.capturePhase, cameraPhase: run.cameraPhase, cameraDenied: run.cameraDenied, stopping: run.stopping,
      sharing: run.publish && {
        label: run.publish.label, preset: run.publish.preset, preview: run.publish.preview,
        sound: !!run.publish.audio && run.publish.audio.mediaStreamTrack.readyState === "live", soundRequested: run.publish.soundRequested, soundError: run.publish.soundError,
      },
      watching: run.watching?.trackSid, video: run.remote, quality: run.quality, layers: available,
      roomName: run.roomName, workspaceChannelId: run.workspaceChannelId,
      participants: phase === "connecting" ? [] : [run.room.localParticipant, ...[...run.room.remoteParticipants.values()].filter(person => !person.identity.startsWith("transcription-"))].map((person: Participant) => {
        let picture: string | undefined; let listener: string | undefined; let agentList: {pubkey:string; name:string}[] = []; let transcribing = false;
        try { const metadata = JSON.parse(person.metadata || "{}"); picture = metadata.picture; if (Array.isArray(metadata.liveAgents)) agentList = metadata.liveAgents.slice(0,4).filter((agent: {pubkey?:unknown; name?:unknown}) => typeof agent.pubkey === "string" && /^[0-9a-f]{64}$/.test(agent.pubkey) && typeof agent.name === "string" && agent.name.length <= 64); transcribing = metadata.liveTranscription === true; if (typeof metadata.liveAgent?.name === "string") listener = metadata.liveAgent.name.slice(0,64); } catch { /* Guest without a picture. */ }
        const cameraTrack = person.isCameraEnabled ? person.getTrackPublication(Track.Source.Camera)?.videoTrack?.mediaStreamTrack : undefined;
        const previousPerson = snapshot.participants.find(item => item.id === person.identity);
        const previous = previousPerson?.video;
        const audioTrack = person.getTrackPublication(Track.Source.Microphone)?.audioTrack?.mediaStreamTrack;
        const audio = audioTrack ? previousPerson?.audio?.getAudioTracks()[0] === audioTrack ? previousPerson.audio : new MediaStream([audioTrack]) : undefined;
        return { id: person.identity, name: person.name || "Participant", picture, listener, listeners: agentList, transcribing,
          local: person === run.room.localParticipant, speaking: person.isSpeaking,
          muted: !person.isMicrophoneEnabled, audio,
          video: cameraTrack ? previous?.getVideoTracks()[0] === cameraTrack ? previous : new MediaStream([cameraTrack]) : undefined };
      }),
      muted: run.microphone?.isMuted ?? false, deafened: run.deafened,
      audioBlocked: !run.room.canPlaybackAudio,
      camera: run.room.localParticipant.isCameraEnabled,
      screens: [...run.grid].flatMap(([id, publication]) => {
        const track = publication.videoTrack?.mediaStreamTrack;
        const previous = snapshot.screens.find(screen => screen.id === id)?.video;
        return track ? [{ id, presenter: streams.find(stream => stream.id === id)?.presenter || "Participant", video: previous?.getVideoTracks()[0] === track ? previous : new MediaStream([track]) }] : [];
      }),
    });
  }

  function wantsScreenAudio(run: ActiveRoom, audio: RemoteTrackPublication) {
    for (const person of run.room.remoteParticipants.values()) {
      if (person.getTrackPublication(Track.Source.ScreenShareAudio) !== audio) continue;
      const screen = person.getTrackPublication(Track.Source.ScreenShare);
      return !!screen && (run.watching?.trackSid === screen.trackSid || run.grid.has(screen.trackSid));
    }
    return false;
  }
  function syncScreenAudio(run: ActiveRoom) {
    for (const person of run.room.remoteParticipants.values()) {
      const audio = person.getTrackPublication(Track.Source.ScreenShareAudio);
      if (!audio) continue;
      const wanted = !!run.roomName && wantsScreenAudio(run, audio);
      const element = run.audio.get(audio.trackSid);
      if (element) { element.muted = run.deafened || !wanted; if (!wanted) element.pause(); }
      if (audio.isDesired !== wanted) audio.setSubscribed(wanted);
    }
  }

  function leave(error?: string) {
    const run = active;
    active = undefined;
    if (run) {
      clearInterval(run.ticker);
      run.abort.abort();
      run.screenAbort?.abort();
      run.cameraAbort?.abort();
      stopStream(run.pending);
      stopStream(run.publish?.stream);
      run.publish?.audio?.stop();
      stopStream(run.pendingMicrophone);
      stopStream(run.pendingCamera);
      run.camera?.stop();
      run.microphone?.stop();
      run.room.localParticipant.getTrackPublication(Track.Source.Camera)?.track?.stop();
      for (const element of run.audio.values()) { element.pause(); element.srcObject = null; element.remove(); }
      run.audio.clear();
      // Every room owns separate tracks and callbacks. An old SDK disconnect
      // must not block joining a new room after a stalled native capture.
      void run.room.disconnect().catch(() => {});
    }
    emit({ ...idle, error });
  }

  async function connect(brokerInput: string, request: RoomRequest, preset?: Preset, proof?: AdmissionProof) {
    if (active) return;
    let broker: string;
    try {
      broker = socketUrl(brokerInput);
    } catch {
      return leave("Enter a secure room service URL ending in /rooms.");
    }
    const room = new Room({ dynacast: true });
    const run: ActiveRoom = { id: crypto.randomUUID(), room, abort: new AbortController(), quality: "auto", picking: preset !== undefined, stopping: false,
      audio: new Map(), grid: new Map(), screenAudio: false, transcription: false, sharedTranscription: false, broker, meeting: isVoice(request) ? request : undefined, proof, workspaceChannelId: request.type === "workspace" ? request.channel : undefined, deafened: false, roomName: isVoice(request) ? request.room : undefined };
    active = run;
    refresh(run, "connecting", "");
    const sync = () => refresh(run);
    room
      .on(RoomEvent.ParticipantConnected, (person) => {
        for (const publication of person.trackPublications.values()) {
          if (publication.source === Track.Source.Microphone || publication.source === Track.Source.Camera) publication.setSubscribed(true);
        }
        sync();
      })
      .on(RoomEvent.ParticipantDisconnected, sync)
      .on(RoomEvent.TrackPublished, (publication) => {
        if (isVoice(request) && [Track.Source.Microphone, Track.Source.Camera].includes(publication.source)) publication.setSubscribed(true);
        sync();
      })
      .on(RoomEvent.TrackUnpublished, sync)
      .on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
        if (active !== run) return;
        if (isVoice(request) && track.kind === Track.Kind.Audio) {
          if (publication.source === Track.Source.ScreenShareAudio && !wantsScreenAudio(run, publication)) { publication.setSubscribed(false); return; }
          const existing = run.audio.get(publication.trackSid);
          if (existing) { existing.pause(); existing.srcObject = null; existing.remove(); }
          const element = track.attach();
          element.muted = run.deafened;
          element.volume = volumes.get(participant.identity) ?? 1;
          if (preferences.output && "setSinkId" in element) void (element as HTMLAudioElement & { setSinkId(id: string): Promise<void> }).setSinkId(preferences.output).catch(() => refresh(run, undefined, "Couldn’t use that audio output. Check Audio settings."));
          element.setAttribute("data-meeting-audio", publication.trackSid);
          element.setAttribute("data-meeting-source", publication.source);
          run.audio.set(publication.trackSid, element);
          document.body.append(element);
          void element.play().catch(sync);
        }
        sync();
      })
      .on(RoomEvent.TrackUnsubscribed, (track, publication) => {
        const owned = run.audio.get(publication.trackSid);
        if (owned) { owned.pause(); owned.srcObject = null; owned.remove(); }
        for (const element of track.detach()) { element.pause(); element.srcObject = null; element.remove(); }
        run.audio.delete(publication.trackSid);
        sync();
      })
      .on(RoomEvent.ActiveSpeakersChanged, sync)
      .on(RoomEvent.AudioPlaybackStatusChanged, sync)
      .on(RoomEvent.ParticipantMetadataChanged, sync)
      .on(RoomEvent.TrackMuted, sync)
      .on(RoomEvent.TrackUnmuted, sync)
      .on(RoomEvent.TrackSubscriptionFailed, (sid) => {
        if (run.watching?.trackSid === sid) {
          changeWatch(undefined);
          refresh(run, undefined, "Couldn’t load that stream. Try watching it again.");
        }
      })
      .on(RoomEvent.Reconnecting, () => refresh(run, "reconnecting"))
      // A full reconnect can land in a new room once the old one closed.
      .on(RoomEvent.Reconnected, () => { refresh(run, "connected"); void confirmOccurrence(run); })
      .on(RoomEvent.Disconnected, () => {
        if (active === run && snapshot.phase !== "connecting") leave("The sharing session disconnected.");
      });

    let source: MediaStream | undefined;
    try {
      if (isVoice(request)) {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error("Microphone capture isn’t available in this Buzz installation.");
        // Acquire from this explicit room click, before network work. A canceled
        // permission prompt must never leave capture running in another room.
        const stream = await untilCanceled(navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, ...(preferences.microphone ? { deviceId: { exact: preferences.microphone } } : {}) }, video: false }), run.abort.signal, stopStream);
        if (active !== run) { stopStream(stream); return; }
        run.pendingMicrophone = stream;
        void room.startAudio().catch(sync);
      }
      if (preset) {
        try {
          source = await pickSource(run, preset);
        } catch (error) {
          if (active === run) leave(captureError(error));
          return;
        }
        if (!source || active !== run) return;
        run.picking = false;
        refresh(run);
      }
      const admission = await requestRoom(broker, request, run.abort.signal, run.proof);
      if (active !== run) return;
      run.transcription = isVoice(request) && admission.capabilities?.transcription === true;
      run.sharedTranscription = isVoice(request) && admission.capabilities?.sharedTranscription === true;
      run.screenAudio = isVoice(request) && admission.capabilities?.screenAudio === true;
      if (admission.invite) {
        run.invite = {
          link: inviteLink({ broker, code: admission.invite.code }),
          expiresAt: admission.invite.expiresAt,
        };
      }
      try {
        if (active !== run) return;
        await room.connect(admission.url, admission.token, { autoSubscribe: false, maxRetries: 0 });
      } catch {
        throw new Error("Couldn’t connect to the video service. Check the room service’s LiveKit setup.");
      }
      if (active !== run) {
        await room.disconnect();
        return;
      }
      run.occurrenceId = validOccurrence(admission.occurrenceId) ? admission.occurrenceId : undefined;
      await confirmOccurrence(run);
      if (active !== run) return;
      if (source && preset) await publishSource(run, source, preset);
      if (run.pendingMicrophone) {
        const track = run.pendingMicrophone.getAudioTracks()[0];
        if (!track || track.readyState !== "live") throw new Error("The microphone is unavailable.");
        const publication = await room.localParticipant.publishTrack(track, { source: Track.Source.Microphone });
        if (active !== run) { track.stop(); await room.disconnect(); return; }
        run.microphone = publication.audioTrack;
        if (!run.microphone) throw new Error("Couldn’t publish microphone audio.");
        if (preferences.joinMuted) { track.enabled = false; await run.microphone.mute(); }
        track.addEventListener("ended", () => { if (active === run && run.microphone?.mediaStreamTrack === track) leave("The microphone disconnected. Join the room to try again."); }, { once: true });
        for (const person of room.remoteParticipants.values()) {
          person.getTrackPublication(Track.Source.Microphone)?.setSubscribed(true);
          person.getTrackPublication(Track.Source.Camera)?.setSubscribed(true);
        }
      }
      if (active !== run) return;
      run.pending = undefined;
      // The SFU can advertise its encodings after announcing the publication.
      run.ticker = setInterval(sync, 2000);
      refresh(run, "connected", "");
    } catch (error) {
      if (active === run) leave(error instanceof DOMException && error.name === "NotAllowedError"
        ? "Microphone permission was denied. Allow microphone access, then join again."
        : error instanceof Error ? error.message : "Couldn’t join the meeting.");
    }
  }

  // The joined room's SID is authoritative. The broker's value is only a
  // pre-connect hint: the room can close between admission and connection.
  async function confirmOccurrence(run: ActiveRoom) {
    try {
      const sid = await untilCanceled(run.room.getSid(), AbortSignal.any([run.abort.signal, AbortSignal.timeout(5000)]));
      if (active === run && validOccurrence(sid) && sid !== run.occurrenceId) { run.occurrenceId = sid; refresh(run); }
    } catch { /* Keep the broker's value; a missing SID leaves occurrence-keyed work unavailable. */ }
  }

  async function setMuted(muted: boolean) {
    const run = active;
    if (!run?.microphone || snapshot.phase !== "connected" || (!muted && run.deafened)) return;
    try {
      if (muted) run.microphone.mediaStreamTrack.enabled = false;
      if (muted) await run.microphone.mute(); else await run.microphone.unmute();
      refresh(run);
    } catch { refresh(run, undefined, "Couldn’t change the microphone. Leave and rejoin to retry."); }
  }

  async function configureAudio(next: Partial<AudioPreferences>) {
    preferences = { ...preferences, ...next };
    const run = active; if (!run || snapshot.phase !== "connected") return;
    try {
      if (next.microphone !== undefined && run.microphone) {
        const stream = await untilCanceled(navigator.mediaDevices.getUserMedia({ audio: { deviceId: preferences.microphone ? { exact:preferences.microphone } : undefined, echoCancellation:true, noiseSuppression:true }, video:false }), run.abort.signal, stopStream);
        if (active !== run) { stopStream(stream); return; }
        const track = stream.getAudioTracks()[0], previous = run.microphone.mediaStreamTrack, muted = run.microphone.isMuted;
        if (!track) throw new Error("No microphone track.");
        track.enabled = !muted;
        await run.microphone.replaceTrack(track, true);
        previous.stop();
        if (active !== run) { track.stop(); return; }
        track.addEventListener("ended", () => { if (active === run && run.microphone?.mediaStreamTrack === track) leave("The microphone disconnected. Choose an available device and rejoin."); },{ once:true });
      }
      if (next.output !== undefined) for (const element of run.audio.values()) {
        if ("setSinkId" in element) await (element as HTMLAudioElement & { setSinkId(id:string):Promise<void> }).setSinkId(preferences.output);
      }
      refresh(run);
    } catch { if (active === run) refresh(run,undefined,"Couldn’t switch audio devices. Choose an available device in Audio settings."); }
  }
  function setVolume(participantId: string, value: number) {
    if (!Number.isFinite(value)) return;
    const volume = Math.max(0,Math.min(1,value)); volumes.set(participantId,volume);
    const run = active; if (!run) return;
    const person = run.room.remoteParticipants.get(participantId);
    for (const publication of person?.audioTrackPublications.values() ?? []) { const element = run.audio.get(publication.trackSid); if (element) element.volume=volume; }
  }
  async function setDeafened(deafened: boolean) {
    const run = active;
    if (!run || snapshot.phase !== "connected") return;
    run.deafened = deafened;
    for (const element of run.audio.values()) element.muted = deafened;
    if (deafened) await setMuted(true);
    refresh(run);
  }

  async function resumeAudio() {
    const run = active;
    if (!run) return;
    try { await run.room.startAudio(); refresh(run); }
    catch { refresh(run, undefined, "Audio playback is blocked. Check this app’s audio permissions."); }
  }

  async function setCamera(enabled: boolean) {
    const run = active;
    if (!run || snapshot.phase !== "connected" || run.cameraAbort) return;
    if (!enabled) {
      const camera = run.camera;
      if (!camera) return;
      camera.stop(); run.camera = undefined;
      try { await run.room.localParticipant.unpublishTrack(camera); refresh(run, undefined, ""); }
      catch { refresh(run, undefined, "Couldn’t stop camera video. Leave the room to disconnect it."); }
      return;
    }
    const operation = new AbortController(); run.cameraAbort = operation; run.cameraPhase = "choosing"; run.cameraDenied = false;
    refresh(run, undefined, "");
    try {
      // Own device acquisition outside the SDK, so leaving/canceling can retire
      // an unresolved OS request without leaving a pending SDK publication.
      const stream = await untilCanceled(navigator.mediaDevices.getUserMedia({ audio: false, video: { width: { ideal: 640 }, height: { ideal: 360 } } }), operation.signal, stopStream);
      if (active !== run) { stopStream(stream); return; }
      run.pendingCamera = stream;
      const track = stream.getVideoTracks()[0];
      if (!track || track.readyState !== "live") throw new Error("No live camera track");
      run.cameraPhase = "publishing"; refresh(run);
      const publication = await run.room.localParticipant.publishTrack(track, { source: Track.Source.Camera });
      if (active !== run) {
        stopStream(stream); publication.track?.stop();
        if (publication.track) await run.room.localParticipant.unpublishTrack(publication.track).catch(() => {});
        return;
      }
      if (!publication.videoTrack) throw new Error("No camera publication");
      run.camera = publication.videoTrack;
      run.pendingCamera = undefined;
      track.addEventListener("ended", () => { if (active === run && run.camera === publication.videoTrack) void setCamera(false); }, { once: true });
      refresh(run, undefined, "");
    } catch (error) {
      if (!operation.signal.aborted) {
        run.cameraDenied = error instanceof DOMException && ["NotAllowedError", "SecurityError"].includes(error.name);
        refresh(run, undefined, cameraError(error));
      }
    } finally {
      stopStream(run.pendingCamera); run.pendingCamera = undefined;
      run.cameraAbort = undefined; run.cameraPhase = undefined; refresh(run);
    }
  }

  function cancelCamera() {
    const run = active;
    if (!run || run.cameraPhase !== "choosing") return;
    run.cameraAbort?.abort();
  }

  function cancelScreen() {
    const run = active;
    if (!run || run.capturePhase === "publishing") return;
    run.screenAbort?.abort();
    stopStream(run.pending);
  }

  function changeWatch(id?: string) {
    const run = active;
    if (!run || (id && snapshot.phase !== "connected")) return;
    if (run.watching?.trackSid === id && !run.grid.size) return;
    for (const publication of run.grid.values()) publication.setSubscribed(false);
    run.grid.clear();
    run.watching?.setSubscribed(false);
    run.watching = undefined;
    run.quality = "auto";
    if (id) {
      for (const participant of run.room.remoteParticipants.values()) {
        const candidate = participant.getTrackPublication(Track.Source.ScreenShare);
        if (candidate?.trackSid === id) {
          run.watching = candidate;
          candidate.setSubscribed(true);
          candidate.setVideoQuality(VideoQuality.HIGH);
          break;
        }
      }
    }
    refresh(run, undefined, "");
  }

  function watchAll() {
    const run = active;
    if (!run || snapshot.phase !== "connected") return;
    run.watching = undefined;
    run.quality = "auto";
    for (const person of run.room.remoteParticipants.values()) {
      const publication = person.getTrackPublication(Track.Source.ScreenShare);
      if (publication) { run.grid.set(publication.trackSid, publication); publication.setSubscribed(true); publication.setVideoQuality(VideoQuality.MEDIUM); }
    }
    refresh(run);
  }

  function quality(value: Quality) {
    const run = active;
    if (!run?.watching || (value !== "auto" && !snapshot.layers.some((layer) => layer.value === value))) return;
    run.quality = value;
    run.watching.setVideoQuality(value === "auto" ? VideoQuality.HIGH : value);
    refresh(run, undefined, "");
  }

  async function stopSharing() {
    const run = active;
    if (!run || !run.publish) return;
    cancelScreen();
    const capture = run.publish;
    run.publish = undefined;
    run.stopping = true;
    stopStream(run.pending);
    stopStream(capture.stream);
    capture.audio?.stop();
    refresh(run);
    try {
      await Promise.all([run.room.localParticipant.unpublishTrack(capture.published), ...(capture.audio ? [run.room.localParticipant.unpublishTrack(capture.audio)] : [])]);
    } catch {
      if (active === run) leave("The sharing session closed while stopping the stream.");
    } finally {
      run.stopping = false;
      refresh(run);
    }
  }

  async function pickSource(run: ActiveRoom, preset: Preset, previous?: Capture, sound = false) {
    run.capturePhase = "choosing";
    refresh(run);
    const signal = run.screenAbort?.signal ?? run.abort.signal;
    const incoming = await untilCanceled(captureScreen(preset, sound && run.screenAudio), signal, stopStream);
    const source = incoming.getVideoTracks()[0];
    if (active !== run || run.publish !== previous) {
      stopStream(incoming);
      return;
    }
    if (!source || source.readyState !== "live") {
      stopStream(incoming);
      throw new Error("The selected source is unavailable.");
    }
    // Keep one video and, only when requested and admitted, one audio track.
    const audio = sound && run.screenAudio ? incoming.getAudioTracks()[0] : undefined;
    for (const track of incoming.getTracks()) if (track !== source && track !== audio) track.stop();
    run.pending = incoming;
    run.capturePhase = "preparing";
    refresh(run);
    await untilCanceled(limitCapture(source, preset), signal);
    if (active !== run || run.publish !== previous) {
      stopStream(incoming);
      return;
    }
    return incoming;
  }

  async function publishSource(run: ActiveRoom, stream: MediaStream, preset: Preset, previous?: Capture, soundRequested = false) {
    const source = stream.getVideoTracks()[0];
    if (!source || source.readyState !== "live") throw new Error("The selected source is unavailable.");
    run.capturePhase = "publishing";
    refresh(run);
    let published: LocalVideoTrack | undefined;
    if (previous) {
      published = await previous.published.replaceTrack(source);
    } else {
      const publication = await run.room.localParticipant.publishTrack(source, {
        source: Track.Source.ScreenShare,
        simulcast: true,
        videoCodec: "vp8",
        screenShareEncoding: presets[preset].video.encoding,
        screenShareSimulcastLayers: preset === "sharp"
          ? [VideoPresets.h360, VideoPresets.h720]
          : [VideoPresets.h360],
      });
      published = publication.videoTrack;
    }
    if (active !== run || run.publish !== previous) {
      stopStream(stream); published?.stop();
      if (published) await run.room.localParticipant.unpublishTrack(published).catch(() => {});
      return;
    }
    if (!published || source.readyState !== "live") {
      if (published) await run.room.localParticipant.unpublishTrack(published);
      if (previous) await stopSharing();
      throw new Error("The selected source is unavailable.");
    }
    // Commit the video before changing sound. Stop the old source's audio before
    // publishing the new one; a failed sound publication keeps the new video visible.
    if (previous?.audio) {
      previous.audio.stop();
      await run.room.localParticipant.unpublishTrack(previous.audio).catch(() => {});
    }
    stopStream(previous?.stream);
    let audio: LocalAudioTrack | undefined;
    let soundError: string | undefined;
    const audioSource = stream.getAudioTracks().find(track => track.readyState === "live");
    if (soundRequested && run.screenAudio && audioSource) {
      try {
        const publication = await run.room.localParticipant.publishTrack(audioSource, { source: Track.Source.ScreenShareAudio });
        audio = publication.audioTrack;
        if (!audio) throw new Error("No shared audio publication");
      } catch {
        audioSource.stop();
        soundError = "Your screen is shared, but sound could not be sent. Change source to try again.";
      }
    } else {
      audioSource?.stop();
      if (soundRequested) soundError = "The picker returned no audio. Your screen is shared without sound.";
    }
    if (active !== run || run.publish !== previous || source.readyState !== "live") {
      stopStream(stream); published.stop(); audio?.stop();
      await Promise.all([run.room.localParticipant.unpublishTrack(published).catch(() => {}), ...(audio ? [run.room.localParticipant.unpublishTrack(audio).catch(() => {})] : [])]);
      if (active === run && run.publish === previous && source.readyState !== "live") {
        if (previous) await stopSharing();
        throw new Error("The selected source stopped before sharing began.");
      }
      return;
    }
    const surface = source.getSettings().displaySurface;
    const label = source.label || ({ monitor: "Entire screen", window: "Window", browser: "Tab" }[surface ?? ""] ?? "Screen");
    const capture: Capture = { stream, audio, soundRequested, soundError, source, published, label, preset, preview: new MediaStream([source]) };
    run.publish = capture;
    audioSource?.addEventListener("ended", () => {
      if (active !== run || run.publish !== capture) return;
      const ended = capture.audio; capture.audio = undefined;
      capture.soundError = "Shared sound stopped. Your screen is still being shared.";
      if (ended) void run.room.localParticipant.unpublishTrack(ended).catch(() => {});
      refresh(run);
    }, { once: true });
    source.addEventListener("ended", () => {
      if (active === run && run.publish === capture) void stopSharing();
    }, { once: true });
  }

  async function share(preset: Preset, sound = false) {
    const run = active;
    if (!run || run.picking || run.stopping || snapshot.phase !== "connected") return;
    const previous = run.publish;
    run.picking = true;
    const operation = new AbortController(); run.screenAbort = operation;
    refresh(run, undefined, "");
    let source: MediaStream | undefined;
    try {
      source = await pickSource(run, preset, previous, sound);
      if (source) await publishSource(run, source, preset, previous, sound);
    } catch (error) {
      if (active === run && run.publish === previous && !operation.signal.aborted) {
        if (previous && source && previous.published.mediaStreamTrack === source.getVideoTracks()[0]) {
          try {
            await previous.published.replaceTrack(previous.source);
          } catch {
            await stopSharing();
          }
        }
        refresh(run, undefined, source ? "Couldn’t publish the selected source." : captureError(error));
      }
    } finally {
      if (run.publish?.stream !== run.pending) stopStream(run.pending);
      run.pending = undefined;
      run.picking = false;
      run.capturePhase = undefined;
      run.screenAbort = undefined;
      refresh(run);
    }
  }

  function updateMetadata(run: ActiveRoom) {
    const update = (run.metadataUpdate ?? Promise.resolve()).catch(() => {}).then(async () => {
      if (active !== run) return;
      let picture: string | undefined;
      try { const metadata = JSON.parse(run.room.localParticipant.metadata || "{}"); if (typeof metadata.picture === "string") picture = metadata.picture; } catch { /* No profile image. */ }
      await run.room.localParticipant.setMetadata(JSON.stringify({ ...(run.meeting?.type === "workspace" ? { channel:run.meeting.channel } : {}), ...(picture ? { picture } : {}), ...(run.transcribing ? { liveTranscription: true } : {}), ...(run.listener ? { liveAgent: { name: run.listener.name.slice(0,64), mode: run.listener.mode }, liveAgents: run.listener.agents?.slice(0,4) } : {}) }));
      refresh(run);
    });
    run.metadataUpdate = update;
    return update;
  }
  async function setListener(callId: string, listener?: ActiveRoom["listener"]) {
    const run = active; if (!run || run.id !== callId) return;
    run.listener = listener;
    await updateMetadata(run);
  }
  async function setTranscribing(callId: string, value: boolean) {
    const run = active; if (!run || run.id !== callId) return;
    run.transcribing = value;
    await updateMetadata(run);
  }
  function captions(signal: AbortSignal, receive: (packet: SharedTranscript) => void, failed: (error: string) => void) {
    const run = active;
    if (!run?.meeting || !run.sharedTranscription || snapshot.phase !== "connected") return Promise.reject(new Error("Shared transcription is unavailable."));
    return openSharedTranscription(run.broker, run.meeting, signal, receive, failed, run.proof);
  }
  function transcribe(signal: AbortSignal, receive: (segments: TranscriptSegment[]) => void, failed: (error: string) => void) {
    const run = active;
    if (!run?.meeting || run.meeting.type !== "meeting" || !run.transcription || snapshot.phase !== "connected") return Promise.reject(new Error("Live transcription requires an updated meeting service with speech support."));
    return openTranscription(run.broker, run.meeting, signal, receive, failed);
  }
  return {
    configureAudio, audioPreferences: () => preferences, setVolume, volume: (id:string) => volumes.get(id) ?? 1,
    setListener, setTranscribing, transcribe, captions, connect, leave, changeWatch, watchAll, quality, share, stopSharing, setMuted, setDeafened, resumeAudio, setCamera, cancelCamera, cancelScreen,
    snapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

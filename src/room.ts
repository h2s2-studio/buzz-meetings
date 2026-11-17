import {
  Room, RoomEvent, Track, VideoPresets, VideoQuality,
  type LocalVideoTrack, type RemoteTrackPublication, type LocalAudioTrack, type Participant,
} from "livekit-client";
import { requestRoom } from "./admission";
import { captureError, captureScreen, limitCapture, presets, stopStream, type Preset } from "./capture";
import { inviteLink, socketUrl, type RoomRequest } from "./protocol";

type RoomPhase = "idle" | "connecting" | "connected" | "reconnecting";
type Capture = {
  source: MediaStreamTrack;
  published: LocalVideoTrack;
  label: string;
  preset: Preset;
  preview: MediaStream;
};
type ActiveRoom = {
  room: Room;
  abort: AbortController;
  invite?: { link: string; expiresAt: number };
  publish?: Capture;
  pending?: MediaStreamTrack;
  picking: boolean;
  stopping: boolean;
  watching?: RemoteTrackPublication;
  remote?: MediaStream;
  quality: Quality;
  ticker?: ReturnType<typeof setInterval>;
  microphone?: LocalAudioTrack;
  pendingMicrophone?: MediaStream;
  audio: Map<string, HTMLMediaElement>;
  deafened: boolean;
  roomName?: string;
  grid: Map<string, RemoteTrackPublication>;
};
type Quality = VideoQuality | "auto";
type Stream = { id: string; presenter: string; muted: boolean };
export type RoomSnapshot = {
  phase: RoomPhase;
  error?: string;
  invite?: ActiveRoom["invite"];
  picking: boolean;
  stopping: boolean;
  sharing?: Pick<Capture, "label" | "preset" | "preview">;
  streams: Stream[];
  watching?: string;
  video?: MediaStream;
  quality: Quality;
  layers: { value: VideoQuality; height: number }[];
  roomName?: string;
  participants: { id: string; name: string; picture?: string; local: boolean; speaking: boolean; muted: boolean; video?: MediaStream }[];
  muted: boolean;
  deafened: boolean;
  audioBlocked: boolean;
  screens: { id: string; presenter: string; video: MediaStream }[];
  camera: boolean;
};
const idle: RoomSnapshot = {
  phase: "idle", picking: false, stopping: false, streams: [], quality: "auto", layers: [],
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
  let teardown: Promise<void> = Promise.resolve();
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
      if (publication) streams.push({ id: publication.trackSid, presenter: participant.name || "Participant", muted: publication.isMuted });
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
    emit({
      phase, error, streams, invite: run.invite, picking: run.picking, stopping: run.stopping,
      sharing: run.publish && {
        label: run.publish.label, preset: run.publish.preset, preview: run.publish.preview,
      },
      watching: run.watching?.trackSid, video: run.remote, quality: run.quality, layers: available,
      roomName: run.roomName,
      participants: phase === "connecting" ? [] : [run.room.localParticipant, ...run.room.remoteParticipants.values()].map((person: Participant) => {
        let picture: string | undefined;
        try { picture = JSON.parse(person.metadata || "{}").picture; } catch { /* Guest without a picture. */ }
        const cameraTrack = person.isCameraEnabled ? person.getTrackPublication(Track.Source.Camera)?.videoTrack?.mediaStreamTrack : undefined;
        const previous = snapshot.participants.find(item => item.id === person.identity)?.video;
        return { id: person.identity, name: person.name || "Participant", picture,
          local: person === run.room.localParticipant, speaking: person.isSpeaking,
          muted: !person.isMicrophoneEnabled,
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

  function leave(error?: string) {
    const run = active;
    active = undefined;
    if (run) {
      clearInterval(run.ticker);
      run.abort.abort();
      run.pending?.stop();
      run.publish?.source.stop();
      stopStream(run.pendingMicrophone);
      run.microphone?.stop();
      run.room.localParticipant.getTrackPublication(Track.Source.Camera)?.track?.stop();
      for (const element of run.audio.values()) { element.pause(); element.srcObject = null; element.remove(); }
      run.audio.clear();
      teardown = run.room.disconnect().catch(() => {});
    }
    emit({ ...idle, error });
  }

  async function connect(brokerInput: string, request: RoomRequest, preset?: Preset) {
    if (active) return;
    let broker: string;
    try {
      broker = socketUrl(brokerInput);
    } catch {
      return leave("Enter a secure room service URL ending in /rooms.");
    }
    const room = new Room({ dynacast: true });
    const run: ActiveRoom = { room, abort: new AbortController(), quality: "auto", picking: preset !== undefined, stopping: false,
      audio: new Map(), grid: new Map(), deafened: false, roomName: request.type === "meeting" ? request.room : undefined };
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
        if (request.type === "meeting" && [Track.Source.Microphone, Track.Source.Camera].includes(publication.source)) publication.setSubscribed(true);
        sync();
      })
      .on(RoomEvent.TrackUnpublished, sync)
      .on(RoomEvent.TrackSubscribed, (track, publication) => {
        if (active !== run) return;
        if (request.type === "meeting" && track.kind === Track.Kind.Audio) {
          const element = track.attach();
          element.muted = run.deafened;
          element.setAttribute("data-meeting-audio", publication.trackSid);
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
      .on(RoomEvent.Reconnected, () => refresh(run, "connected"))
      .on(RoomEvent.Disconnected, () => {
        if (active === run && snapshot.phase !== "connecting") leave("The sharing session disconnected.");
      });

    let source: MediaStreamTrack | undefined;
    try {
      if (request.type === "meeting") {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error("Microphone capture isn’t available in this Buzz installation.");
        // Acquire from this explicit room click, before network work. A canceled
        // permission prompt must never leave capture running in another room.
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
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
      const admission = await requestRoom(broker, request, run.abort.signal);
      if (active !== run) return;
      if (admission.invite) {
        run.invite = {
          link: inviteLink({ broker, code: admission.invite.code }),
          expiresAt: admission.invite.expiresAt,
        };
      }
      try {
        await teardown;
        if (active !== run) return;
        await room.connect(admission.url, admission.token, { autoSubscribe: false, maxRetries: 0 });
      } catch {
        throw new Error("Couldn’t connect to the video service. Check the room service’s LiveKit setup.");
      }
      if (active !== run) {
        await room.disconnect();
        return;
      }
      if (source && preset) await publishSource(run, source, preset);
      if (run.pendingMicrophone) {
        const track = run.pendingMicrophone.getAudioTracks()[0];
        if (!track || track.readyState !== "live") throw new Error("The microphone is unavailable.");
        const publication = await room.localParticipant.publishTrack(track, { source: Track.Source.Microphone });
        if (active !== run) { track.stop(); await room.disconnect(); return; }
        run.microphone = publication.audioTrack;
        if (!run.microphone) throw new Error("Couldn’t publish microphone audio.");
        track.addEventListener("ended", () => { if (active === run) leave("The microphone disconnected. Join the room to try again."); }, { once: true });
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

  async function setMuted(muted: boolean) {
    const run = active;
    if (!run?.microphone || snapshot.phase !== "connected" || (!muted && run.deafened)) return;
    try {
      if (muted) run.microphone.mediaStreamTrack.enabled = false;
      if (muted) await run.microphone.mute(); else await run.microphone.unmute();
      refresh(run);
    } catch { refresh(run, undefined, "Couldn’t change the microphone. Leave and rejoin to retry."); }
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
    if (!run || snapshot.phase !== "connected") return;
    try {
      const publication = await run.room.localParticipant.setCameraEnabled(enabled, { resolution: { width: 640, height: 360 } });
      if (active !== run) { publication?.track?.stop(); return; }
      refresh(run);
    } catch { refresh(run, undefined, "Couldn’t open the camera. Check camera permissions and try again."); }
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
    const capture = run.publish;
    run.publish = undefined;
    run.stopping = true;
    capture.source.stop();
    refresh(run);
    try {
      await run.room.localParticipant.unpublishTrack(capture.published);
    } catch {
      if (active === run) leave("The sharing session closed while stopping the stream.");
    } finally {
      run.stopping = false;
      refresh(run);
    }
  }

  async function pickSource(run: ActiveRoom, preset: Preset, previous?: Capture) {
    const incoming = await captureScreen(preset);
    const source = incoming.getVideoTracks()[0];
    if (active !== run || run.publish !== previous) {
      stopStream(incoming);
      return;
    }
    if (!source || source.readyState !== "live") {
      stopStream(incoming);
      throw new Error("The selected source is unavailable.");
    }
    run.pending = source;
    await limitCapture(source, preset);
    if (active !== run || run.publish !== previous) return;
    return source;
  }

  async function publishSource(run: ActiveRoom, source: MediaStreamTrack, preset: Preset, previous?: Capture) {
    if (source.readyState !== "live") throw new Error("The selected source is unavailable.");
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
    if (active !== run || run.publish !== previous) return;
    if (!published || source.readyState !== "live") {
      if (published) await run.room.localParticipant.unpublishTrack(published);
      if (previous) await stopSharing();
      throw new Error("The selected source is unavailable.");
    }
    previous?.source.stop();
    const surface = source.getSettings().displaySurface;
    const label = source.label || ({ monitor: "Entire screen", window: "Window", browser: "Tab" }[surface ?? ""] ?? "Screen");
    const capture = { source, published, label, preset, preview: new MediaStream([source]) };
    run.publish = capture;
    source.addEventListener("ended", () => {
      if (active === run && run.publish === capture) void stopSharing();
    }, { once: true });
  }

  async function share(preset: Preset) {
    const run = active;
    if (!run || run.picking || run.stopping || snapshot.phase !== "connected") return;
    const previous = run.publish;
    preset = previous?.preset ?? preset;
    run.picking = true;
    refresh(run, undefined, "");
    let source: MediaStreamTrack | undefined;
    try {
      source = await pickSource(run, preset, previous);
      if (source) await publishSource(run, source, preset, previous);
    } catch (error) {
      if (active === run && run.publish === previous) {
        if (previous && source && previous.published.mediaStreamTrack === source) {
          try {
            await previous.published.replaceTrack(previous.source);
          } catch {
            await stopSharing();
          }
        }
        refresh(run, undefined, source ? "Couldn’t publish the selected source." : captureError(error));
      }
    } finally {
      if (run.publish?.source !== run.pending) run.pending?.stop();
      run.pending = undefined;
      run.picking = false;
      refresh(run);
    }
  }

  return {
    connect, leave, changeWatch, watchAll, quality, share, stopSharing, setMuted, setDeafened, resumeAudio, setCamera,
    snapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

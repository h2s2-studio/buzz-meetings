// Speaker identity comes from one LiveKit microphone publication per capture graph.
export type Speaker = { id: string; name: string; audio?: MediaStream; muted: boolean };
export type SpeechChunk = { speakerId: string; speakerName: string; startedAt: number; endedAt: number; samples: Float32Array };
export function wav16(samples: Float32Array) {
  const bytes = new Uint8Array(44 + samples.length * 2), view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i); };
  text(0, "RIFF"); view.setUint32(4, bytes.length - 8, true); text(8, "WAVE"); text(12, "fmt "); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, "data"); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), true);
  return bytes;
}

export class SpeechSegments {
  private parts: Float32Array[] = [];
  private pre?: Float32Array;
  private count = 0;
  private started = 0;
  private silence = 0;
  private readonly speaker: () => { id: string; name: string };
  private readonly emit: (chunk: SpeechChunk) => void;
  constructor(speaker: () => { id: string; name: string }, emit: (chunk: SpeechChunk) => void) { this.speaker = speaker; this.emit = emit; }
  push(samples: Float32Array, endedAt: number) {
    let energy = 0; for (const sample of samples) energy += sample * sample;
    const speech = Math.sqrt(energy / Math.max(1, samples.length)) > 0.012;
    if (!this.count && !speech) { this.pre = samples; return; }
    if (!this.count) {
      this.started = endedAt - (samples.length + (this.pre?.length ?? 0)) / 16;
      if (this.pre) { this.parts.push(this.pre); this.count += this.pre.length; this.pre = undefined; }
    }
    this.parts.push(samples); this.count += samples.length;
    this.silence = speech ? 0 : this.silence + samples.length;
    if (this.count >= 128000 || this.silence >= 11200) this.flush();
  }
  flush() {
    if (this.count >= 6400) {
      const samples = new Float32Array(this.count); let offset = 0;
      for (const part of this.parts) { samples.set(part, offset); offset += part.length; }
      const speaker = this.speaker();
      this.emit({ speakerId: speaker.id, speakerName: speaker.name, startedAt: Math.round(this.started), endedAt: Math.round(this.started + samples.length / 16), samples });
    }
    this.parts = []; this.count = 0; this.silence = 0; this.pre = undefined;
  }
}

export function captureSpeakers(context: AudioContext, emit: (chunk: SpeechChunk) => void) {
  const sources = new Map<string, { track: MediaStreamTrack; speaker: Speaker; close(flush: boolean): void }>();
  const epoch = Date.now() - context.currentTime * 1000;
  function update(speakers: readonly Speaker[]) {
    const live = new Set(speakers.filter(speaker => speaker.audio?.getAudioTracks()[0]?.readyState === "live").map(speaker => speaker.id));
    for (const [id, source] of sources) if (!live.has(id)) { source.close(true); sources.delete(id); }
    for (const speaker of speakers) {
      const track = speaker.audio?.getAudioTracks()[0]; if (!track || track.readyState !== "live") continue;
      const existing = sources.get(speaker.id);
      if (existing?.track === track) { existing.speaker = speaker; continue; }
      existing?.close(true);
      const source = context.createMediaStreamSource(new MediaStream([track]));
      const processor = context.createScriptProcessor(4096, 1, 1), silence = context.createGain(); silence.gain.value = 0;
      let phase = 0, sum = 0, count = 0;
      const entry = { track, speaker, close(flush: boolean) { processor.onaudioprocess = null; source.disconnect(); processor.disconnect(); silence.disconnect(); if (flush) segments.flush(); } };
      const segments = new SpeechSegments(() => entry.speaker, emit);
      processor.onaudioprocess = event => {
        const input = event.inputBuffer.getChannelData(0), output: number[] = [];
        for (const sample of input) {
          sum += entry.speaker.muted ? 0 : sample; count++; phase += 16000;
          if (phase >= context.sampleRate) { output.push(sum / count); phase -= context.sampleRate; sum = 0; count = 0; }
        }
        segments.push(Float32Array.from(output), epoch + context.currentTime * 1000);
      };
      source.connect(processor); processor.connect(silence); silence.connect(context.destination);
      sources.set(speaker.id, entry);
    }
  }
  return { update, close() { for (const source of sources.values()) source.close(false); sources.clear(); } };
}

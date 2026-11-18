import type { WorkspaceConnection } from "./workspaces";
import { readable } from "./workspaces";
import { socketUrl } from "./protocol";

export type AdmissionProof = (nonce: string, digest: string, request: string, signal: AbortSignal) => Promise<unknown>;
export function workspaceProof(connection: WorkspaceConnection, current: () => WorkspaceConnection): AdmissionProof {
  return async (nonce, digest, raw, signal) => {
    const request = JSON.parse(raw), fresh = current();
    const channel = fresh.session.channels?.list().channels.find(channel => channel.id === request.channel);
    if (fresh.session !== connection.session || fresh.viewer !== connection.viewer || fresh.origin !== connection.origin || fresh.status !== "ready" || request.community !== connection.origin || !readable(channel, fresh.viewer) || !connection.session.configArtifactWriter?.kinds?.includes(45010)) throw new Error("Reconnect to this workspace before joining voice.");
    if (!/^[A-Za-z0-9_-]{32}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(digest)) throw new Error("Invalid meeting admission challenge.");
    const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw)))].map(byte => byte.toString(16).padStart(2,"0")).join("");
    if (digest !== hash) throw new Error("The meeting admission request changed.");
    const template = { kind: 45010, created_at: Math.floor(Date.now()/1000), tags: [["ar","1"],["d",crypto.randomUUID()],["h",request.channel],["type","studio.h2s2.meetings.admission"],["op","create"]], content: `Meetings admission ${nonce} ${digest}` };
    const event = await connection.session.configArtifactWriter.sign(template, signal);
    signal.throwIfAborted();
    if (current().session !== connection.session || event.pubkey !== connection.viewer || event.content !== template.content || JSON.stringify(event.tags) !== JSON.stringify(template.tags)) throw new Error("The meeting identity could not be confirmed.");
    return { event };
  };
}
export type MeetingService = { workspaceVoice: boolean; identity?: string; community?: string };
export function meetingService(broker: string, signal: AbortSignal): Promise<MeetingService> {
  return new Promise((resolve,reject) => {
    const socket = new WebSocket(socketUrl(broker));
    let finished = false;
    const finish = (value?: MeetingService) => { if (finished) return; finished = true; clearTimeout(timer); socket.close(); signal.removeEventListener("abort", cancel); if (value) resolve(value); else reject(new Error("Couldn’t load voice availability. Check your meeting service.")); };
    const timer = setTimeout(() => finish(), 8000), cancel = () => finish();
    socket.onopen = () => socket.send(JSON.stringify({ type: "service" }));
    socket.onmessage = ({data}) => { try { const value = JSON.parse(data); if (value.type !== "service" || value.workspaceVoice && (!/^[a-f0-9]{64}$/.test(value.identity) || typeof value.community !== "string")) return finish(); finish(value); } catch { finish(); } };
    socket.onclose = socket.onerror = cancel;
    signal.addEventListener("abort",cancel,{once:true}); if (signal.aborted) cancel();
  });
}

/** Who is in a call, read without joining it. */
export type Presence = { checkedAt: number; startedAt?: number; participants: { name: string; sharing: boolean; transcribing: boolean; agents: { name: string; mode?: "act" | "assist" }[] }[] };
export function requestPresence(broker: string, request: Record<string, unknown>, signal: AbortSignal, proof?: AdmissionProof): Promise<Presence> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(socketUrl(broker)), raw = JSON.stringify(request);
    let finished = false, challenged = false;
    const finish = (value?: Presence, error = "Couldn’t check who is in the call.") => { if (finished) return; finished = true; clearTimeout(timer); signal.removeEventListener("abort", cancel); socket.close(); if (value) resolve(value); else reject(new Error(error)); };
    const timer = setTimeout(() => finish(), 20000), cancel = () => finish();
    socket.onopen = () => socket.send(raw);
    socket.onclose = socket.onerror = cancel;
    socket.onmessage = ({ data }) => {
      try {
        if (typeof data !== "string" || data.length > 64000) return finish();
        const value = JSON.parse(data);
        if (value.type === "challenge" && proof && !challenged) { challenged = true; void proof(value.nonce, value.digest, raw, signal).then(answer => { if (!finished) socket.send(JSON.stringify(answer)); }).catch(error => finish(undefined, error instanceof Error ? error.message : undefined)); return; }
        if (value.type === "error") return finish(undefined, typeof value.error === "string" ? value.error.slice(0, 180) : undefined);
        const people = Array.isArray(value.participants) ? value.participants.slice(0, 32) : undefined;
        if (value.type !== "presence" || !Number.isSafeInteger(value.checkedAt) || (value.startedAt !== null && value.startedAt !== undefined && !Number.isSafeInteger(value.startedAt)) || !people) return finish();
        finish({ checkedAt: value.checkedAt, startedAt: value.startedAt ?? undefined, participants: people.filter((person: { name?: unknown }) => typeof person?.name === "string").map((person: { name: string; sharing?: unknown; transcribing?: unknown; agents?: unknown }) => ({
          name: person.name.slice(0, 48), sharing: person.sharing === true, transcribing: person.transcribing === true,
          agents: (Array.isArray(person.agents) ? person.agents : []).slice(0, 4).filter((agent: { name?: unknown }) => typeof agent?.name === "string").map((agent: { name: string; mode?: unknown }) => ({ name: agent.name.slice(0, 64), ...(agent.mode === "act" || agent.mode === "assist" ? { mode: agent.mode } : {}) })),
        })) });
      } catch { finish(); }
    };
    signal.addEventListener("abort", cancel, { once: true }); if (signal.aborted) cancel();
  });
}

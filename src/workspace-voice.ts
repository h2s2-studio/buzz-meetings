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

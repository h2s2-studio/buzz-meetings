import { inviteFromParams, socketUrl, roomServiceError, validOccurrence, type RoomAdmission, type RoomRequest } from "./protocol";

import type { AdmissionProof } from "./workspace-voice";

export function requestRoom(broker: string, request: RoomRequest, signal: AbortSignal, proof?: AdmissionProof): Promise<RoomAdmission> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(broker), raw = JSON.stringify(request);
    let challenged = false;
    const finish = (reply?: RoomAdmission, error = "Couldn’t reach the room service.") => {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      socket.onopen = socket.onclose = socket.onerror = socket.onmessage = null;
      socket.close();
      if (reply) resolve(reply);
      else reject(new Error(error));
    };
    const cancel = () => finish();
    const timer = setTimeout(cancel, request.type === "workspace" ? 30000 : 6500);
    socket.onopen = () => socket.send(raw);
    socket.onerror = socket.onclose = cancel;
    socket.onmessage = ({ data }) => {
      try {
        if (typeof data !== "string" || data.length > 10000) return finish();
        const reply = JSON.parse(data);
        if (reply.type === "challenge" && request.type === "workspace" && proof && !challenged) {
          challenged = true;
          void proof(reply.nonce, reply.digest, raw, signal).then(answer => { if (socket.readyState === WebSocket.OPEN && !signal.aborted) socket.send(JSON.stringify(answer)); }).catch(error => finish(undefined, error instanceof Error ? error.message : "Couldn’t verify your identity."));
          return;
        }
        if (reply.type === "error" && typeof reply.error === "string") {
          return finish(undefined, roomServiceError(request.type, reply.error));
        }
        if (reply.type !== "admitted" || typeof reply.token !== "string" || typeof reply.url !== "string") {
          return finish();
        }
        if (request.type === "create" && (
          !inviteFromParams({ broker, code: reply.invite?.code }) ||
          !Number.isSafeInteger(reply.invite?.expiresAt)
        )) return finish();
        finish({
          type: "admitted", room: typeof reply.room === "string" ? reply.room : undefined,
          occurrenceId: validOccurrence(reply.occurrenceId) ? reply.occurrenceId : undefined,
          url: socketUrl(reply.url, false),
          token: reply.token,
          capabilities: { screenAudio: reply.capabilities?.screenAudio === true, transcription: reply.capabilities?.transcription === true, sharedTranscription: reply.capabilities?.sharedTranscription === true },
          invite: request.type === "create" ? reply.invite : undefined,
        });
      } catch {
        finish();
      }
    };
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
  });
}

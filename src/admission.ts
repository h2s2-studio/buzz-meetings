import { inviteFromParams, socketUrl, roomServiceError, type RoomAdmission, type RoomRequest } from "./protocol";

export function requestRoom(broker: string, request: RoomRequest, signal: AbortSignal): Promise<RoomAdmission> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(broker);
    const finish = (reply?: RoomAdmission, error = "Couldn’t reach the room service.") => {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      socket.onopen = socket.onclose = socket.onerror = socket.onmessage = null;
      socket.close();
      if (reply) resolve(reply);
      else reject(new Error(error));
    };
    const cancel = () => finish();
    const timer = setTimeout(cancel, 6500);
    socket.onopen = () => socket.send(JSON.stringify(request));
    socket.onerror = socket.onclose = cancel;
    socket.onmessage = ({ data }) => {
      try {
        if (typeof data !== "string" || data.length > 10000) return finish();
        const reply = JSON.parse(data);
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
          type: "admitted",
          url: socketUrl(reply.url, false),
          token: reply.token,
          capabilities: { screenAudio: reply.capabilities?.screenAudio === true, transcription: reply.capabilities?.transcription === true },
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

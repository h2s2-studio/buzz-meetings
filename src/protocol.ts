export const pluginId = "studio.h2s2.meetings";
export const invitePage = "join-streams";
export const invitePattern = /^[A-Za-z0-9_-]{32}$/;
export const nameLimit = 48;

export type Invite = { broker: string; code: string };
export type RoomRequest =
  | { type: "create"; name: string; key?: string }
  | { type: "join"; name: string; code: string }
  | { type: "workspace"; name: string; community: string; channel: string; room: string; picture?: string }
  | { type: "meeting"; name: string; community: string; room: string; picture?: string; key?: string };
export type VoiceRequest = Extract<RoomRequest, { type: "meeting" | "workspace" }>;
export const isVoice = (request: RoomRequest): request is VoiceRequest => request.type === "meeting" || request.type === "workspace";
export type RoomAdmission = {
  room?: string;
  /** Media room SID reported by the broker: the call occurrence. */
  occurrenceId?: string;
  type: "admitted";
  url: string;
  token: string;
  capabilities?: { screenAudio: boolean; transcription?: boolean; sharedTranscription?: boolean };
  invite?: { code: string; expiresAt: number };
};
// LiveKit room SIDs identify one call occurrence. Validate before keying on one.
export const occurrencePattern = /^RM_[A-Za-z0-9]{1,61}$/;
export const validOccurrence = (value: unknown): value is string => typeof value === "string" && occurrencePattern.test(value);
export type RoomReply = RoomAdmission | { type: "error"; error: string };

export function roomServiceError(type: RoomRequest["type"], error: string): string {
  if (type === "meeting" && error === "Invalid room request.") {
    return "This service does not support Meetings yet. Ask your administrator to deploy the Buzz Meetings server, then join again.";
  }
  return error.slice(0, 180);
}

export function socketUrl(value: string, isBroker = true): string {
  const url = new URL(value.trim());
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  const secure = url.protocol === "wss:" || (loopback && url.protocol === "ws:");
  if (
    !secure || url.username || url.password || url.search || url.hash ||
    (isBroker && url.pathname !== "/rooms")
  ) {
    throw new Error(isBroker ? "Enter a secure room service URL ending in /rooms." : "Invalid media service URL.");
  }
  return url.href;
}

export function inviteFromParams(params: unknown): Invite | undefined {
  if (!params || typeof params !== "object" || !("broker" in params) || !("code" in params)) return;
  if (
    typeof params.broker !== "string" || params.broker.length > 256 ||
    typeof params.code !== "string" || !invitePattern.test(params.code)
  ) return;
  try {
    return { broker: socketUrl(params.broker), code: params.code };
  } catch {
    return;
  }
}

export function communityBroker(origin?: string): string | undefined {
  if (!origin) return;
  try {
    const url = new URL(origin);
    if (url.protocol === "https:") url.protocol = "wss:";
    if (url.protocol === "http:") url.protocol = "ws:";
    url.pathname = "/rooms";
    return socketUrl(url.href);
  } catch {
    return;
  }
}

export function inviteLink(invite: Invite): string {
  const url = new URL("buzz://plugin");
  url.searchParams.set("id", pluginId);
  url.searchParams.set("page", invitePage);
  url.searchParams.set("route.broker", invite.broker);
  url.searchParams.set("route.code", invite.code);
  return url.href;
}

export function parseInvite(value: string): Invite | undefined {
  try {
    const url = new URL(value.trim());
    if (
      url.protocol !== "buzz:" || url.hostname !== "plugin" ||
      url.searchParams.get("id") !== pluginId || url.searchParams.get("page") !== invitePage
    ) return;
    return inviteFromParams({
      broker: url.searchParams.get("route.broker"),
      code: url.searchParams.get("route.code"),
    });
  } catch {
    return;
  }
}

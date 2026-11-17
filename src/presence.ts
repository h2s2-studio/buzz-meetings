export const roomLifetime = 3600;
export const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const publicKey = /^[a-f0-9]{64}$/;

export type LifecycleEvent = Readonly<{
  id: string;
  pubkey: string;
  kind: number;
  created_at: number;
  content: string;
  tags: readonly (readonly string[])[];
}>;

function body(event: LifecycleEvent) {
  try {
    const data: unknown = JSON.parse(event.content);
    if (!data || typeof data !== "object" || !("ephemeral_channel_id" in data)) return;
    const id = data.ephemeral_channel_id;
    if (typeof id !== "string" || !uuid.test(id)) return;
    const admission = "admission_id" in data ? data.admission_id : undefined;
    const revision = "roster_revision" in data ? data.roster_revision : undefined;
    const generation = "generation" in data ? data.generation : undefined;
    return {
      id,
      admission: typeof admission === "string" && uuid.test(admission) ? admission : "",
      revision: typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 0 ? revision : 0,
      generation: typeof generation === "string" ? generation : "",
    };
  } catch {
    return;
  }
}

/** Fold Buzz's verified relay read model for display. The relay owns admission. */
export function recentParticipants(
  events: readonly LifecycleEvent[], parent: string, authority: string, now: number,
): string[] {
  if (!publicKey.test(authority)) return [];
  const scoped = events.flatMap((event) => {
    if (event.created_at > now || event.created_at <= now - roomLifetime ||
      !event.tags.some(([tag, value]) => tag === "h" && value === parent)) return [];
    const room = body(event);
    return room && room.id !== parent ? [{ event, ...room }] : [];
  });
  const starts = new Map<string, (typeof scoped)[number]>();
  for (const entry of scoped) {
    if (entry.event.kind !== 48100) continue;
    const previous = starts.get(entry.id);
    if (!previous || entry.event.created_at < previous.event.created_at ||
      (entry.event.created_at === previous.event.created_at && entry.event.id < previous.event.id)) {
      starts.set(entry.id, entry);
    }
  }
  const joined = new Set<string>();
  const ended = new Set<string>();
  for (const { event, id } of scoped) {
    const start = starts.get(id)?.event;
    if (!start || event.created_at < start.created_at) continue;
    if (event.kind === 48101 && event.pubkey === authority) joined.add(id);
    if (event.kind === 48103 && (event.pubkey === authority || event.pubkey === start.pubkey)) ended.add(id);
  }
  const current = [...starts.values()]
    .filter(({ id }) => joined.has(id) && !ended.has(id))
    .sort((a, b) => b.event.created_at - a.event.created_at || b.event.id.localeCompare(a.event.id))[0];
  if (!current) return [];

  const participants = new Map<string, string>();
  const participation = scoped.filter(({ event, id }) =>
    id === current.id && event.created_at >= current.event.created_at &&
    event.pubkey === authority && (event.kind === 48101 || event.kind === 48102));
  participation.sort((a, b) =>
    a.event.created_at - b.event.created_at || a.generation.localeCompare(b.generation) ||
    a.revision - b.revision || a.event.kind - b.event.kind || a.event.id.localeCompare(b.event.id));
  for (const { event, admission } of participation) {
    const person = event.tags.find(([tag]) => tag === "p")?.[1];
    if (!person || !publicKey.test(person)) continue;
    const key = admission || person;
    if (event.kind === 48101) participants.set(key, person);
    else if (participants.get(key) === person) participants.delete(key);
  }
  return [...new Set(participants.values())];
}

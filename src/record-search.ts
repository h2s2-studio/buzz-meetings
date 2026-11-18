// Lets an agent find what earlier meetings said. Buzz's own search covers
// messages; saved meeting records and their transcripts are artifacts, so they
// need this tool. An agent only ever sees records from channels it belongs to,
// read through its owner's connection on this device.
import type { AgentRuntime } from "./live-agents";
import type { MeetingRecords } from "./meeting-records";
import { uuid, type WorkspaceConnection } from "./workspaces";

const recordLimit = 20, excerptLimit = 5, excerptLength = 300, cacheLimit = 64;

export const searchTerms = (query: string) => [...new Set(query.toLocaleLowerCase().split(/\s+/).filter(Boolean))].slice(0, 8);
const matches = (text: string, terms: readonly string[]) => { const value = text.toLocaleLowerCase(); return terms.every(term => value.includes(term)); };
/** Transcript entries (blank-line separated) that contain every term. */
export function excerpts(text: string, terms: readonly string[], limit = excerptLimit) {
  const found: string[] = [];
  for (const entry of text.split("\n\n")) {
    if (!matches(entry, terms)) continue;
    found.push(entry.length > excerptLength ? `${entry.slice(0, excerptLength)}…` : entry);
    if (found.length >= limit) break;
  }
  return found;
}

export function registerRecordSearch(ctx: { agents?: Pick<AgentRuntime, "addTool">; relay: { snapshot(): WorkspaceConnection } }, records: Pick<MeetingRecords, "snapshot" | "read">) {
  const transcripts = new Map<string, string>();
  async function transcript(id: string) {
    const cached = transcripts.get(id);
    if (cached !== undefined) return cached;
    const text = await records.read(id);
    transcripts.set(id, text);
    if (transcripts.size > cacheLimit) transcripts.delete(transcripts.keys().next().value!);
    return text;
  }
  ctx.agents?.addTool({
    name: "meetings_search_records",
    description: "Search saved meeting records (transcripts and task results) from earlier calls in channels you belong to. Every word in query must appear in a transcript entry, a record title or a task. Returns speaker-attributed excerpts with the record and channel they came from. Use Buzz's own search for chat messages.",
    inputSchema: { type: "object", properties: { query: { type: "string", minLength: 2, maxLength: 200 }, channel_id: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 10 } }, required: ["query"], additionalProperties: false },
    async call(client, _context, args) {
      client.signal?.throwIfAborted();
      const connection = ctx.relay.snapshot(), terms = typeof args.query === "string" && args.query.length <= 200 ? searchTerms(args.query) : [];
      // Records are read through the owner's connection, so only the owner's own agents may search.
      if (!connection.viewer || connection.status !== "ready" || client.owner !== connection.viewer) throw new Error("Meeting records are only available to your owner’s agents while Buzz is connected.");
      if (!terms.length || terms.join("").length < 2) throw new Error("Supply a query of at least two characters.");
      if (args.channel_id !== undefined && !uuid(args.channel_id)) throw new Error("channel_id is not a channel ID.");
      const limit = Number.isSafeInteger(args.limit) ? Math.min(10, Math.max(1, Number(args.limit))) : 5;
      const channels = connection.session.channels?.list().channels ?? [];
      // The agent sees a record only when it is a member of that record's channel.
      const reachable = records.snapshot().records.filter(record => channels.find(channel => channel.id === record.value.channelId)?.members?.includes(client.pubkey));
      const candidates = reachable.filter(record => !args.channel_id || record.value.channelId === args.channel_id).slice(0, recordLimit);
      const results: unknown[] = [];
      let unavailable = 0;
      for (const record of candidates) {
        client.signal?.throwIfAborted();
        if (results.length >= limit) break;
        let found: string[] = [];
        try { found = excerpts(await transcript(record.id), terms); } catch { unavailable++; }
        const tasks = record.value.tasks.filter(task => matches(`${task.title} ${task.result}`, terms)).slice(0, excerptLimit)
          .map(task => ({ title: task.title, status: task.status, result: task.result.slice(0, excerptLength), ...(task.messageId ? { messageId: task.messageId } : {}) }));
        if (!found.length && !tasks.length && !matches(record.value.title, terms)) continue;
        results.push({ recordId: record.id, channelId: record.value.channelId, channel: channels.find(channel => channel.id === record.value.channelId)?.name, title: record.value.title,
          savedAt: new Date(record.value.capturedAt).toISOString(), ...(record.value.callId ? { callId: record.value.callId } : {}), excerpts: found, tasks });
      }
      return JSON.stringify({ query: terms.join(" "), searchedRecords: candidates.length, moreRecordsNotSearched: Math.max(0, reachable.filter(record => !args.channel_id || record.value.channelId === args.channel_id).length - candidates.length), unavailableRecords: unavailable,
        note: "Transcripts are speech recognition and may contain errors; speaker names are media labels, not verified identity. Only records in channels you belong to are searched.", results });
    },
  });
}

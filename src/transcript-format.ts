import { speakerLabels } from "./speaker-labels";

/** One attributed transcript entry, as shown live, exported and saved. */
export type TranscriptEntry = { id: string; speakerId: string; speakerName: string; startedAt: number; endedAt: number; text: string };

// The live export and saved records share this format, including the stable
// suffix that tells same-name speakers apart.
export function formatTranscript(rows: readonly Omit<TranscriptEntry, "id">[]) {
  const label = speakerLabels(rows.map(row => ({ id: row.speakerId, name: row.speakerName })));
  return rows.map(row => `[${new Date(row.startedAt).toISOString()}] ${label({ id: row.speakerId, name: row.speakerName })}: ${row.text}`).join("\n\n");
}

export function validEntry(value: unknown): value is TranscriptEntry {
  const entry = value as Partial<TranscriptEntry> | null;
  return !!entry && typeof entry.id === "string" && entry.id.length > 0 && entry.id.length <= 160 && typeof entry.speakerId === "string" && entry.speakerId.length <= 128 && typeof entry.speakerName === "string" && entry.speakerName.length <= 256 && typeof entry.text === "string" && entry.text.length <= 20000 && Number.isSafeInteger(entry.startedAt) && Number.isSafeInteger(entry.endedAt) && entry.startedAt! >= 0 && entry.endedAt! >= entry.startedAt! && entry.endedAt! <= 8640000000000000;
}

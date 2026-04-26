export interface IngestEventInput {
  userId: string;
  songId: string;
  eventType: "play" | "skip" | "search" | "add_to_playlist";
  ts?: string;
  queryText?: string;
  playlistId?: string;
}

export function validateEvent(input: IngestEventInput): IngestEventInput {
  if (!input.userId) throw new Error("userId is required");
  if (!input.songId) throw new Error("songId is required");
  if (!input.eventType) throw new Error("eventType is required");
  return { ...input, ts: input.ts ?? new Date().toISOString() };
}


interface EventRecord {
  songId: string;
  eventType: "play" | "skip" | "search" | "add_to_playlist";
}

export interface SongStats {
  playCount: number;
  skipCount: number;
  addToPlaylistCount: number;
  searchHitCount: number;
}

export function buildSongStats(events: EventRecord[]): Record<string, SongStats> {
  const stats: Record<string, SongStats> = {};
  for (const event of events) {
    const row = stats[event.songId] ?? {
      playCount: 0,
      skipCount: 0,
      addToPlaylistCount: 0,
      searchHitCount: 0
    };
    if (event.eventType === "play") row.playCount += 1;
    if (event.eventType === "skip") row.skipCount += 1;
    if (event.eventType === "add_to_playlist") row.addToPlaylistCount += 1;
    if (event.eventType === "search") row.searchHitCount += 1;
    stats[event.songId] = row;
  }
  return stats;
}


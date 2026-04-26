import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

interface SeedEvent {
  userId: string;
  songId: string;
  eventType: "play" | "skip" | "search" | "add_to_playlist";
}

interface SongStats {
  playCount: number;
  skipCount: number;
  addToPlaylistCount: number;
  searchHitCount: number;
  updatedAt: string;
}

const OUTPUT_DIR = path.resolve(process.cwd(), "scripts/data/seed-output");

function incrementNeighbor(map: Map<string, Map<string, number>>, a: string, b: string) {
  if (a === b) return;
  if (!map.has(a)) map.set(a, new Map());
  const neighbors = map.get(a)!;
  neighbors.set(b, (neighbors.get(b) ?? 0) + 1);
}

async function main() {
  const events = JSON.parse(await readFile(path.join(OUTPUT_DIR, "events.json"), "utf-8")) as SeedEvent[];
  const stats: Record<string, SongStats> = {};
  const coPlaylist = new Map<string, Map<string, number>>();
  const coSearch = new Map<string, Map<string, number>>();

  const userRecentPlays: Record<string, string[]> = {};
  for (const event of events) {
    const current = stats[event.songId] ?? {
      playCount: 0,
      skipCount: 0,
      addToPlaylistCount: 0,
      searchHitCount: 0,
      updatedAt: new Date().toISOString()
    };
    if (event.eventType === "play") current.playCount += 1;
    if (event.eventType === "skip") current.skipCount += 1;
    if (event.eventType === "add_to_playlist") current.addToPlaylistCount += 1;
    if (event.eventType === "search") current.searchHitCount += 1;
    stats[event.songId] = current;

    if (!userRecentPlays[event.userId]) userRecentPlays[event.userId] = [];
    const recent = userRecentPlays[event.userId];
    for (const prevSong of recent) {
      if (event.eventType === "add_to_playlist") incrementNeighbor(coPlaylist, prevSong, event.songId);
      if (event.eventType === "search") incrementNeighbor(coSearch, prevSong, event.songId);
    }
    if (event.eventType === "play") {
      recent.push(event.songId);
      if (recent.length > 20) recent.shift();
    }
  }

  const toNeighborObject = (source: Map<string, Map<string, number>>) =>
    Array.from(source.entries()).map(([songId, neighbors]) => ({
      songId,
      neighbors: Object.fromEntries(Array.from(neighbors.entries()).sort((a, b) => b[1] - a[1]).slice(0, 50))
    }));

  await writeFile(path.join(OUTPUT_DIR, "song_stats.json"), JSON.stringify(stats, null, 2), "utf-8");
  await writeFile(
    path.join(OUTPUT_DIR, "cooccurrence_playlist.json"),
    JSON.stringify(toNeighborObject(coPlaylist), null, 2),
    "utf-8"
  );
  await writeFile(
    path.join(OUTPUT_DIR, "cooccurrence_search.json"),
    JSON.stringify(toNeighborObject(coSearch), null, 2),
    "utf-8"
  );
  console.log("Aggregate and co-occurrence outputs built.");
}

void main();


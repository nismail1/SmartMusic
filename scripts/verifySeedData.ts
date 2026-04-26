import { readFile } from "node:fs/promises";
import path from "node:path";
import { assertTrackIdsExist, validateCatalog } from "./lib/spotifyTruthValidator.js";
import type { SpotifyCatalogTrack } from "./lib/types.js";

const OUTPUT_DIR = path.resolve(process.cwd(), "scripts/data/seed-output");

async function main() {
  const songs = JSON.parse(await readFile(path.join(OUTPUT_DIR, "songs.json"), "utf-8")) as SpotifyCatalogTrack[];
  const events = JSON.parse(await readFile(path.join(OUTPUT_DIR, "events.json"), "utf-8")) as Array<{ songId: string }>;
  const validation = validateCatalog(songs);
  if (!validation.ok) throw new Error(validation.errors.join("; "));
  assertTrackIdsExist(events.map((event) => event.songId), songs);
  console.log("Seed verification passed: all tracks map to Spotify catalog cache.");
}

void main();


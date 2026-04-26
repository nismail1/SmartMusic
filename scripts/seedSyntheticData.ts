import { config as loadEnv } from "dotenv";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { generateEvents, generateUsers } from "./lib/behaviorModel.js";
import { assertTrackIdsExist, validateCatalog } from "./lib/spotifyTruthValidator.js";
import type { SeedConfig, SpotifyCatalogTrack } from "./lib/types.js";

loadEnv();

const ROOT = process.cwd();
const CONFIG_PATH = path.resolve(ROOT, "scripts/config/seedConfig.json");
const CACHE_DIR = path.resolve(ROOT, "scripts/data/spotify-cache");
const OUTPUT_DIR = path.resolve(ROOT, "scripts/data/seed-output");

async function main() {
  const config = JSON.parse(await readFile(CONFIG_PATH, "utf-8")) as SeedConfig;
  const catalogPath = path.join(CACHE_DIR, `${config.catalogVersion}.json`);
  const catalog = JSON.parse(await readFile(catalogPath, "utf-8")) as SpotifyCatalogTrack[];
  const validation = validateCatalog(catalog);
  if (!validation.ok) throw new Error(`Catalog validation failed: ${validation.errors.slice(0, 5).join("; ")}`);

  const users = generateUsers(config);
  const events = generateEvents(config, catalog, users);

  const rngSeed = config.seedRandom;
  const playlistIds = Array.from({ length: config.playlistCount }, (_, index) => `playlist_${index + 1}`);
  const playlists = playlistIds.map((id, index) => ({
    id,
    userId: users[index % users.length].id,
    name: `Playlist ${index + 1}`,
    createdAt: new Date(Date.now() - index * 1000 * 60).toISOString(),
    updatedAt: new Date().toISOString()
  }));

  events.forEach((event, index) => {
    if (event.eventType === "add_to_playlist") {
      event.playlistId = playlistIds[index % playlistIds.length];
    }
  });

  assertTrackIdsExist(events.map((event) => event.songId), catalog);
  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeFile(path.join(OUTPUT_DIR, "songs.json"), JSON.stringify(catalog, null, 2), "utf-8");
  await writeFile(path.join(OUTPUT_DIR, "users.json"), JSON.stringify(users, null, 2), "utf-8");
  await writeFile(path.join(OUTPUT_DIR, "playlists.json"), JSON.stringify(playlists, null, 2), "utf-8");
  await writeFile(path.join(OUTPUT_DIR, "events.json"), JSON.stringify(events, null, 2), "utf-8");
  await writeFile(
    path.join(OUTPUT_DIR, "seed-manifest.json"),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        catalogVersion: config.catalogVersion,
        rngSeed,
        counts: { songs: catalog.length, users: users.length, playlists: playlists.length, events: events.length }
      },
      null,
      2
    ),
    "utf-8"
  );
  console.log("Synthetic seed data generated in scripts/data/seed-output");
}

void main();


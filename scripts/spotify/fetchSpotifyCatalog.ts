import { config as loadEnv } from "dotenv";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import fetch from "node-fetch";
import type { SpotifyCatalogTrack } from "../lib/types.js";
import { validateCatalog } from "../lib/spotifyTruthValidator.js";

loadEnv();

const CACHE_DIR = path.resolve(process.cwd(), "scripts/data/spotify-cache");
const MARKET = "US";
const CATALOG_VERSION = process.env.SPOTIFY_CATALOG_VERSION ?? "catalog-us-v1";

async function getToken() {
  const clientId = process.env.VITE_SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.VITE_SPOTIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("Missing VITE_SPOTIFY_CLIENT_ID or VITE_SPOTIFY_CLIENT_SECRET");
  }
  const tokenResponse = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`
    },
    body: "grant_type=client_credentials"
  });
  if (!tokenResponse.ok) {
    throw new Error(`Token request failed: ${tokenResponse.status}`);
  }
  const tokenPayload = (await tokenResponse.json()) as { access_token: string };
  return tokenPayload.access_token;
}

function normalizeTrack(track: any): SpotifyCatalogTrack {
  return {
    id: track.id,
    name: track.name,
    artists: Array.isArray(track.artists) ? track.artists.map((artist: any) => artist.name) : [],
    albumId: track.album?.id ?? "",
    albumName: track.album?.name ?? "",
    releaseDate: track.album?.release_date ?? null,
    durationMs: track.duration_ms ?? 0,
    popularity: track.popularity ?? 0,
    previewUrl: track.preview_url ?? null,
    artworkUrl: track.album?.images?.[0]?.url ?? null,
    genres: []
  };
}

async function fetchTrackPage(token: string, query: string, offset: number) {
  const url = new URL("https://api.spotify.com/v1/search");
  url.searchParams.set("q", query);
  url.searchParams.set("type", "track");
  url.searchParams.set("market", MARKET);
  url.searchParams.set("limit", "10");
  url.searchParams.set("offset", String(offset));
  const response = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) {
    throw new Error(`Spotify search failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function buildCatalog(token: string): Promise<{ catalog: SpotifyCatalogTrack[]; rawPayloads: any[] }> {
  const queries = ["top hits", "indie", "hip hop", "chill", "electronic", "rock", "rnb", "country"];
  const rawPayloads: any[] = [];
  const byId = new Map<string, SpotifyCatalogTrack>();
  for (const query of queries) {
    for (const offset of [0, 10, 20, 30, 40]) {
      const payload = (await fetchTrackPage(token, query, offset)) as any;
      rawPayloads.push({ query, offset, payload });
      const items = payload?.tracks?.items ?? [];
      for (const item of items) {
        const normalized = normalizeTrack(item);
        if (!byId.has(normalized.id)) byId.set(normalized.id, normalized);
      }
    }
  }
  return { catalog: Array.from(byId.values()), rawPayloads };
}

async function main() {
  await mkdir(CACHE_DIR, { recursive: true });
  const token = await getToken();
  const { catalog, rawPayloads } = await buildCatalog(token);
  const validation = validateCatalog(catalog);
  if (!validation.ok) throw new Error(validation.errors.slice(0, 5).join("; "));

  const timestamp = new Date().toISOString();
  const rawPath = path.join(CACHE_DIR, `raw-${Date.now()}.json`);
  const catalogPath = path.join(CACHE_DIR, `${CATALOG_VERSION}.json`);
  const manifestPath = path.join(CACHE_DIR, "manifest.json");
  const catalogString = JSON.stringify(catalog, null, 2);
  const hash = createHash("sha256").update(catalogString).digest("hex");

  await writeFile(rawPath, JSON.stringify(rawPayloads, null, 2), "utf-8");
  await writeFile(catalogPath, catalogString, "utf-8");

  let previousRuns: any[] = [];
  try {
    const previous = await readFile(manifestPath, "utf-8");
    previousRuns = JSON.parse(previous).runs ?? [];
  } catch {
    previousRuns = [];
  }

  const manifest = {
    market: MARKET,
    latestCatalog: `${CATALOG_VERSION}.json`,
    runs: [
      ...previousRuns,
      { timestamp, hash, trackCount: catalog.length, rawFile: path.basename(rawPath), catalogVersion: CATALOG_VERSION }
    ]
  };
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
  console.log(`Fetched ${catalog.length} tracks into ${catalogPath}`);
}

void main();


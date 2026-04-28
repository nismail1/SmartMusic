import type { RecommendationItem, PlaylistTrack, SpotifyTrack } from "../types/music";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  query,
  orderBy,
  limit
} from "firebase/firestore";
import { db } from "./firebase";
import { spotifyService, type SpotifyPublicPlaylist } from "./spotify";

interface NeighborDoc {
  neighbors?: Record<string, number>;
}

interface SearchCacheDoc {
  normalizedQuery: string;
  playlistIds: string[];
  fetchedAt: number;
  expiresAt: number;
}

interface PlaylistTracksCacheDoc {
  trackIds: string[];
  tracksLite: Array<{
    id: string;
    name: string;
    artists: string[];
    artworkUrl: string | null;
    previewUrl: string | null;
  }>;
  fetchedAt: number;
  expiresAt: number;
}

interface TrackCooccurrenceCacheDoc {
  neighbors: Record<string, number>;
  sourcePlaylistsCount: number;
  fetchedAt: number;
  expiresAt: number;
}

interface PlaylistSuggestionCacheDoc {
  playlistId: string;
  playlistTrackHash: string;
  excludedHash: string;
  suggestions: RecommendationItem[];
  primarySuggestion: RecommendationItem | null;
  fetchedAt: number;
  expiresAt: number;
  /** When `"api"`, co-occurrence must ignore this doc and rebuild; API path may reuse hydrated rows. */
  suggestionSource?: "cooc" | "api";
}

const TTL_MS = {
  search: 12 * 60 * 60 * 1000,
  playlistTracks: 12 * 60 * 60 * 1000,
  trackCooccurrence: 24 * 60 * 60 * 1000,
  finalSuggestion: 20 * 60 * 1000
} as const;

const MIN_SUGGESTIONS = 5;
const RETURN_SUGGESTIONS = 1;
const MAX_SEEDS = 8;
const PLAYLISTS_PER_SEED = 12;
const TRACKS_PER_PUBLIC_PLAYLIST = 120;

function debugLog(location: string, message: string, data: Record<string, unknown>, hypothesisId: string, runId = "suggestion-debug") {
  // #region agent log
  import.meta.env.DEV && fetch("http://127.0.0.1:7701/ingest/35369d23-7f37-4585-ac9a-076a3915746b", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "658713" },
    body: JSON.stringify({
      sessionId: "658713",
      runId,
      hypothesisId,
      location,
      message,
      data,
      timestamp: Date.now()
    })
  }).catch(() => {});
  // #endregion
}

function nowMs(): number {
  return Date.now();
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isSyntheticGenreTag(tag: string): boolean {
  const normalized = String(tag).toLowerCase().trim();
  return (
    normalized.startsWith("era ") ||
    normalized.startsWith("duration ") ||
    normalized.startsWith("popularity ") ||
    normalized === "explicit" ||
    normalized === "unclassified"
  );
}

function hashString(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return Math.abs(hash >>> 0).toString(16);
}

function playlistTrackHash(trackIds: string[]): string {
  return hashString(trackIds.slice().sort().join("|"));
}

function normalizeQuery(seedName: string, seedArtist: string): string {
  return normalizeText(`${seedName} ${seedArtist}`.trim());
}

function computeGenreProfile(tracks: PlaylistTrack[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const track of tracks) {
    for (const genre of track.genres ?? []) {
      if (isSyntheticGenreTag(genre)) continue;
      const key = normalizeText(String(genre));
      if (!key) continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

function computeGenreMatch(track: { genres?: string[] }, profile: Map<string, number>): number {
  if (!profile.size || !Array.isArray(track.genres) || !track.genres.length) return 0;
  const total = track.genres.length;
  let hits = 0;
  for (const genre of track.genres) {
    if (isSyntheticGenreTag(genre)) continue;
    if (profile.has(normalizeText(genre))) hits += 1;
  }
  return total ? hits / total : 0;
}

function buildReason(
  seedCoverage: number,
  cooccurCount: number,
  genreMatch: number,
  seedTrackNames: string[]
): string {
  const topSeeds = seedTrackNames.slice(0, 3).map((name) => `‘${name}’`);
  const seedPhrase = topSeeds.length > 1 ? `${topSeeds.slice(0, -1).join(", ")} and ${topSeeds[topSeeds.length - 1]}` : (topSeeds[0] ?? "songs in your playlist");
  const genrePct = Math.round(genreMatch * 100);
  if (seedCoverage >= 2 && genreMatch >= 0.25) {
    return `Picked because it co-occurs with ${seedCoverage} of your playlist songs (${seedPhrase}) across ${cooccurCount} matching public playlists, and aligns with your genre profile (${genrePct}% match).`;
  }
  if (seedCoverage >= 2) {
    return `Picked because it co-occurs with ${seedCoverage} of your playlist songs (${seedPhrase}) across ${cooccurCount} matching public playlists.`;
  }
  if (genreMatch >= 0.25) {
    return `Picked because it appears in ${cooccurCount} related public playlists and matches your playlist’s genre profile (${genrePct}% match).`;
  }
  return `Picked because it repeatedly appears in public playlists related to your current tracks (${cooccurCount} co-occurrence hits).`;
}

/** Shown when the LLM endpoint misbehaves; keep listener-facing, not algorithmic. */
const SUGGESTION_REASON_ENJOY_FALLBACK =
  "Could be a fun next listen — it sits in a similar pocket to the stuff you’ve already got in this playlist.";

const SUGGESTION_REASON_LLM_INSTRUCTION =
  "Write exactly 1–2 short sentences an actual human would enjoy reading in a music app. Focus on why someone might *love listening* to this suggestion next — mood, energy, artist vibe, or how it fits emotionally with their taste. Be warm and a little playful; skip dry or corporate tone. Do not mention rankings, scores, statistics, algorithms, co-occurrence, playlists of strangers, or how the app picked the track.";

async function refineReasonWithLLM(
  baseReason: string,
  context: {
    trackName: string;
    artists: string[];
    seedTrackNames: string[];
    playlistTrackNames?: string[];
    albumName?: string;
  }
): Promise<string> {
  const explicitEndpoint = (import.meta.env.VITE_REASON_LLM_ENDPOINT ?? "").trim();
  const recommendationEndpoint = (import.meta.env.VITE_RECOMMENDATIONS_ENDPOINT ?? "").trim();
  const derivedEndpoint = recommendationEndpoint
    ? recommendationEndpoint.replace("getRecommendations", "getSuggestionReason")
    : "";
  const endpoint = explicitEndpoint || derivedEndpoint;
  if (!endpoint) {
    return `${baseReason} (LLM reason endpoint not configured)`;
  }
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instruction: SUGGESTION_REASON_LLM_INSTRUCTION,
        baseReason,
        context
      })
    });
    if (!response.ok) return SUGGESTION_REASON_ENJOY_FALLBACK;
    const payload = (await response.json()) as { reason?: string };
    const candidate = String(payload.reason ?? "").trim();
    return candidate || SUGGESTION_REASON_ENJOY_FALLBACK;
  } catch {
    return SUGGESTION_REASON_ENJOY_FALLBACK;
  }
}

async function getCacheDoc<T extends { expiresAt: number }>(pathCollection: string, key: string): Promise<T | null> {
  const snap = await getDoc(doc(db, pathCollection, key));
  if (!snap.exists()) return null;
  const data = snap.data() as T;
  if (!data || Number(data.expiresAt ?? 0) < nowMs()) return null;
  return data;
}

/** Firestore rejects `undefined` at any depth; only omit keys (or use `null` where a sentinel is required). */
function stripUndefinedForFirestore<T extends object>(payload: T): T {
  return stripPlainPayload(payload) as T;
}

function stripPlainPayload(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "object") return value;
  if (value instanceof Date) return value;
  if (Array.isArray(value)) {
    return value.map(stripPlainPayload).filter((v) => v !== undefined);
  }
  const proto = Object.getPrototypeOf(value as object);
  if (proto !== Object.prototype && proto !== null) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(value as Record<string, unknown>)) {
    const v = (value as Record<string, unknown>)[k];
    if (v === undefined) continue;
    const s = stripPlainPayload(v);
    if (s === undefined) continue;
    out[k] = s;
  }
  return out;
}

async function setCacheDoc(pathCollection: string, key: string, payload: object): Promise<void> {
  const safe = stripUndefinedForFirestore(payload);
  await setDoc(doc(db, pathCollection, key), safe, { merge: true });
}

async function getOrBuildSearchCache(normalized: string): Promise<string[]> {
  const cacheKey = hashString(normalized);
  const cached = await getCacheDoc<SearchCacheDoc>("spotify_playlist_search_cache", cacheKey);
  if (cached) return cached.playlistIds ?? [];
  const playlists = await spotifyService.searchPublicPlaylists(normalized, PLAYLISTS_PER_SEED);
  const playlistIds = playlists.map((item: SpotifyPublicPlaylist) => item.id).filter(Boolean);
  await setCacheDoc("spotify_playlist_search_cache", cacheKey, {
    normalizedQuery: normalized,
    playlistIds,
    fetchedAt: nowMs(),
    expiresAt: nowMs() + TTL_MS.search
  });
  return playlistIds;
}

async function getOrBuildPlaylistTracksCache(playlistId: string): Promise<PlaylistTracksCacheDoc> {
  const cached = await getCacheDoc<PlaylistTracksCacheDoc>("spotify_playlist_tracks_cache", playlistId);
  if (cached) return cached;
  const tracks = await spotifyService.getPublicPlaylistTracks(playlistId, TRACKS_PER_PUBLIC_PLAYLIST);
  const payload: PlaylistTracksCacheDoc = {
    trackIds: tracks.map((track) => track.id),
    tracksLite: tracks.map((track) => ({
      id: track.id,
      name: track.name,
      artists: track.artists,
      artworkUrl: track.artworkUrl,
      previewUrl: track.previewUrl
    })),
    fetchedAt: nowMs(),
    expiresAt: nowMs() + TTL_MS.playlistTracks
  };
  await setCacheDoc("spotify_playlist_tracks_cache", playlistId, payload);
  return payload;
}

async function getOrBuildTrackCooccurrence(
  seedTrack: PlaylistTrack
): Promise<{ neighbors: Map<string, number>; sourcePlaylistsCount: number }> {
  const cached = await getCacheDoc<TrackCooccurrenceCacheDoc>("spotify_track_cooccurrence_cache", seedTrack.id);
  if (cached) {
    return {
      neighbors: new Map(Object.entries(cached.neighbors ?? {}).map(([k, v]) => [k, Number(v)])),
      sourcePlaylistsCount: Number(cached.sourcePlaylistsCount ?? 0)
    };
  }
  const normalized = normalizeQuery(seedTrack.name, seedTrack.artists[0] ?? "");
  const playlistIds = await getOrBuildSearchCache(normalized);
  const neighbors = new Map<string, number>();
  let sourcePlaylistsCount = 0;
  for (const playlistId of playlistIds.slice(0, PLAYLISTS_PER_SEED)) {
    const playlistCache = await getOrBuildPlaylistTracksCache(playlistId);
    if (!playlistCache.trackIds.includes(seedTrack.id)) continue;
    sourcePlaylistsCount += 1;
    for (const coTrackId of playlistCache.trackIds) {
      if (!coTrackId || coTrackId === seedTrack.id) continue;
      neighbors.set(coTrackId, (neighbors.get(coTrackId) ?? 0) + 1);
    }
  }
  await setCacheDoc("spotify_track_cooccurrence_cache", seedTrack.id, {
    neighbors: Object.fromEntries(neighbors.entries()),
    sourcePlaylistsCount,
    fetchedAt: nowMs(),
    expiresAt: nowMs() + TTL_MS.trackCooccurrence
  });
  return { neighbors, sourcePlaylistsCount };
}

async function buildFromOwnAppCooccurrence(seedTracks: PlaylistTrack[]): Promise<Map<string, number>> {
  const combined = new Map<string, number>();
  for (const seed of seedTracks) {
    const snap = await getDoc(doc(db, "cooccurrence_playlist", seed.id));
    const neighbors = (snap.data() as NeighborDoc | undefined)?.neighbors ?? {};
    for (const [trackId, raw] of Object.entries(neighbors)) {
      combined.set(trackId, (combined.get(trackId) ?? 0) + Number(raw ?? 0));
    }
  }
  return combined;
}

async function fallbackPopularityExcluding(excludedIds: Set<string>): Promise<RecommendationItem[]> {
  const statsSnap = await getDocs(query(collection(db, "song_stats"), orderBy("playCount", "desc"), limit(20)));
  const candidateIds = statsSnap.docs
    .map((docSnap) => docSnap.id)
    .filter((id) => !excludedIds.has(id))
    .slice(0, 50);
  const tracks = await spotifyService.getTracksByIds(candidateIds);
  const recs: RecommendationItem[] = tracks.map((track) => ({
    songId: track.id,
    spotifyId: track.id,
    songName: track.name,
    artists: track.artists,
    uri: track.uri,
    albumName: track.albumName,
    artworkUrl: track.artworkUrl,
    previewUrl: track.previewUrl,
    releaseDate: track.releaseDate,
    durationMs: track.durationMs,
    score: 0.1,
    reasons: ["Suggested as a fallback popular track while co-occurrence data is still warming up."]
  }));
  if (recs.length >= MIN_SUGGESTIONS) return recs.slice(0, MIN_SUGGESTIONS);

  const topUpSearches = ["top hits", "today's top hits", "popular tracks"];
  for (const queryText of topUpSearches) {
    const searchTracks = await spotifyService.searchTracks(queryText, "US", "recommendation-fallback-popularity");
    for (const track of searchTracks) {
      if (excludedIds.has(track.id) || recs.some((item) => item.songId === track.id)) continue;
      recs.push({
        songId: track.id,
        spotifyId: track.id,
        songName: track.name,
        artists: track.artists,
        uri: track.uri,
        albumName: track.albumName,
        artworkUrl: track.artworkUrl,
        previewUrl: track.previewUrl,
        releaseDate: track.releaseDate,
        durationMs: track.durationMs,
        score: 0.08,
        reasons: ["Suggested from Spotify popular tracks while co-occurrence data is warming up."]
      });
      if (recs.length >= MIN_SUGGESTIONS) return recs.slice(0, MIN_SUGGESTIONS);
    }
  }
  return recs.slice(0, MIN_SUGGESTIONS);
}

interface RecommendationOptions {
  excludeSongIds?: string[];
  forceRefresh?: boolean;
}

const recommendationsInFlight = new Map<string, Promise<RecommendationItem[]>>();

async function loadPlaylistTrackIds(playlistId: string): Promise<string[]> {
  const tracksSnap = await getDocs(collection(db, "playlists", playlistId, "tracks"));
  return tracksSnap.docs
    .map((docSnap) => {
      const data = docSnap.data() as Partial<PlaylistTrack>;
      return String(data.id ?? docSnap.id);
    })
    .filter(Boolean);
}

function buildSuggestionCacheKey(
  playlistId: string,
  playlistTrackIds: string[],
  excludeSongIds: string[] | undefined
): { cacheKey: string; excludedHash: string } {
  const excludedIds = new Set(playlistTrackIds);
  for (const id of excludeSongIds ?? []) {
    if (id) excludedIds.add(id);
  }
  const excludedHash = hashString(Array.from(excludedIds).sort().join("|"));
  const cacheKey = `${playlistId}_${playlistTrackHash(playlistTrackIds)}_${excludedHash}`;
  return { cacheKey, excludedHash };
}

function recommendationItemLooksSpotifyHydrated(item: RecommendationItem | undefined): boolean {
  if (!item) return false;
  if (Number(item.durationMs) > 0) return true;
  if (item.releaseDate && String(item.releaseDate).trim()) return true;
  if (item.previewUrl) return true;
  if (item.albumName && String(item.albumName).trim()) return true;
  return false;
}

function mergeSpotifyTrackIntoRecommendation(item: RecommendationItem, track: SpotifyTrack): RecommendationItem {
  return {
    ...item,
    spotifyId: item.spotifyId ?? track.id,
    songName: item.songName && item.songName !== item.songId ? item.songName : track.name,
    artists: item.artists?.length ? item.artists : track.artists,
    spotifyArtistIds: track.spotifyArtistIds,
    uri: item.uri || track.uri,
    albumName: item.albumName || track.albumName,
    artworkUrl: item.artworkUrl ?? track.artworkUrl,
    previewUrl: item.previewUrl ?? track.previewUrl,
    releaseDate: item.releaseDate ?? track.releaseDate,
    durationMs: item.durationMs && item.durationMs > 0 ? item.durationMs : track.durationMs,
    genres: track.genres,
    genresFetchedAt: track.genresFetchedAt
  };
}

/** After Cloud Function returns thin items: batch `getTracksByIds`, merge, persist to `playlist_suggestion_cache`. */
async function hydrateApiRecommendationsFromSpotify(
  playlistId: string,
  fromApi: RecommendationItem[],
  options?: RecommendationOptions
): Promise<RecommendationItem[]> {
  if (!fromApi.length) return [];
  // #region agent log
  fetch("http://127.0.0.1:7701/ingest/35369d23-7f37-4585-ac9a-076a3915746b", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "658713" },
    body: JSON.stringify({
      sessionId: "658713",
      runId: "suggestions-fail",
      hypothesisId: "DBG-H0",
      location: "recommendations.ts:hydrateApiRecommendationsFromSpotify:entry",
      message: "hydrate started",
      data: { playlistId, fromApiCount: fromApi.length, firstSongId: fromApi[0]?.songId ?? null },
      timestamp: Date.now()
    })
  }).catch(() => {});
  // #endregion
  let playlistTrackIds: string[];
  try {
    playlistTrackIds = await loadPlaylistTrackIds(playlistId);
  } catch (loadErr) {
    // #region agent log
    fetch("http://127.0.0.1:7701/ingest/35369d23-7f37-4585-ac9a-076a3915746b", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "658713" },
      body: JSON.stringify({
        sessionId: "658713",
        runId: "suggestions-fail",
        hypothesisId: "DBG-H-B",
        location: "recommendations.ts:hydrateApiRecommendationsFromSpotify:loadPlaylistTrackIds",
        message: "loadPlaylistTrackIds threw",
        data: { message: loadErr instanceof Error ? loadErr.message : String(loadErr) },
        timestamp: Date.now()
      })
    }).catch(() => {});
    // #endregion
    throw loadErr;
  }
  const { cacheKey, excludedHash } = buildSuggestionCacheKey(playlistId, playlistTrackIds, options?.excludeSongIds);

  if (!options?.forceRefresh) {
    const cached = await getCacheDoc<PlaylistSuggestionCacheDoc>("playlist_suggestion_cache", cacheKey);
    if (
      cached?.suggestions?.length &&
      cached.suggestions[0]?.songId === fromApi[0]?.songId &&
      recommendationItemLooksSpotifyHydrated(cached.suggestions[0])
    ) {
      debugLog(
        "src/services/recommendations.ts:hydrateApiRecommendationsFromSpotify",
        "served hydrated suggestions from playlist_suggestion_cache",
        { cacheKey, songId: fromApi[0].songId, source: cached.suggestionSource ?? "legacy" },
        "H50",
        "metadata-genre-debug"
      );
      return cached.suggestions.slice(0, RETURN_SUGGESTIONS);
    }
  }

  // #region agent log
  fetch("http://127.0.0.1:7701/ingest/35369d23-7f37-4585-ac9a-076a3915746b", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "658713" },
    body: JSON.stringify({
      sessionId: "658713",
      runId: "post-fix-verify",
      hypothesisId: "DBG-H-E",
      location: "recommendations.ts:hydrateApiRecommendationsFromSpotify:pastCacheRead",
      message: "getCacheDoc branch completed without throw",
      data: { cacheKey },
      timestamp: Date.now()
    })
  }).catch(() => {});
  // #endregion

  const toHydrate = fromApi.slice(0, Math.max(RETURN_SUGGESTIONS, 5));
  const ids = toHydrate.map((i) => i.songId).filter(Boolean);
  // #region agent log
  fetch("http://127.0.0.1:7701/ingest/35369d23-7f37-4585-ac9a-076a3915746b", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "658713" },
    body: JSON.stringify({
      sessionId: "658713",
      runId: "suggestions-fail",
      hypothesisId: "DBG-H-A-pre",
      location: "recommendations.ts:hydrateApiRecommendationsFromSpotify:beforeSpotify",
      message: "about to call getTracksByIds",
      data: {
        idCount: ids.length,
        hasViteSpotifyClientId: Boolean(import.meta.env.VITE_SPOTIFY_CLIENT_ID),
        hasViteSpotifyClientSecret: Boolean(import.meta.env.VITE_SPOTIFY_CLIENT_SECRET)
      },
      timestamp: Date.now()
    })
  }).catch(() => {});
  // #endregion
  let tracks;
  try {
    tracks = await spotifyService.getTracksByIds(ids);
  } catch (spotifyErr) {
    // #region agent log
    fetch("http://127.0.0.1:7701/ingest/35369d23-7f37-4585-ac9a-076a3915746b", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "658713" },
      body: JSON.stringify({
        sessionId: "658713",
        runId: "suggestions-fail",
        hypothesisId: "DBG-H-A",
        location: "recommendations.ts:hydrateApiRecommendationsFromSpotify:getTracksByIds",
        message: "getTracksByIds threw",
        data: { message: spotifyErr instanceof Error ? spotifyErr.message : String(spotifyErr) },
        timestamp: Date.now()
      })
    }).catch(() => {});
    // #endregion
    throw spotifyErr;
  }
  const byId = new Map(tracks.map((t) => [t.id, t]));
  const merged = toHydrate.map((item) => {
    const t = byId.get(item.songId);
    return t ? mergeSpotifyTrackIntoRecommendation(item, t) : item;
  });
  const out = merged.slice(0, RETURN_SUGGESTIONS);

  try {
    await setCacheDoc("playlist_suggestion_cache", cacheKey, {
      playlistId,
      playlistTrackHash: playlistTrackHash(playlistTrackIds),
      excludedHash,
      suggestionSource: "api",
      suggestions: merged,
      primarySuggestion: out[0] ?? null,
      fetchedAt: nowMs(),
      expiresAt: nowMs() + TTL_MS.finalSuggestion
    });
  } catch (cacheWriteErr) {
    console.error(
      "[hydrateApiRecommendationsFromSpotify] playlist_suggestion_cache setDoc failed:",
      cacheWriteErr
    );
    // #region agent log
    fetch("http://127.0.0.1:7701/ingest/35369d23-7f37-4585-ac9a-076a3915746b", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "658713" },
      body: JSON.stringify({
        sessionId: "658713",
        runId: "suggestions-fail",
        hypothesisId: "DBG-H-C",
        location: "recommendations.ts:hydrateApiRecommendationsFromSpotify:setCacheDoc",
        message: "setCacheDoc playlist_suggestion_cache threw",
        data: { message: cacheWriteErr instanceof Error ? cacheWriteErr.message : String(cacheWriteErr) },
        timestamp: Date.now()
      })
    }).catch(() => {});
    // #endregion
    throw cacheWriteErr;
  }
  debugLog(
    "src/services/recommendations.ts:hydrateApiRecommendationsFromSpotify",
    "merged Spotify metadata into API items and cached",
    {
      cacheKey,
      outCount: out.length,
      sample: out[0]
        ? { songId: out[0].songId, releaseDate: out[0].releaseDate ?? null, durationMs: out[0].durationMs ?? null }
        : null
    },
    "H51",
    "metadata-genre-debug"
  );
  return out;
}

async function buildCooccurrenceRecommendations(playlistId: string, options?: RecommendationOptions): Promise<RecommendationItem[]> {
  const tracksSnap = await getDocs(collection(db, "playlists", playlistId, "tracks"));
  const playlistTracks = tracksSnap.docs.map((docSnap) => {
    const data = docSnap.data() as Partial<PlaylistTrack>;
    return {
      id: String(data.id ?? docSnap.id),
      name: String(data.name ?? ""),
      artists: Array.isArray(data.artists) ? data.artists : [],
      uri: data.uri ?? `spotify:track:${String(data.id ?? docSnap.id)}`,
      albumId: String(data.albumId ?? ""),
      albumName: String(data.albumName ?? ""),
      artworkUrl: data.artworkUrl ?? null,
      previewUrl: data.previewUrl ?? null,
      releaseDate: data.releaseDate ?? null,
      durationMs: Number(data.durationMs ?? 0),
      genres: data.genres ?? [],
      addedAt: String(data.addedAt ?? new Date().toISOString())
    } as PlaylistTrack;
  });
  const playlistTrackIds = playlistTracks.map((track) => track.id).filter(Boolean);
  const excludedIds = new Set(playlistTrackIds);
  for (const excludedSongId of options?.excludeSongIds ?? []) {
    if (excludedSongId) excludedIds.add(excludedSongId);
  }
  if (!playlistTrackIds.length) return fallbackPopularityExcluding(excludedIds);

  const excludedHash = hashString(Array.from(excludedIds).sort().join("|"));
  const cacheKey = `${playlistId}_${playlistTrackHash(playlistTrackIds)}_${excludedHash}`;
  debugLog(
    "src/services/recommendations.ts:buildCooccurrenceRecommendations",
    "building cooccurrence recommendations",
    { playlistId, playlistTrackCount: playlistTrackIds.length, excludedCount: excludedIds.size, forceRefresh: Boolean(options?.forceRefresh), cacheKey },
    "H15",
    "suppression-debug"
  );
  const suggestionCache = await getCacheDoc<PlaylistSuggestionCacheDoc>("playlist_suggestion_cache", cacheKey);
  if (!options?.forceRefresh && suggestionCache?.suggestions?.length && suggestionCache.suggestionSource !== "api") {
    debugLog(
      "src/services/recommendations.ts:buildCooccurrenceRecommendations",
      "served suggestions from cache",
      {
        cacheKey,
        count: suggestionCache.suggestions.length,
        sample: suggestionCache.suggestions[0]
          ? {
              songId: suggestionCache.suggestions[0].songId,
              releaseDate: suggestionCache.suggestions[0].releaseDate ?? null,
              durationMs: suggestionCache.suggestions[0].durationMs ?? null,
              previewUrl: suggestionCache.suggestions[0].previewUrl ?? null
            }
          : null
      },
      "H1"
    );
    return suggestionCache.suggestions;
  }

  const seedTracks = playlistTracks.slice(0, MAX_SEEDS);
  const cooccurCounts = new Map<string, number>();
  const seedCoverage = new Map<string, number>();
  const seedNamesByCandidate = new Map<string, Set<string>>();

  const ownDataNeighbors = await buildFromOwnAppCooccurrence(seedTracks);
  ownDataNeighbors.forEach((count, candidateId) => {
    cooccurCounts.set(candidateId, (cooccurCounts.get(candidateId) ?? 0) + count);
    seedCoverage.set(candidateId, Math.max(seedCoverage.get(candidateId) ?? 0, 1));
  });

  for (const seed of seedTracks) {
    try {
      const { neighbors } = await getOrBuildTrackCooccurrence(seed);
      for (const [candidateId, count] of neighbors.entries()) {
        cooccurCounts.set(candidateId, (cooccurCounts.get(candidateId) ?? 0) + count);
        seedCoverage.set(candidateId, (seedCoverage.get(candidateId) ?? 0) + 1);
        const names = seedNamesByCandidate.get(candidateId) ?? new Set<string>();
        names.add(seed.name);
        seedNamesByCandidate.set(candidateId, names);
      }
    } catch (error) {
      debugLog(
        "src/services/recommendations.ts:buildCooccurrenceRecommendations",
        "seed cooccurrence bootstrap failed; continuing",
        {
          seedTrackId: seed.id,
          seedTrackName: seed.name,
          message: error instanceof Error ? error.message : String(error)
        },
        "H9"
      );
    }
  }

  const candidates = Array.from(cooccurCounts.entries())
    .filter(([candidateId]) => !excludedIds.has(candidateId))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 80);

  const candidateIds = candidates.map(([id]) => id);
  const spotifyTracks = await spotifyService.getTracksByIds(candidateIds.slice(0, 50));
  const trackById = new Map(spotifyTracks.map((track) => [track.id, track]));
  const genreProfile = computeGenreProfile(seedTracks);
  const maxCooccur = Math.max(1, ...candidates.map(([, count]) => count));
  const maxCoverage = Math.max(1, ...Array.from(seedCoverage.values(), (value) => value));

  const recs: RecommendationItem[] = [];
  for (const [candidateId, count] of candidates) {
    const track = trackById.get(candidateId);
    if (!track) continue;
    const normalizedCooccurCount = count / maxCooccur;
    const coverage = seedCoverage.get(candidateId) ?? 0;
    const normalizedSeedCoverage = coverage / maxCoverage;
    const genreMatch = computeGenreMatch(track, genreProfile);
    const novelty = seedTracks.some((seed) => seed.artists[0] && track.artists[0] && seed.artists[0] === track.artists[0]) ? 0 : 1;
    const score =
      0.55 * normalizedCooccurCount +
      0.3 * normalizedSeedCoverage +
      0.1 * genreMatch +
      0.05 * novelty;
    const baseReason = buildReason(
      coverage,
      count,
      genreMatch,
      Array.from(seedNamesByCandidate.get(candidateId) ?? [])
    );
    const reason = baseReason;
    recs.push({
      songId: candidateId,
      spotifyId: candidateId,
      songName: track.name,
      artists: track.artists,
      uri: track.uri,
      albumName: track.albumName,
      artworkUrl: track.artworkUrl,
      previewUrl: track.previewUrl,
      releaseDate: track.releaseDate,
      durationMs: track.durationMs,
      score,
      reasons: [reason],
      scoreBreakdown: {
        cooccurCount: normalizedCooccurCount,
        seedCoverage: normalizedSeedCoverage,
        genreMatch,
        novelty
      }
    });
  }
  recs.sort((a, b) => b.score - a.score);

  if (recs.length < MIN_SUGGESTIONS) {
    const fallbackByGenre: RecommendationItem[] = [];
    const topGenres = Array.from(genreProfile.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([genre]) => genre);
    for (const genre of topGenres) {
      const tracks = await spotifyService.searchTracks(genre, "US", "recommendation-fallback-genre");
      for (const track of tracks) {
        if (excludedIds.has(track.id) || recs.some((item) => item.songId === track.id)) continue;
        fallbackByGenre.push({
          songId: track.id,
          spotifyId: track.id,
          songName: track.name,
          artists: track.artists,
          uri: track.uri,
          albumName: track.albumName,
          artworkUrl: track.artworkUrl,
          previewUrl: track.previewUrl,
          releaseDate: track.releaseDate,
          durationMs: track.durationMs,
          score: 0.2,
          reasons: ["Suggested as a lower-confidence co-occurrence fallback aligned to your playlist style."]
        });
        if (recs.length + fallbackByGenre.length >= MIN_SUGGESTIONS) break;
      }
      if (recs.length + fallbackByGenre.length >= MIN_SUGGESTIONS) break;
    }
    recs.push(...fallbackByGenre);
  }

  if (recs.length < MIN_SUGGESTIONS) {
    const fallbackPopular = await fallbackPopularityExcluding(new Set([...excludedIds, ...recs.map((item) => item.songId)]));
    recs.push(...fallbackPopular);
  }

  const finalSuggestions = recs.slice(0, MIN_SUGGESTIONS);
  if (finalSuggestions[0]) {
    const first = finalSuggestions[0];
    const refined = await refineReasonWithLLM(first.reasons?.[0] ?? "", {
      trackName: first.songName ?? first.songId,
      artists: first.artists ?? [],
      seedTrackNames: seedTracks.map((track) => track.name).slice(0, 5),
      playlistTrackNames: playlistTracks.map((track) => track.name).slice(0, 12),
      albumName: first.albumName
    });
    first.reasons = [refined];
  }
  debugLog(
    "src/services/recommendations.ts:buildCooccurrenceRecommendations",
    "built suggestions fresh",
    {
      count: finalSuggestions.length,
      sample: finalSuggestions[0]
        ? {
            songId: finalSuggestions[0].songId,
            releaseDate: finalSuggestions[0].releaseDate ?? null,
            durationMs: finalSuggestions[0].durationMs ?? null,
            previewUrl: finalSuggestions[0].previewUrl ?? null
          }
        : null
    },
    "H2"
  );
  await setCacheDoc("playlist_suggestion_cache", cacheKey, {
    playlistId,
    playlistTrackHash: playlistTrackHash(playlistTrackIds),
    excludedHash,
    suggestionSource: "cooc",
    suggestions: finalSuggestions,
    primarySuggestion: finalSuggestions[0] ?? null,
    fetchedAt: nowMs(),
    expiresAt: nowMs() + TTL_MS.finalSuggestion
  });
  return finalSuggestions;
}

export const recommendationService = {
  async getRecommendations(playlistId: string, options?: RecommendationOptions): Promise<RecommendationItem[]> {
    const requestKey = `${playlistId}|${(options?.excludeSongIds ?? []).slice().sort().join(",")}|${options?.forceRefresh ? "force" : "normal"}`;
    if (recommendationsInFlight.has(requestKey)) {
      return recommendationsInFlight.get(requestKey) ?? [];
    }
    const task = (async () => {
    const endpoint = import.meta.env.VITE_RECOMMENDATIONS_ENDPOINT ?? "";
    const excludedIds = new Set((options?.excludeSongIds ?? []).filter(Boolean));
    debugLog(
      "src/services/recommendations.ts:getRecommendations",
      "recommendation request started",
      {
        playlistId,
        hasEndpoint: Boolean(endpoint),
        excludedCount: excludedIds.size,
        forceRefresh: Boolean(options?.forceRefresh)
      },
      "H11",
      "suppression-debug"
    );
    try {
      if (endpoint) {
        let response: Response;
        try {
          response = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ playlistId })
          });
        } catch {
          debugLog(
            "src/services/recommendations.ts:getRecommendations",
            "api call failed, switching to fallback builder",
            { playlistId },
            "H12",
            "suppression-debug"
          );
          return (await buildCooccurrenceRecommendations(playlistId, options)).slice(0, RETURN_SUGGESTIONS);
        }
        if (!response.ok) {
          debugLog(
            "src/services/recommendations.ts:getRecommendations",
            "api response not ok, switching to fallback builder",
            { status: response.status, playlistId },
            "H12",
            "suppression-debug"
          );
          return (await buildCooccurrenceRecommendations(playlistId, options)).slice(0, RETURN_SUGGESTIONS);
        }
        const payload = (await response.json()) as { suggestions?: RecommendationItem[]; items?: RecommendationItem[] };
        const fromApi = payload.suggestions ?? payload.items ?? [];
        const filteredFromApi = fromApi.filter((item) => !excludedIds.has(item.songId));
        debugLog(
          "src/services/recommendations.ts:getRecommendations",
          "api recommendations payload",
          {
            endpoint,
            count: filteredFromApi.length,
            sample: filteredFromApi[0]
              ? {
                  songId: filteredFromApi[0].songId,
                  releaseDate: filteredFromApi[0].releaseDate ?? null,
                  durationMs: filteredFromApi[0].durationMs ?? null,
                  previewUrl: filteredFromApi[0].previewUrl ?? null
                }
              : null
          },
          "H3"
        );
        if (filteredFromApi.length >= RETURN_SUGGESTIONS) {
          return hydrateApiRecommendationsFromSpotify(playlistId, filteredFromApi, options);
        }
        const fallback = await buildCooccurrenceRecommendations(playlistId, options);
        const filteredFallback = fallback.filter((item) => !excludedIds.has(item.songId));
        debugLog(
          "src/services/recommendations.ts:getRecommendations",
          "combined api+fallback result computed",
          {
            hydratedCount: filteredFromApi.length,
            fallbackCount: filteredFallback.length,
            returnCount: [...filteredFromApi, ...filteredFallback.filter((item) => !filteredFromApi.some((existing) => existing.songId === item.songId))]
              .slice(0, RETURN_SUGGESTIONS).length
          },
          "H13",
          "suppression-debug"
        );
        return [...filteredFromApi, ...filteredFallback.filter((item) => !filteredFromApi.some((existing) => existing.songId === item.songId))]
          .slice(0, RETURN_SUGGESTIONS);
      }
      return (await buildCooccurrenceRecommendations(playlistId, options)).slice(0, RETURN_SUGGESTIONS);
    } catch (error) {
      debugLog(
        "src/services/recommendations.ts:getRecommendations",
        "recommendation request threw error",
        { playlistId, message: error instanceof Error ? error.message : String(error) },
        "H14",
        "suppression-debug"
      );
      throw error;
    }
    })();
    recommendationsInFlight.set(requestKey, task);
    try {
      return await task;
    } finally {
      recommendationsInFlight.delete(requestKey);
    }
  }
};

import type { RecommendationItem, PlaylistTrack } from "../types/music";
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
  suggestions: RecommendationItem[];
  primarySuggestion: RecommendationItem | null;
  fetchedAt: number;
  expiresAt: number;
}

const TTL_MS = {
  search: 12 * 60 * 60 * 1000,
  playlistTracks: 12 * 60 * 60 * 1000,
  trackCooccurrence: 24 * 60 * 60 * 1000,
  finalSuggestion: 20 * 60 * 1000
} as const;

const MIN_SUGGESTIONS = 5;
const MAX_SEEDS = 8;
const PLAYLISTS_PER_SEED = 12;
const TRACKS_PER_PUBLIC_PLAYLIST = 120;

function debugLog(location: string, message: string, data: Record<string, unknown>, hypothesisId: string, runId = "suggestion-debug") {
  // #region agent log
  fetch("http://127.0.0.1:7701/ingest/35369d23-7f37-4585-ac9a-076a3915746b", {
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

function isLikelySpotifyTrackId(id: string): boolean {
  return /^[A-Za-z0-9]{22}$/.test(id);
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
  const topSeeds = seedTrackNames.slice(0, 2).map((name) => `‘${name}’`).join(" and ");
  if (genreMatch >= 0.3) {
    return "Suggested because it co-occurs with multiple songs in your playlist and matches your playlist genre profile.";
  }
  if (seedCoverage >= 2 && topSeeds) {
    return `Suggested because listeners who playlisted ${topSeeds} often also playlist this track.`;
  }
  if (cooccurCount >= 2) {
    return "Suggested because this track appears in several public Spotify playlists that also include songs from your playlist.";
  }
  return "Suggested because this track co-occurs with songs from your playlist in Spotify playlists.";
}

async function getCacheDoc<T extends { expiresAt: number }>(pathCollection: string, key: string): Promise<T | null> {
  const snap = await getDoc(doc(db, pathCollection, key));
  if (!snap.exists()) return null;
  const data = snap.data() as T;
  if (!data || Number(data.expiresAt ?? 0) < nowMs()) return null;
  return data;
}

async function setCacheDoc(pathCollection: string, key: string, payload: object): Promise<void> {
  await setDoc(doc(db, pathCollection, key), payload, { merge: true });
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
    const searchTracks = await spotifyService.searchTracks(queryText);
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

async function buildCooccurrenceRecommendations(playlistId: string): Promise<RecommendationItem[]> {
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
  if (!playlistTrackIds.length) return fallbackPopularityExcluding(excludedIds);

  const cacheKey = `${playlistId}_${playlistTrackHash(playlistTrackIds)}`;
  const suggestionCache = await getCacheDoc<PlaylistSuggestionCacheDoc>("playlist_suggestion_cache", cacheKey);
  if (suggestionCache?.suggestions?.length) {
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
    const reason = buildReason(
      coverage,
      count,
      genreMatch,
      Array.from(seedNamesByCandidate.get(candidateId) ?? [])
    );
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
      const tracks = await spotifyService.searchTracks(genre, "US");
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
    suggestions: finalSuggestions,
    primarySuggestion: finalSuggestions[0] ?? null,
    fetchedAt: nowMs(),
    expiresAt: nowMs() + TTL_MS.finalSuggestion
  });
  return finalSuggestions;
}

async function getFallbackRecommendationsOrThrow(playlistId: string): Promise<RecommendationItem[]> {
  try {
    return await buildCooccurrenceRecommendations(playlistId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown fallback error";
    throw new Error(`Recommendation fallback failed: ${message}`);
  }
}

async function hydrateAndValidateSuggestions(items: RecommendationItem[]): Promise<RecommendationItem[]> {
  const ids = Array.from(new Set(items.map((item) => item.songId).filter(Boolean)));
  if (!ids.length) return [];
  const resolvableIds = ids.filter((id) => isLikelySpotifyTrackId(id));
  debugLog(
    "src/services/recommendations.ts:hydrateAndValidateSuggestions",
    "validating incoming suggestion IDs",
    { totalIds: ids.length, spotifyLikeIds: resolvableIds.length },
    "H10"
  );
  const tracks = await spotifyService.getTracksByIds(resolvableIds);
  const byId = new Map(tracks.map((track) => [track.id, track]));
  const hydratedDirect = items
    .map((item) => {
      const track = byId.get(item.songId);
      if (!track) return null;
      return {
        ...item,
        songId: track.id,
        spotifyId: track.id,
        songName: track.name,
        artists: track.artists,
        uri: track.uri,
        albumName: track.albumName,
        artworkUrl: track.artworkUrl,
        previewUrl: track.previewUrl,
        releaseDate: track.releaseDate,
        durationMs: track.durationMs
      } as RecommendationItem;
    })
    .filter((item): item is RecommendationItem => Boolean(item));
  if (hydratedDirect.length >= MIN_SUGGESTIONS) return hydratedDirect;

  const unresolved = items.filter((item) => !hydratedDirect.some((resolved) => resolved.songId === item.songId));
  const recovered: RecommendationItem[] = [];
  for (const item of unresolved) {
    const query = [item.songName ?? "", item.artists?.[0] ?? ""].filter(Boolean).join(" ").trim();
    if (!query) continue;
    try {
      const searchResults = await spotifyService.searchTracks(query);
      const best = searchResults[0];
      if (!best) continue;
      recovered.push({
        ...item,
        songId: best.id,
        spotifyId: best.id,
        songName: best.name,
        artists: best.artists,
        uri: best.uri,
        albumName: best.albumName,
        artworkUrl: best.artworkUrl,
        previewUrl: best.previewUrl,
        releaseDate: best.releaseDate,
        durationMs: best.durationMs
      });
    } catch {}
    if (hydratedDirect.length + recovered.length >= MIN_SUGGESTIONS) break;
  }
  return [...hydratedDirect, ...recovered];
}

export const recommendationService = {
  async getRecommendations(playlistId: string): Promise<RecommendationItem[]> {
    const endpoint = import.meta.env.VITE_RECOMMENDATIONS_ENDPOINT ?? "";
    if (endpoint) {
      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ playlistId })
        });
      } catch {
        return getFallbackRecommendationsOrThrow(playlistId);
      }
      if (!response.ok) {
        return getFallbackRecommendationsOrThrow(playlistId);
      }
      const payload = (await response.json()) as { suggestions?: RecommendationItem[]; items?: RecommendationItem[] };
      const fromApi = payload.suggestions ?? payload.items ?? [];
      debugLog(
        "src/services/recommendations.ts:getRecommendations",
        "api recommendations payload",
        {
          endpoint,
          count: fromApi.length,
          sample: fromApi[0]
            ? {
                songId: fromApi[0].songId,
                releaseDate: fromApi[0].releaseDate ?? null,
                durationMs: fromApi[0].durationMs ?? null,
                previewUrl: fromApi[0].previewUrl ?? null
              }
            : null
        },
        "H3"
      );
      const hydratedApi = await hydrateAndValidateSuggestions(fromApi);
      debugLog(
        "src/services/recommendations.ts:getRecommendations",
        "api suggestions hydrated against spotify",
        {
          originalCount: fromApi.length,
          hydratedCount: hydratedApi.length,
          sample: hydratedApi[0]
            ? {
                songId: hydratedApi[0].songId,
                releaseDate: hydratedApi[0].releaseDate ?? null,
                durationMs: hydratedApi[0].durationMs ?? null,
                previewUrl: hydratedApi[0].previewUrl ?? null
              }
            : null
        },
        "H8",
        "post-fix"
      );
      if (hydratedApi.length >= MIN_SUGGESTIONS) {
        return hydratedApi.slice(0, MIN_SUGGESTIONS);
      }
      const fallback = await getFallbackRecommendationsOrThrow(playlistId);
      return [...hydratedApi, ...fallback.filter((item) => !hydratedApi.some((existing) => existing.songId === item.songId))]
        .slice(0, MIN_SUGGESTIONS);
    }
    return getFallbackRecommendationsOrThrow(playlistId);
  }
};

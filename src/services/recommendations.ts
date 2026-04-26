import type { RecommendationItem } from "../types/music";
import { collection, doc, getDoc, getDocs, limit, orderBy, query } from "firebase/firestore";
import { db } from "./firebase";

interface NeighborDoc {
  neighbors?: Record<string, number>;
}

interface SongStatsDoc {
  playCount?: number;
  skipCount?: number;
  addToPlaylistCount?: number;
}

interface GeniusMetaDoc {
  tags?: string[];
  relatedArtistNames?: string[];
}

function computePopularSafeScore(stats: SongStatsDoc): number {
  const plays = Number(stats.playCount ?? 0);
  const skips = Number(stats.skipCount ?? 0);
  const adds = Number(stats.addToPlaylistCount ?? 0);
  const engagement = Math.max(0, (plays + adds - skips) / Math.max(1, plays + adds + skips));
  const popularity = Math.min(1, Math.log10(plays + 1) / 5);
  return 0.7 * engagement + 0.3 * popularity;
}

function buildFriendlyReason(
  playlistSimilarity: number,
  searchSimilarity: number,
  globalEngagement: number,
  metadataSimilarity: number,
  isTopUp = false
): string {
  if (isTopUp) return "A popular pick to keep your playlist momentum going.";
  if (metadataSimilarity >= playlistSimilarity && metadataSimilarity >= searchSimilarity) {
    return "Shares song context and related-artist traits with your playlist.";
  }
  if (playlistSimilarity >= searchSimilarity && playlistSimilarity >= globalEngagement) {
    return "Fits the vibe of songs already in your playlist.";
  }
  if (searchSimilarity >= globalEngagement) {
    return "Matches what listeners often explore around your tracks.";
  }
  return "Popular with steady replay value right now.";
}

function normalizeTags(values: string[] | undefined): string[] {
  if (!Array.isArray(values)) return [];
  return values
    .map((value) => String(value).toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function computeMetadataSimilarity(
  candidateMeta: GeniusMetaDoc | undefined,
  playlistTagSet: Set<string>,
  playlistRelatedArtistSet: Set<string>
): number {
  if (!candidateMeta) return 0;
  const tags = normalizeTags(candidateMeta.tags);
  const relatedArtists = Array.isArray(candidateMeta.relatedArtistNames)
    ? candidateMeta.relatedArtistNames.map((name) => String(name || "").toLowerCase().trim()).filter(Boolean)
    : [];
  const tagHits = tags.filter((tag) => playlistTagSet.has(tag)).length;
  const artistHits = relatedArtists.filter((artist) => playlistRelatedArtistSet.has(artist)).length;
  const tagScore = tags.length ? tagHits / tags.length : 0;
  const artistScore = relatedArtists.length ? artistHits / relatedArtists.length : 0;
  return Math.max(0, Math.min(1, 0.7 * tagScore + 0.3 * artistScore));
}

function normalizeMap(values: Map<string, number>): Map<string, number> {
  const max = Math.max(...Array.from(values.values()), 0);
  if (max <= 0) return values;
  return new Map(Array.from(values.entries()).map(([k, v]) => [k, v / max]));
}

async function getFallbackRecommendations(playlistId: string): Promise<RecommendationItem[]> {
  const tracksSnap = await getDocs(collection(db, "playlists", playlistId, "tracks"));
  const playlistTrackIds = new Set(tracksSnap.docs.map((docSnap) => docSnap.id));

  // Cold-start fallback: global engagement if playlist is empty.
  if (playlistTrackIds.size === 0) {
    const statsSnap = await getDocs(query(collection(db, "song_stats"), orderBy("playCount", "desc"), limit(5)));
    const items = await Promise.all(
      statsSnap.docs.map(async (statDoc) => {
        const songSnap = await getDoc(doc(db, "songs", statDoc.id));
        const song = songSnap.data() as { name?: string; artists?: string[] } | undefined;
        return {
          songId: statDoc.id,
          songName: song?.name ?? statDoc.id,
          artists: song?.artists ?? [],
          score: computePopularSafeScore(statDoc.data() as SongStatsDoc),
          reasons: ["A popular pick to keep your playlist momentum going."]
        };
      })
    );
    return items;
  }

  const playlistScoresRaw = new Map<string, number>();
  const searchScoresRaw = new Map<string, number>();

  for (const trackId of playlistTrackIds) {
    const [playlistCoDoc, searchCoDoc] = await Promise.all([
      getDoc(doc(db, "cooccurrence_playlist", trackId)),
      getDoc(doc(db, "cooccurrence_search", trackId))
    ]);
    const playlistNeighbors = (playlistCoDoc.data() as NeighborDoc | undefined)?.neighbors ?? {};
    const searchNeighbors = (searchCoDoc.data() as NeighborDoc | undefined)?.neighbors ?? {};
    for (const [candidateId, value] of Object.entries(playlistNeighbors)) {
      if (playlistTrackIds.has(candidateId)) continue;
      playlistScoresRaw.set(candidateId, (playlistScoresRaw.get(candidateId) ?? 0) + Number(value));
    }
    for (const [candidateId, value] of Object.entries(searchNeighbors)) {
      if (playlistTrackIds.has(candidateId)) continue;
      searchScoresRaw.set(candidateId, (searchScoresRaw.get(candidateId) ?? 0) + Number(value));
    }
  }

  const playlistScores = normalizeMap(playlistScoresRaw);
  const searchScores = normalizeMap(searchScoresRaw);
  const candidateIds = Array.from(new Set([...playlistScores.keys(), ...searchScores.keys()])).slice(0, 80);
  if (candidateIds.length === 0) return [];

  const playlistSongDocs = await Promise.all(
    Array.from(playlistTrackIds).map((id) => getDoc(doc(db, "songs", id)))
  );
  const playlistTagSet = new Set<string>();
  const playlistRelatedArtistSet = new Set<string>();
  playlistSongDocs.forEach((songSnap) => {
    const meta = (songSnap.data() as { geniusMeta?: GeniusMetaDoc } | undefined)?.geniusMeta;
    normalizeTags(meta?.tags).forEach((tag) => playlistTagSet.add(tag));
    if (Array.isArray(meta?.relatedArtistNames)) {
      meta.relatedArtistNames.forEach((name) => {
        const normalized = String(name || "").toLowerCase().trim();
        if (normalized) playlistRelatedArtistSet.add(normalized);
      });
    }
  });

  const scored = await Promise.all(
    candidateIds.map(async (candidateId) => {
      const [statsSnap, songSnap] = await Promise.all([
        getDoc(doc(db, "song_stats", candidateId)),
        getDoc(doc(db, "songs", candidateId))
      ]);
      const stats = (statsSnap.data() as SongStatsDoc | undefined) ?? {};
      const globalEngagement = computePopularSafeScore(stats);
      const playlistSimilarity = playlistScores.get(candidateId) ?? 0;
      const searchSimilarity = searchScores.get(candidateId) ?? 0;
      const candidateMeta = (songSnap.data() as { geniusMeta?: GeniusMetaDoc } | undefined)?.geniusMeta;
      const metadataSimilarity = computeMetadataSimilarity(candidateMeta, playlistTagSet, playlistRelatedArtistSet);
      const recencyAffinity = playlistSimilarity * 0.8 + searchSimilarity * 0.2;
      const score =
        0.45 * playlistSimilarity +
        0.2 * searchSimilarity +
        0.2 * globalEngagement +
        0.05 * recencyAffinity +
        0.1 * metadataSimilarity;
      const song = (songSnap.data() as { name?: string; artists?: string[] } | undefined) ?? {};
      const hasUsefulSignal =
        playlistSimilarity >= 0.05 || searchSimilarity >= 0.05 || globalEngagement >= 0.1 || metadataSimilarity > 0;
      if (!hasUsefulSignal) return null;

      return {
        songId: candidateId,
        songName: song.name ?? candidateId,
        artists: song.artists ?? [],
        score,
        reasons: [buildFriendlyReason(playlistSimilarity, searchSimilarity, globalEngagement, metadataSimilarity)]
      };
    })
  );

  const ranked = scored
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .sort((a, b) => b.score - a.score);
  const chosen = ranked.slice(0, 5);
  if (chosen.length < 5) {
    const chosenIds = new Set(chosen.map((item) => item.songId));
    const topUpStats = await getDocs(query(collection(db, "song_stats"), orderBy("playCount", "desc"), limit(30)));
    for (const statDoc of topUpStats.docs) {
      if (chosen.length >= 5) break;
      if (playlistTrackIds.has(statDoc.id) || chosenIds.has(statDoc.id)) continue;
      const songSnap = await getDoc(doc(db, "songs", statDoc.id));
      const song = (songSnap.data() as { name?: string; artists?: string[] } | undefined) ?? {};
      chosen.push({
        songId: statDoc.id,
        songName: song.name ?? statDoc.id,
        artists: song.artists ?? [],
        score: computePopularSafeScore(statDoc.data() as SongStatsDoc),
        reasons: [buildFriendlyReason(0, 0, 1, 0, true)]
      });
      chosenIds.add(statDoc.id);
    }
  }
  return chosen.slice(0, 5);
}

async function getFallbackRecommendationsOrThrow(playlistId: string): Promise<RecommendationItem[]> {
  try {
    return await getFallbackRecommendations(playlistId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown fallback error";
    throw new Error(`Recommendation fallback failed: ${message}`);
  }
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
      const payload = (await response.json()) as { items: RecommendationItem[] };
      return payload.items ?? [];
    }
    return getFallbackRecommendationsOrThrow(playlistId);
  }
};

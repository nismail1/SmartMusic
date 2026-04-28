import type { PlaylistLlmGenresCache, PlaylistTrack } from "../types/music";
import { computePlaylistTrackContentHash, playlistService } from "./playlists";

/** Deploy `getPlaylistLlmGenres` and point here; defaults from same base as recommendations. */
export function resolvePlaylistLlmGenresEndpoint(): string {
  const explicit = (import.meta.env.VITE_PLAYLIST_LLM_GENRES_ENDPOINT ?? "").trim();
  if (explicit) return explicit;
  const rec = (import.meta.env.VITE_RECOMMENDATIONS_ENDPOINT ?? "").trim();
  if (rec.includes("getRecommendations")) return rec.replace("getRecommendations", "getPlaylistLlmGenres");
  return "";
}

/**
 * Returns genre map for current tracks using Firestore cache when playlist track set unchanged.
 * Does nothing when endpoint unset or playlist empty.
 */
export async function ensurePlaylistLlmGenres(
  playlistId: string,
  tracks: PlaylistTrack[]
): Promise<PlaylistLlmGenresCache | null> {
  if (!playlistId || !tracks.length) return null;

  const contentHash = computePlaylistTrackContentHash(tracks.map((t) => t.id));
  const cached = await playlistService.getPlaylistLlmGenresCache(playlistId);
  if (cached?.contentHash === contentHash && cached.byTrackId) {
    return cached;
  }

  const endpoint = resolvePlaylistLlmGenresEndpoint();
  if (!endpoint) return cached ?? null;

  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tracks: tracks.map((t) => ({
        id: t.id,
        name: t.name,
        artists: t.artists ?? []
      }))
    })
  });

  if (!res.ok) {
    return cached ?? null;
  }

  const json = (await res.json()) as { byTrackId?: Record<string, string[]> };
  const raw = json.byTrackId && typeof json.byTrackId === "object" ? json.byTrackId : {};
  const byTrackId: Record<string, string[]> = {};
  for (const t of tracks) {
    const arr = raw[t.id];
    byTrackId[t.id] = Array.isArray(arr)
      ? arr.map((g) => String(g).toLowerCase().trim()).filter(Boolean).slice(0, 8)
      : [];
  }

  const next: PlaylistLlmGenresCache = {
    contentHash,
    fetchedAt: new Date().toISOString(),
    byTrackId
  };
  await playlistService.savePlaylistLlmGenresCache(playlistId, next);
  return next;
}

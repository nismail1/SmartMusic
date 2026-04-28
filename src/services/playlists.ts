import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where
} from "firebase/firestore";
import { db } from "./firebase";
import type { Playlist, PlaylistLlmGenresCache, PlaylistTrack, SpotifyTrack } from "../types/music";
import { spotifyService } from "./spotify";

const playlistsCol = collection(db, "playlists");

function debugLog(location: string, message: string, data: Record<string, unknown>, hypothesisId: string, runId = "metadata-genre-debug") {
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

/** Stable hash of the playlist's track id set (order-independent). */
export function computePlaylistTrackContentHash(trackIds: string[]): string {
  let hash = 2166136261;
  const s = [...new Set(trackIds.map((id) => String(id).trim()).filter(Boolean))].sort().join("|");
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return Math.abs(hash >>> 0).toString(16);
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

export const playlistService = {
  async createPlaylist(userId: string, name: string): Promise<string> {
    const ref = await addDoc(playlistsCol, {
      userId,
      name,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    return ref.id;
  },
  async listPlaylists(userId: string): Promise<Playlist[]> {
    const q = query(playlistsCol, where("userId", "==", userId), orderBy("updatedAt", "desc"));
    try {
      const snap = await getDocs(q);
      return snap.docs.map((d) => {
        const data = d.data();
        return {
          id: d.id,
          userId: data.userId,
          name: data.name,
          createdAt: data.createdAt?.toDate?.()?.toISOString?.() ?? new Date().toISOString(),
          updatedAt: data.updatedAt?.toDate?.()?.toISOString?.() ?? new Date().toISOString()
        };
      });
    } catch (error) {
      throw error;
    }
  },
  async listPlaylistTracks(playlistId: string): Promise<PlaylistTrack[]> {
    const tracksRef = collection(db, "playlists", playlistId, "tracks");
    const snap = await getDocs(query(tracksRef, orderBy("addedAt", "asc")));
    const tracks = snap.docs.map((d) => {
      const data = d.data() as Partial<PlaylistTrack>;
      const id = String(data.id ?? d.id);
      const rawGenres = Array.isArray(data.genres) ? data.genres.map((value) => String(value)).filter(Boolean) : [];
      const cleanedGenres = rawGenres.filter((genre) => !isSyntheticGenreTag(genre));
      return {
        id,
        name: data.name ?? "",
        artists: Array.isArray(data.artists) ? data.artists : [],
        uri: data.uri ?? `spotify:track:${id}`,
        albumId: data.albumId ?? "",
        albumName: data.albumName ?? "",
        artworkUrl: data.artworkUrl ?? null,
        previewUrl: data.previewUrl ?? null,
        releaseDate: data.releaseDate ?? null,
        durationMs: Number(data.durationMs ?? 0),
        genres: cleanedGenres,
        genresFetchedAt: data.genresFetchedAt ?? null,
        addedAt: data.addedAt ?? new Date().toISOString(),
        genius: data.genius
      };
    });
    debugLog(
      "src/services/playlists.ts:listPlaylistTracks",
      "playlist tracks loaded for analytics/view",
      {
        playlistId,
        trackCount: tracks.length,
        withGenres: tracks.filter((track) => Array.isArray(track.genres) && track.genres.length > 0).length,
        withReleaseDate: tracks.filter((track) => Boolean(track.releaseDate)).length,
        sample: tracks[0]
          ? { id: tracks[0].id, genreCount: tracks[0].genres?.length ?? 0, releaseDate: tracks[0].releaseDate ?? null, albumName: tracks[0].albumName ?? "" }
          : null
      },
      "H31"
    );
    return tracks;
  },
  async getPlaylist(playlistId: string): Promise<Playlist | null> {
    const snap = await getDoc(doc(db, "playlists", playlistId));
    if (!snap.exists()) return null;
    const data = snap.data();
    return {
      id: snap.id,
      userId: data.userId ?? "",
      name: data.name ?? "Untitled playlist",
      createdAt: data.createdAt?.toDate?.()?.toISOString?.() ?? new Date().toISOString(),
      updatedAt: data.updatedAt?.toDate?.()?.toISOString?.() ?? new Date().toISOString()
    };
  },

  async getPlaylistLlmGenresCache(playlistId: string): Promise<PlaylistLlmGenresCache | null> {
    const snap = await getDoc(doc(db, "playlists", playlistId));
    if (!snap.exists()) return null;
    const data = snap.data();
    const c = data.playlistLlmGenresCache;
    if (!c || typeof c.contentHash !== "string") return null;
    const byTrackId =
      typeof c.byTrackId === "object" && c.byTrackId !== null && !Array.isArray(c.byTrackId)
        ? (c.byTrackId as Record<string, string[]>)
        : {};
    return {
      contentHash: c.contentHash,
      fetchedAt: typeof c.fetchedAt === "string" ? c.fetchedAt : "",
      byTrackId
    };
  },

  async savePlaylistLlmGenresCache(playlistId: string, cache: PlaylistLlmGenresCache): Promise<void> {
    await updateDoc(doc(db, "playlists", playlistId), {
      playlistLlmGenresCache: {
        contentHash: cache.contentHash,
        fetchedAt: cache.fetchedAt,
        byTrackId: cache.byTrackId
      }
    });
  },
  async addTrack(playlistId: string, track: SpotifyTrack): Promise<void> {
    const withGenres = await spotifyService.enrichTrackWithSpotifyGenres(track);
    const enrichedGenres = Array.isArray(withGenres.genres) ? withGenres.genres.filter(Boolean) : [];
    const payload: SpotifyTrack = {
      ...withGenres,
      genres: enrichedGenres,
      genresFetchedAt: withGenres.genresFetchedAt ?? new Date().toISOString()
    };
    debugLog(
      "src/services/playlists.ts:addTrack",
      "addTrack called",
      {
        playlistId,
        trackId: track.id,
        incomingGenreCount: Array.isArray(track.genres) ? track.genres.length : 0,
        resolvedGenreCount: enrichedGenres.length,
        spotifyArtistIdCount: withGenres.spotifyArtistIds?.length ?? 0,
        hasReleaseDate: Boolean(withGenres.releaseDate),
        hasAlbumName: Boolean(withGenres.albumName)
      },
      "H30"
    );
    const trackRef = doc(db, "playlists", playlistId, "tracks", track.id);
    await setDoc(trackRef, { ...payload, addedAt: new Date().toISOString() });
    await updateDoc(doc(db, "playlists", playlistId), { updatedAt: serverTimestamp() });
  },
  async removeTrack(playlistId: string, trackId: string): Promise<void> {
    await deleteDoc(doc(db, "playlists", playlistId, "tracks", trackId));
    await updateDoc(doc(db, "playlists", playlistId), { updatedAt: serverTimestamp() });
  },
  async deletePlaylist(playlistId: string): Promise<void> {
    const tracksRef = collection(db, "playlists", playlistId, "tracks");
    const tracksSnap = await getDocs(tracksRef);
    await Promise.all(tracksSnap.docs.map((trackDoc) => deleteDoc(trackDoc.ref)));
    await deleteDoc(doc(db, "playlists", playlistId));
  }
};

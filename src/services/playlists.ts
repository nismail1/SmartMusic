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
import type { Playlist, PlaylistTrack, SpotifyTrack } from "../types/music";

const playlistsCol = collection(db, "playlists");

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
    return snap.docs.map((d) => {
      const data = d.data() as Partial<PlaylistTrack>;
      const id = String(data.id ?? d.id);
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
        genres: data.genres ?? [],
        addedAt: data.addedAt ?? new Date().toISOString(),
        genius: data.genius
      };
    });
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
  async addTrack(playlistId: string, track: SpotifyTrack): Promise<void> {
    const trackRef = doc(db, "playlists", playlistId, "tracks", track.id);
    await setDoc(trackRef, { ...track, addedAt: new Date().toISOString() });
    await updateDoc(doc(db, "playlists", playlistId), { updatedAt: serverTimestamp() });
  },
  async removeTrack(playlistId: string, trackId: string): Promise<void> {
    await deleteDoc(doc(db, "playlists", playlistId, "tracks", trackId));
    await updateDoc(doc(db, "playlists", playlistId), { updatedAt: serverTimestamp() });
  }
};

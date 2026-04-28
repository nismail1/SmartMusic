export interface SpotifyTrack {
  id: string;
  name: string;
  artists: string[];
  /** Spotify artist IDs (Web API `artists[].id`); genres come from `GET /v1/artists/{id}` (tracks have no genre field). */
  spotifyArtistIds?: string[];
  uri: string;
  albumId: string;
  albumName: string;
  artworkUrl: string | null;
  previewUrl: string | null;
  releaseDate: string | null;
  durationMs: number;
  genres?: string[];
  genresFetchedAt?: string | null;
}

export interface GeniusEnrichment {
  songDescription: string | null;
  artistDescription: string | null;
  tags: string[];
  relatedSongIds: string[];
  relatedArtistNames: string[];
  geniusSongId: string | null;
  geniusSongUrl: string | null;
}

export interface PlaylistTrack extends SpotifyTrack {
  addedAt: string;
  genius?: GeniusEnrichment;
  /** Inferred genre tags from OpenAI (cached on playlist); used when Spotify/Genius lack tags. */
  llmGenres?: string[];
}

export interface Playlist {
  id: string;
  userId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

/** Stored on `playlists/{id}` as `playlistLlmGenresCache` so we do not re-call the LLM on every page load. */
export interface PlaylistLlmGenresCache {
  contentHash: string;
  fetchedAt: string;
  byTrackId: Record<string, string[]>;
}

export interface RecommendationItem {
  songId: string;
  spotifyId?: string;
  songName?: string;
  artists?: string[];
  spotifyArtistIds?: string[];
  uri?: string;
  albumName?: string;
  artworkUrl?: string | null;
  previewUrl?: string | null;
  releaseDate?: string | null;
  durationMs?: number;
  genres?: string[];
  genresFetchedAt?: string | null;
  score: number;
  reasons: string[];
  scoreBreakdown?: {
    cooccurCount: number;
    seedCoverage: number;
    genreMatch: number;
    novelty: number;
  };
}

export interface SpotifyTrack {
  id: string;
  name: string;
  artists: string[];
  uri: string;
  albumId: string;
  albumName: string;
  artworkUrl: string | null;
  previewUrl: string | null;
  releaseDate: string | null;
  durationMs: number;
  genres?: string[];
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
}

export interface Playlist {
  id: string;
  userId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface RecommendationItem {
  songId: string;
  spotifyId?: string;
  songName?: string;
  artists?: string[];
  uri?: string;
  albumName?: string;
  artworkUrl?: string | null;
  previewUrl?: string | null;
  releaseDate?: string | null;
  durationMs?: number;
  score: number;
  reasons: string[];
  scoreBreakdown?: {
    cooccurCount: number;
    seedCoverage: number;
    genreMatch: number;
    novelty: number;
  };
}

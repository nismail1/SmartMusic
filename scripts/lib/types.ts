export interface SpotifyCatalogTrack {
  id: string;
  name: string;
  artists: string[];
  albumId: string;
  albumName: string;
  releaseDate: string | null;
  durationMs: number;
  popularity: number;
  previewUrl: string | null;
  artworkUrl: string | null;
  genres: string[];
}

export interface SeedConfig {
  catalogVersion: string;
  market: "US";
  seedRandom: number;
  userCount: number;
  eventCount: number;
  playlistCount: number;
}

export interface SyntheticUser {
  id: string;
  displayName: string;
  persona: string;
}

export type EventType = "play" | "skip" | "search" | "add_to_playlist";

export interface SyntheticEvent {
  id: string;
  userId: string;
  songId: string;
  eventType: EventType;
  ts: string;
  queryText?: string;
  playlistId?: string;
}


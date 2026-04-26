import type { PlaylistTrack } from "../types/music";

export interface PlaylistAnalytics {
  totalDurationMs: number;
  decadeBreakdown: Record<string, number>;
  genreComposition: Record<string, number>;
}

function toDecade(date: string | null): string {
  if (!date) return "Unknown";
  const year = Number.parseInt(date.slice(0, 4), 10);
  if (Number.isNaN(year)) return "Unknown";
  return `${Math.floor(year / 10) * 10}s`;
}

export function computePlaylistAnalytics(tracks: PlaylistTrack[]): PlaylistAnalytics {
  return tracks.reduce<PlaylistAnalytics>(
    (acc, track) => {
      acc.totalDurationMs += track.durationMs;
      const decade = toDecade(track.releaseDate);
      acc.decadeBreakdown[decade] = (acc.decadeBreakdown[decade] ?? 0) + 1;
      for (const genre of track.genres ?? []) {
        acc.genreComposition[genre] = (acc.genreComposition[genre] ?? 0) + 1;
      }
      return acc;
    },
    { totalDurationMs: 0, decadeBreakdown: {}, genreComposition: {} }
  );
}

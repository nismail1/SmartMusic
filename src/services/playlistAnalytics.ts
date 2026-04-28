import type { PlaylistTrack } from "../types/music";

export interface PlaylistAnalytics {
  totalDurationMs: number;
  decadeBreakdown: Record<string, number>;
  genreComposition: Record<string, number>;
  /** Primary artist (first listed) frequency, most common first. */
  topArtists: { name: string; count: number }[];
}

export interface ChartSegment {
  label: string;
  count: number;
  percent: number;
  color: string;
}

/** Build donut legend segments: top labels + optional "Other"; percents sum to ~100. */
export function countsToChartSegments(
  record: Record<string, number>,
  maxVisible: number,
  colors: string[]
): ChartSegment[] {
  const entries = Object.entries(record)
    .filter(([, c]) => c > 0)
    .sort((a, b) => b[1] - a[1]);
  if (!entries.length) return [];
  const total = entries.reduce((s, [, c]) => s + c, 0);
  const topN = Math.max(1, maxVisible - 1);
  const topTuples = entries.slice(0, topN);
  const rest = entries.slice(topN);
  const rows: { label: string; count: number }[] = topTuples.map(([label, count]) => ({ label, count }));
  if (rest.length) {
    const otherCount = rest.reduce((s, [, c]) => s + c, 0);
    rows.push({ label: "Other", count: otherCount });
  }
  return rows.map((row, i) => ({
    ...row,
    percent: total > 0 ? Math.round((row.count / total) * 100) : 0,
    color: colors[i % colors.length] ?? colors[0]
  }));
}

function toDecade(date: string | null): string {
  if (!date) return "Unknown";
  const year = Number.parseInt(date.slice(0, 4), 10);
  if (Number.isNaN(year)) return "Unknown";
  return `${Math.floor(year / 10) * 10}s`;
}

export function computePlaylistAnalytics(tracks: PlaylistTrack[]): PlaylistAnalytics {
  const artistCounts = new Map<string, number>();
  const rollups = tracks.reduce(
    (acc, track) => {
      acc.totalDurationMs += track.durationMs;
      const decade = toDecade(track.releaseDate);
      acc.decadeBreakdown[decade] = (acc.decadeBreakdown[decade] ?? 0) + 1;
      const genreLabels = new Set([...(track.genres ?? []), ...(track.llmGenres ?? [])]);
      for (const genre of genreLabels) {
        acc.genreComposition[genre] = (acc.genreComposition[genre] ?? 0) + 1;
      }
      const primary = track.artists?.[0]?.trim();
      if (primary) {
        artistCounts.set(primary, (artistCounts.get(primary) ?? 0) + 1);
      }
      return acc;
    },
    {
      totalDurationMs: 0,
      decadeBreakdown: {} as Record<string, number>,
      genreComposition: {} as Record<string, number>
    }
  );

  const topArtists = [...artistCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, count]) => ({ name, count }));

  return {
    totalDurationMs: rollups.totalDurationMs,
    decadeBreakdown: rollups.decadeBreakdown,
    genreComposition: rollups.genreComposition,
    topArtists
  };
}

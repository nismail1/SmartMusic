import { describe, expect, it } from "vitest";
import { computePlaylistAnalytics } from "./playlistAnalytics";

describe("computePlaylistAnalytics", () => {
  it("computes duration, decade, and genre rollups", () => {
    const result = computePlaylistAnalytics([
      {
        id: "1",
        name: "Track A",
        artists: ["Artist A"],
        uri: "spotify:track:1",
        albumId: "a1",
        albumName: "Album A",
        artworkUrl: null,
        previewUrl: null,
        releaseDate: "2019-04-01",
        durationMs: 120000,
        genres: ["pop"],
        addedAt: "2026-01-01T00:00:00.000Z"
      },
      {
        id: "2",
        name: "Track B",
        artists: ["Artist B"],
        uri: "spotify:track:2",
        albumId: "a2",
        albumName: "Album B",
        artworkUrl: null,
        previewUrl: null,
        releaseDate: "1997-02-01",
        durationMs: 180000,
        genres: ["rock"],
        addedAt: "2026-01-02T00:00:00.000Z"
      }
    ]);

    expect(result.totalDurationMs).toBe(300000);
    expect(result.decadeBreakdown["2010s"]).toBe(1);
    expect(result.decadeBreakdown["1990s"]).toBe(1);
    expect(result.genreComposition.pop).toBe(1);
    expect(result.genreComposition.rock).toBe(1);
    expect(result.topArtists.map((t) => t.name)).toEqual(expect.arrayContaining(["Artist A", "Artist B"]));
  });
});

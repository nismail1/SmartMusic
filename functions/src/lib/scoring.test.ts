import { describe, expect, it } from "vitest";
import { scoreCandidate } from "./scoring";

describe("scoreCandidate", () => {
  it("weights features and applies penalties", () => {
    const result = scoreCandidate({
      songId: "song_1",
      playlistSimilarity: 0.8,
      searchSimilarity: 0.6,
      globalEngagement: 0.7,
      recencyAffinity: 0.5,
      skippedRecently: true,
      artistRepeatPenalty: false
    });
    expect(result.baseScore).toBeGreaterThan(0);
    expect(result.baseScore).toBeLessThan(1);
  });
});


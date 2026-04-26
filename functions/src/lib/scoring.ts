export interface CandidateFeatures {
  songId: string;
  playlistSimilarity: number;
  searchSimilarity: number;
  globalEngagement: number;
  recencyAffinity: number;
  skippedRecently: boolean;
  artistRepeatPenalty: boolean;
}

export interface ScoredCandidate extends CandidateFeatures {
  baseScore: number;
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

export function scoreCandidate(features: CandidateFeatures): ScoredCandidate {
  const playlistSimilarity = clamp01(features.playlistSimilarity);
  const searchSimilarity = clamp01(features.searchSimilarity);
  const globalEngagement = clamp01(features.globalEngagement);
  const recencyAffinity = clamp01(features.recencyAffinity);

  let score =
    0.4 * playlistSimilarity + 0.25 * searchSimilarity + 0.2 * globalEngagement + 0.15 * recencyAffinity;
  if (features.skippedRecently) score -= 0.1;
  if (features.artistRepeatPenalty) score -= 0.05;
  return { ...features, playlistSimilarity, searchSimilarity, globalEngagement, recencyAffinity, baseScore: score };
}


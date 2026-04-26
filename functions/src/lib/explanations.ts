import type { ScoredCandidate } from "./scoring";

export function buildReasons(candidate: ScoredCandidate, llmReason?: string): string[] {
  const reasons: string[] = [];
  if (candidate.playlistSimilarity > 0.5) {
    reasons.push("Listeners who added songs in your playlist also added this track");
  }
  if (candidate.searchSimilarity > 0.45) {
    reasons.push("Matches your recent searches");
  }
  if (candidate.globalEngagement > 0.55) {
    reasons.push("High completion and low skip rate among similar listeners");
  }
  if (llmReason) reasons.push(llmReason);
  return reasons.slice(0, 3);
}


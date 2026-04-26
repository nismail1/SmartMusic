import { buildReasons } from "./lib/explanations";
import { rerankWithLlm } from "./lib/llmReranker";
import { scoreCandidate, type CandidateFeatures } from "./lib/scoring";

interface RecommendationResponse {
  items: Array<{ songId: string; score: number; reasons: string[] }>;
}

export async function getRecommendations(
  featureRows: CandidateFeatures[],
  llmClient: { rerank(payload: unknown): Promise<unknown> } | null = null
): Promise<RecommendationResponse> {
  const scored = featureRows.map(scoreCandidate).sort((a, b) => b.baseScore - a.baseScore);
  let llmMap = new Map();
  try {
    llmMap = await rerankWithLlm(llmClient, scored);
  } catch {
    llmMap = new Map();
  }

  const reranked = scored
    .map((candidate) => {
      const llmData = llmMap.get(candidate.songId);
      const score = candidate.baseScore + (llmData?.llmDelta ?? 0);
      return { songId: candidate.songId, score, reasons: buildReasons(candidate, llmData?.reasonText) };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  return { items: reranked };
}


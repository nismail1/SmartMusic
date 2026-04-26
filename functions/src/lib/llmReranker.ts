import { validateLlmOutput, type LlmRerankItem } from "./llmSchema";
import type { ScoredCandidate } from "./scoring";

interface LlmClient {
  rerank(promptPayload: unknown): Promise<unknown>;
}

export async function rerankWithLlm(
  client: LlmClient | null,
  candidates: ScoredCandidate[]
): Promise<Map<string, LlmRerankItem>> {
  if (!client || candidates.length === 0) return new Map();
  const top = candidates.slice(0, 30);
  const allowedSongIds = new Set(top.map((candidate) => candidate.songId));
  const payload = {
    instruction:
      "Re-rank existing candidate IDs only. Do not invent songs. Return [{songId,llmDelta,reasonText,confidence}]",
    candidates: top
  };
  const raw = await client.rerank(payload);
  const validated = validateLlmOutput(raw, allowedSongIds);
  return new Map(validated.map((item) => [item.songId, item]));
}


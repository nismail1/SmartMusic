export interface LlmRerankItem {
  songId: string;
  llmDelta: number;
  reasonText: string;
  confidence: number;
}

export function validateLlmOutput(items: unknown, allowedSongIds: Set<string>): LlmRerankItem[] {
  if (!Array.isArray(items)) throw new Error("LLM output is not an array");
  return items.map((item) => {
    if (!item || typeof item !== "object") throw new Error("Invalid LLM item");
    const candidate = item as Record<string, unknown>;
    const songId = String(candidate.songId ?? "");
    const llmDelta = Number(candidate.llmDelta ?? 0);
    if (!allowedSongIds.has(songId)) throw new Error(`Unknown songId from LLM: ${songId}`);
    if (!Number.isFinite(llmDelta) || llmDelta < -0.08 || llmDelta > 0.08) {
      throw new Error(`llmDelta out of bounds for ${songId}`);
    }
    return {
      songId,
      llmDelta,
      reasonText: String(candidate.reasonText ?? ""),
      confidence: Number(candidate.confidence ?? 0)
    };
  });
}


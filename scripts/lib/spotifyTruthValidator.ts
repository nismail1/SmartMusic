import type { SpotifyCatalogTrack } from "./types.js";

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export function validateCatalog(catalog: SpotifyCatalogTrack[]): ValidationResult {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const track of catalog) {
    if (!track.id) errors.push("Missing Spotify track id");
    if (!track.name) errors.push(`Track ${track.id} missing name`);
    if (!track.albumId) errors.push(`Track ${track.id} missing albumId`);
    if (!track.artists?.length) errors.push(`Track ${track.id} missing artists`);
    if (seen.has(track.id)) errors.push(`Duplicate track id: ${track.id}`);
    seen.add(track.id);
  }
  return { ok: errors.length === 0, errors };
}

export function assertTrackIdsExist(trackIds: string[], catalog: SpotifyCatalogTrack[]) {
  const idSet = new Set(catalog.map((track) => track.id));
  const missing = trackIds.filter((id) => !idSet.has(id));
  if (missing.length > 0) {
    throw new Error(`Unknown track IDs found: ${missing.slice(0, 10).join(", ")}`);
  }
}


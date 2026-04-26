import type { SeedConfig, SpotifyCatalogTrack, SyntheticEvent, SyntheticUser } from "./types.js";

function createRng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function pick<T>(items: T[], rng: () => number): T {
  return items[Math.floor(rng() * items.length)];
}

function weightedTrackPick(catalog: SpotifyCatalogTrack[], rng: () => number) {
  const total = catalog.reduce((acc, track) => acc + Math.max(1, track.popularity), 0);
  const target = rng() * total;
  let running = 0;
  for (const track of catalog) {
    running += Math.max(1, track.popularity);
    if (running >= target) return track;
  }
  return catalog[catalog.length - 1];
}

export function generateUsers(config: SeedConfig): SyntheticUser[] {
  const personas = ["PopHeavy", "ChillElectronic", "HipHopFocus", "IndieBlend", "Throwback"];
  const rng = createRng(config.seedRandom);
  return Array.from({ length: config.userCount }, (_, idx) => ({
    id: `user_${idx + 1}`,
    displayName: `Listener ${idx + 1}`,
    persona: pick(personas, rng)
  }));
}

export function generateEvents(
  config: SeedConfig,
  catalog: SpotifyCatalogTrack[],
  users: SyntheticUser[]
): SyntheticEvent[] {
  const rng = createRng(config.seedRandom + 99);
  const events: SyntheticEvent[] = [];
  const start = Date.now() - 1000 * 60 * 60 * 24 * 30;
  const queries = ["lofi", "pop", "chill", "indie", "hip hop", "workout"];
  for (let i = 0; i < config.eventCount; i += 1) {
    const user = pick(users, rng);
    const roll = rng();
    const track = weightedTrackPick(catalog, rng);
    const ts = new Date(start + i * 60000).toISOString();
    if (roll < 0.15) {
      events.push({
        id: `event_${i + 1}`,
        userId: user.id,
        songId: track.id,
        eventType: "search",
        queryText: pick(queries, rng),
        ts
      });
    } else if (roll < 0.7) {
      events.push({ id: `event_${i + 1}`, userId: user.id, songId: track.id, eventType: "play", ts });
    } else if (roll < 0.85) {
      events.push({ id: `event_${i + 1}`, userId: user.id, songId: track.id, eventType: "add_to_playlist", ts });
    } else {
      events.push({ id: `event_${i + 1}`, userId: user.id, songId: track.id, eventType: "skip", ts });
    }
  }
  return events;
}


# SmartMusic

SmartMusic is a React + TypeScript web app for:

- searching real Spotify tracks,
- building playlists persisted in Firebase,
- enriching playlist songs with Genius metadata,
- showing recommendation candidates and playlist analytics.

## Prerequisites

- Node.js 16+
- npm 8+
- Firebase project (Web app + Auth + Firestore enabled)
- Spotify app credentials
- Genius access token

## Setup

1. Install dependencies:

```bash
npm install
```

2. Copy environment template:

```bash
cp .env.example .env
```

3. Fill all values in `.env`.

## Run

```bash
npm run dev
```

Open the local Vite URL shown in terminal.

## Scripts

- `npm run dev` - start local dev server
- `npm run build` - create production build
- `npm run preview` - preview production build
- `npm run test` - run unit tests once
- `npm run test:watch` - run tests in watch mode
- `npm run seed:fetch-spotify` - fetch and cache real Spotify US tracks
- `npm run seed:generate` - generate deterministic synthetic users/playlists/events
- `npm run seed:build-aggregates` - build song stats and co-occurrence files
- `npm run seed:verify` - verify all seeded song IDs exist in cached Spotify catalog
- `npm run seed:firestore` - write seed outputs + aggregate collections into Firestore

## Firebase Notes

- Firestore collections used:
  - `users/{userId}`
  - `playlists/{playlistId}`
  - `playlists/{playlistId}/tracks/{trackId}`
  - `playlist_stats/{playlistId}`
  - `recommendations_cache/{playlistId}`
- Auth flow is email/password only.
- Starter rules file is included at `firestore.rules`.

## External Data Notes

- Spotify search is the source track metadata.
- Genius enrichment may mismatch; UI treats Spotify metadata as primary and shows Genius confidence.
- Recommendations are fetched from `VITE_RECOMMENDATIONS_ENDPOINT`.

## Recommendation Engine Pipeline

The recommendation engine pipeline now includes:

- `scripts/spotify/fetchSpotifyCatalog.ts` for Spotify truth-data cache,
- `scripts/seedSyntheticData.ts` for deterministic event generation,
- `scripts/buildCooccurrence.ts` for precomputed aggregate features,
- `functions/src/getRecommendations.ts` for deterministic scoring + optional LLM reranking + fallback.

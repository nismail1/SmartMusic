# SmartMusic — Smart Playlist Builder

SmartMusic is a React + TypeScript web app for building playlists with Spotify catalog search, Genius enrichment, Firebase persistence, and smart next-track suggestions.

This README is written to map directly to the Syncopate rubric and reflects what is currently implemented in this repository.

## Tech Stack

- Frontend: React + TypeScript + Vite + React Router
- Backend: Firebase (Auth, Firestore, Cloud Functions)
- External APIs: Spotify Web API, Genius API
- Optional LLM: suggestion-reason endpoint (`getSuggestionReason`)

## Quick Start

### 1) Prerequisites

- Node.js 18+
- npm
- Firebase project with:
  - Authentication enabled
  - Firestore enabled
  - Cloud Functions enabled
- Spotify developer app credentials
- Genius access token

### 2) Install and configure

```bash
npm install
cp .env.example .env
```

Fill `.env` values. See `.env.example` for all keys, including:

- Firebase web config (`VITE_FIREBASE_*`)
- Spotify keys and redirect/scopes
- Genius token and optional proxy endpoint
- Recommendation and optional LLM reason endpoints
- Spotify-to-Firebase session function URL (`VITE_SPOTIFY_FIREBASE_SESSION_URL`)

### 3) Run locally

```bash
npm run dev
```

### 4) Deploy functions (when needed)

```bash
npm run deploy:functions
```

or only Spotify session link function:

```bash
npm run deploy:functions:spotify-auth
```

## Rubric Mapping

## 1) Correctness

Implemented user-facing flows:

- Create playlists, view playlist details, delete playlist
- Search tracks (Spotify), add/remove tracks in app playlists
- Import one Spotify playlist at a time into SmartMusic playlists
- Smart suggestion card with:
  - reason text
  - play preview
  - add to playlist
  - dismiss (`Nah, not for me`)
- Playlist overview statistics and track table with sorting/filter controls
- Floating playback experience integrated with drawer/player components

Graceful error/empty/loading states are present across search, import, suggestions, and playlist views.

## 2) Backend & API Integration

### Persistence (Firestore)

Primary collections used in current implementation include:

- `playlists/{playlistId}`
- `playlists/{playlistId}/tracks/{trackId}`
- `song_stats`
- `cooccurrence_playlist`
- `cooccurrence_search`
- `spotify_playlist_search_cache`
- `spotify_playlist_tracks_cache`
- `spotify_track_cooccurrence_cache`
- `playlist_suggestion_cache`

### Cloud Functions

Implemented endpoints in `functions/index.js`:

- `getRecommendations`
- `getGeniusEnrichment`
- `createSpotifyFirebaseSession`
- `getSuggestionReason`

### Auth

- Firebase auth is used for app persistence identity
- Spotify OAuth is supported
- Spotify login is linked to a stable Firebase user session via `createSpotifyFirebaseSession`

### API resiliency patterns currently in code

- Spotify request retry wrapper for 429s (`fetchWithSpotifyRetry`)
- Search in-flight dedupe + short-term caching
- Search cooldown behavior on 429 (`Retry-After` aware)
- Recommendation request dedupe by request key

## 3) Code Quality

Current code organization:

- `src/pages/*`: route-level UI
- `src/components/*`: reusable UI (layout, floating player, drawers)
- `src/services/*`: API/data/business logic
- `src/context/AuthContext.tsx`: session/auth state
- `functions/index.js`: backend endpoints

Design choices:

- Types centralized in `src/types/music.ts`
- Service-layer abstractions for Spotify, playlists, recommendations, playback, and Genius
- Focused per-page state and UI logic with utility service calls

## 4) Types & Safety

- Strong TypeScript interfaces for tracks, playlists, recommendations, and enrichment payloads
- React + service layers are typed end-to-end for main entities
- Runtime fallback handling is used where external APIs can be partial or missing fields

Note: there are still some dynamic API payload casts in service code (expected when consuming third-party APIs).

## 5) UX & Polish

Implemented UX details:

- Dedicated pages for landing, auth, home, search results, playlist, Spotify callback
- Loading and failure messages for search/import/suggestions
- Playlist table layout with metadata columns
- Sort controls (`addedAt`, artist, release date, duration)
- Genre chips for filtering
- Suggestion spotlight UI with prominent reason text
- Subtle icon-only remove/delete controls
- Playback controls with graceful fallback messaging when preview/full playback is unavailable

## 6) Judgment & Trade-offs

## Design Decisions (What I set out to build)

The original goal for the recommendation engine was to mirror the assignment intent: suggest tracks based on playlist context rather than generic popularity.

Implemented architecture (co-occurrence-first):

1. Start from the current playlist tracks (seed set).
2. Build candidate neighbors from:
   - app-level co-occurrence data (`cooccurrence_playlist`, `cooccurrence_search`)
   - Spotify public playlist co-occurrence bootstrap (cached in Firestore)
3. Hydrate candidate tracks from Spotify IDs.
4. Score candidates with weighted signals:
   - co-occurrence frequency
   - seed coverage (how many playlist tracks support the candidate)
   - genre overlap
   - novelty
5. Generate explanation text from score evidence.
6. Optionally refine the top explanation with an LLM endpoint (`getSuggestionReason`).

This is intentionally not a black-box model; the design favors transparent ranking signals and debuggable recommendation reasons.

### Recommendation strategy in current code

- Co-occurrence-first recommendations (seed tracks -> related playlists/tracks)
- Firestore caches to reduce repeated expensive API fanout
- Optional LLM step for refining suggestion reason text
- Fallback behavior when recommendation endpoint data is unavailable

### Trade-offs made

- Prioritized robustness and API-failure handling over model complexity.
- Kept Spotify as source-of-truth for playable/verifiable tracks, even when third-party metadata is sparse.
- Added cache, in-flight dedupe, and cooldown behavior to prevent repeated 429 bursts.
- Reduced/removed high-fanout enrichment paths from hot UI actions to keep interactions responsive.
- Kept recommendation output deterministic enough to explain, instead of introducing a heavier model that would hide failure modes.

Rate-limit and data-availability trade-offs:

- Spotify rate-limits (429) forced stricter request budgeting:
  - single-flight request guards
  - search-result caching
  - cooldown windows from `Retry-After`
  - fewer redundant lookups during add/play/suggestion flows
- Metadata completeness is constrained by upstream data quality:
  - suggestion payloads can occasionally miss release/duration/preview fields
  - genre data can be sparse for some tracks/artists
  - Genius matches are not guaranteed for every song
- Because of this, the UI is built to degrade gracefully:
  - fallback messaging
  - imported-track fallback search results when Spotify search is unavailable
  - recommendation refresh controls that avoid re-suggesting dismissed tracks

Scope decisions against original ambition:

- I originally targeted richer “Spotify-like” personalization depth; for this take-home I optimized for:
  - correctness,
  - explainable recommendation logic,
  - reliable cloud persistence,
  - and resilient behavior under API constraints.
- This keeps the implementation interview-ready and easy to reason about, while still demonstrating an extensible recommendation system.

## Functional Requirements Coverage

### 3.1 Track Search & Playlist Management

- Implemented: Spotify track search, add/remove tracks, playlist CRUD, cloud persistence
- Implemented: track metadata shown in playlist/search/suggestion views

### 3.2 Metadata Enrichment

- Implemented: Genius enrichment on song details open
- Implemented: graceful fallback when no Genius match/details

### 3.3 Smart Suggestions

- Implemented: recommendation mechanism based on playlist contents
- Implemented: reason text displayed in UI
- Implemented: suggestion can be previewed and added in one action

### 3.4 Playlist Overview

- Implemented: total duration, decade breakdown, genre composition
- Implemented: sorting + filtering for long playlists

## Bonus Feature Coverage

- Multiple playlists (create/delete + list + navigate)
- Audio previews and playback integration
- Spotify playlist import (single selected playlist)
- Suggestion controls (`Add`, `Nah, not for me`, suppression persistence)

## Available Scripts

- `npm run dev` - start local dev server
- `npm run build` - create production build
- `npm run preview` - preview production build
- `npm run test` - run tests once
- `npm run test:watch` - run tests in watch mode
- `npm run seed:fetch-spotify` - fetch Spotify catalog seed data
- `npm run seed:generate` - generate deterministic synthetic data
- `npm run seed:build-aggregates` - build co-occurrence/stat aggregates
- `npm run seed:verify` - validate seed IDs against Spotify cache
- `npm run seed:firestore` - push seed/aggregate data to Firestore
- `npm run deploy:functions` - deploy Cloud Functions
- `npm run deploy:functions:spotify-auth` - deploy Spotify/Firebase session function only

## Security / Secrets

- Do not commit API keys.
- Use `.env` locally and secret/config management in Firebase for production.
- `OPENAI_API_KEY` is intended for function runtime config, not frontend env.

## Demo + Submission Notes

- Add Loom/demo link here: `TODO`
- Add approximate time spent here: `TODO`
- Include key scope decisions/trade-offs for reviewer context in your submission email.


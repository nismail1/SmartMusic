# SmartMusic — Smart Playlist Builder

SmartMusic is a React + TypeScript web app for building playlists with Spotify catalog search, Genius enrichment, Firebase persistence, and smart next-track suggestions.


## Tech Stack

- Frontend: React + TypeScript + Vite + React Router
- Backend: Firebase (Auth, Firestore, Cloud Functions)
- External APIs: Spotify Web API, Genius API


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


## 1) Functionality

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
- `getSpotifyTracksByIds` — server-side Spotify catalog lookup for track metadata (expects `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` on the Functions runtime, not in the browser).
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


## 3) Judgment & Trade-offs

## Design Decisions and Tradeoffs: Smart Suggestions

### Initial Design: Collaborative Filtering via Playlist Co-occurrence

The original design for the Smart Suggestions feature was based on a standard industry approach: collaborative filtering through track co-occurrence.

The goal was to approximate:
> “Users who added this song to a playlist also tend to add these songs.”

The planned implementation was:

1. Take one or more seed tracks from the current playlist
2. Search for public Spotify playlists containing those tracks
3. Fetch a subset of tracks from each playlist
4. Build a co-occurrence score based on how often tracks appeared alongside the seed tracks
5. Rank candidate tracks using:
   - co-occurrence frequency
   - genre similarity
   - artist similarity
   - playlist context (era, mood, etc.)

This approach would have produced highly realistic recommendations because it is directly based on aggregated user behavior. It also would have allowed for strong, data-driven explanations such as:
> “Suggested because this song frequently appears in playlists alongside songs in your playlist.”

### API Constraints and Limitations

While implementing this, I ran into several limitations with the :contentReference[oaicite:0]{index=0} API:

- Access to public playlist data is restricted or inconsistent for new applications
- Fetching playlist tracks often resulted in 403 errors depending on playlist ownership or permissions
- Several endpoints that would support co-occurrence or discovery are deprecated or unreliable
- Spotify does not provide track-level genre data, and artist genre data was not consistently available in testing

Because of these limitations, the co-occurrence approach could not be implemented in a reliable or scalable way within the scope of this project.

### Pivot: LLM-Assisted Recommendation

Given these constraints, I redesigned the system to use an LLM-based inference approach.

Instead of directly observing co-occurrence, the system approximates it by leveraging broad music knowledge and contextual reasoning. The app sends structured playlist metadata to the OpenAI API, including:

- track titles
- artist names
- album names
- release years
- any available contextual metadata

The model then returns a structured JSON response containing:

- recommended track(s)
- inferred genre/style alignment
- confidence score
- a natural-language explanation

The output is constrained using Structured Outputs to ensure predictable JSON that can be safely parsed by the application.

### Verification and Integration

After receiving a recommendation from the model:

1. The app verifies the track using Spotify search
2. Ensures the track exists and is playable
3. Displays it with artwork, metadata, and playback support
4. Allows the user to add it directly to the playlist

### Tradeoffs

This approach involves several tradeoffs:

**Pros**
- Works reliably within Spotify API constraints
- Produces context-aware recommendations
- Provides human-readable explanations, improving UX
- Avoids reliance on deprecated or restricted endpoints

**Cons**
- Does not use real user co-occurrence data
- Recommendations are inferred rather than behavior-driven
- Adds latency due to external API calls
- Depends on model quality and prompt design

### Future Improvements

With broader API access or more time, the ideal system would combine:

- real co-occurrence data (primary signal)
- user listening behavior (personalization)
- LLM reasoning (fallback + explanation layer)

This would provide both accuracy and explainability.

## 4) Known Bugs and Issues

- Private Spotify playlists may not work reliably depending on the user’s permissions and Spotify API access.
- Genius API metadata is inconsistent. Tags often come back empty, and some song descriptions or bios do not return as expected.
- Spotify playback requires Spotify Premium.
- A song sometimes needs to be clicked twice before playback starts. On the first click, the app may show a playback-related message instead of immediately playing.
- Spotify genre data is limited. Spotify track objects do not include genre, and artist genre data was not reliably available during testing.
- Genius tags were explored as a genre fallback, but they were often empty or too broad to be useful for genre classification.
- As a workaround, the app uses OpenAI to infer genres from structured song metadata. The response is constrained using Structured Outputs so the app receives predictable JSON. This is a practical compromise given the time constraints and API limitations, but it is not the same as official genre metadata.
- Recommended songs can take a few seconds to generate because the app calls the OpenAI API and then verifies the result against Spotify.

## 5) Functional Requirements Coverage

### 5.1 Track Search & Playlist Management

- Implemented: Spotify track search, add/remove tracks, playlist CRUD, cloud persistence
- Implemented: track metadata shown in playlist/search/suggestion views

### 5.2 Metadata Enrichment

- Implemented: Genius enrichment on song details open
- Implemented: graceful fallback when no Genius match/details

### 5.3 Smart Suggestions

- Implemented: recommendation mechanism based on playlist contents
- Implemented: reason text displayed in UI
- Implemented: suggestion can be previewed and added in one action

### 5.4 Playlist Overview

- Implemented: total duration, decade breakdown, genre composition
- Implemented: sorting + filtering for long playlists

## Bonus Feature Coverage

- Multiple playlists (create/delete)
- Audio previews and playback integration
- Spotify playlist import (single selected playlist)
- Chart visuals for playlist overview

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

- Add approximate time spent here: 1 dat


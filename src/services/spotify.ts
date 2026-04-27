import type { SpotifyTrack } from "../types/music";

const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";
const SPOTIFY_SEARCH_URL = "https://api.spotify.com/v1/search";
const SPOTIFY_TRACKS_URL = "https://api.spotify.com/v1/tracks";

/** Client-credentials tokens have no user market; Spotify requires `market` or requests may return 403. */
function spotifyCatalogMarket(): string {
  const raw = (import.meta.env.VITE_SPOTIFY_MARKET ?? "US").trim();
  return /^[A-Za-z]{2}$/.test(raw) ? raw.toUpperCase() : "US";
}

/** Prefer Cloud Function proxy so Spotify secrets stay server-side (browser direct /v1/tracks often returns 403). */
function resolveSpotifyTracksProxyUrl(): string {
  const explicit = (import.meta.env.VITE_SPOTIFY_TRACKS_PROXY_URL ?? "").trim();
  if (explicit) return explicit;
  const rec = (import.meta.env.VITE_RECOMMENDATIONS_ENDPOINT ?? "").trim();
  if (rec.includes("getRecommendations")) return rec.replace("getRecommendations", "getSpotifyTracksByIds");
  return "";
}
const SPOTIFY_ARTISTS_URL = "https://api.spotify.com/v1/artists";
const SPOTIFY_PLAYLISTS_URL = "https://api.spotify.com/v1/playlists";

function debugLog(
  location: string,
  message: string,
  data: Record<string, unknown>,
  hypothesisId: string,
  runId = "spotify-api-debug"
) {
  // #region agent log
  import.meta.env.DEV && fetch("http://127.0.0.1:7701/ingest/35369d23-7f37-4585-ac9a-076a3915746b", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "658713" },
    body: JSON.stringify({
      sessionId: "658713",
      runId,
      hypothesisId,
      location,
      message,
      data,
      timestamp: Date.now()
    })
  }).catch(() => {});
  // #endregion
}

let cachedToken: { value: string; expiresAt: number } | null = null;
const supplementalTagsCache = new Map<string, string[]>();
const supplementalTagsInFlight = new Map<string, Promise<string[]>>();
const searchTracksCache = new Map<string, { expiresAt: number; results: SpotifyTrack[] }>();
const searchTracksInFlight = new Map<string, Promise<SpotifyTrack[]>>();
const listCurrentUserPlaylistsInFlight = new Map<string, Promise<SpotifyUserPlaylist[]>>();
let searchCooldownUntil = 0;
const spotifyCooldowns = new Map<string, number>();
let supplementalQueue = Promise.resolve<void>(undefined);
let supplementalCooldownUntil = 0;
const SEARCH_TRACKS_TTL_MS = 10 * 60 * 1000;

async function getToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 30_000) {
    return cachedToken.value;
  }

  const clientId = import.meta.env.VITE_SPOTIFY_CLIENT_ID ?? "";
  const clientSecret = import.meta.env.VITE_SPOTIFY_CLIENT_SECRET ?? "";
  if (!clientId || !clientSecret) {
    throw new Error("Missing Spotify client credentials.");
  }

  const res = await fetch(SPOTIFY_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`
    },
    body: new URLSearchParams({ grant_type: "client_credentials" }).toString()
  });

  if (!res.ok) {
    throw new Error("Failed to get Spotify token");
  }
  const json = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = { value: json.access_token, expiresAt: now + json.expires_in * 1000 };
  return json.access_token;
}

function normalizeTrack(item: any): SpotifyTrack {
  return {
    id: item.id,
    name: item.name,
    artists: Array.isArray(item.artists) ? item.artists.map((a: any) => a.name) : [],
    uri: item.uri ?? "",
    albumId: item.album?.id ?? "",
    albumName: item.album?.name ?? "",
    artworkUrl: item.album?.images?.[0]?.url ?? null,
    previewUrl: item.preview_url ?? null,
    releaseDate: item.album?.release_date ?? null,
    durationMs: item.duration_ms ?? 0
  };
}

function normalizePlaylistTrack(item: any): SpotifyTrack | null {
  const track = item?.track ?? item?.item;
  if (!track?.id || !track?.name) return null;
  return normalizeTrack(track);
}

function normalizePlaylistTrackFromEmbedded(track: any): SpotifyTrack | null {
  if (!track?.id || !track?.name) return null;
  return normalizeTrack(track);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithSpotifyRetry(url: string, token: string, init?: RequestInit): Promise<Response> {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const response = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init?.headers ?? {})
      }
    });
    if (response.status !== 429) return response;
    const retryAfterHeader = response.headers.get("retry-after");
    const retryAfterMs = Math.max(300, Number(retryAfterHeader ?? "1") * 1000);
    if (attempt === maxAttempts) return response;
    await sleep(retryAfterMs + Math.floor(Math.random() * 250));
  }
  throw new Error("Spotify request exhausted retries.");
}

function getCooldownRemainingMs(key: string): number {
  const until = spotifyCooldowns.get(key) ?? 0;
  const now = Date.now();
  return until > now ? until - now : 0;
}

function setSpotifyCooldown(key: string, retryAfterHeader: string | null): number {
  const retryAfterMs = parseRetryAfterMs(retryAfterHeader);
  spotifyCooldowns.set(key, Date.now() + retryAfterMs);
  return retryAfterMs;
}

/** After repeated 5xx failures, back off so we do not hammer Spotify while their gateway is unhealthy. */
function setTransientSpotifyFailureCooldown(key: string, ms: number) {
  const until = Date.now() + Math.max(2_000, ms);
  const prev = spotifyCooldowns.get(key) ?? 0;
  spotifyCooldowns.set(key, Math.max(until, prev));
}

function parseRetryAfterMs(retryAfterHeader: string | null): number {
  if (!retryAfterHeader) return 1000;
  const numeric = Number(retryAfterHeader);
  if (Number.isFinite(numeric) && numeric > 0) {
    // Spotify should return seconds; some intermediaries return milliseconds.
    // Treat very large values as milliseconds to avoid absurd wait times.
    if (numeric > 3600) return Math.max(300, Math.floor(numeric));
    return Math.max(300, Math.floor(numeric * 1000));
  }
  const parsedDateMs = Date.parse(retryAfterHeader);
  if (Number.isFinite(parsedDateMs)) {
    return Math.max(300, parsedDateMs - Date.now());
  }
  return 1000;
}

export interface SpotifyUserProfile {
  id: string;
  displayName: string;
  email: string | null;
}

export interface SpotifyUserPlaylist {
  id: string;
  name: string;
  trackCount: number;
  public: boolean | null;
  collaborative: boolean;
  ownerId: string | null;
  tracksHref: string | null;
  itemsHref: string | null;
}

export interface SpotifyPublicPlaylist {
  id: string;
  name: string;
  ownerId: string | null;
  trackCount: number;
}

function normalizeTag(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

export const spotifyService = {
  async searchTracks(
    query: string,
    market = "US",
    source = "unknown",
    accessToken?: string
  ): Promise<SpotifyTrack[]> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) return [];
    const cacheKey = `${market}:${normalizedQuery.toLowerCase()}`;
    const cooldownKey = "search";
    const now = Date.now();
    const globalCooldownRemainingMs = getCooldownRemainingMs(cooldownKey);
    if (searchCooldownUntil > now || globalCooldownRemainingMs > 0) {
      const waitMs = Math.max(searchCooldownUntil - now, globalCooldownRemainingMs);
      // #region agent log
      import.meta.env.DEV && fetch("http://127.0.0.1:7701/ingest/35369d23-7f37-4585-ac9a-076a3915746b", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "658713" },
        body: JSON.stringify({
          sessionId: "658713",
          runId: "search-token-debug",
          hypothesisId: "H48",
          location: "src/services/spotify.ts:searchTracks",
          message: "search request skipped due cooldown",
          data: { query: normalizedQuery, source, waitMs },
          timestamp: Date.now()
        })
      }).catch(() => {});
      // #endregion
      return [];
    }
    const cached = searchTracksCache.get(cacheKey);
    // #region agent log
    import.meta.env.DEV && fetch("http://127.0.0.1:7701/ingest/35369d23-7f37-4585-ac9a-076a3915746b", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "658713" },
      body: JSON.stringify({
        sessionId: "658713",
        runId: "search-rate-debug",
        hypothesisId: "H41",
        location: "src/services/spotify.ts:searchTracks",
        message: "searchTracks invoked",
        data: { query: normalizedQuery, market, source, hasFreshCache: Boolean(cached && cached.expiresAt > now) },
        timestamp: Date.now()
      })
    }).catch(() => {});
    // #endregion
    if (cached && cached.expiresAt > now) {
      return cached.results;
    }
    if (searchTracksInFlight.has(cacheKey)) {
      return searchTracksInFlight.get(cacheKey) ?? [];
    }
    const task = (async () => {
    const token = accessToken?.trim() ? accessToken.trim() : await getToken();
    // #region agent log
    import.meta.env.DEV && fetch("http://127.0.0.1:7701/ingest/35369d23-7f37-4585-ac9a-076a3915746b", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "658713" },
      body: JSON.stringify({
        sessionId: "658713",
        runId: "search-token-debug",
        hypothesisId: "H46",
        location: "src/services/spotify.ts:searchTracks",
        message: "search token mode selected",
        data: { query: normalizedQuery, source, tokenMode: accessToken?.trim() ? "user-access-token" : "client-credentials" },
        timestamp: Date.now()
      })
    }).catch(() => {});
    // #endregion
    const params = new URLSearchParams({
      q: normalizedQuery,
      type: "track",
      market,
      limit: "10"
    });
    const res = await fetchWithSpotifyRetry(`${SPOTIFY_SEARCH_URL}?${params.toString()}`, token);
    if (!res.ok) {
      if (res.status === 429) {
        const retryAfterMs = setSpotifyCooldown(cooldownKey, res.headers.get("retry-after"));
        searchCooldownUntil = Date.now() + retryAfterMs;
        // #region agent log
        import.meta.env.DEV && fetch("http://127.0.0.1:7701/ingest/35369d23-7f37-4585-ac9a-076a3915746b", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "658713" },
          body: JSON.stringify({
            sessionId: "658713",
            runId: "search-token-debug",
            hypothesisId: "H47",
            location: "src/services/spotify.ts:searchTracks",
            message: "search cooldown set from 429 retry-after",
            data: { query: normalizedQuery, source, retryAfterHeader: res.headers.get("retry-after"), retryAfterMs },
            timestamp: Date.now()
          })
        }).catch(() => {});
        // #endregion
      }
      debugLog(
        "src/services/spotify.ts:searchTracks",
        "spotify search failed",
        { query: normalizedQuery, market, source, status: res.status },
        "H37",
        "metadata-genre-debug"
      );
      if (cached) {
        debugLog(
          "src/services/spotify.ts:searchTracks",
          "serving stale cached search results after failure",
          { query: normalizedQuery, market, cachedCount: cached.results.length, status: res.status },
          "H40",
          "metadata-genre-debug"
        );
        return cached.results;
      }
      return [];
    }
    const json = await res.json();
    const results = (json.tracks?.items ?? []).map(normalizeTrack);
    searchTracksCache.set(cacheKey, { expiresAt: Date.now() + SEARCH_TRACKS_TTL_MS, results });
    return results;
    })();
    searchTracksInFlight.set(cacheKey, task);
    try {
      return await task;
    } finally {
      searchTracksInFlight.delete(cacheKey);
    }
  },

  async getSupplementalTags(trackId: string): Promise<string[]> {
    if (!trackId) return [];
    if (supplementalTagsCache.has(trackId)) {
      return supplementalTagsCache.get(trackId) ?? [];
    }
    if (supplementalTagsInFlight.has(trackId)) {
      return supplementalTagsInFlight.get(trackId) ?? [];
    }
    const queuedTask = async () => {
    const now = Date.now();
    if (supplementalCooldownUntil > now) {
      const waitMs = supplementalCooldownUntil - now;
      debugLog(
        "src/services/spotify.ts:getSupplementalTags",
        "waiting for supplemental cooldown window",
        { trackId, waitMs },
        "H35",
        "metadata-genre-debug"
      );
      await sleep(waitMs);
    }
    const token = await getToken();
    debugLog(
      "src/services/spotify.ts:getSupplementalTags",
      "supplemental tags request started",
      { trackId },
      "H5"
    );
    const market = spotifyCatalogMarket();
    const trackRes = await fetchWithSpotifyRetry(
      `${SPOTIFY_TRACKS_URL}/${encodeURIComponent(trackId)}?${new URLSearchParams({ market }).toString()}`,
      token
    );
    if (!trackRes.ok) {
      if (trackRes.status === 429) {
        const retryAfterHeader = trackRes.headers.get("retry-after");
        const retryAfterMs = Math.max(1000, Number(retryAfterHeader ?? "2") * 1000);
        supplementalCooldownUntil = Date.now() + retryAfterMs;
      }
      debugLog(
        "src/services/spotify.ts:getSupplementalTags",
        "supplemental track request failed",
        { trackId, status: trackRes.status },
        "H5"
      );
      return [];
    }
    const track = await trackRes.json();

    const artistId = track?.artists?.[0]?.id ? String(track.artists[0].id) : "";
    const artistRes = artistId
      ? await fetchWithSpotifyRetry(`${SPOTIFY_ARTISTS_URL}/${encodeURIComponent(artistId)}`, token)
      : null;
    if (artistRes && !artistRes.ok && artistRes.status === 429) {
      const retryAfterHeader = artistRes.headers.get("retry-after");
      const retryAfterMs = Math.max(1000, Number(retryAfterHeader ?? "2") * 1000);
      supplementalCooldownUntil = Date.now() + retryAfterMs;
    }
    const artist = artistRes && artistRes.ok ? await artistRes.json() : null;

    const genreTags: string[] = Array.isArray(artist?.genres)
      ? artist.genres.map((genre: string) => normalizeTag(String(genre)))
      : [];
    const tags: string[] = Array.from(new Set<string>(genreTags)).filter(Boolean).slice(0, 25);
    debugLog(
      "src/services/spotify.ts:getSupplementalTags",
      "supplemental tags computed",
      { trackId, genreTagCount: genreTags.length, finalTagCount: tags.length },
      "H33",
      "metadata-genre-debug"
    );
    supplementalTagsCache.set(trackId, tags);
    return tags;
    };
    const task = supplementalQueue.then(queuedTask, queuedTask);
    supplementalQueue = task.then(() => undefined, () => undefined);
    supplementalTagsInFlight.set(trackId, task);
    try {
      return await task;
    } finally {
      supplementalTagsInFlight.delete(trackId);
    }
  },

  async getCurrentUserProfile(accessToken: string): Promise<SpotifyUserProfile> {
    const cooldownKey = "me";
    const cooldownRemainingMs = getCooldownRemainingMs(cooldownKey);
    if (cooldownRemainingMs > 0) {
      throw new Error(`Spotify profile is cooling down after rate-limit. Try again in ${Math.ceil(cooldownRemainingMs / 1000)}s.`);
    }
    const res = await fetch("https://api.spotify.com/v1/me", {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (res.status === 429) {
      setSpotifyCooldown(cooldownKey, res.headers.get("retry-after"));
    }
    if (!res.ok) {
      throw new Error("Failed to load Spotify profile.");
    }
    const data = await res.json();
    return {
      id: String(data?.id ?? ""),
      displayName: String(data?.display_name ?? data?.id ?? "Spotify User"),
      email: data?.email ? String(data.email) : null
    };
  },

  async listCurrentUserPlaylists(accessToken: string): Promise<SpotifyUserPlaylist[]> {
    const inFlightKey = accessToken;
    const existing = listCurrentUserPlaylistsInFlight.get(inFlightKey);
    if (existing) return existing;

    const task = (async () => {
      const cooldownKey = "me_playlists";
      const cooldownRemainingMs = getCooldownRemainingMs(cooldownKey);
      if (cooldownRemainingMs > 0) {
        throw new Error(
          `Spotify playlists are cooling down (recent errors or rate limits). Try again in ${Math.ceil(cooldownRemainingMs / 1000)}s.`
        );
      }
      const items: SpotifyUserPlaylist[] = [];
      let nextUrl: string | null = "https://api.spotify.com/v1/me/playlists?limit=50";
      while (nextUrl) {
        const maxAttempts = 3;
        let response: Response | null = null;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          response = await fetch(nextUrl, {
            headers: { Authorization: `Bearer ${accessToken}` }
          });
          if (response.status === 429) {
            const retryAfterMs = setSpotifyCooldown(cooldownKey, response.headers.get("retry-after"));
            if (attempt < maxAttempts) {
              await sleep(retryAfterMs + Math.floor(Math.random() * 250));
              continue;
            }
          }
          if (response.ok) break;
          const transient = [502, 503, 504].includes(response.status);
          if (transient && attempt < maxAttempts) {
            import.meta.env.DEV && fetch("http://127.0.0.1:7701/ingest/35369d23-7f37-4585-ac9a-076a3915746b", {
              method: "POST",
              headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "658713" },
              body: JSON.stringify({
                sessionId: "658713",
                runId: "spotify-playlist-retry",
                hypothesisId: "H4",
                location: "src/services/spotify.ts:listCurrentUserPlaylists",
                message: "transient spotify error, retrying",
                data: { status: response.status, attempt, nextUrl: nextUrl.slice(0, 60) },
                timestamp: Date.now()
              })
            }).catch(() => {});
            const backoff = Math.min(10_000, 700 * 2 ** (attempt - 1) + Math.floor(Math.random() * 500));
            await sleep(backoff);
            continue;
          }
          break;
        }
        if (!response || !response.ok) {
          const status = response?.status ?? 0;
          if ([502, 503, 504].includes(status) || status === 429) {
            setTransientSpotifyFailureCooldown(cooldownKey, 8_000);
          }
          throw new Error(
            "Failed to load Spotify playlists. If Spotify is busy, try again in a few seconds."
          );
        }
        const payload: any = await response.json();
        debugLog(
          "src/services/spotify.ts:listCurrentUserPlaylists",
          "spotify me playlists page fetched",
          {
            status: response.status,
            itemCount: Array.isArray(payload?.items) ? payload.items.length : 0,
            sample: Array.isArray(payload?.items) && payload.items[0]
              ? {
                  id: payload.items[0].id ?? null,
                  ownerId: payload.items[0]?.owner?.id ?? null,
                  public: payload.items[0]?.public ?? null,
                  collaborative: payload.items[0]?.collaborative ?? null,
                  tracksTotal: payload.items[0]?.tracks?.total ?? null,
                  hasTracksHref: Boolean(payload.items[0]?.tracks?.href)
                }
              : null
          },
          "M60"
        );
        const pageItems = Array.isArray(payload?.items) ? payload.items : [];
        items.push(
          ...pageItems.map((playlist: any) => ({
            id: String(playlist?.id ?? ""),
            name: String(playlist?.name ?? "Untitled Spotify playlist"),
            trackCount: Number(playlist?.tracks?.total ?? 0),
            public: typeof playlist?.public === "boolean" ? playlist.public : null,
            collaborative: Boolean(playlist?.collaborative),
            ownerId: playlist?.owner?.id ? String(playlist.owner.id) : null,
            tracksHref: playlist?.tracks?.href ? String(playlist.tracks.href) : null,
            itemsHref: playlist?.items?.href ? String(playlist.items.href) : null
          }))
        );
        nextUrl = payload?.next ? String(payload.next) : null;
      }
      return items.filter((playlist) => Boolean(playlist.id));
    })();

    listCurrentUserPlaylistsInFlight.set(inFlightKey, task);
    try {
      return await task;
    } finally {
      listCurrentUserPlaylistsInFlight.delete(inFlightKey);
    }
  },

  async listSpotifyPlaylistTracks(
    accessToken: string,
    playlistId: string,
    tracksHref?: string | null,
    itemsHref?: string | null
  ): Promise<SpotifyTrack[]> {
    const cooldownKey = "playlists";
    const cooldownRemainingMs = getCooldownRemainingMs(cooldownKey);
    if (cooldownRemainingMs > 0) {
      throw new Error(`Spotify playlist endpoints are cooling down after rate-limit. Try again in ${Math.ceil(cooldownRemainingMs / 1000)}s.`);
    }
    const tracks: SpotifyTrack[] = [];
    let hadForbiddenTracksResponse = false;
    debugLog(
      "src/services/spotify.ts:listSpotifyPlaylistTracks",
      "spotify playlist track fetch started",
      { playlistId, tokenPrefix: accessToken.slice(0, 6), tokenLength: accessToken.length },
      "M50"
    );
    try {
      const meResponse = await fetch("https://api.spotify.com/v1/me", {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      let meBody = "";
      try {
        meBody = await meResponse.text();
      } catch {
        meBody = "";
      }
      debugLog(
        "src/services/spotify.ts:listSpotifyPlaylistTracks",
        "spotify me probe response",
        { status: meResponse.status, bodyPreview: meBody.slice(0, 200) },
        "M57"
      );
    } catch (error) {
      debugLog(
        "src/services/spotify.ts:listSpotifyPlaylistTracks",
        "spotify me probe failed",
        { errorMessage: error instanceof Error ? error.message : "unknown" },
        "M57"
      );
    }
    try {
      const playlistProbe = await fetch(`https://api.spotify.com/v1/playlists/${encodeURIComponent(playlistId)}?fields=id,name,public,collaborative,owner(id),tracks(total)`, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      let probeBody = "";
      try {
        probeBody = await playlistProbe.text();
      } catch {
        probeBody = "";
      }
      debugLog(
        "src/services/spotify.ts:listSpotifyPlaylistTracks",
        "spotify playlist probe response",
        { playlistId, status: playlistProbe.status, bodyPreview: probeBody.slice(0, 300) },
        "M55"
      );
    } catch (error) {
      debugLog(
        "src/services/spotify.ts:listSpotifyPlaylistTracks",
        "spotify playlist probe failed",
        { playlistId, errorMessage: error instanceof Error ? error.message : "unknown" },
        "M55"
      );
    }
    let nextUrl: string | null =
      itemsHref ||
      `https://api.spotify.com/v1/playlists/${encodeURIComponent(playlistId)}/items?limit=100`;
    while (nextUrl) {
      const response: Response = await fetch(nextUrl, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      if (response.status === 429) {
        setSpotifyCooldown(cooldownKey, response.headers.get("retry-after"));
      }
      if (!response.ok) {
        hadForbiddenTracksResponse = response.status === 403;
        let bodyText = "";
        try {
          bodyText = await response.text();
        } catch {
          bodyText = "";
        }
        debugLog(
          "src/services/spotify.ts:listSpotifyPlaylistTracks",
          "spotify playlist track fetch failed",
          {
            playlistId,
            status: response.status,
            wwwAuthenticate: response.headers.get("www-authenticate"),
            bodyPreview: bodyText.slice(0, 300)
          },
          "M51"
        );
        // Fallback legacy endpoint first for compatibility on older apps.
        const legacyTracksUrl = tracksHref || `https://api.spotify.com/v1/playlists/${encodeURIComponent(playlistId)}/tracks?limit=100`;
        const legacyTracksResponse = await fetch(legacyTracksUrl, {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        if (legacyTracksResponse.status === 429) {
          setSpotifyCooldown(cooldownKey, legacyTracksResponse.headers.get("retry-after"));
        }
        if (legacyTracksResponse.ok) {
          const legacyPayload: any = await legacyTracksResponse.json();
          const legacyItems = Array.isArray(legacyPayload?.items) ? legacyPayload.items : [];
          const legacyTracks = legacyItems.map(normalizePlaylistTrack).filter(Boolean) as SpotifyTrack[];
          debugLog(
            "src/services/spotify.ts:listSpotifyPlaylistTracks",
            "spotify legacy tracks fallback succeeded",
            { playlistId, legacyTrackCount: legacyTracks.length, hasNext: Boolean(legacyPayload?.next) },
            "M58"
          );
          return legacyTracks;
        }

        // Fallback: try playlist endpoint with embedded items fields.
        const fallbackUrl = `https://api.spotify.com/v1/playlists/${encodeURIComponent(
          playlistId
        )}?fields=items(items(item(id,name,artists(name),album(id,name,images,release_date),duration_ms)),next),tracks(total)`;
        const fallbackResponse = await fetch(fallbackUrl, {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        if (fallbackResponse.status === 429) {
          setSpotifyCooldown(cooldownKey, fallbackResponse.headers.get("retry-after"));
        }
        if (!fallbackResponse.ok) {
          let fallbackBody = "";
          try {
            fallbackBody = await fallbackResponse.text();
          } catch {
            fallbackBody = "";
          }
          debugLog(
            "src/services/spotify.ts:listSpotifyPlaylistTracks",
            "spotify embedded tracks fallback failed",
            { playlistId, status: fallbackResponse.status, bodyPreview: fallbackBody.slice(0, 300) },
            "M58"
          );
          throw new Error(
            "Spotify denied playlist track access for this playlist. Reconnect Spotify to refresh playlist permissions, then try again."
          );
        }
        const fallbackPayload: any = await fallbackResponse.json();
        const embeddedItems = Array.isArray(fallbackPayload?.items?.items) ? fallbackPayload.items.items : [];
        const embeddedTracks = embeddedItems
          .map((item: any) => normalizePlaylistTrackFromEmbedded(item?.item))
          .filter(Boolean) as SpotifyTrack[];
        debugLog(
          "src/services/spotify.ts:listSpotifyPlaylistTracks",
          "spotify embedded tracks fallback succeeded",
          {
            playlistId,
            embeddedTrackCount: embeddedTracks.length,
            hasNext: Boolean(fallbackPayload?.items?.next),
            declaredTrackCount: Number(fallbackPayload?.tracks?.total ?? 0)
          },
          "M58"
        );
        if (hadForbiddenTracksResponse && embeddedTracks.length === 0) {
          throw new Error(
            "Spotify denied access to playlist track items for this playlist. Reconnect Spotify to refresh playlist permissions, then try again."
          );
        }
        return embeddedTracks;
      }
      const payload: any = await response.json();
      debugLog(
        "src/services/spotify.ts:listSpotifyPlaylistTracks",
        "spotify playlist page fetched",
        { playlistId, itemCount: Array.isArray(payload?.items) ? payload.items.length : 0, hasNext: Boolean(payload?.next) },
        "M52"
      );
      const pageItems = Array.isArray(payload?.items) ? payload.items : [];
      tracks.push(...pageItems.map(normalizePlaylistTrack).filter(Boolean) as SpotifyTrack[]);
      nextUrl = payload?.next ? String(payload.next) : null;
    }
    debugLog(
      "src/services/spotify.ts:listSpotifyPlaylistTracks",
      "spotify playlist track fetch completed",
      { playlistId, trackCount: tracks.length },
      "M53"
    );
    return tracks;
  },

  async searchPublicPlaylists(query: string, limit = 12): Promise<SpotifyPublicPlaylist[]> {
    const normalized = query.trim();
    if (!normalized) return [];
    const cooldownKey = "search";
    const cooldownRemainingMs = getCooldownRemainingMs(cooldownKey);
    if (cooldownRemainingMs > 0) return [];
    const token = await getToken();
    const params = new URLSearchParams({
      q: normalized,
      type: "playlist",
      market: "US",
      limit: String(Math.max(1, Math.min(50, limit)))
    });
    const response = await fetchWithSpotifyRetry(`${SPOTIFY_SEARCH_URL}?${params.toString()}`, token);
    if (response.status === 429) {
      setSpotifyCooldown(cooldownKey, response.headers.get("retry-after"));
    }
    if (!response.ok) {
      throw new Error(`Spotify public playlist search failed (${response.status}).`);
    }
    const payload: any = await response.json();
    const items = Array.isArray(payload?.playlists?.items) ? payload.playlists.items : [];
    return items
      .filter((item: any) => Boolean(item?.id))
      .map((item: any) => ({
        id: String(item.id),
        name: String(item?.name ?? "Untitled Spotify playlist"),
        ownerId: item?.owner?.id ? String(item.owner.id) : null,
        trackCount: Number(item?.tracks?.total ?? 0)
      }));
  },

  async getPublicPlaylistTracks(playlistId: string, limit = 120): Promise<SpotifyTrack[]> {
    if (!playlistId) return [];
    const cooldownKey = "playlists";
    const cooldownRemainingMs = getCooldownRemainingMs(cooldownKey);
    if (cooldownRemainingMs > 0) return [];
    const token = await getToken();
    const tracks: SpotifyTrack[] = [];
    let nextUrl: string | null = `${SPOTIFY_PLAYLISTS_URL}/${encodeURIComponent(playlistId)}/items?limit=100`;
    while (nextUrl && tracks.length < limit) {
      const response = await fetchWithSpotifyRetry(nextUrl, token);
      if (response.status === 429) {
        setSpotifyCooldown(cooldownKey, response.headers.get("retry-after"));
      }
      if (!response.ok) {
        throw new Error(`Spotify playlist tracks fetch failed (${response.status}).`);
      }
      const payload: any = await response.json();
      const pageItems = Array.isArray(payload?.items) ? payload.items : [];
      tracks.push(...pageItems.map(normalizePlaylistTrack).filter(Boolean) as SpotifyTrack[]);
      nextUrl = payload?.next ? String(payload.next) : null;
    }
    return tracks.slice(0, limit);
  },

  async getTracksByIds(trackIds: string[]): Promise<SpotifyTrack[]> {
    const uniqueIds = Array.from(new Set(trackIds.map((id) => id.trim()).filter(Boolean)));
    if (!uniqueIds.length) return [];
    const proxyUrl = resolveSpotifyTracksProxyUrl();
    if (proxyUrl) {
      const market = spotifyCatalogMarket();
      let proxyHost = "";
      try {
        proxyHost = new URL(proxyUrl).host;
      } catch {
        proxyHost = "(invalid URL)";
      }
      debugLog(
        "src/services/spotify.ts:getTracksByIds",
        "track lookup via server proxy",
        { requestedCount: uniqueIds.length, proxyHost },
        "H-proxy"
      );
      const all: SpotifyTrack[] = [];
      for (let i = 0; i < uniqueIds.length; i += 50) {
        const batch = uniqueIds.slice(i, i + 50);
        try {
          const response = await fetch(proxyUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ids: batch, market })
          });
          if (!response.ok) {
            let preview = "";
            try {
              preview = (await response.text()).slice(0, 200);
            } catch {}
            debugLog(
              "src/services/spotify.ts:getTracksByIds",
              "proxy track batch failed",
              { status: response.status, preview },
              "H-proxy"
            );
            continue;
          }
          const payload = (await response.json()) as { tracks?: SpotifyTrack[] };
          const tracks = Array.isArray(payload?.tracks) ? payload.tracks : [];
          all.push(...tracks.filter((t): t is SpotifyTrack => Boolean(t?.id)));
        } catch (err) {
          debugLog(
            "src/services/spotify.ts:getTracksByIds",
            "proxy track batch threw",
            { message: err instanceof Error ? err.message : String(err) },
            "H-proxy"
          );
        }
      }
      debugLog(
        "src/services/spotify.ts:getTracksByIds",
        "track lookup via proxy finished",
        { requestedCount: uniqueIds.length, returnedCount: all.length },
        "H-proxy"
      );
      return all;
    }

    debugLog(
      "src/services/spotify.ts:getTracksByIds",
      "track lookup started (browser client-credentials; prefer VITE_RECOMMENDATIONS_ENDPOINT for proxy)",
      { requestedCount: uniqueIds.length, sampleIds: uniqueIds.slice(0, 3) },
      "H7"
    );
    const cooldownKey = "tracks";
    const cooldownRemainingMs = getCooldownRemainingMs(cooldownKey);
    if (cooldownRemainingMs > 0) {
      debugLog(
        "src/services/spotify.ts:getTracksByIds",
        "track lookup skipped due cooldown",
        { waitMs: cooldownRemainingMs, requestedCount: uniqueIds.length },
        "H49",
        "search-token-debug"
      );
      return [];
    }
    const token = await getToken();
    const all: SpotifyTrack[] = [];
    const market = spotifyCatalogMarket();
    /** Batch GET /v1/tracks?ids= often returns 403 with client-credentials; per-track GET matches server/proxy behavior. */
    const chunkSize = 10;
    for (let i = 0; i < uniqueIds.length; i += chunkSize) {
      const chunk = uniqueIds.slice(i, i + chunkSize);
      const chunkRows = await Promise.all(
        chunk.map(async (trackId) => {
          const params = new URLSearchParams({ market });
          const response = await fetchWithSpotifyRetry(
            `${SPOTIFY_TRACKS_URL}/${encodeURIComponent(trackId)}?${params.toString()}`,
            token
          );
          if (response.status === 429) {
            setSpotifyCooldown(cooldownKey, response.headers.get("retry-after"));
          }
          if (!response.ok) {
            let bodyPreview = "";
            try {
              bodyPreview = (await response.text()).slice(0, 200);
            } catch {}
            debugLog(
              "src/services/spotify.ts:getTracksByIds",
              "track lookup single failed",
              { status: response.status, trackId, bodyPreview },
              "H7"
            );
            return null;
          }
          const item: unknown = await response.json();
          return normalizeTrack(item as Parameters<typeof normalizeTrack>[0]);
        })
      );
      all.push(...chunkRows.filter((t): t is SpotifyTrack => Boolean(t?.id)));
    }
    debugLog(
      "src/services/spotify.ts:getTracksByIds",
      "track lookup finished",
      {
        requestedCount: uniqueIds.length,
        returnedCount: all.length,
        sample: all[0]
          ? {
              id: all[0].id,
              releaseDate: all[0].releaseDate ?? null,
              durationMs: all[0].durationMs ?? null,
              previewUrl: all[0].previewUrl ?? null
            }
          : null
      },
      "H7"
    );
    return all;
  }
};

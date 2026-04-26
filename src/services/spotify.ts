import type { SpotifyTrack } from "../types/music";

const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";
const SPOTIFY_SEARCH_URL = "https://api.spotify.com/v1/search";
const SPOTIFY_TRACKS_URL = "https://api.spotify.com/v1/tracks";
const SPOTIFY_ARTISTS_URL = "https://api.spotify.com/v1/artists";

function debugLog(
  location: string,
  message: string,
  data: Record<string, unknown>,
  hypothesisId: string,
  runId = "spotify-api-debug"
) {
  // #region agent log
  fetch("http://127.0.0.1:7701/ingest/35369d23-7f37-4585-ac9a-076a3915746b", {
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

function normalizeTag(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function buildHeuristicTrackTags(track: any): string[] {
  const tags: string[] = [];
  const popularity = Number(track?.popularity ?? 0);
  const durationMs = Number(track?.duration_ms ?? 0);
  const releaseDate = String(track?.album?.release_date ?? "");
  const year = Number(releaseDate.slice(0, 4));

  if (track?.explicit) tags.push("explicit");
  if (popularity >= 75) tags.push("popularity high");
  else if (popularity >= 40) tags.push("popularity medium");
  else tags.push("popularity low");

  if (durationMs >= 240_000) tags.push("duration long");
  else if (durationMs >= 150_000) tags.push("duration medium");
  else if (durationMs > 0) tags.push("duration short");

  if (Number.isFinite(year) && year > 0) {
    if (year >= 2020) tags.push("era 2020s");
    else if (year >= 2010) tags.push("era 2010s");
    else if (year >= 2000) tags.push("era 2000s");
    else if (year >= 1990) tags.push("era 90s");
  }

  return tags;
}

export const spotifyService = {
  async searchTracks(query: string, market = "US"): Promise<SpotifyTrack[]> {
    if (!query.trim()) return [];
    const token = await getToken();
    const params = new URLSearchParams({
      q: query,
      type: "track",
      market,
      limit: "10"
    });
    const res = await fetch(`${SPOTIFY_SEARCH_URL}?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) {
      throw new Error("Spotify search failed");
    }
    const json = await res.json();
    return (json.tracks?.items ?? []).map(normalizeTrack);
  },

  async getSupplementalTags(trackId: string): Promise<string[]> {
    if (!trackId) return [];
    if (supplementalTagsCache.has(trackId)) {
      return supplementalTagsCache.get(trackId) ?? [];
    }
    if (supplementalTagsInFlight.has(trackId)) {
      return supplementalTagsInFlight.get(trackId) ?? [];
    }
    const task = (async () => {
    const token = await getToken();
    debugLog(
      "src/services/spotify.ts:getSupplementalTags",
      "supplemental tags request started",
      { trackId },
      "H5"
    );
    const trackRes = await fetch(`${SPOTIFY_TRACKS_URL}/${encodeURIComponent(trackId)}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!trackRes.ok) {
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
      ? await fetch(`${SPOTIFY_ARTISTS_URL}/${encodeURIComponent(artistId)}`, {
          headers: { Authorization: `Bearer ${token}` }
        })
      : null;
    const artist = artistRes && artistRes.ok ? await artistRes.json() : null;

    const genreTags = Array.isArray(artist?.genres) ? artist.genres.map((genre: string) => normalizeTag(String(genre))) : [];
    const heuristicTags = buildHeuristicTrackTags(track).map(normalizeTag);
    const tags = Array.from(new Set([...genreTags, ...heuristicTags])).filter(Boolean).slice(0, 25);
    supplementalTagsCache.set(trackId, tags);
    return tags;
    })();
    supplementalTagsInFlight.set(trackId, task);
    try {
      return await task;
    } finally {
      supplementalTagsInFlight.delete(trackId);
    }
  },

  async getCurrentUserProfile(accessToken: string): Promise<SpotifyUserProfile> {
    const res = await fetch("https://api.spotify.com/v1/me", {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
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
    const items: SpotifyUserPlaylist[] = [];
    let nextUrl: string | null = "https://api.spotify.com/v1/me/playlists?limit=50";
    while (nextUrl) {
      const response: Response = await fetch(nextUrl, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      if (!response.ok) {
        throw new Error("Failed to load Spotify playlists.");
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
  },

  async listSpotifyPlaylistTracks(
    accessToken: string,
    playlistId: string,
    tracksHref?: string | null,
    itemsHref?: string | null
  ): Promise<SpotifyTrack[]> {
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
  }
};

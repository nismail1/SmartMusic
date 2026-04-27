import type { SpotifyTrack } from "../types/music";

type PlaybackMode = "none" | "preview" | "spotify";

export interface PlaybackState {
  isPlaying: boolean;
  mode: PlaybackMode;
  currentTrackId: string | null;
  /** For global mini-player; set whenever a play session is active. */
  currentTrack: SpotifyTrack | null;
  /** True if Next can advance in the current list context. */
  queueHasNext: boolean;
  error: string;
  isPremiumCapable: boolean | null;
}

interface PlaybackContext {
  queue: SpotifyTrack[];
  index: number;
}

function hasRequiredPlaybackScopes(scope?: string | null): boolean {
  const parts = String(scope ?? "")
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.includes("streaming") && parts.includes("user-modify-playback-state");
}

function debugLog(location: string, message: string, data: Record<string, unknown>, hypothesisId: string, runId = "playback-debug") {
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

declare global {
  interface Window {
    onSpotifyWebPlaybackSDKReady?: () => void;
    Spotify?: any;
  }
}

class PlaybackController {
  private audio = new Audio();
  private spotifyPlayer: any = null;
  private spotifyDeviceId: string | null = null;
  private spotifySdkLoaded = false;
  private context: PlaybackContext | null = null;
  private state: PlaybackState = {
    isPlaying: false,
    mode: "none",
    currentTrackId: null,
    currentTrack: null,
    queueHasNext: false,
    error: "",
    isPremiumCapable: null
  };
  private listeners = new Set<(state: PlaybackState) => void>();

  constructor() {
    this.audio.addEventListener("play", () => this.setState({ isPlaying: true }));
    this.audio.addEventListener("pause", () => this.setState({ isPlaying: false }));
    this.audio.addEventListener("ended", () => this.setState({ isPlaying: false }));
  }

  subscribe(listener: (state: PlaybackState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  private setState(patch: Partial<PlaybackState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener(this.state));
  }

  private setContext(queue: SpotifyTrack[] | undefined, index: number | undefined) {
    if (!queue || index === undefined || index < 0 || index >= queue.length) {
      this.context = null;
      this.setState({ queueHasNext: false });
      return;
    }
    this.context = { queue, index };
    this.setState({ queueHasNext: index < queue.length - 1 });
  }

  async play(
    track: SpotifyTrack,
    options: {
      preferSpotify: boolean;
      spotifyAccessToken?: string | null;
      spotifyScope?: string | null;
      queue?: SpotifyTrack[];
      index?: number;
    }
  ) {
    debugLog(
      "src/services/playback.ts:play",
      "play called",
      {
        trackId: track.id,
        preferSpotify: options.preferSpotify,
        hasSpotifyToken: Boolean(options.spotifyAccessToken),
        hasPlaybackScope: hasRequiredPlaybackScopes(options.spotifyScope),
        hasTrackUri: Boolean(track.uri),
        hasPreviewUrl: Boolean(track.previewUrl)
      },
      "H1"
    );
    if (options.queue !== undefined) {
      this.setContext(options.queue, options.index);
    } else if (this.state.currentTrackId !== track.id) {
      this.setContext(undefined, undefined);
    }
    this.setState({ error: "", currentTrackId: track.id, currentTrack: track });

    if (options.preferSpotify && options.spotifyAccessToken && hasRequiredPlaybackScopes(options.spotifyScope)) {
      const spotifyPlayed = await this.playViaSpotify(track, options.spotifyAccessToken);
      if (spotifyPlayed) return;
    }
    if (options.preferSpotify && !hasRequiredPlaybackScopes(options.spotifyScope)) {
      this.setState({
        error:
          "Spotify playback is not authorized yet. Log out, then Continue with Spotify again so the app can request playback permission.",
        isPremiumCapable: false
      });
      debugLog(
        "src/services/playback.ts:play",
        "missing required spotify playback scopes",
        { spotifyScope: options.spotifyScope ?? null },
        "H2"
      );
      // Do not fall through to playPreview — it would show the wrong "no preview" message and hide this error.
      if (track.previewUrl) {
        await this.playPreview(track);
      }
      return;
    }
    await this.playPreview(track);
  }

  async pause() {
    if (this.state.mode === "spotify" && this.spotifyPlayer) {
      await this.spotifyPlayer.pause();
      this.setState({ isPlaying: false });
      return;
    }
    this.audio.pause();
  }

  async resume(track: SpotifyTrack, spotifyAccessToken?: string | null, spotifyScope?: string | null) {
    if (this.state.mode === "spotify" && this.spotifyPlayer && spotifyAccessToken) {
      await this.spotifyPlayer.resume();
      this.setState({ isPlaying: true });
      return;
    }
    if (this.audio.src) {
      await this.audio.play();
      return;
    }
    await this.play(track, {
      preferSpotify: Boolean(spotifyAccessToken),
      spotifyAccessToken,
      spotifyScope: spotifyScope ?? null
    });
  }

  async next(options: { preferSpotify: boolean; spotifyAccessToken?: string | null; spotifyScope?: string | null }) {
    if (!this.context) return;
    const nextIndex = this.context.index + 1;
    if (nextIndex >= this.context.queue.length) return;
    this.context.index = nextIndex;
    const nextTrack = this.context.queue[nextIndex];
    await this.play(nextTrack, {
      preferSpotify: options.preferSpotify,
      spotifyAccessToken: options.spotifyAccessToken,
      spotifyScope: options.spotifyScope,
      queue: this.context.queue,
      index: nextIndex
    });
  }

  async stop(spotifyAccessToken?: string | null) {
    const mode = this.state.mode;
    // #region agent log
    fetch("http://127.0.0.1:7701/ingest/35369d23-7f37-4585-ac9a-076a3915746b", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "658713" },
      body: JSON.stringify({
        sessionId: "658713",
        runId: "stop-verify",
        hypothesisId: "H1",
        location: "src/services/playback.ts:stop",
        message: "stop() entered",
        data: { mode, hasSpotifyPlayer: Boolean(this.spotifyPlayer) },
        timestamp: Date.now()
      })
    }).catch(() => {});
    // #endregion

    this.setContext(undefined, undefined);
    this.audio.pause();
    this.audio.currentTime = 0;

    if (mode === "spotify" && this.spotifyPlayer) {
      try {
        await this.spotifyPlayer.pause();
        // #region agent log
        fetch("http://127.0.0.1:7701/ingest/35369d23-7f37-4585-ac9a-076a3915746b", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "658713" },
          body: JSON.stringify({
            sessionId: "658713",
            runId: "stop-verify",
            hypothesisId: "H1",
            location: "src/services/playback.ts:stop",
            message: "spotify web playback SDK pause completed",
            data: {},
            timestamp: Date.now()
          })
        }).catch(() => {});
        // #endregion
      } catch (err) {
        debugLog(
          "src/services/playback.ts:stop",
          "spotify player pause error",
          { message: err instanceof Error ? err.message : "unknown" },
          "H1"
        );
      }
    }
    if (mode === "spotify" && spotifyAccessToken) {
      try {
        const r = await fetch("https://api.spotify.com/v1/me/player/pause", {
          method: "PUT",
          headers: { Authorization: `Bearer ${spotifyAccessToken}` }
        });
        // #region agent log
        fetch("http://127.0.0.1:7701/ingest/35369d23-7f37-4585-ac9a-076a3915746b", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "658713" },
          body: JSON.stringify({
            sessionId: "658713",
            runId: "stop-verify",
            hypothesisId: "H2",
            location: "src/services/playback.ts:stop",
            message: "REST /me/player/pause",
            data: { status: r.status, ok: r.ok },
            timestamp: Date.now()
          })
        }).catch(() => {});
        // #endregion
      } catch (err) {
        debugLog(
          "src/services/playback.ts:stop",
          "REST pause failed",
          { message: err instanceof Error ? err.message : "unknown" },
          "H2"
        );
      }
    }

    this.setState({ isPlaying: false, mode: "none", currentTrackId: null, currentTrack: null, queueHasNext: false, error: "" });
  }

  private async playPreview(track: SpotifyTrack) {
    if (!track.previewUrl) {
      this.setState({
        mode: "preview",
        isPlaying: false,
        currentTrack: track,
        error: "No preview available for this track. Connect Spotify Premium for full playback."
      });
      return;
    }
    this.audio.src = track.previewUrl;
    await this.audio.play();
    this.setState({ mode: "preview", isPlaying: true, isPremiumCapable: false, currentTrack: track });
  }

  private async loadSpotifySdk(): Promise<void> {
    if (this.spotifySdkLoaded && window.Spotify) return;
    await new Promise<void>((resolve, reject) => {
      const existing = document.querySelector('script[data-spotify-sdk="true"]') as HTMLScriptElement | null;
      if (existing && window.Spotify) {
        this.spotifySdkLoaded = true;
        resolve();
        return;
      }
      const script = existing ?? document.createElement("script");
      script.src = "https://sdk.scdn.co/spotify-player.js";
      script.async = true;
      script.dataset.spotifySdk = "true";
      window.onSpotifyWebPlaybackSDKReady = () => {
        this.spotifySdkLoaded = true;
        resolve();
      };
      script.onerror = () => reject(new Error("Failed to load Spotify playback SDK."));
      if (!existing) document.body.appendChild(script);
    });
  }

  private async ensureSpotifyPlayer(accessToken: string): Promise<boolean> {
    try {
      await this.loadSpotifySdk();
      if (!window.Spotify) {
        this.setState({ error: "Spotify SDK is unavailable in this browser.", isPremiumCapable: false });
        return false;
      }
      if (!this.spotifyPlayer) {
        this.spotifyPlayer = new window.Spotify.Player({
          name: "SmartMusic Web Player",
          getOAuthToken: (cb: (token: string) => void) => cb(accessToken),
          volume: 0.8
        });
        this.spotifyPlayer.addListener("ready", ({ device_id }: { device_id: string }) => {
          this.spotifyDeviceId = device_id;
          this.setState({ isPremiumCapable: true });
          debugLog("src/services/playback.ts:ensureSpotifyPlayer", "spotify sdk ready", { hasDeviceId: Boolean(device_id) }, "H3");
        });
        this.spotifyPlayer.addListener("authentication_error", () => {
          this.setState({ error: "Spotify authentication failed. Reconnect Spotify.", isPremiumCapable: false });
          debugLog("src/services/playback.ts:ensureSpotifyPlayer", "spotify authentication_error", {}, "H2");
        });
        this.spotifyPlayer.addListener("account_error", () => {
          this.setState({ error: "Spotify Premium is required for full-song playback.", isPremiumCapable: false });
          debugLog("src/services/playback.ts:ensureSpotifyPlayer", "spotify account_error", {}, "H2");
        });
        this.spotifyPlayer.addListener("playback_error", ({ message }: { message: string }) => {
          this.setState({ error: message || "Spotify playback failed." });
          debugLog("src/services/playback.ts:ensureSpotifyPlayer", "spotify playback_error", { message }, "H3");
        });
        await this.spotifyPlayer.connect();
      }
      debugLog(
        "src/services/playback.ts:ensureSpotifyPlayer",
        "spotify player initialized",
        { hasPlayer: Boolean(this.spotifyPlayer), hasDeviceId: Boolean(this.spotifyDeviceId), tokenLength: accessToken.length },
        "H3"
      );
      return Boolean(this.spotifyPlayer);
    } catch (error) {
      this.setState({
        error: error instanceof Error ? error.message : "Failed to initialize Spotify playback.",
        isPremiumCapable: false
      });
      return false;
    }
  }

  private async playViaSpotify(track: SpotifyTrack, accessToken: string): Promise<boolean> {
    if (!track.uri) {
      debugLog("src/services/playback.ts:playViaSpotify", "missing track uri", { trackId: track.id }, "H4");
      return false;
    }
    const ready = await this.ensureSpotifyPlayer(accessToken);
    if (!ready || !this.spotifyDeviceId) {
      return false;
    }
    const response = await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${encodeURIComponent(this.spotifyDeviceId)}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ uris: [track.uri] })
    });
    debugLog(
      "src/services/playback.ts:playViaSpotify",
      "spotify play endpoint response",
      { status: response.status, trackId: track.id, hasDeviceId: Boolean(this.spotifyDeviceId) },
      "H2"
    );
    if (response.status === 204) {
      this.setState({ mode: "spotify", isPlaying: true, error: "", isPremiumCapable: true, currentTrack: track });
      return true;
    }
    if (response.status === 403) {
      this.setState({
        mode: "spotify",
        isPlaying: false,
        isPremiumCapable: false,
        currentTrack: track,
        error: "Spotify Premium is required for full-song playback."
      });
      return false;
    }
    this.setState({ error: "Spotify playback request failed.", currentTrack: track });
    return false;
  }
}

export const playbackController = new PlaybackController();

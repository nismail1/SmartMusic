import { useEffect, useState } from "react";
import type { GeniusEnrichment, SpotifyTrack } from "../types/music";
import { formatDuration } from "../lib/format";
import { useAuth } from "../context/AuthContext";
import { playbackController, type PlaybackState } from "../services/playback";

interface SongDetailsDrawerProps {
  track: SpotifyTrack | null;
  details: GeniusEnrichment | null;
  queue?: SpotifyTrack[];
  queueIndex?: number;
  loading: boolean;
  error: string;
  onClose: () => void;
}

const initialPlaybackState: PlaybackState = {
  isPlaying: false,
  mode: "none",
  currentTrackId: null,
  currentTrack: null,
  queueHasNext: false,
  error: "",
  isPremiumCapable: null
};

function debugLog(location: string, message: string, data: Record<string, unknown>, hypothesisId: string, runId = "playback-debug") {
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

export function SongDetailsDrawer({ track, details, queue, queueIndex, loading, error, onClose }: SongDetailsDrawerProps) {
  const { authMode, spotifySession } = useAuth();
  const [playbackState, setPlaybackState] = useState<PlaybackState>(initialPlaybackState);

  useEffect(() => playbackController.subscribe(setPlaybackState), []);
  useEffect(() => {
    // #region agent log
    import.meta.env.DEV && fetch("http://127.0.0.1:7701/ingest/35369d23-7f37-4585-ac9a-076a3915746b", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "658713" },
      body: JSON.stringify({
        sessionId: "658713",
        runId: "playback-debug",
        hypothesisId: "H7",
        location: "src/components/SongDetailsDrawer.tsx:useEffect",
        message: "drawer mounted",
        data: {},
        timestamp: Date.now()
      })
    }).catch(() => {});
    // #endregion
    return () => {
      // #region agent log
      import.meta.env.DEV && fetch("http://127.0.0.1:7701/ingest/35369d23-7f37-4585-ac9a-076a3915746b", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "658713" },
        body: JSON.stringify({
          sessionId: "658713",
          runId: "playback-debug",
          hypothesisId: "H7",
          location: "src/components/SongDetailsDrawer.tsx:useEffectCleanup",
          message: "drawer unmounted",
          data: {},
          timestamp: Date.now()
        })
      }).catch(() => {});
      // #endregion
    };
  }, []);

  if (!track) return null;
  const activeTrack = track;
  const hasMetadata =
    Boolean(details?.songDescription) ||
    Boolean(details?.artistDescription) ||
    Boolean(details?.tags?.length);
  const isCurrentTrack = playbackState.currentTrackId === activeTrack.id;

  async function handlePlayPause() {
    debugLog(
      "src/components/SongDetailsDrawer.tsx:handlePlayPause",
      "play/pause pressed",
      {
        authMode,
        hasSpotifySession: Boolean(spotifySession),
        hasSpotifyToken: Boolean(spotifySession?.accessToken),
        spotifyScope: spotifySession?.scope ?? null,
        isCurrentTrack,
        isPlaying: playbackState.isPlaying,
        trackId: activeTrack.id,
        hasUri: Boolean(activeTrack.uri),
        hasPreviewUrl: Boolean(activeTrack.previewUrl)
      },
      "H1"
    );
    if (isCurrentTrack && playbackState.isPlaying) {
      await playbackController.pause();
      return;
    }
    if (isCurrentTrack && !playbackState.isPlaying) {
      await playbackController.resume(activeTrack, spotifySession?.accessToken ?? null, spotifySession?.scope ?? null);
      return;
    }
    await playbackController.play(activeTrack, {
      preferSpotify: authMode === "spotify",
      spotifyAccessToken: spotifySession?.accessToken ?? null,
      spotifyScope: spotifySession?.scope ?? null,
      queue,
      index: queueIndex
    });
  }

  return (
    <aside className="song-drawer-overlay" onClick={onClose} role="presentation">
      <section className="song-drawer" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Song details">
        <div className="song-drawer-header">
          <h3>Song Details</h3>
          <button type="button" onClick={onClose} aria-label="Close song details">
            Close
          </button>
        </div>

        <div className="song-drawer-track">
          {activeTrack.artworkUrl ? (
            <button type="button" className="cover-play-button" onClick={() => void handlePlayPause()}>
              <img src={activeTrack.artworkUrl} alt={activeTrack.albumName} width={88} height={88} />
              <span className="cover-play-icon">{isCurrentTrack && playbackState.isPlaying ? "Pause" : "Play"}</span>
            </button>
          ) : null}
          <div>
            <strong>{activeTrack.name}</strong>
            <p>{activeTrack.artists.join(", ")}</p>
            <p>{activeTrack.albumName}</p>
            <p>
              {activeTrack.releaseDate ?? "Unknown release"} | {formatDuration(activeTrack.durationMs)}
            </p>
          </div>
        </div>

        {loading ? <p>Loading Genius details...</p> : null}
        {!loading && error ? <p className="error">{error}</p> : null}

        {!loading && !error ? (
          <>
            <h4>About this song</h4>
            <p>{details?.songDescription ?? "No song description available."}</p>

            <h4>Artist Bio</h4>
            <p>{details?.artistDescription ?? "No artist description available."}</p>

            <h4>Tags</h4>
            {details?.tags?.length ? (
              <p>{details.tags.join(" • ")}</p>
            ) : (
              <p>No tags available yet.</p>
            )}

            {details?.geniusSongUrl ? (
              <>
                <h4>Source</h4>
                <p>Open the source song page on Genius for reference metadata context.</p>
                <p>
                  <a href={details.geniusSongUrl} target="_blank" rel="noreferrer" className="genius-cta-link">
                    Open source page on Genius
                  </a>
                </p>
              </>
            ) : null}

            {!hasMetadata ? <p>No metadata available for this song yet. Try another track to seed analytics.</p> : null}
          </>
        ) : null}
      </section>
    </aside>
  );
}

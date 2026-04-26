import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "../context/AuthContext";
import { playbackController, type PlaybackState } from "../services/playback";
import { formatDuration } from "../lib/format";

const POS_KEY = "smartmusic.floatingPlayer.position";

const initialPlaybackState: PlaybackState = {
  isPlaying: false,
  mode: "none",
  currentTrackId: null,
  currentTrack: null,
  queueHasNext: false,
  error: "",
  isPremiumCapable: null
};

function readSavedPosition(): { x: number; y: number } | null {
  try {
    const raw = localStorage.getItem(POS_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as { x?: number; y?: number };
    if (typeof p.x === "number" && typeof p.y === "number") return { x: p.x, y: p.y };
  } catch {
    // ignore
  }
  return null;
}

function defaultPosition() {
  const w = typeof window !== "undefined" ? window.innerWidth : 400;
  const h = typeof window !== "undefined" ? window.innerHeight : 600;
  return { x: Math.max(16, w - 16 - 220), y: Math.max(16, h - 16 - 220) };
}

export function FloatingPlayer() {
  const { authMode, spotifySession } = useAuth();
  const [state, setState] = useState<PlaybackState>(initialPlaybackState);
  const [pos, setPos] = useState<{ x: number; y: number }>(() => readSavedPosition() ?? defaultPosition());
  const posRef = useRef(pos);
  posRef.current = pos;
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => playbackController.subscribe(setState), []);

  useEffect(() => {
    // #region agent log
    fetch("http://127.0.0.1:7701/ingest/35369d23-7f37-4585-ac9a-076a3915746b", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "658713" },
      body: JSON.stringify({
        sessionId: "658713",
        runId: "playback-debug",
        hypothesisId: "H9",
        location: "src/components/FloatingPlayer.tsx:useEffect",
        message: "floating player mounted in AppLayout (persists across route Outlet)",
        data: {},
        timestamp: Date.now()
      })
    }).catch(() => {});
    // #endregion
  }, []);

  useEffect(() => {
    if (!state.currentTrack) return;
    // #region agent log
    fetch("http://127.0.0.1:7701/ingest/35369d23-7f37-4585-ac9a-076a3915746b", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "658713" },
      body: JSON.stringify({
        sessionId: "658713",
        runId: "playback-debug",
        hypothesisId: "H10",
        location: "src/components/FloatingPlayer.tsx:useEffect",
        message: "floating player visible (has currentTrack)",
        data: { trackId: state.currentTrack.id },
        timestamp: Date.now()
      })
    }).catch(() => {});
    // #endregion
  }, [state.currentTrack]);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: PointerEvent) => {
      if (!dragRef.current) return;
      const dx = e.clientX - dragRef.current.startX;
      const dy = e.clientY - dragRef.current.startY;
      const w = window.innerWidth;
      const h = window.innerHeight;
      const size = 200;
      const nextX = Math.min(Math.max(8, dragRef.current.origX + dx), w - size - 8);
      const nextY = Math.min(Math.max(8, dragRef.current.origY + dy), h - size - 8);
      setPos({ x: nextX, y: nextY });
    };
    const onUp = () => {
      dragRef.current = null;
      setDragging(false);
      try {
        const p = posRef.current;
        localStorage.setItem(POS_KEY, JSON.stringify({ x: p.x, y: p.y }));
      } catch {
        // ignore
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [dragging]);

  const onDragStart = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      dragRef.current = { startX: e.clientX, startY: e.clientY, origX: posRef.current.x, origY: posRef.current.y };
      setDragging(true);
    },
    []
  );

  const track = state.currentTrack;
  if (!track) return null;
  const activeTrack = track;

  async function handlePlayPause() {
    if (state.currentTrackId === activeTrack.id && state.isPlaying) {
      await playbackController.pause();
      return;
    }
    if (state.currentTrackId === activeTrack.id && !state.isPlaying) {
      await playbackController.resume(activeTrack, spotifySession?.accessToken ?? null, spotifySession?.scope ?? null);
      return;
    }
    await playbackController.play(activeTrack, {
      preferSpotify: authMode === "spotify",
      spotifyAccessToken: spotifySession?.accessToken ?? null,
      spotifyScope: spotifySession?.scope ?? null
    });
  }

  async function handleNext() {
    await playbackController.next({
      preferSpotify: authMode === "spotify",
      spotifyAccessToken: spotifySession?.accessToken ?? null,
      spotifyScope: spotifySession?.scope ?? null
    });
  }

  return (
    <div className="floating-player" style={{ left: pos.x, top: pos.y }} role="region" aria-label="Now playing">
      <div
        className="floating-player-drag"
        onPointerDown={onDragStart}
        title="Drag to move"
      />
      <div className="floating-player-chrome">
        {activeTrack.artworkUrl ? <img className="floating-player-art" src={activeTrack.artworkUrl} alt="" width={200} height={200} /> : null}
        <div className="floating-player-meta">
          <div className="floating-player-title">{activeTrack.name}</div>
          <div className="floating-player-artist">{activeTrack.artists.join(", ")}</div>
          <div className="floating-player-dur">{formatDuration(activeTrack.durationMs)}</div>
        </div>
        <div className="floating-player-controls">
          <button type="button" onClick={() => void handlePlayPause()} aria-label={state.isPlaying ? "Pause" : "Play"}>
            {state.isPlaying ? "Pause" : "Play"}
          </button>
          {state.queueHasNext ? (
            <button type="button" onClick={() => void handleNext()}>
              Next
            </button>
          ) : null}
          <button type="button" onClick={() => playbackController.stop()} aria-label="Stop">
            Stop
          </button>
        </div>
        {state.error ? <p className="error floating-player-err">{state.error}</p> : null}
        <p className="floating-player-mode">{authMode === "spotify" ? "Spotify" : "Preview"}</p>
      </div>
    </div>
  );
}

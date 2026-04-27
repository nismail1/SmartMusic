import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { SongDetailsDrawer } from "../components/SongDetailsDrawer";
import { useAuth } from "../context/AuthContext";
import { geniusService } from "../services/genius";
import { computePlaylistAnalytics } from "../services/playlistAnalytics";
import { playbackController } from "../services/playback";
import { playlistService } from "../services/playlists";
import { recommendationService } from "../services/recommendations";
import type { GeniusEnrichment, PlaylistTrack, RecommendationItem, SpotifyTrack } from "../types/music";
import { formatDuration } from "../lib/format";

type SortKey = "addedAt" | "artist" | "releaseDate" | "durationMs";

export function PlaylistPage() {
  const navigate = useNavigate();
  const { playlistId = "" } = useParams();
  const { authMode, spotifySession } = useAuth();
  const [playlistName, setPlaylistName] = useState("Playlist View");
  const [tracks, setTracks] = useState<PlaylistTrack[]>([]);
  const [recommendations, setRecommendations] = useState<RecommendationItem[]>([]);
  const [recommendationError, setRecommendationError] = useState("");
  const [selectedTrack, setSelectedTrack] = useState<PlaylistTrack | null>(null);
  const [selectedQueue, setSelectedQueue] = useState<PlaylistTrack[]>([]);
  const [selectedQueueIndex, setSelectedQueueIndex] = useState<number>(-1);
  const [drawerDetails, setDrawerDetails] = useState<GeniusEnrichment | null>(null);
  const [drawerLoading, setDrawerLoading] = useState(false);
  const [drawerError, setDrawerError] = useState("");
  const [loading, setLoading] = useState(true);
  const [deletingPlaylist, setDeletingPlaylist] = useState(false);
  const [mutatingTrackId, setMutatingTrackId] = useState<string | null>(null);
  const [suggestionStatus, setSuggestionStatus] = useState("");
  const [sortBy, setSortBy] = useState<SortKey>("addedAt");
  const [activeGenreFilter, setActiveGenreFilter] = useState<string>("all");
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
  const [suppressedSuggestionIds, setSuppressedSuggestionIds] = useState<string[]>([]);
  const [addedFromSuggestions, setAddedFromSuggestions] = useState<string[]>([]);

  const suppressionStorageKey = useMemo(() => `smartmusic:suppressedSuggestions:${playlistId}`, [playlistId]);
  const addedFromSuggestionStorageKey = useMemo(() => `smartmusic:addedFromSuggestions:${playlistId}`, [playlistId]);

  useEffect(() => {
    setHasLoadedOnce(false);
    setPlaylistName("Playlist View");
  }, [playlistId]);

  useEffect(() => {
    if (!playlistId) return;
    try {
      const suppressed = JSON.parse(window.localStorage.getItem(suppressionStorageKey) ?? "[]");
      setSuppressedSuggestionIds(Array.isArray(suppressed) ? suppressed.filter((id) => typeof id === "string") : []);
      const added = JSON.parse(window.localStorage.getItem(addedFromSuggestionStorageKey) ?? "[]");
      setAddedFromSuggestions(Array.isArray(added) ? added.filter((id) => typeof id === "string") : []);
    } catch {
      setSuppressedSuggestionIds([]);
      setAddedFromSuggestions([]);
    }
  }, [playlistId, suppressionStorageKey, addedFromSuggestionStorageKey]);

  useEffect(() => {
    if (!recommendations.length) return;
    const missingReleaseCount = recommendations.filter((item) => !item.releaseDate).length;
    const missingDurationCount = recommendations.filter((item) => !Number(item.durationMs ?? 0)).length;
    // #region agent log
    import.meta.env.DEV && fetch("http://127.0.0.1:7701/ingest/35369d23-7f37-4585-ac9a-076a3915746b", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "658713" },
      body: JSON.stringify({
        sessionId: "658713",
        runId: "metadata-playback-debug",
        hypothesisId: "H21",
        location: "src/pages/PlaylistPage.tsx:useEffect(recommendations)",
        message: "recommendations set for display",
        data: {
          count: recommendations.length,
          missingReleaseCount,
          missingDurationCount,
          first: {
            songId: recommendations[0]?.songId ?? null,
            releaseDate: recommendations[0]?.releaseDate ?? null,
            durationMs: recommendations[0]?.durationMs ?? null,
            previewUrl: recommendations[0]?.previewUrl ?? null
          }
        },
        timestamp: Date.now()
      })
    }).catch(() => {});
    // #endregion
  }, [recommendations]);

  useEffect(() => {
    async function load() {
      if (!playlistId) return;
      if (hasLoadedOnce) return;
      setLoading(true);
      setRecommendationError("");
      try {
        const playlist = await playlistService.getPlaylist(playlistId);
        setPlaylistName(playlist?.name || "Playlist View");
        const baseTracks = await playlistService.listPlaylistTracks(playlistId);
        setTracks(baseTracks);
      } catch {
        setTracks([]);
        setRecommendations([]);
        setRecommendationError("Failed to load playlist data.");
        setLoading(false);
        return;
      }

      try {
        setRecommendations(await recommendationService.getRecommendations(playlistId, { excludeSongIds: suppressedSuggestionIds }));
      } catch {
        setRecommendations([]);
        setRecommendationError("Unable to load suggestions right now. Please try again in a moment.");
      } finally {
        setHasLoadedOnce(true);
        setLoading(false);
      }
    }
    void load();
  }, [playlistId, hasLoadedOnce, suppressedSuggestionIds]);

  async function refreshSuggestions() {
    if (!playlistId) return;
    try {
      setRecommendations(await recommendationService.getRecommendations(playlistId, { excludeSongIds: suppressedSuggestionIds }));
      setRecommendationError("");
    } catch (error) {
      // #region agent log
      import.meta.env.DEV && fetch("http://127.0.0.1:7701/ingest/35369d23-7f37-4585-ac9a-076a3915746b", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "658713" },
        body: JSON.stringify({
          sessionId: "658713",
          runId: "suppression-debug",
          hypothesisId: "H14",
          location: "src/pages/PlaylistPage.tsx:refreshSuggestions",
          message: "refresh suggestions failed",
          data: { playlistId, suppressedCount: suppressedSuggestionIds.length, message: error instanceof Error ? error.message : String(error) },
          timestamp: Date.now()
        })
      }).catch(() => {});
      // #endregion
      setRecommendations([]);
      setRecommendationError("Unable to load suggestions right now. Please try again in a moment.");
    }
  }

  function persistSuppressedIds(updater: (previous: string[]) => string[]) {
    setSuppressedSuggestionIds((previous) => {
      const next = updater(previous);
      window.localStorage.setItem(suppressionStorageKey, JSON.stringify(next));
      return next;
    });
  }

  function persistAddedFromSuggestions(updater: (previous: string[]) => string[]) {
    setAddedFromSuggestions((previous) => {
      const next = updater(previous);
      window.localStorage.setItem(addedFromSuggestionStorageKey, JSON.stringify(next));
      return next;
    });
  }

  async function openSongDetails(track: PlaylistTrack, queue: PlaylistTrack[] = [], queueIndex = -1) {
    setSelectedTrack(track);
    setSelectedQueue(queue);
    setSelectedQueueIndex(queueIndex);
    setDrawerLoading(true);
    setDrawerError("");
    setDrawerDetails(track.genius ?? null);
    try {
      const details = await geniusService.enrichTrack(track);
      setDrawerDetails(details);
      setTracks((prev) =>
        prev.map((item) =>
          item.id === track.id
            ? {
                ...item,
                genius: details
              }
            : item
        )
      );
    } catch {
      setDrawerDetails(track.genius ?? null);
      setDrawerError("Unable to load Genius details for this song.");
    } finally {
      setDrawerLoading(false);
    }
  }

  const analytics = useMemo(() => computePlaylistAnalytics(tracks), [tracks]);
  const genreOptions = useMemo(() => {
    const fromAnalytics = Object.keys(analytics.genreComposition);
    const fromGeniusTags = Array.from(
      new Set(
        tracks
          .flatMap((track) => track.genius?.tags ?? [])
          .map((tag) => tag.toLowerCase().trim())
          .filter(Boolean)
      )
    );
    return Array.from(new Set(["all", ...fromAnalytics, ...fromGeniusTags]));
  }, [analytics.genreComposition, tracks]);

  function handleTrackClick(track: PlaylistTrack) {
    const queue = sortedAndFilteredTracks;
    const queueIndex = queue.findIndex((item) => item.id === track.id);
    void openSongDetails(track, queue, queueIndex);
  }

  async function handleSuggestionAdd(item: RecommendationItem) {
    if (!playlistId) return;
    try {
      const trackToAdd: SpotifyTrack = {
        id: item.songId,
        name: item.songName ?? item.songId,
        artists: item.artists ?? [],
        uri: item.uri ?? `spotify:track:${item.songId}`,
        albumId: "",
        albumName: item.albumName ?? "",
        artworkUrl: item.artworkUrl ?? null,
        previewUrl: item.previewUrl ?? null,
        releaseDate: item.releaseDate ?? null,
        durationMs: Number(item.durationMs ?? 0),
        genres: []
      };
      // #region agent log
      import.meta.env.DEV && fetch("http://127.0.0.1:7701/ingest/35369d23-7f37-4585-ac9a-076a3915746b", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "658713" },
        body: JSON.stringify({
          sessionId: "658713",
          runId: "metadata-genre-debug",
          hypothesisId: "H30",
          location: "src/pages/PlaylistPage.tsx:handleSuggestionAdd",
          message: "suggestion converted to playlist track",
          data: {
            playlistId,
            songId: item.songId,
            resolvedByLookup: false,
            releaseDate: trackToAdd.releaseDate ?? null,
            albumName: trackToAdd.albumName ?? "",
            genreCount: Array.isArray(trackToAdd.genres) ? trackToAdd.genres.length : 0
          },
          timestamp: Date.now()
        })
      }).catch(() => {});
      // #endregion
      await playlistService.addTrack(playlistId, trackToAdd);
      setSuggestionStatus(`Added ${trackToAdd.name} to this playlist.`);
      setTracks((prev) => [...prev, { ...trackToAdd, addedAt: new Date().toISOString() }]);
      persistAddedFromSuggestions((previous) => Array.from(new Set([...previous, trackToAdd.id])));
      await refreshSuggestions();
    } catch {
      setSuggestionStatus("Could not add this suggestion right now.");
    }
  }

  async function handleRemoveTrack(trackId: string, trackName: string) {
    if (!playlistId) return;
    setMutatingTrackId(trackId);
    try {
      await playlistService.removeTrack(playlistId, trackId);
      setTracks((prev) => prev.filter((track) => track.id !== trackId));
      setSuggestionStatus(`Removed ${trackName} from this playlist.`);
      if (addedFromSuggestions.includes(trackId)) {
        persistSuppressedIds((previous) => Array.from(new Set([...previous, trackId])));
        persistAddedFromSuggestions((previous) => previous.filter((id) => id !== trackId));
      }
      await refreshSuggestions();
    } catch {
      setSuggestionStatus("Could not remove this song right now.");
    } finally {
      setMutatingTrackId(null);
    }
  }

  async function handleDeletePlaylist() {
    if (!playlistId) return;
    const confirmDelete = window.confirm(
      "Delete this SmartMusic playlist and all its songs from the app? This will not affect your Spotify account."
    );
    if (!confirmDelete) return;
    setDeletingPlaylist(true);
    try {
      await playlistService.deletePlaylist(playlistId);
      navigate("/home");
    } catch {
      setSuggestionStatus("Could not delete this playlist right now.");
      setDeletingPlaylist(false);
    }
  }

  async function handleSuggestionPlay(item: RecommendationItem) {
    try {
      // #region agent log
      import.meta.env.DEV && fetch("http://127.0.0.1:7701/ingest/35369d23-7f37-4585-ac9a-076a3915746b", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "658713" },
        body: JSON.stringify({
          sessionId: "658713",
          runId: "suggestion-play-debug",
          hypothesisId: "H4",
          location: "src/pages/PlaylistPage.tsx:handleSuggestionPlay",
          message: "play suggestion clicked",
          data: {
            songId: item.songId,
            releaseDate: item.releaseDate ?? null,
            durationMs: item.durationMs ?? null,
            previewUrl: item.previewUrl ?? null
          },
          timestamp: Date.now()
        })
      }).catch(() => {});
      // #endregion
      const track: SpotifyTrack = {
        id: item.songId,
        name: item.songName ?? item.songId,
        artists: item.artists ?? [],
        uri: item.uri ?? `spotify:track:${item.songId}`,
        albumId: "",
        albumName: item.albumName ?? "",
        artworkUrl: item.artworkUrl ?? null,
        previewUrl: item.previewUrl ?? null,
        releaseDate: item.releaseDate ?? null,
        durationMs: Number(item.durationMs ?? 0)
      };
      await playbackController.play(track, {
        preferSpotify: authMode === "spotify",
        spotifyAccessToken: spotifySession?.accessToken ?? null,
        spotifyScope: spotifySession?.scope ?? null,
        queue: recommendations
          .map((rec) => ({
            id: rec.songId,
            name: rec.songName ?? rec.songId,
            artists: rec.artists ?? [],
            uri: rec.uri ?? `spotify:track:${rec.songId}`,
            albumId: "",
            albumName: rec.albumName ?? "",
            artworkUrl: rec.artworkUrl ?? null,
            previewUrl: rec.previewUrl ?? null,
            releaseDate: rec.releaseDate ?? null,
            durationMs: Number(rec.durationMs ?? 0)
          }))
          .filter((recTrack) => Boolean(recTrack.id)),
        index: recommendations.findIndex((rec) => rec.songId === item.songId)
      });
      // #region agent log
      import.meta.env.DEV && fetch("http://127.0.0.1:7701/ingest/35369d23-7f37-4585-ac9a-076a3915746b", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "658713" },
        body: JSON.stringify({
          sessionId: "658713",
          runId: "metadata-playback-debug",
          hypothesisId: "H22",
          location: "src/pages/PlaylistPage.tsx:handleSuggestionPlay",
          message: "suggestion playback dispatched",
          data: {
            songId: track.id,
            authMode,
            hasSpotifySession: Boolean(spotifySession),
            hasSpotifyToken: Boolean(spotifySession?.accessToken),
            spotifyScope: spotifySession?.scope ?? null,
            hasPreviewUrl: Boolean(track.previewUrl),
            releaseDate: track.releaseDate ?? null
          },
          timestamp: Date.now()
        })
      }).catch(() => {});
      // #endregion
    } catch {
      // #region agent log
      import.meta.env.DEV && fetch("http://127.0.0.1:7701/ingest/35369d23-7f37-4585-ac9a-076a3915746b", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "658713" },
        body: JSON.stringify({
          sessionId: "658713",
          runId: "suggestion-play-debug",
          hypothesisId: "H6",
          location: "src/pages/PlaylistPage.tsx:handleSuggestionPlay",
          message: "playback failed in suggestion flow",
          data: { songId: item.songId },
          timestamp: Date.now()
        })
      }).catch(() => {});
      // #endregion
      setSuggestionStatus("Unable to play this suggestion right now.");
    }
  }

  async function handleSuggestionClick(item: RecommendationItem) {
    try {
      const track: PlaylistTrack = {
        id: item.songId,
        name: item.songName ?? item.songId,
        artists: item.artists ?? [],
        uri: item.uri ?? `spotify:track:${item.songId}`,
        albumId: "",
        albumName: item.albumName ?? "",
        artworkUrl: item.artworkUrl ?? null,
        previewUrl: item.previewUrl ?? null,
        releaseDate: item.releaseDate ?? null,
        durationMs: Number(item.durationMs ?? 0),
        genres: [],
        addedAt: new Date().toISOString()
      };
      await openSongDetails(track);
    } catch {
      const fallbackTrack: PlaylistTrack = {
        id: item.songId,
        name: item.songName ?? item.songId,
        artists: item.artists ?? [],
        uri: item.uri ?? `spotify:track:${item.songId}`,
        albumId: "",
        albumName: item.albumName ?? "",
        artworkUrl: item.artworkUrl ?? null,
        previewUrl: item.previewUrl ?? null,
        releaseDate: item.releaseDate ?? null,
        durationMs: Number(item.durationMs ?? 0),
        genres: [],
        addedAt: new Date().toISOString()
      };
      await openSongDetails(fallbackTrack);
    }
  }

  async function handleSuggestionDismiss(item: RecommendationItem) {
    if (!playlistId) return;
    const dismissedId = item.songId;
    const nextSuppressed = Array.from(new Set([...suppressedSuggestionIds, dismissedId]));
    // #region agent log
    import.meta.env.DEV && fetch("http://127.0.0.1:7701/ingest/35369d23-7f37-4585-ac9a-076a3915746b", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "658713" },
      body: JSON.stringify({
        sessionId: "658713",
        runId: "suppression-debug",
        hypothesisId: "H11",
        location: "src/pages/PlaylistPage.tsx:handleSuggestionDismiss",
        message: "dismiss suggestion requested",
        data: { playlistId, dismissedId, previousSuppressedCount: suppressedSuggestionIds.length, nextSuppressedCount: nextSuppressed.length },
        timestamp: Date.now()
      })
    }).catch(() => {});
    // #endregion
    persistSuppressedIds(() => nextSuppressed);
    setSuggestionStatus(`Got it - we won't suggest ${item.songName ?? "that track"} again for this playlist.`);
    try {
      setRecommendations(
        await recommendationService.getRecommendations(playlistId, {
          excludeSongIds: nextSuppressed,
          forceRefresh: true
        })
      );
      setRecommendationError("");
    } catch (error) {
      // #region agent log
      import.meta.env.DEV && fetch("http://127.0.0.1:7701/ingest/35369d23-7f37-4585-ac9a-076a3915746b", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "658713" },
        body: JSON.stringify({
          sessionId: "658713",
          runId: "suppression-debug",
          hypothesisId: "H14",
          location: "src/pages/PlaylistPage.tsx:handleSuggestionDismiss",
          message: "dismiss flow failed to fetch next suggestion",
          data: { playlistId, dismissedId, nextSuppressedCount: nextSuppressed.length, message: error instanceof Error ? error.message : String(error) },
          timestamp: Date.now()
        })
      }).catch(() => {});
      // #endregion
      setRecommendations([]);
      setRecommendationError("Unable to load suggestions right now. Please try again in a moment.");
    }
  }

  const sortedAndFilteredTracks = useMemo(() => {
    let next = [...tracks];
    if (activeGenreFilter !== "all") {
      const target = activeGenreFilter.toLowerCase();
      next = next.filter((track) => {
        const trackGenres = (track.genres ?? []).map((genre) => genre.toLowerCase());
        const trackTags = (track.genius?.tags ?? []).map((tag) => tag.toLowerCase());
        return trackGenres.includes(target) || trackTags.includes(target);
      });
    }
    next.sort((a, b) => {
      switch (sortBy) {
        case "artist":
          return (a.artists[0] ?? "").localeCompare(b.artists[0] ?? "");
        case "releaseDate":
          return (a.releaseDate ?? "").localeCompare(b.releaseDate ?? "");
        case "durationMs":
          return a.durationMs - b.durationMs;
        default:
          return a.addedAt.localeCompare(b.addedAt);
      }
    });
    return next;
  }, [tracks, activeGenreFilter, sortBy]);

  return (
    <section>
      <h2 className="page-title" style={{ fontSize: "2rem" }}>
        {playlistName}
      </h2>
      {loading ? <p>Loading playlist...</p> : null}

      <h3>Overview</h3>
      <div className="page-section" style={{ marginTop: 8 }}>
        <p style={{ margin: "0 0 8px" }}>Total duration: {formatDuration(analytics.totalDurationMs)}</p>
        <p style={{ margin: "0 0 8px" }}>
          Decades: {Object.entries(analytics.decadeBreakdown).map(([d, c]) => `${d} (${c})`).join(", ") || "None"}
        </p>
        <p style={{ margin: 0 }}>Genres: {Object.entries(analytics.genreComposition).map(([g, c]) => `${g} (${c})`).join(", ") || "None"}</p>
      </div>

      <div className="filters">
        <label>
          Sort by
          <select value={sortBy} onChange={(e) => setSortBy(e.target.value as SortKey)}>
            <option value="addedAt">Recently added</option>
            <option value="artist">Artist</option>
            <option value="releaseDate">Release date</option>
            <option value="durationMs">Duration</option>
          </select>
        </label>
      </div>
      <div className="genre-filters">
        {genreOptions.map((genre) => (
          <button
            key={genre}
            type="button"
            className={genre === activeGenreFilter ? "genre-filter-chip active" : "genre-filter-chip"}
            onClick={() => setActiveGenreFilter(genre)}
          >
            {genre === "all" ? "All genres" : genre}
          </button>
        ))}
      </div>

      <h3>Tracks</h3>
      <div className="actions" style={{ margin: "0 0 10px" }}>
        <button
          type="button"
          className="icon-minus-button icon-minus-button--danger"
          onClick={() => void handleDeletePlaylist()}
          disabled={deletingPlaylist}
          aria-label={deletingPlaylist ? "Deleting playlist" : "Delete playlist from SmartMusic"}
          title={deletingPlaylist ? "Deleting..." : "Delete playlist (SmartMusic only)"}
        >
          &minus;
        </button>
      </div>
      <div className="track-chart-wrap">
        <table className="track-chart">
          <thead>
            <tr>
              <th>Title</th>
              <th>Artist</th>
              <th>Album</th>
              <th>Duration</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {sortedAndFilteredTracks.map((track) => (
              <tr key={track.id}>
                <td>
                  <button type="button" className="track-link-button" onClick={() => handleTrackClick(track)}>
                    {track.name}
                  </button>
                </td>
                <td>{track.artists.join(", ")}</td>
                <td>{track.albumName}</td>
                <td>{formatDuration(track.durationMs)}</td>
                <td>
                  <button
                    type="button"
                    className="icon-minus-button"
                    onClick={() => void handleRemoveTrack(track.id, track.name)}
                    disabled={mutatingTrackId === track.id}
                    aria-label={mutatingTrackId === track.id ? "Removing song" : `Remove ${track.name} from playlist`}
                    title={mutatingTrackId === track.id ? "Removing..." : "Remove from playlist"}
                  >
                    &minus;
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3>Suggestions</h3>
      {recommendationError ? <p className="error">{recommendationError}</p> : null}
      {suggestionStatus ? <p>{suggestionStatus}</p> : null}
      {!recommendationError && !recommendations.length ? <p style={{ color: "var(--color-muted)" }}>No suggestions yet.</p> : null}
      {recommendations[0] ? (
        <section className="suggestion-spotlight" aria-label="Suggested next song">
          <p className="suggestion-spotlight__kicker">Suggested Next Song</p>
          <button type="button" className="track-link-button suggestion-spotlight__title" onClick={() => void handleSuggestionClick(recommendations[0])}>
            <strong>{recommendations[0].songName ?? recommendations[0].songId}</strong>
            {recommendations[0].artists?.length ? ` — ${recommendations[0].artists.join(", ")}` : ""}
          </button>
          <p className="suggestion-spotlight__meta">
            {(recommendations[0].releaseDate ?? "Unknown release")} | {formatDuration(Number(recommendations[0].durationMs ?? 0))}
          </p>
          <p className="suggestion-spotlight__reason">
            {recommendations[0].reasons?.[0] ?? "Picked to fit this playlist right now."}
          </p>
          <div className="actions" style={{ marginTop: 8 }}>
            <button type="button" onClick={() => void handleSuggestionPlay(recommendations[0])}>
              Play preview
            </button>
            <button type="button" onClick={() => void handleSuggestionAdd(recommendations[0])}>
              Add to playlist
            </button>
            <button type="button" className="ghost-button" onClick={() => void handleSuggestionDismiss(recommendations[0])}>
              Nah, not for me
            </button>
          </div>
        </section>
      ) : null}

      <SongDetailsDrawer
        track={selectedTrack}
        details={drawerDetails}
        queue={selectedQueue}
        queueIndex={selectedQueueIndex}
        loading={drawerLoading}
        error={drawerError}
        onClose={() => {
          setSelectedTrack(null);
          setSelectedQueue([]);
          setSelectedQueueIndex(-1);
          setDrawerDetails(null);
          setDrawerError("");
        }}
      />
    </section>
  );
}

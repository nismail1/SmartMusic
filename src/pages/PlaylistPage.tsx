import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { SongDetailsDrawer } from "../components/SongDetailsDrawer";
import { useAuth } from "../context/AuthContext";
import { geniusService } from "../services/genius";
import { computePlaylistAnalytics } from "../services/playlistAnalytics";
import { playbackController } from "../services/playback";
import { playlistService } from "../services/playlists";
import { recommendationService } from "../services/recommendations";
import { spotifyService } from "../services/spotify";
import type { GeniusEnrichment, PlaylistTrack, RecommendationItem, SpotifyTrack } from "../types/music";
import { formatDuration } from "../lib/format";

type SortKey = "addedAt" | "artist" | "releaseDate" | "durationMs";

export function PlaylistPage() {
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
  const [suggestionStatus, setSuggestionStatus] = useState("");
  const [sortBy, setSortBy] = useState<SortKey>("addedAt");
  const [activeGenreFilter, setActiveGenreFilter] = useState<string>("all");
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);

  useEffect(() => {
    setHasLoadedOnce(false);
    setPlaylistName("Playlist View");
  }, [playlistId]);

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
        void Promise.all(
          baseTracks.map(async (track) => ({
            ...track,
            genius: track.genius ?? (await geniusService.enrichTrack(track))
          }))
        ).then((withGenius) => {
          setTracks(withGenius);
        });
      } catch {
        setTracks([]);
        setRecommendations([]);
        setRecommendationError("Failed to load playlist data.");
        setLoading(false);
        return;
      }

      try {
        setRecommendations(await recommendationService.getRecommendations(playlistId));
      } catch {
        setRecommendations([]);
        setRecommendationError("Unable to load suggestions right now. Please try again in a moment.");
      } finally {
        setHasLoadedOnce(true);
        setLoading(false);
      }
    }
    void load();
  }, [playlistId, hasLoadedOnce]);

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
      const fullTrack = (await spotifyService.getTracksByIds([item.songId]))[0];
      const trackToAdd: SpotifyTrack = fullTrack ?? {
        id: item.songId,
        name: item.songName ?? item.songId,
        artists: item.artists ?? [],
        uri: `spotify:track:${item.songId}`,
        albumId: "",
        albumName: "",
        artworkUrl: item.artworkUrl ?? null,
        previewUrl: item.previewUrl ?? null,
        releaseDate: null,
        durationMs: 0
      };
      await playlistService.addTrack(playlistId, trackToAdd);
      setSuggestionStatus(`Added ${trackToAdd.name} to this playlist.`);
      setTracks((prev) => [...prev, { ...trackToAdd, addedAt: new Date().toISOString() }]);
    } catch {
      setSuggestionStatus("Could not add this suggestion right now.");
    }
  }

  async function handleSuggestionPlay(item: RecommendationItem) {
    try {
      // #region agent log
      fetch("http://127.0.0.1:7701/ingest/35369d23-7f37-4585-ac9a-076a3915746b", {
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
      const fullTrack = (await spotifyService.getTracksByIds([item.songId]))[0];
      // #region agent log
      fetch("http://127.0.0.1:7701/ingest/35369d23-7f37-4585-ac9a-076a3915746b", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "658713" },
        body: JSON.stringify({
          sessionId: "658713",
          runId: "suggestion-play-debug",
          hypothesisId: "H5",
          location: "src/pages/PlaylistPage.tsx:handleSuggestionPlay",
          message: "spotify track lookup result",
          data: fullTrack
            ? {
                found: true,
                trackId: fullTrack.id,
                releaseDate: fullTrack.releaseDate ?? null,
                durationMs: fullTrack.durationMs ?? null,
                previewUrl: fullTrack.previewUrl ?? null,
                uri: fullTrack.uri ?? null
              }
            : { found: false, requestedId: item.songId },
          timestamp: Date.now()
        })
      }).catch(() => {});
      // #endregion
      const track: SpotifyTrack = fullTrack ?? {
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
    } catch {
      // #region agent log
      fetch("http://127.0.0.1:7701/ingest/35369d23-7f37-4585-ac9a-076a3915746b", {
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
      const fullTrack = (await spotifyService.getTracksByIds([item.songId]))[0];
      const track: PlaylistTrack = fullTrack
        ? { ...fullTrack, addedAt: new Date().toISOString() }
        : {
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
      <div className="track-chart-wrap">
        <table className="track-chart">
          <thead>
            <tr>
              <th>Title</th>
              <th>Artist</th>
              <th>Album</th>
              <th>Duration</th>
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
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3>Suggestions</h3>
      {recommendationError ? <p className="error">{recommendationError}</p> : null}
      {suggestionStatus ? <p>{suggestionStatus}</p> : null}
      {!recommendationError && !recommendations.length ? <p style={{ color: "var(--color-muted)" }}>No suggestions yet.</p> : null}
      <ul className="suggestions-list">
        {recommendations.map((item) => (
          <li key={item.songId}>
            <button type="button" className="track-link-button" onClick={() => void handleSuggestionClick(item)}>
              <strong>{item.songName ?? item.songId}</strong>
              {item.artists?.length ? ` — ${item.artists.join(", ")}` : ""}
            </button>
            <div style={{ color: "var(--color-muted)", fontSize: "0.85rem" }}>
              {(item.releaseDate ?? "Unknown release")} | {formatDuration(Number(item.durationMs ?? 0))}
            </div>
            <div>{item.reasons?.[0] ?? "Picked to fit this playlist right now."}</div>
            <div className="actions" style={{ marginTop: 6 }}>
              <button type="button" onClick={() => void handleSuggestionPlay(item)}>
                Play preview
              </button>
              <button type="button" onClick={() => void handleSuggestionAdd(item)}>
                Add to playlist
              </button>
            </div>
          </li>
        ))}
      </ul>

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

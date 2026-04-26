import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { SongDetailsDrawer } from "../components/SongDetailsDrawer";
import { geniusService } from "../services/genius";
import { computePlaylistAnalytics } from "../services/playlistAnalytics";
import { playlistService } from "../services/playlists";
import { recommendationService } from "../services/recommendations";
import type { GeniusEnrichment, PlaylistTrack, RecommendationItem } from "../types/music";
import { formatDuration } from "../lib/format";

type SortKey = "addedAt" | "artist" | "releaseDate" | "durationMs";

export function PlaylistPage() {
  const { playlistId = "" } = useParams();
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
      <h2>{playlistName}</h2>
      {loading ? <p>Loading playlist...</p> : null}

      <h3>Overview</h3>
      <p>Total duration: {formatDuration(analytics.totalDurationMs)}</p>
      <p>Decades: {Object.entries(analytics.decadeBreakdown).map(([d, c]) => `${d} (${c})`).join(", ") || "None"}</p>
      <p>Genres: {Object.entries(analytics.genreComposition).map(([g, c]) => `${g} (${c})`).join(", ") || "None"}</p>

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
      {!recommendationError && !recommendations.length ? <p>No suggestions yet.</p> : null}
      <ul>
        {recommendations.map((item) => (
          <li key={item.songId}>
            <strong>{item.songName ?? item.songId}</strong>
            {item.artists?.length ? ` - ${item.artists.join(", ")}` : ""}
            <div>{item.reasons?.[0] ?? "Picked to fit this playlist right now."}</div>
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

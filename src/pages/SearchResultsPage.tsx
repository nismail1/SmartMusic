import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { SongDetailsDrawer } from "../components/SongDetailsDrawer";
import { playlistService } from "../services/playlists";
import { geniusService } from "../services/genius";
import { spotifyService } from "../services/spotify";
import { useAuth } from "../context/AuthContext";
import type { GeniusEnrichment, Playlist, SpotifyTrack } from "../types/music";
import { formatDuration } from "../lib/format";

export function SearchResultsPage() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const initialQuery = params.get("query") ?? "";
  const [queryText, setQueryText] = useState(initialQuery);
  const [results, setResults] = useState<SpotifyTrack[]>([]);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [selectedPlaylistId, setSelectedPlaylistId] = useState("");
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);
  const [selectedTrack, setSelectedTrack] = useState<SpotifyTrack | null>(null);
  const [drawerDetails, setDrawerDetails] = useState<GeniusEnrichment | null>(null);
  const [drawerLoading, setDrawerLoading] = useState(false);
  const [drawerError, setDrawerError] = useState("");

  useEffect(() => {
    if (!user) return;
    void playlistService.listPlaylists(user.uid).then((items) => {
      setPlaylists(items);
      if (items.length > 0) setSelectedPlaylistId(items[0].id);
    });
  }, [user]);

  useEffect(() => {
    if (!initialQuery.trim()) return;
    setLoading(true);
    void spotifyService
      .searchTracks(initialQuery)
      .then(setResults)
      .catch((err) => setStatus(err instanceof Error ? err.message : "Search failed"))
      .finally(() => setLoading(false));
  }, [initialQuery]);

  async function runSearch(e: React.FormEvent) {
    e.preventDefault();
    setParams({ query: queryText });
  }

  async function handleAdd(track: SpotifyTrack) {
    if (!selectedPlaylistId) {
      setStatus("Select a playlist first.");
      return;
    }
    await playlistService.addTrack(selectedPlaylistId, track);
    setStatus(`Added ${track.name}`);
  }

  async function handleRemove(track: SpotifyTrack) {
    if (!selectedPlaylistId) {
      setStatus("Select a playlist first.");
      return;
    }
    await playlistService.removeTrack(selectedPlaylistId, track.id);
    setStatus(`Removed ${track.name}`);
  }

  async function openSongDetails(track: SpotifyTrack) {
    setSelectedTrack(track);
    setDrawerLoading(true);
    setDrawerError("");
    setDrawerDetails(null);
    try {
      setDrawerDetails(await geniusService.enrichTrack(track));
    } catch {
      setDrawerError("Unable to load Genius details for this song.");
    } finally {
      setDrawerLoading(false);
    }
  }

  const hasResults = useMemo(() => results.length > 0, [results]);

  return (
    <section>
      <h2 className="page-title" style={{ fontSize: "1.75rem" }}>
        Search
      </h2>
      <div className="page-section" style={{ marginTop: 20, marginBottom: 20 }}>
        <form onSubmit={runSearch} className="form inline" style={{ marginBottom: 0 }}>
          <input value={queryText} onChange={(e) => setQueryText(e.target.value)} placeholder="Search Spotify tracks" />
          <button type="submit">Search</button>
        </form>
        <label style={{ display: "grid", gap: 8, marginTop: 16, fontSize: "0.9rem", fontWeight: 500 }}>
          Target playlist
          <select value={selectedPlaylistId} onChange={(e) => setSelectedPlaylistId(e.target.value)}>
            {playlists.map((playlist) => (
              <option key={playlist.id} value={playlist.id}>
                {playlist.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {status ? <p>{status}</p> : null}
      {loading ? <p>Searching Spotify...</p> : null}
      {!hasResults && !loading ? <p style={{ color: "var(--color-muted)" }}>No results yet.</p> : null}
      <ul className="track-list">
        {results.map((track) => (
          <li key={track.id}>
            <div className="track-row">
              <button type="button" className="track-card-button" onClick={() => void openSongDetails(track)}>
                <div>
                  <strong>{track.name}</strong> - {track.artists.join(", ")}
                  <div>
                    {track.releaseDate ?? "Unknown release"} | {formatDuration(track.durationMs)}
                  </div>
                  <div className="row-affordance">Click for Genius metadata and song analytics context</div>
                </div>
              </button>
              <div className="actions">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleAdd(track);
                  }}
                >
                  Add
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleRemove(track);
                  }}
                >
                  Remove
                </button>
              </div>
            </div>
          </li>
        ))}
      </ul>
      <SongDetailsDrawer
        track={selectedTrack}
        details={drawerDetails}
        loading={drawerLoading}
        error={drawerError}
        onClose={() => {
          setSelectedTrack(null);
          setDrawerDetails(null);
          setDrawerError("");
        }}
      />
    </section>
  );
}

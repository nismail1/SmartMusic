import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { SongDetailsDrawer } from "../components/SongDetailsDrawer";
import { playlistService } from "../services/playlists";
import { geniusService } from "../services/genius";
import { spotifyService } from "../services/spotify";
import { useAuth } from "../context/AuthContext";
import type { GeniusEnrichment, Playlist, SpotifyTrack } from "../types/music";
import { formatDuration } from "../lib/format";

function debugLog(location: string, message: string, data: Record<string, unknown>, hypothesisId: string, runId = "search-page-debug") {
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

const searchPageInFlightKeys = new Set<string>();

export function SearchResultsPage() {
  const { user, spotifySession } = useAuth();
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
    const searchKey = `${initialQuery.trim().toLowerCase()}::${user?.uid ?? "anon"}`;
    if (searchPageInFlightKeys.has(searchKey)) {
      debugLog(
        "src/pages/SearchResultsPage.tsx:useEffect",
        "duplicate in-flight search skipped",
        { initialQuery, searchKey },
        "H45"
      );
      return;
    }
    searchPageInFlightKeys.add(searchKey);
    debugLog(
      "src/pages/SearchResultsPage.tsx:useEffect",
      "search effect triggered",
      { initialQuery, hasUser: Boolean(user?.uid) },
      "H42"
    );
    setLoading(true);
    void (async () => {
      try {
        const spotifyResults = await spotifyService.searchTracks(
          initialQuery,
          "US",
          "search-page",
          spotifySession?.accessToken
        );
        if (spotifyResults.length > 0) {
          setResults(spotifyResults);
          setStatus("");
          return;
        }
        if (!user) {
          setResults([]);
          setStatus("Spotify is rate-limited right now. Try again in a moment.");
          return;
        }
        const userPlaylists = await playlistService.listPlaylists(user.uid);
        const importedMatches: SpotifyTrack[] = [];
        const seen = new Set<string>();
        const normalizedQuery = initialQuery.toLowerCase();
        for (const playlist of userPlaylists) {
          const tracks = await playlistService.listPlaylistTracks(playlist.id);
          for (const track of tracks) {
            if (seen.has(track.id)) continue;
            const haystack = `${track.name} ${track.artists.join(" ")} ${track.albumName}`.toLowerCase();
            if (!haystack.includes(normalizedQuery)) continue;
            importedMatches.push(track);
            seen.add(track.id);
          }
        }
        setResults(importedMatches);
        setStatus(
          importedMatches.length
            ? "Spotify is rate-limited, showing matches from your imported tracks."
            : "Spotify is rate-limited right now. Try again in a moment."
        );
      } catch (err) {
        setStatus(err instanceof Error ? err.message : "Search failed");
      } finally {
        searchPageInFlightKeys.delete(searchKey);
        setLoading(false);
      }
    })();
  }, [initialQuery, user, spotifySession?.accessToken]);

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

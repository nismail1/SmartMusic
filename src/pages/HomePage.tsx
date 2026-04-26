import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { authService } from "../services/auth";
import { playlistService } from "../services/playlists";
import { spotifyService, type SpotifyUserPlaylist } from "../services/spotify";
import type { Playlist } from "../types/music";

function debugLog(
  location: string,
  message: string,
  data: Record<string, unknown>,
  hypothesisId: string,
  runId = "spotify-import-debug"
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

export function HomePage() {
  const { user, authMode, spotifySession } = useAuth();
  const navigate = useNavigate();
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [spotifyPlaylists, setSpotifyPlaylists] = useState<SpotifyUserPlaylist[]>([]);
  const [selectedSpotifyPlaylistId, setSelectedSpotifyPlaylistId] = useState("");
  const [loadingSpotifyPlaylists, setLoadingSpotifyPlaylists] = useState(false);
  const [importingSpotify, setImportingSpotify] = useState(false);
  const [importStatus, setImportStatus] = useState("");
  const [spotifyImportBlockedReason, setSpotifyImportBlockedReason] = useState("");
  const [name, setName] = useState("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const spotifyUserId = spotifySession?.spotifyUserId ?? null;
  const importableSpotifyPlaylists = useMemo(
    () => spotifyPlaylists.filter((playlist) => !spotifyUserId || playlist.ownerId === spotifyUserId),
    [spotifyPlaylists, spotifyUserId]
  );

  useEffect(() => {
    async function run() {
      let ownerId = user?.uid ?? "";
      if (!ownerId && authMode === "spotify") {
        try {
          const firebaseUser = await authService.ensureFirestoreSession();
          ownerId = firebaseUser.uid;
          setSpotifyImportBlockedReason("");
          debugLog("src/pages/HomePage.tsx:run", "ensured firebase session for spotify mode", { ownerId }, "M36");
        } catch (err) {
          const message = err instanceof Error ? err.message : "Spotify import is blocked due to Firebase auth configuration.";
          setSpotifyImportBlockedReason(message);
          setError(message);
          debugLog("src/pages/HomePage.tsx:run", "failed to ensure firebase session", { message }, "M42");
          setLoading(false);
          return;
        }
      }
      if (!ownerId) return;
      setLoading(true);
      setError("");
      try {
        setPlaylists(await playlistService.listPlaylists(ownerId));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load playlists");
      } finally {
        setLoading(false);
      }
    }
    void run();
  }, [user?.uid, authMode]);

  useEffect(() => {
    async function loadSpotifyPlaylists() {
      if (authMode !== "spotify" || !spotifySession?.accessToken) {
        setSpotifyPlaylists([]);
        return;
      }
      setLoadingSpotifyPlaylists(true);
      setImportStatus("");
      try {
        const items = await spotifyService.listCurrentUserPlaylists(spotifySession.accessToken);
        setSpotifyPlaylists(items);
        const importable = items.filter((item) => !spotifyUserId || item.ownerId === spotifyUserId);
        setSelectedSpotifyPlaylistId((current) =>
          current && importable.some((item) => item.id === current) ? current : importable[0]?.id ?? ""
        );
      } catch (err) {
        setImportStatus(err instanceof Error ? err.message : "Failed to load Spotify playlists.");
      } finally {
        setLoadingSpotifyPlaylists(false);
      }
    }
    void loadSpotifyPlaylists();
  }, [authMode, spotifySession?.accessToken, spotifyUserId]);

  async function handleCreatePlaylist(e: React.FormEvent) {
    e.preventDefault();
    let ownerId = user?.uid ?? "";
    if (!ownerId) {
      try {
        ownerId = (await authService.ensureFirestoreSession()).uid;
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unable to create playlist.");
        return;
      }
    }
    if (!ownerId || !name.trim()) return;
    const id = await playlistService.createPlaylist(ownerId, name.trim());
    setName("");
    navigate(`/playlists/${id}`);
  }

  async function importSpotifyPlaylists() {
    if (!spotifySession?.accessToken) return;
    if (!selectedSpotifyPlaylistId) {
      setImportStatus("Select one Spotify playlist to import.");
      return;
    }
    let ownerId = user?.uid ?? "";
    if (!ownerId) {
      try {
        ownerId = (await authService.ensureFirestoreSession()).uid;
      } catch (err) {
        const message = err instanceof Error ? err.message : "Spotify import is blocked due to Firebase auth configuration.";
        setImportStatus(message);
        debugLog("src/pages/HomePage.tsx:importSpotifyPlaylists", "blocked before import due to firebase auth session failure", { message }, "M42");
        return;
      }
    }
    setImportingSpotify(true);
    setImportStatus("");
    let importedPlaylists = 0;
    let importedTracks = 0;
    const selectedPlaylist = spotifyPlaylists.find((playlist) => playlist.id === selectedSpotifyPlaylistId);
    debugLog(
      "src/pages/HomePage.tsx:importSpotifyPlaylists",
      "import started",
      {
        authMode,
        hasFirebaseUser: Boolean(user),
        ownerId,
        spotifyPlaylistCount: spotifyPlaylists.length,
        selectedSpotifyPlaylistId,
        selectedPlaylistMeta: selectedPlaylist
          ? {
              ownerId: selectedPlaylist.ownerId,
              public: selectedPlaylist.public,
              collaborative: selectedPlaylist.collaborative,
              hasTracksHref: Boolean(selectedPlaylist.tracksHref),
              hasItemsHref: Boolean(selectedPlaylist.itemsHref)
            }
          : null,
        spotifyTokenScope: spotifySession?.scope ?? null
      },
      "M31"
    );
    try {
      const sourcePlaylist =
        selectedPlaylist ??
        (await spotifyService.listCurrentUserPlaylists(spotifySession.accessToken)).find(
          (playlist) => playlist.id === selectedSpotifyPlaylistId
        );
      if (!sourcePlaylist) {
        throw new Error("Selected Spotify playlist was not found.");
      }
      if (spotifyUserId && sourcePlaylist.ownerId !== spotifyUserId) {
        const message = "This Spotify playlist is not owned by your account and cannot be imported due to Spotify access restrictions.";
        debugLog(
          "src/pages/HomePage.tsx:importSpotifyPlaylists",
          "blocked import due to playlist ownership mismatch",
          { selectedSpotifyPlaylistId, spotifyUserId, playlistOwnerId: sourcePlaylist.ownerId },
          "M56"
        );
        setImportStatus(message);
        return;
      }
      debugLog(
        "src/pages/HomePage.tsx:importSpotifyPlaylists",
        "creating playlist",
        { sourcePlaylistId: sourcePlaylist.id, sourcePlaylistName: sourcePlaylist.name, ownerId },
        "M32"
      );
      const tracks = await spotifyService.listSpotifyPlaylistTracks(
        spotifySession.accessToken,
        sourcePlaylist.id,
        sourcePlaylist.tracksHref,
        sourcePlaylist.itemsHref
      );
      if (sourcePlaylist.trackCount > 0 && tracks.length === 0) {
        const message =
          "Spotify returned this playlist but did not permit reading its track items for this app/token. Try another playlist.";
        debugLog(
          "src/pages/HomePage.tsx:importSpotifyPlaylists",
          "blocked import due to zero readable tracks despite non-empty playlist",
          {
            sourcePlaylistId: sourcePlaylist.id,
            declaredTrackCount: sourcePlaylist.trackCount,
            fetchedTrackCount: tracks.length
          },
          "M59"
        );
        setImportStatus(message);
        return;
      }
      const newPlaylistId = await playlistService.createPlaylist(ownerId, sourcePlaylist.name);
      importedPlaylists += 1;
      debugLog(
        "src/pages/HomePage.tsx:importSpotifyPlaylists",
        "playlist tracks fetched",
        { sourcePlaylistId: sourcePlaylist.id, fetchedTrackCount: tracks.length, createdPlaylistId: newPlaylistId },
        "M33"
      );
      for (const track of tracks) {
        await playlistService.addTrack(newPlaylistId, track);
        importedTracks += 1;
      }
      setPlaylists(await playlistService.listPlaylists(ownerId));
      setImportStatus(`Imported "${sourcePlaylist.name}" with ${importedTracks} tracks.`);
      debugLog(
        "src/pages/HomePage.tsx:importSpotifyPlaylists",
        "import completed",
        { importedPlaylists, importedTracks },
        "M34"
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Spotify import failed.";
      if (message.includes("Reconnect Spotify")) {
        setImportStatus(`${message} Use Log out, then Continue with Spotify again.`);
      } else {
        setImportStatus(message);
      }
      debugLog(
        "src/pages/HomePage.tsx:importSpotifyPlaylists",
        "import failed",
        {
          errorMessage: message,
          errorCode: err && typeof err === "object" && "code" in err ? String((err as { code?: unknown }).code) : null,
          importedPlaylists,
          importedTracks
        },
        "M35"
      );
    } finally {
      setImportingSpotify(false);
    }
  }

  const filtered = useMemo(() => {
    if (!search.trim()) return playlists;
    return playlists.filter((p) => p.name.toLowerCase().includes(search.toLowerCase()));
  }, [playlists, search]);

  return (
    <section>
      <h2>Home</h2>
      {authMode === "spotify" ? (
        <section>
          <h3>Import from Spotify</h3>
          {loadingSpotifyPlaylists ? <p>Loading Spotify playlists...</p> : null}
          {!loadingSpotifyPlaylists ? <p>Found {spotifyPlaylists.length} playlists in your Spotify account.</p> : null}
          {spotifyUserId ? (
            <p>
              Importable playlists you own: {importableSpotifyPlaylists.length} of {spotifyPlaylists.length}
            </p>
          ) : null}
          <label>
            Choose Spotify playlist
            <select
              value={selectedSpotifyPlaylistId}
              onChange={(e) => setSelectedSpotifyPlaylistId(e.target.value)}
              disabled={loadingSpotifyPlaylists || importingSpotify || importableSpotifyPlaylists.length === 0}
            >
              {importableSpotifyPlaylists.map((playlist) => (
                <option key={playlist.id} value={playlist.id}>
                  {playlist.name} ({playlist.trackCount})
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() => void importSpotifyPlaylists()}
            disabled={importingSpotify || !selectedSpotifyPlaylistId || Boolean(spotifyImportBlockedReason)}
          >
            {importingSpotify ? "Importing..." : "Import selected Spotify playlist"}
          </button>
          {spotifyImportBlockedReason ? <p className="error">{spotifyImportBlockedReason}</p> : null}
          {importStatus ? <p>{importStatus}</p> : null}
        </section>
      ) : null}
      <form onSubmit={handleCreatePlaylist} className="form inline">
        <input
          placeholder="New playlist name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label="New playlist name"
        />
        <button type="submit">Create Playlist</button>
      </form>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          navigate(`/search?query=${encodeURIComponent(search)}`);
        }}
        className="form inline"
      >
        <input
          placeholder="Search songs in Spotify"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search songs"
        />
        <button type="submit">Search</button>
      </form>

      <h3>Your Playlists</h3>
      {loading ? <p>Loading playlists...</p> : null}
      {error ? <p className="error">{error}</p> : null}
      <ul>
        {filtered.map((playlist) => (
          <li key={playlist.id}>
            <Link to={`/playlists/${playlist.id}`}>{playlist.name}</Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

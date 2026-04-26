import { useEffect } from "react";
import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { FloatingPlayer } from "./FloatingPlayer";

export function AppLayout() {
  const { isAuthenticated, authMode, spotifyDisplayName, logoutAll } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    // #region agent log
    fetch("http://127.0.0.1:7701/ingest/35369d23-7f37-4585-ac9a-076a3915746b", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "658713" },
      body: JSON.stringify({
        sessionId: "658713",
        runId: "playback-debug",
        hypothesisId: "H8",
        location: "src/components/AppLayout.tsx:useEffect",
        message: "route changed in app layout",
        data: { pathname: location.pathname },
        timestamp: Date.now()
      })
    }).catch(() => {});
    // #endregion
  }, [location.pathname]);

  async function handleLogout() {
    await logoutAll();
    navigate("/login");
  }

  return (
    <div className="app-shell">
      <header className="header">
        <h1>SmartMusic</h1>
        <nav>
          <Link to="/home">Home</Link>
        </nav>
        {authMode === "spotify" && spotifyDisplayName ? <span>Spotify: {spotifyDisplayName}</span> : null}
        {isAuthenticated ? <button onClick={handleLogout}>Log out</button> : null}
      </header>
      <main>
        <Outlet />
      </main>
      <FloatingPlayer />
    </div>
  );
}

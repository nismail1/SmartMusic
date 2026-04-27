import { useEffect, useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { FloatingPlayer } from "./FloatingPlayer";

function useRetroClock(): { label: string; iso: string } {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(t);
  }, []);
  const wk = new Intl.DateTimeFormat("en-GB", { weekday: "short" }).format(now);
  const d = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric" }).format(now);
  const time = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false }).format(now);
  return { label: `${wk} ${d} | ${time}`, iso: now.toISOString() };
}

export function AppLayout() {
  const { isAuthenticated, authMode, spotifyDisplayName, logoutAll } = useAuth();
  const navigate = useNavigate();
  const { label: clockLabel, iso: clockIso } = useRetroClock();

  async function handleLogout() {
    await logoutAll();
    navigate("/login");
  }

  return (
    <div className="app-frame">
      <header className="app-top">
        <h1 className="app-top__brand">SmartMusic</h1>
        <div className="app-top__meta">
          <time dateTime={clockIso}>{clockLabel}</time>
          {authMode === "spotify" && spotifyDisplayName ? <span className="app-top__user">Spotify: {spotifyDisplayName}</span> : null}
          {isAuthenticated ? (
            <button type="button" className="btn-primary" onClick={() => void handleLogout()}>
              Log out
            </button>
          ) : null}
        </div>
      </header>
      <div className="app-body">
        <aside className="app-sidebar">
          <div className="app-sidebar__section">Navigate</div>
          <nav className="app-nav" aria-label="Main">
            <NavLink
              to="/home"
              end
              className={({ isActive }) => (isActive ? "app-nav__link active" : "app-nav__link")}
            >
              Home
            </NavLink>
            <NavLink to="/search" className={({ isActive }) => (isActive ? "app-nav__link active" : "app-nav__link")}>
              Search
            </NavLink>
          </nav>
        </aside>
        <div className="app-main">
          <div className="app-main__inner">
            <Outlet />
          </div>
        </div>
      </div>
      <FloatingPlayer />
    </div>
  );
}

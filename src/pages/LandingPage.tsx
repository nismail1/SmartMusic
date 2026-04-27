import { Link } from "react-router-dom";

export function LandingPage() {
  return (
    <div className="page-public">
      <div className="page-public__card">
        <h1 className="page-lede" style={{ marginTop: 0 }}>
          Build smarter playlists
        </h1>
        <p>Search tracks, curate playlists, and discover what should play next — with Spotify and AI-assisted suggestions.</p>
        <div className="page-public__actions">
          <Link to="/create-account" className="btn-primary" style={{ textAlign: "center", display: "block" }}>
            Create account
          </Link>
          <Link to="/login" className="btn-secondary">
            Log in
          </Link>
        </div>
      </div>
    </div>
  );
}

import { Link } from "react-router-dom";

export function LandingPage() {
  return (
    <section>
      <h2>Build smarter playlists with Spotify + AI insights</h2>
      <p>Search tracks, curate playlists, and discover what should play next.</p>
      <div className="actions">
        <Link to="/create-account">Create Account</Link>
        <Link to="/login">Log In</Link>
      </div>
    </section>
  );
}

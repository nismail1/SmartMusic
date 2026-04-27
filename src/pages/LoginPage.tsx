import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { authService } from "../services/auth";

export function LoginPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    try {
      await authService.login(email, password);
      navigate("/home");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to login");
    }
  }

  async function handleSpotifyLogin() {
    setError("");
    try {
      await authService.startSpotifyLogin();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start Spotify login.");
    }
  }

  return (
    <div className="page-public">
      <div className="page-public__card">
        <h1 className="page-lede" style={{ marginTop: 0 }}>
          Log in
        </h1>
        <form onSubmit={handleSubmit} className="form">
          <label>
            Email
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
          </label>
          <label>
            Password
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" />
          </label>
          {error ? <p className="error">{error}</p> : null}
          <div className="page-public__actions">
            <button type="submit" className="btn-primary">
              Log in
            </button>
            <button type="button" onClick={() => void handleSpotifyLogin()}>
              Continue with Spotify
            </button>
          </div>
        </form>
        <p style={{ marginBottom: 0, marginTop: 16, fontSize: "0.9rem" }}>
          Need an account? <Link to="/create-account">Create one</Link>
        </p>
      </div>
    </div>
  );
}

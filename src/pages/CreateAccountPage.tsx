import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { authService } from "../services/auth";

export function CreateAccountPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    try {
      await authService.signup(email, password);
      navigate("/home");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create account");
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
          Create account
        </h1>
        <form onSubmit={handleSubmit} className="form">
          <label>
            Email
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
          </label>
          <label>
            Password
            <input
              type="password"
              value={password}
              minLength={8}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="new-password"
            />
          </label>
          {error ? <p className="error">{error}</p> : null}
          <div className="page-public__actions">
            <button type="submit" className="btn-primary">
              Create account
            </button>
            <button type="button" onClick={() => void handleSpotifyLogin()}>
              Continue with Spotify
            </button>
          </div>
        </form>
        <p style={{ marginBottom: 0, marginTop: 16, fontSize: "0.9rem" }}>
          Already have an account? <Link to="/login">Log in</Link>
        </p>
      </div>
    </div>
  );
}

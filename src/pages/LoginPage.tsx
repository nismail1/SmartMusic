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
    <section>
      <h2>Log In</h2>
      <form onSubmit={handleSubmit} className="form">
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {error ? <p className="error">{error}</p> : null}
        <button type="submit">Log In</button>
        <button type="button" onClick={() => void handleSpotifyLogin()}>
          Continue with Spotify
        </button>
      </form>
      <p>
        Need an account? <Link to="/create-account">Create one</Link>
      </p>
    </section>
  );
}

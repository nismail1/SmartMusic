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
    <section>
      <h2>Create Account</h2>
      <form onSubmit={handleSubmit} className="form">
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            minLength={8}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        {error ? <p className="error">{error}</p> : null}
        <button type="submit">Create Account</button>
        <button type="button" onClick={() => void handleSpotifyLogin()}>
          Continue with Spotify
        </button>
      </form>
      <p>
        Already have an account? <Link to="/login">Log in</Link>
      </p>
    </section>
  );
}

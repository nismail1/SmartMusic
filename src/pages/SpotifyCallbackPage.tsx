import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { authService } from "../services/auth";
import { useAuth } from "../context/AuthContext";

export function SpotifyCallbackPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { refreshSpotifySession } = useAuth();
  const [error, setError] = useState("");

  useEffect(() => {
    async function run() {
      const authError = params.get("error");
      const code = params.get("code");
      const state = params.get("state");
      if (authError) {
        setError("Spotify sign-in was denied.");
        return;
      }
      if (!code || !state) {
        setError("Spotify sign-in callback is missing required parameters.");
        return;
      }
      try {
        const session = await authService.handleSpotifyCallback(code, state);
        await authService.signInWithSpotifyForFirestore(session.accessToken);
        await refreshSpotifySession();
        navigate("/home", { replace: true });
      } catch (err) {
        setError(err instanceof Error ? err.message : "Spotify sign-in failed.");
      }
    }
    void run();
  }, [params, navigate, refreshSpotifySession]);

  return (
    <div className="page-public">
      <div className="page-public__card">
        <h1 className="page-lede" style={{ marginTop: 0 }}>
          Connecting Spotify
        </h1>
        {error ? <p className="error">{error}</p> : <p>Finalizing sign-in…</p>}
      </div>
    </div>
  );
}

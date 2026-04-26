import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { User } from "firebase/auth";
import { authService, type SpotifySession } from "../services/auth";
import { spotifyService } from "../services/spotify";

interface AuthContextValue {
  user: User | null;
  spotifySession: SpotifySession | null;
  authMode: "firebase" | "spotify" | "none";
  effectiveUserId: string | null;
  spotifyDisplayName: string | null;
  isAuthenticated: boolean;
  loading: boolean;
  refreshSpotifySession: () => Promise<void>;
  logoutAll: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  spotifySession: null,
  authMode: "none",
  effectiveUserId: null,
  spotifyDisplayName: null,
  isAuthenticated: false,
  loading: true,
  refreshSpotifySession: async () => {},
  logoutAll: async () => {}
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [spotifySession, setSpotifySession] = useState<SpotifySession | null>(authService.getSpotifySession());
  const [loading, setLoading] = useState(true);

  async function refreshSpotifySession() {
    const existing = authService.getSpotifySession();
    if (!existing?.accessToken) {
      setSpotifySession(null);
      return;
    }
    try {
      const profile = await spotifyService.getCurrentUserProfile(existing.accessToken);
      const nextSession: SpotifySession = {
        ...existing,
        spotifyUserId: profile.id,
        spotifyDisplayName: profile.displayName
      };
      authService.setSpotifySession(nextSession);
      setSpotifySession(nextSession);
    } catch {
      authService.setSpotifySession(null);
      setSpotifySession(null);
    }
  }

  async function logoutAll() {
    try {
      if (user) await authService.logout();
    } catch {
      // best effort
    }
    authService.logoutSpotify();
    setSpotifySession(null);
  }

  useEffect(() => {
    void refreshSpotifySession();
    const unsub = authService.subscribe((nextUser) => {
      setUser(nextUser);
      setLoading(false);
    });
    return unsub;
  }, []);

  const authMode: AuthContextValue["authMode"] = spotifySession ? "spotify" : user ? "firebase" : "none";
  const effectiveUserId = user?.uid ?? (spotifySession?.spotifyUserId ? `spotify:${spotifySession.spotifyUserId}` : null);
  const spotifyDisplayName = spotifySession?.spotifyDisplayName ?? null;
  const isAuthenticated = Boolean(user || spotifySession);
  const value = useMemo(
    () => ({
      user,
      spotifySession,
      authMode,
      effectiveUserId,
      spotifyDisplayName,
      isAuthenticated,
      loading,
      refreshSpotifySession,
      logoutAll
    }),
    [user, spotifySession, authMode, effectiveUserId, spotifyDisplayName, isAuthenticated, loading]
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}

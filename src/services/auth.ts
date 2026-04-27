import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInAnonymously,
  signInWithCustomToken,
  signInWithEmailAndPassword,
  signOut,
  type User
} from "firebase/auth";
import { auth } from "./firebase";

const SPOTIFY_AUTHORIZE_URL = "https://accounts.spotify.com/authorize";
const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";
const SPOTIFY_SESSION_KEY = "smartmusic.spotify.session";
const SPOTIFY_STATE_KEY = "smartmusic.spotify.state";
const SPOTIFY_VERIFIER_KEY = "smartmusic.spotify.verifier";

function debugLog(
  location: string,
  message: string,
  data: Record<string, unknown>,
  hypothesisId: string,
  runId = "spotify-auth-debug"
) {
  // #region agent log
  fetch("http://127.0.0.1:7701/ingest/35369d23-7f37-4585-ac9a-076a3915746b", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "658713" },
    body: JSON.stringify({
      sessionId: "658713",
      runId,
      hypothesisId,
      location,
      message,
      data,
      timestamp: Date.now()
    })
  }).catch(() => {});
  // #endregion
}

function isAdminRestrictedError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && String((error as { code?: unknown }).code) === "auth/admin-restricted-operation");
}

export interface SpotifySession {
  accessToken: string;
  tokenType: string;
  expiresAt: number;
  scope?: string;
  refreshToken?: string;
  spotifyUserId?: string;
  spotifyDisplayName?: string;
}

function getSpotifyClientId(): string {
  return import.meta.env.VITE_SPOTIFY_CLIENT_ID ?? "";
}

function getSpotifyRedirectUri(): string {
  return import.meta.env.VITE_SPOTIFY_REDIRECT_URI ?? `${window.location.origin}/auth/spotify/callback`;
}

/** Web Playback + /me/player require these; merged into env/default so a stale VITE_SPOTIFY_SCOPES cannot omit them. */
const REQUIRED_SPOTIFY_SCOPES = [
  "streaming",
  "user-read-playback-state",
  "user-modify-playback-state"
] as const;

function mergeSpotifyScopes(configured: string): string {
  const set = new Set<string>();
  for (const s of configured.split(/\s+/).map((p) => p.trim()).filter(Boolean)) set.add(s);
  for (const s of REQUIRED_SPOTIFY_SCOPES) set.add(s);
  return Array.from(set).join(" ");
}

function getSpotifyScopes(): string {
  const base =
    import.meta.env.VITE_SPOTIFY_SCOPES ??
    "user-read-email user-read-private playlist-read-private playlist-read-collaborative streaming user-read-playback-state user-modify-playback-state";
  return mergeSpotifyScopes(String(base));
}

function generateRandomString(length: number): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

async function createCodeChallenge(codeVerifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier));
  const base64 = btoa(String.fromCharCode(...new Uint8Array(digest)));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function readSpotifySession(): SpotifySession | null {
  const raw = window.localStorage.getItem(SPOTIFY_SESSION_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as SpotifySession;
    if (!parsed.accessToken || !parsed.expiresAt || parsed.expiresAt <= Date.now()) {
      window.localStorage.removeItem(SPOTIFY_SESSION_KEY);
      return null;
    }
    return parsed;
  } catch {
    window.localStorage.removeItem(SPOTIFY_SESSION_KEY);
    return null;
  }
}

function writeSpotifySession(session: SpotifySession | null) {
  if (!session) {
    window.localStorage.removeItem(SPOTIFY_SESSION_KEY);
    return;
  }
  window.localStorage.setItem(SPOTIFY_SESSION_KEY, JSON.stringify(session));
}

export const authService = {
  async signup(email: string, password: string) {
    try {
      const credential = await createUserWithEmailAndPassword(auth, email, password);
      return credential;
    } catch (error) {
      throw error;
    }
  },
  login(email: string, password: string) {
    return signInWithEmailAndPassword(auth, email, password);
  },
  logout() {
    return signOut(auth);
  },
  getSpotifySession() {
    return readSpotifySession();
  },
  setSpotifySession(session: SpotifySession | null) {
    writeSpotifySession(session);
  },
  async startSpotifyLogin() {
    const clientId = getSpotifyClientId();
    if (!clientId) {
      throw new Error("Missing Spotify client ID.");
    }
    const state = generateRandomString(16);
    const verifier = generateRandomString(64);
    const challenge = await createCodeChallenge(verifier);
    window.sessionStorage.setItem(SPOTIFY_STATE_KEY, state);
    window.sessionStorage.setItem(SPOTIFY_VERIFIER_KEY, verifier);

    const scope = getSpotifyScopes();
    debugLog("src/services/auth.ts:startSpotifyLogin", "authorize request scopes prepared", { hasStreaming: scope.includes("streaming"), hasModifyPlayback: scope.includes("user-modify-playback-state") }, "H6");
    const params = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: getSpotifyRedirectUri(),
      scope,
      state,
      code_challenge_method: "S256",
      code_challenge: challenge
    });
    window.location.assign(`${SPOTIFY_AUTHORIZE_URL}?${params.toString()}`);
  },
  async handleSpotifyCallback(code: string, state: string) {
    const expectedState = window.sessionStorage.getItem(SPOTIFY_STATE_KEY);
    const verifier = window.sessionStorage.getItem(SPOTIFY_VERIFIER_KEY);
    window.sessionStorage.removeItem(SPOTIFY_STATE_KEY);
    window.sessionStorage.removeItem(SPOTIFY_VERIFIER_KEY);
    if (!expectedState || state !== expectedState || !verifier) {
      throw new Error("Spotify sign-in validation failed. Please try again.");
    }

    const clientId = getSpotifyClientId();
    if (!clientId) {
      throw new Error("Missing Spotify client ID.");
    }

    const tokenResponse = await fetch(SPOTIFY_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: getSpotifyRedirectUri(),
        client_id: clientId,
        code_verifier: verifier
      }).toString()
    });

    if (!tokenResponse.ok) {
      throw new Error("Failed to complete Spotify sign-in.");
    }

    const tokenPayload = (await tokenResponse.json()) as {
      access_token: string;
      token_type: string;
      expires_in: number;
      scope?: string;
      refresh_token?: string;
    };
    debugLog(
      "src/services/auth.ts:handleSpotifyCallback",
      "spotify token exchange succeeded",
      { hasScope: Boolean(tokenPayload.scope), scope: tokenPayload.scope ?? null },
      "M54"
    );
    const session: SpotifySession = {
      accessToken: tokenPayload.access_token,
      tokenType: tokenPayload.token_type ?? "Bearer",
      expiresAt: Date.now() + Math.max(0, tokenPayload.expires_in - 30) * 1000,
      scope: tokenPayload.scope ?? getSpotifyScopes(),
      refreshToken: tokenPayload.refresh_token
    };
    writeSpotifySession(session);
    return session;
  },
  /**
   * Stable Firebase user for Spotify: custom token (uid `spotify_{id}`) from Cloud Function
   * when VITE_SPOTIFY_FIREBASE_SESSION_URL is set; otherwise anonymous (legacy, not stable across re-OAuth).
   */
  async signInWithSpotifyForFirestore(accessToken: string): Promise<User> {
    await auth.authStateReady();
    if (auth.currentUser?.uid?.startsWith("spotify_")) {
      debugLog(
        "src/services/auth.ts:signInWithSpotifyForFirestore",
        "reusing existing spotify-linked firebase user",
        { uid: auth.currentUser.uid },
        "H6"
      );
      return auth.currentUser;
    }
    const url = (import.meta.env.VITE_SPOTIFY_FIREBASE_SESSION_URL ?? "").trim();
    if (!url) {
      debugLog("src/services/auth.ts:signInWithSpotifyForFirestore", "no VITE_SPOTIFY_FIREBASE_SESSION_URL, using anonymous", {}, "H5");
      return this.ensureFirestoreSession();
    }
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accessToken })
    });
    if (!res.ok) {
      let text = await res.text();
      try {
        const j = JSON.parse(text) as { error?: string; detail?: string };
        if (j?.detail) text = `${j.error ?? "Error"}: ${j.detail}`;
        else if (j?.error) text = j.error;
      } catch {
        /* use raw text */
      }
      throw new Error(
        `Could not link your Firebase account to Spotify (${res.status}). ${text || res.statusText} Use the Function URL from deploy (often *.run.app), deploy createSpotifyFirebaseSession, and set VITE_SPOTIFY_FIREBASE_SESSION_URL.`
      );
    }
    const data = (await res.json()) as { customToken?: string };
    if (!data.customToken) {
      throw new Error("Spotify session endpoint returned no customToken.");
    }
    const cred = await signInWithCustomToken(auth, data.customToken);
    debugLog("src/services/auth.ts:signInWithSpotifyForFirestore", "custom token sign-in", { uid: cred.user.uid }, "H6");
    return cred.user;
  },
  async ensureFirestoreSession() {
    const preReady = { hasUser: Boolean(auth.currentUser), uid: auth.currentUser?.uid ?? null };
    debugLog("src/services/auth.ts:ensureFirestoreSession", "pre authStateReady", { ...preReady }, "H1");
    await auth.authStateReady();
    const afterReady = { hasUser: Boolean(auth.currentUser), uid: auth.currentUser?.uid ?? null };
    debugLog("src/services/auth.ts:ensureFirestoreSession", "post authStateReady", { ...afterReady, raceFixed: preReady.hasUser === false && afterReady.hasUser === true }, "H1");
    if (auth.currentUser) {
      debugLog("src/services/auth.ts:ensureFirestoreSession", "reused existing firebase user", { uid: auth.currentUser.uid }, "M40");
      return auth.currentUser;
    }
    try {
      const credential = await signInAnonymously(auth);
      debugLog("src/services/auth.ts:ensureFirestoreSession", "anonymous sign-in succeeded", { uid: credential.user.uid }, "M40");
      return credential.user;
    } catch (error) {
      const errorCode = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "unknown";
      debugLog("src/services/auth.ts:ensureFirestoreSession", "anonymous sign-in failed", { errorCode }, "M41");
      if (isAdminRestrictedError(error)) {
        throw new Error(
          "Firebase Anonymous sign-in is disabled. Enable it in Firebase Console: Authentication -> Sign-in method -> Anonymous."
        );
      }
      throw error;
    }
  },
  logoutSpotify() {
    writeSpotifySession(null);
  },
  subscribe(cb: (user: User | null) => void) {
    return onAuthStateChanged(auth, cb);
  }
};

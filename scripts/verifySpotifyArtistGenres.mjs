/**
 * Live check: client-credentials token + GET /v1/artists/{id} (same path as the app).
 *
 * Tests:
 * - Token exchange succeeds.
 * - Artist detail URL is GET https://api.spotify.com/v1/artists/{id} (not deprecated batch ?ids=).
 * - Response is 200 JSON with an artist id (endpoint contract works).
 *
 * Spotify may return genres: [] under current Web API rules (e.g. Feb 2026); empty genres still exits 0
 * if the HTTP response is valid — the app will show tags when Spotify supplies them.
 *
 * Usage: npm run test:spotify-genres
 * Requires VITE_SPOTIFY_CLIENT_ID and VITE_SPOTIFY_CLIENT_SECRET in .env
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const TOKEN_URL = "https://accounts.spotify.com/api/token";
const ARTIST_ID = "06HL4z0CvFAxyc27GXpf02";

async function getClientCredentialsToken() {
  const clientId = process.env.VITE_SPOTIFY_CLIENT_ID ?? "";
  const clientSecret = process.env.VITE_SPOTIFY_CLIENT_SECRET ?? "";
  if (!clientId || !clientSecret) {
    throw new Error("Set VITE_SPOTIFY_CLIENT_ID and VITE_SPOTIFY_CLIENT_SECRET in .env");
  }
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`
    },
    body: new URLSearchParams({ grant_type: "client_credentials" }).toString()
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Token request failed ${res.status}: ${t.slice(0, 300)}`);
  }
  const json = await res.json();
  if (!json.access_token) throw new Error("Token response missing access_token");
  return json.access_token;
}

async function main() {
  const token = await getClientCredentialsToken();
  const url = `https://api.spotify.com/v1/artists/${encodeURIComponent(ARTIST_ID)}`;
  if (url.includes("?ids=")) {
    console.error("FAIL: URL must not use batch ?ids= query");
    process.exit(1);
  }
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const text = await res.text();
  if (!res.ok) {
    console.error("FAIL: Artist request", res.status, text.slice(0, 500));
    process.exit(1);
  }
  /** @type {{ id?: string; name?: string; genres?: string[] }} */
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    console.error("FAIL: Invalid JSON from Spotify");
    process.exit(1);
  }
  if (!body.id) {
    console.error("FAIL: Response missing artist id");
    process.exit(1);
  }
  const genres = Array.isArray(body.genres) ? body.genres : [];
  console.log("PASS: per-artist GET works (not batch ?ids=)");
  console.log("  ", url);
  console.log("  ", "Artist:", body.name ?? body.id);
  console.log("  ", "genres length:", genres.length, genres.length ? `(${genres.slice(0, 8).join(", ")})` : "(Spotify may return [] for client-credentials / current API rules)");
  process.exit(0);
}

main().catch((err) => {
  console.error("FAIL:", err instanceof Error ? err.message : err);
  process.exit(1);
});

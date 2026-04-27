const { onRequest } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

/** Gen2 default runtime is often the Compute SA; custom tokens require signBlob. Run as App Engine default. */
function getAppspotServiceAccount() {
  const projectId = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || admin.app().options?.projectId;
  return projectId ? `${String(projectId)}@appspot.gserviceaccount.com` : undefined;
}

function normalizeMap(values) {
  const entries = Array.from(values.entries());
  const max = Math.max(0, ...entries.map(([, value]) => value));
  if (max <= 0) return values;
  return new Map(entries.map(([key, value]) => [key, value / max]));
}

function scoreCandidate({ playlistSimilarity, searchSimilarity, globalEngagement, recencyAffinity }) {
  return (
    0.45 * playlistSimilarity +
    0.2 * searchSimilarity +
    0.2 * globalEngagement +
    0.05 * recencyAffinity
  );
}

function buildReasons({ playlistSimilarity, searchSimilarity, globalEngagement, isTopUp }) {
  if (isTopUp) return ["A popular pick to keep your playlist momentum going."];
  if (playlistSimilarity >= searchSimilarity && playlistSimilarity >= globalEngagement) {
    return ["Fits the vibe of songs already in your playlist."];
  }
  if (searchSimilarity >= globalEngagement) {
    return ["Matches what listeners often explore around your tracks."];
  }
  return ["Popular with steady replay value right now."];
}

function computePopularSafeScore(stats) {
  const plays = Number(stats?.playCount || 0);
  const skips = Number(stats?.skipCount || 0);
  const adds = Number(stats?.addToPlaylistCount || 0);
  const engagement = Math.max(0, (plays + adds - skips) / Math.max(1, plays + adds + skips));
  const popularity = Math.min(1, Math.log10(plays + 1) / 5);
  return 0.7 * engagement + 0.3 * popularity;
}

function normalizeText(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
}

function simplifyTrackName(trackName) {
  return String(trackName || "")
    .replace(/\((feat|featuring|with|remix|live)[^)]+\)/gi, "")
    .replace(/\[(feat|featuring|with|remix|live)[^\]]+\]/gi, "")
    .replace(/- (feat|featuring|with|remix|live).*/gi, "")
    .trim();
}

function buildGeniusQueries(trackName, artistName) {
  const simplified = simplifyTrackName(trackName);
  const base = `${trackName} ${artistName}`.trim();
  const simple = `${simplified} ${artistName}`.trim();
  const trackOnly = `${trackName}`.trim();
  const simpleOnly = `${simplified}`.trim();
  return Array.from(new Set([base, simple, trackOnly, simpleOnly].filter(Boolean)));
}

function computeConfidence(hit, trackName, artistName) {
  const titleMatch = normalizeText(hit?.title) === normalizeText(trackName);
  const artistMatch = normalizeText(hit?.primary_artist?.name) === normalizeText(artistName);
  return titleMatch && artistMatch ? "high" : titleMatch || artistMatch ? "medium" : "low";
}

function scoreGeniusHit(hit, trackName, artistName) {
  const normalizedTrack = normalizeText(trackName);
  const normalizedArtist = normalizeText(artistName);
  const hitTitle = normalizeText(hit?.title || "");
  const hitArtist = normalizeText(hit?.primary_artist?.name || "");
  const hitFullTitle = normalizeText(hit?.full_title || "");
  let score = 0;

  if (hitTitle === normalizedTrack) score += 60;
  if (hitArtist === normalizedArtist) score += 35;
  if (hitFullTitle.includes(normalizedTrack) && normalizedTrack) score += 10;
  if (hitFullTitle.includes(normalizedArtist) && normalizedArtist) score += 8;
  if (hit?.lyrics_state === "complete") score += 2;

  return score;
}

function canonicalGeniusUrl(urlValue) {
  const raw = String(urlValue || "").trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    return parsed.toString();
  } catch {
    return raw.startsWith("http") ? raw : `https://genius.com${raw.startsWith("/") ? raw : `/${raw}`}`;
  }
}

function normalizeSeedText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function buildColdItems(limit = 5) {
  const coldStatsSnap = await db.collection("song_stats").orderBy("playCount", "desc").limit(limit).get();
  return Promise.all(
    coldStatsSnap.docs.map(async (statsDoc) => {
      const songSnap = await db.collection("songs").doc(statsDoc.id).get();
      const songData = songSnap.exists ? songSnap.data() : {};
      return {
        songId: statsDoc.id,
        songName: songData?.name || statsDoc.id,
        artists: songData?.artists || [],
        score: computePopularSafeScore(statsDoc.data()),
        reasons: buildReasons({
          playlistSimilarity: 0,
          searchSimilarity: 0,
          globalEngagement: computePopularSafeScore(statsDoc.data()),
          isTopUp: true
        })
      };
    })
  );
}

exports.getRecommendations = onRequest({ cors: true, region: "us-central1", invoker: "public" }, async (req, res) => {
  try {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }
    const { playlistId } = req.body || {};
    if (!playlistId) {
      res.status(400).json({ error: "playlistId is required" });
      return;
    }

    const tracksSnap = await db.collection("playlists").doc(playlistId).collection("tracks").get();
    const playlistTrackIds = new Set(tracksSnap.docs.map((doc) => doc.id));

    if (playlistTrackIds.size === 0) {
      const coldItems = await buildColdItems(5);
      res.json({ items: coldItems });
      return;
    }

    const playlistRaw = new Map();
    const searchRaw = new Map();

    for (const trackId of playlistTrackIds) {
      const [playlistCoDoc, searchCoDoc] = await Promise.all([
        db.collection("cooccurrence_playlist").doc(trackId).get(),
        db.collection("cooccurrence_search").doc(trackId).get()
      ]);

      const playlistNeighbors = playlistCoDoc.exists ? playlistCoDoc.data().neighbors || {} : {};
      const searchNeighbors = searchCoDoc.exists ? searchCoDoc.data().neighbors || {} : {};

      Object.entries(playlistNeighbors).forEach(([candidateId, rawValue]) => {
        if (playlistTrackIds.has(candidateId)) return;
        const next = (playlistRaw.get(candidateId) || 0) + Number(rawValue || 0);
        playlistRaw.set(candidateId, next);
      });

      Object.entries(searchNeighbors).forEach(([candidateId, rawValue]) => {
        if (playlistTrackIds.has(candidateId)) return;
        const next = (searchRaw.get(candidateId) || 0) + Number(rawValue || 0);
        searchRaw.set(candidateId, next);
      });
    }

    const playlistScores = normalizeMap(playlistRaw);
    const searchScores = normalizeMap(searchRaw);
    const candidateIds = Array.from(new Set([...playlistScores.keys(), ...searchScores.keys()])).slice(0, 80);

    if (candidateIds.length === 0) {
      const coldItems = await buildColdItems(5);
      res.json({ items: coldItems });
      return;
    }

    const scoredItems = await Promise.all(
      candidateIds.map(async (candidateId) => {
        const [statsSnap, songSnap] = await Promise.all([
          db.collection("song_stats").doc(candidateId).get(),
          db.collection("songs").doc(candidateId).get()
        ]);
        const stats = statsSnap.exists ? statsSnap.data() : {};
        const song = songSnap.exists ? songSnap.data() : {};

        const globalEngagement = computePopularSafeScore(stats);
        const playlistSimilarity = playlistScores.get(candidateId) || 0;
        const searchSimilarity = searchScores.get(candidateId) || 0;
        const recencyAffinity = playlistSimilarity * 0.8 + searchSimilarity * 0.2;
        const baseScore = scoreCandidate({ playlistSimilarity, searchSimilarity, globalEngagement, recencyAffinity });
        const score = baseScore;
        const hasUsefulSignal =
          playlistSimilarity >= 0.05 || searchSimilarity >= 0.05 || globalEngagement >= 0.1;
        if (!hasUsefulSignal) return null;

        return {
          songId: candidateId,
          songName: song?.name || candidateId,
          artists: song?.artists || [],
          score,
          reasons: buildReasons({
            playlistSimilarity,
            searchSimilarity,
            globalEngagement,
            isTopUp: false
          })
        };
      })
    );

    const dedupedRanked = scoredItems
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);
    const chosen = dedupedRanked.slice(0, 5);

    if (chosen.length < 5) {
      const chosenIds = new Set(chosen.map((item) => item.songId));
      const needed = 5 - chosen.length;
      const topUpItems = (await buildColdItems(30))
        .filter((item) => !playlistTrackIds.has(item.songId) && !chosenIds.has(item.songId))
        .slice(0, needed)
        .map((item) => ({
          ...item,
          reasons: buildReasons({
            playlistSimilarity: 0,
            searchSimilarity: 0,
            globalEngagement: item.score,
            isTopUp: true
          })
        }));
      chosen.push(...topUpItems);
    }

    const items = chosen.slice(0, 5);
    res.json({ items });
  } catch (error) {
    logger.error("getRecommendations failed", error);
    res.status(500).json({ error: "Internal recommendation error" });
  }
});

exports.getGeniusEnrichment = onRequest({ cors: true, region: "us-central1", invoker: "public" }, async (req, res) => {
  try {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    const token = process.env.GENIUS_ACCESS_TOKEN || String(req.body?.token || "").trim();
    if (!token) {
      res.status(200).json({
        songDescription: null,
        artistDescription: null,
        tags: [],
        relatedSongIds: [],
        relatedArtistNames: [],
        geniusSongId: null,
        geniusSongUrl: null
      });
      return;
    }

    const trackName = String(req.body?.trackName || "").trim();
    const artistName = String(req.body?.artistName || "").trim();
    const queries = buildGeniusQueries(trackName, artistName);
    if (!queries.length) {
      res.status(400).json({ error: "trackName or artistName is required" });
      return;
    }

    let bestHit = null;
    let bestHitScore = -1;
    for (const query of queries) {
      const response = await fetch(`https://api.genius.com/search?q=${encodeURIComponent(query)}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!response.ok) continue;
      const payload = await response.json();
      const hits = Array.isArray(payload?.response?.hits) ? payload.response.hits : [];
      for (const entry of hits.slice(0, 6)) {
        const hit = entry?.result;
        if (!hit) continue;
        const score = scoreGeniusHit(hit, trackName, artistName);
        if (score > bestHitScore) {
          bestHit = hit;
          bestHitScore = score;
        }
        if (score >= 95) break;
      }
    }

    if (!bestHit) {
      res.status(200).json({
        songDescription: null,
        artistDescription: null,
        tags: [],
        relatedSongIds: [],
        relatedArtistNames: [],
        geniusSongId: null,
        geniusSongUrl: null
      });
      return;
    }

    const selectedConfidence = computeConfidence(bestHit, trackName, artistName);
    let songDescription = null;
    let artistDescription = null;
    let tags = [];
    let relatedSongIds = [];
    let relatedArtistNames = [];
    let primaryTagName = null;
    let detailDebug = {
      featuredArtists: [],
      writerArtists: [],
      producerArtists: [],
      performerArtists: [],
      relationshipArtists: []
    };
    try {
      const detailResponse = await fetch(`https://api.genius.com/songs/${bestHit.id}?text_format=plain`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (detailResponse.ok) {
        const detailPayload = await detailResponse.json();
        const detailSong = detailPayload?.response?.song;
        songDescription =
          detailSong?.description?.plain ||
          detailSong?.description_preview ||
          detailSong?.full_title ||
          null;
        artistDescription =
          detailSong?.primary_artist?.description?.plain ||
          detailSong?.primary_artist?.name ||
          null;
        const relatedArtistPool = [
          ...(Array.isArray(detailSong?.featured_artists) ? detailSong.featured_artists : []),
          ...(Array.isArray(detailSong?.writer_artists) ? detailSong.writer_artists : []),
          ...(Array.isArray(detailSong?.producer_artists) ? detailSong.producer_artists : [])
        ];
        detailDebug = {
          featuredArtists: Array.isArray(detailSong?.featured_artists)
            ? detailSong.featured_artists.map((artist) => String(artist?.name || "")).filter(Boolean).slice(0, 8)
            : [],
          writerArtists: Array.isArray(detailSong?.writer_artists)
            ? detailSong.writer_artists.map((artist) => String(artist?.name || "")).filter(Boolean).slice(0, 8)
            : [],
          producerArtists: Array.isArray(detailSong?.producer_artists)
            ? detailSong.producer_artists.map((artist) => String(artist?.name || "")).filter(Boolean).slice(0, 8)
            : [],
          performerArtists: Array.isArray(detailSong?.custom_performances)
            ? detailSong.custom_performances
                .flatMap((entry) => (Array.isArray(entry?.artists) ? entry.artists : []))
                .map((artist) => String(artist?.name || "")).filter(Boolean).slice(0, 8)
            : [],
          relationshipArtists: Array.isArray(detailSong?.song_relationships)
            ? detailSong.song_relationships
                .flatMap((relationship) => (Array.isArray(relationship?.songs) ? relationship.songs : []))
                .map((song) => String(song?.primary_artist?.name || "")).filter(Boolean).slice(0, 8)
            : []
        };
        const currentArtist = normalizeText(artistName);
        relatedArtistNames = Array.from(
          new Set(
            relatedArtistPool
              .map((artist) => String(artist?.name || "").trim())
              .filter(Boolean)
              .filter((name) => normalizeText(name) !== currentArtist)
          )
        ).slice(0, 8);
        const descriptionSeed = normalizeSeedText(`${songDescription || ""} ${artistDescription || ""}`);
        const dictionary = [
          "hip hop",
          "rap",
          "pop",
          "rock",
          "rnb",
          "r and b",
          "soul",
          "jazz",
          "latin",
          "indie",
          "electronic",
          "dance",
          "country",
          "alternative"
        ];
        primaryTagName = detailSong?.primary_tag?.name ? String(detailSong.primary_tag.name) : null;
        const explicitTags = Array.isArray(detailSong?.tags) ? detailSong.tags.map((tag) => tag?.name).filter(Boolean) : [];
        const derivedTags = dictionary.filter((tag) => descriptionSeed.includes(tag));
        tags = Array.from(new Set([primaryTagName, ...explicitTags, ...derivedTags].filter(Boolean)));
        relatedSongIds = Array.isArray(detailSong?.writer_artists)
          ? detailSong.writer_artists.map((artist) => String(artist?.id || "")).filter(Boolean).slice(0, 5)
          : [];
      }
    } catch (error) {
      logger.warn("getGeniusEnrichment detail fetch failed", error);
    }
    res.status(200).json({
      songDescription,
      artistDescription,
      tags,
      relatedSongIds,
      relatedArtistNames,
      geniusSongId: bestHit.id ? String(bestHit.id) : null,
      geniusSongUrl: canonicalGeniusUrl(bestHit.url),
      _debug: {
        selectedTitle: bestHit?.title || null,
        selectedArtist: bestHit?.primary_artist?.name || null,
        selectedConfidence,
        selectedScore: bestHitScore,
        primaryTagName,
        relatedArtistCount: relatedArtistNames.length,
        explicitTags: Array.isArray(tags) ? tags.slice(0, 10) : [],
        rawDetailFields: {
          featuredArtists: detailDebug.featuredArtists.length,
          writerArtists: detailDebug.writerArtists.length,
          producerArtists: detailDebug.producerArtists.length,
          performerArtists: detailDebug.performerArtists.length,
          relationshipArtists: detailDebug.relationshipArtists.length
        }
        ,
        detailFieldSamples: detailDebug
      }
    });
  } catch (error) {
    logger.error("getGeniusEnrichment failed", error);
    res.status(200).json({
      songDescription: null,
      artistDescription: null,
      tags: [],
      relatedSongIds: [],
      relatedArtistNames: [],
      geniusSongId: null,
      geniusSongUrl: null
    });
  }
});

const SPOTIFY_ME_URL = "https://api.spotify.com/v1/me";

/**
 * Exchange a valid Spotify access token for a Firebase custom token.
 * UID is stable per Spotify user: spotify_{spotifyUserId} (alphanumeric + underscore only).
 */
function parseJsonBody(req) {
  const raw = req.body;
  if (raw && typeof raw === "object" && !Buffer.isBuffer(raw)) {
    return raw;
  }
  if (Buffer.isBuffer(raw)) {
    try {
      return JSON.parse(raw.toString("utf8"));
    } catch (e) {
      return null;
    }
  }
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }
  return null;
}

const appspotSa = getAppspotServiceAccount();
const createSpotifyAuthOptions = {
  cors: true,
  region: "us-central1",
  invoker: "public",
  ...(appspotSa ? { serviceAccount: appspotSa } : {})
};

exports.createSpotifyFirebaseSession = onRequest(createSpotifyAuthOptions, async (req, res) => {
  try {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }
    const body = parseJsonBody(req) || {};
    const accessToken = body.accessToken;
    if (!accessToken || typeof accessToken !== "string") {
      res.status(400).json({ error: "accessToken is required" });
      return;
    }
    const meRes = await fetch(SPOTIFY_ME_URL, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!meRes.ok) {
      logger.warn("createSpotifyFirebaseSession: Spotify /me failed", { status: meRes.status });
      res.status(401).json({ error: "Invalid or expired Spotify access token" });
      return;
    }
    const me = await meRes.json();
    const spotifyId = me?.id ? String(me.id) : "";
    if (!spotifyId) {
      res.status(400).json({ error: "Spotify profile had no id" });
      return;
    }
    const safeId = spotifyId.replace(/[^a-zA-Z0-9]/g, "_");
    const uid = `spotify_${safeId}`;
    // Avoid reserved / ambiguous claim keys; keep payload small.
    const customToken = await admin.auth().createCustomToken(uid, { spotifyUserId: spotifyId });
    res.status(200).json({ customToken, uid });
  } catch (error) {
    const message = error && typeof error === "object" && "message" in error ? String(error.message) : String(error);
    logger.error("createSpotifyFirebaseSession failed", error);
    res.status(500).json({
      error: "Failed to create session",
      detail: message
    });
  }
});

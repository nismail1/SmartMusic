import type { GeniusEnrichment, SpotifyTrack } from "../types/music";
import { db } from "./firebase";
import { doc, serverTimestamp, setDoc } from "firebase/firestore";
import { spotifyService } from "./spotify";

const GENIUS_SEARCH_URL = "https://api.genius.com/search";

const emptyEnrichment: GeniusEnrichment = {
  songDescription: null,
  artistDescription: null,
  tags: [],
  relatedSongIds: [],
  relatedArtistNames: [],
  geniusSongId: null,
  geniusSongUrl: null
};

function normalizeGeniusUrl(value: string | null | undefined): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  try {
    return new URL(raw).toString();
  } catch {
    return raw.startsWith("http") ? raw : `https://genius.com${raw.startsWith("/") ? raw : `/${raw}`}`;
  }
}

function normalizeTag(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

function mergeTags(...groups: string[][]): string[] {
  const merged = groups.flat().map(normalizeTag).filter(Boolean);
  return Array.from(new Set(merged)).slice(0, 30);
}

function deriveTags(
  description: string | null,
  artistDescription: string | null,
  relatedArtistNames: string[]
): string[] {
  const seeds = [description ?? "", artistDescription ?? "", ...relatedArtistNames].join(" ").toLowerCase();
  const dictionary = [
    "hip hop",
    "rap",
    "pop",
    "rock",
    "rnb",
    "soul",
    "jazz",
    "latin",
    "indie",
    "electronic",
    "dance",
    "lofi",
    "afrobeats",
    "country",
    "acoustic",
    "alternative",
    "kpop"
  ];
  const matched = dictionary.filter((tag) => seeds.includes(tag));
  return Array.from(new Set(matched.map(normalizeTag))).slice(0, 8);
}

async function persistGeniusMetadata(songId: string, enrichment: GeniusEnrichment): Promise<void> {
  const songRef = doc(db, "songs", songId);
  await setDoc(
    songRef,
    {
      geniusMeta: {
        ...enrichment,
        updatedAt: new Date().toISOString()
      },
      updatedAt: serverTimestamp()
    },
    { merge: true }
  );
}
function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\(.*?\)/g, '') 
    .replace(/\[.*?\]/g, '') 
    .replace(/feat\.?.*/gi, '')
    .replace(/ft\.?.*/gi, '')
    .replace(/featuring.*/gi, '')
    .replace(/remaster(ed)?/gi, '')
    .replace(/\bradio edit\b.*$/gi, '')
    .replace(/live/gi, '')
    .replace(/[^\w\s]/g, '')
    .trim();
}

export const geniusService = {
  async enrichTrack(track: SpotifyTrack): Promise<GeniusEnrichment> {
    const token = import.meta.env.VITE_GENIUS_ACCESS_TOKEN ?? "";
    const proxyEndpoint = import.meta.env.VITE_GENIUS_PROXY_ENDPOINT ?? "";
    const recommendationsEndpoint = import.meta.env.VITE_RECOMMENDATIONS_ENDPOINT ?? "";
    const derivedProxyEndpoint = recommendationsEndpoint
      ? recommendationsEndpoint.replace("getRecommendations", "getGeniusEnrichment")
      : "";
    const resolvedProxyEndpoint = proxyEndpoint || derivedProxyEndpoint;
    if (!token && !resolvedProxyEndpoint) {
      return emptyEnrichment;
    }

    const query = `${track.name} ${track.artists[0] ?? ""}`.trim();
    let spotifySupplementalTags: string[] = [];
    try {
      spotifySupplementalTags = await spotifyService.getSupplementalTags(track.id);
    } catch {}

    if (resolvedProxyEndpoint) {

    console.log("payload", track.name, track.artists);
    let normalizedTrackName = normalizeTitle(track.name);
    
      try {
        const proxyResponse = await fetch(resolvedProxyEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            trackName: normalizedTrackName,
            artistName: track.artists[0] ?? "",
            token
          })
        });

        if (proxyResponse.ok) {
          const proxyPayload = (await proxyResponse.json()) as Partial<GeniusEnrichment>;
          console.log("proxyPayload", proxyPayload);
          const enrichment: GeniusEnrichment = {
            songDescription: proxyPayload.songDescription ?? null,
            artistDescription: proxyPayload.artistDescription ?? null,
            tags: Array.isArray(proxyPayload.tags) ? proxyPayload.tags.map((t) => normalizeTag(String(t))).filter(Boolean) : [],
            relatedSongIds: Array.isArray(proxyPayload.relatedSongIds)
              ? proxyPayload.relatedSongIds.map((id) => String(id)).filter(Boolean)
              : [],
            relatedArtistNames: Array.isArray(proxyPayload.relatedArtistNames)
              ? proxyPayload.relatedArtistNames.map((name) => String(name)).filter(Boolean)
              : [],
            geniusSongId: proxyPayload.geniusSongId ? String(proxyPayload.geniusSongId) : null,
            geniusSongUrl: normalizeGeniusUrl(proxyPayload.geniusSongUrl)
          };
          enrichment.tags = enrichment.tags.length
            ? enrichment.tags
            : deriveTags(enrichment.songDescription, enrichment.artistDescription, enrichment.relatedArtistNames);
          enrichment.tags = mergeTags(enrichment.tags, spotifySupplementalTags);
          try {
            await persistGeniusMetadata(track.id, enrichment);
          } catch {}
          return enrichment;
        }
      } catch {
        // Falls through to direct API path.
      }
    }

    if (!token) {
      return emptyEnrichment;
    }

    try {
      const res = await fetch(`${GENIUS_SEARCH_URL}?q=${encodeURIComponent(query)}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) {
        return emptyEnrichment;
      }
      const json = await res.json();
      const hit = json.response?.hits?.[0]?.result;
      if (!hit) {
        return emptyEnrichment;
      }
      const relatedArtistNames = Array.isArray(hit.featured_artists)
        ? hit.featured_artists.map((artist: { name?: string }) => artist.name ?? "").filter(Boolean)
        : [];
      const enrichment: GeniusEnrichment = {
        songDescription: hit.title_with_featured ?? null,
        artistDescription: hit.primary_artist?.name ?? null,
        tags: mergeTags(
          deriveTags(hit.title_with_featured ?? null, hit.primary_artist?.name ?? null, relatedArtistNames),
          spotifySupplementalTags
        ),
        relatedSongIds: [],
        relatedArtistNames,
        geniusSongId: hit.id ? String(hit.id) : null,
        geniusSongUrl: normalizeGeniusUrl(hit.url)
      };
      try {
        await persistGeniusMetadata(track.id, enrichment);
      } catch {}
      return enrichment;
    } catch {
      return emptyEnrichment;
    }
  }
};

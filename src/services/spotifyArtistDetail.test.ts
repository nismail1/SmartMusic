import { describe, expect, it } from "vitest";
import { parseSpotifyArtistDetailJson, spotifyArtistDetailUrl } from "./spotify";

describe("Spotify artist detail (per-id GET, not batch ?ids=)", () => {
  it("builds GET /v1/artists/{id} with encoded id and no query string", () => {
    const url = spotifyArtistDetailUrl("0E422F25rKRNgDTYfPyq38");
    expect(url).toBe("https://api.spotify.com/v1/artists/0E422F25rKRNgDTYfPyq38");
    expect(url).not.toContain("?");
    expect(url).not.toContain("ids=");
  });

  it("encodes special characters in the path", () => {
    const url = spotifyArtistDetailUrl("abc/def");
    expect(url).toBe("https://api.spotify.com/v1/artists/abc%2Fdef");
  });

  it("extracts id and genres from Get Artist response body", () => {
    const { id, genres } = parseSpotifyArtistDetailJson(
      { id: "3mY9R0bV1a2b3c4d5e6f7g8", genres: ["indie pop", "art pop"] },
      "ignored"
    );
    expect(id).toBe("3mY9R0bV1a2b3c4d5e6f7g8");
    expect(genres).toEqual(["indie pop", "art pop"]);
  });

  it("uses requested id when response omits id", () => {
    const { id, genres } = parseSpotifyArtistDetailJson({ genres: ["rock"] }, "  fallbackId  ");
    expect(id).toBe("fallbackId");
    expect(genres).toEqual(["rock"]);
  });

  it("treats missing or empty genres as []", () => {
    expect(parseSpotifyArtistDetailJson({}, "x").genres).toEqual([]);
    expect(parseSpotifyArtistDetailJson({ genres: null }, "x").genres).toEqual([]);
  });
});

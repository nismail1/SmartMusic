import { config as loadEnv } from "dotenv";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { readFile } from "node:fs/promises";
import path from "node:path";

loadEnv();

const OUTPUT_DIR = path.resolve(process.cwd(), "scripts/data/seed-output");

type WriteInstruction = { collectionPath: string; docId: string; data: unknown };

async function commitChunked(db: ReturnType<typeof getFirestore>, writes: WriteInstruction[]) {
  const chunkSize = 450;
  for (let offset = 0; offset < writes.length; offset += chunkSize) {
    const chunk = writes.slice(offset, offset + chunkSize);
    const batch = db.batch();
    chunk.forEach((write) => {
      const docRef = db.collection(write.collectionPath).doc(write.docId);
      batch.set(docRef, write.data);
    });
    await batch.commit();
  }
}

async function main() {
  const projectId = process.env.VITE_FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!projectId || !clientEmail || !privateKey) {
    throw new Error("Missing FIREBASE_CLIENT_EMAIL or FIREBASE_PRIVATE_KEY or VITE_FIREBASE_PROJECT_ID");
  }
  if (getApps().length === 0) {
    initializeApp({
      credential: cert({ projectId, clientEmail, privateKey })
    });
  }

  const db = getFirestore();
  const songs = JSON.parse(await readFile(path.join(OUTPUT_DIR, "songs.json"), "utf-8"));
  const users = JSON.parse(await readFile(path.join(OUTPUT_DIR, "users.json"), "utf-8"));
  const playlists = JSON.parse(await readFile(path.join(OUTPUT_DIR, "playlists.json"), "utf-8"));
  const events = JSON.parse(await readFile(path.join(OUTPUT_DIR, "events.json"), "utf-8"));
  const songStats = JSON.parse(await readFile(path.join(OUTPUT_DIR, "song_stats.json"), "utf-8"));
  const playlistCo = JSON.parse(await readFile(path.join(OUTPUT_DIR, "cooccurrence_playlist.json"), "utf-8"));
  const searchCo = JSON.parse(await readFile(path.join(OUTPUT_DIR, "cooccurrence_search.json"), "utf-8"));

  const writes: WriteInstruction[] = [];
  songs.forEach((song: any) => writes.push({ collectionPath: "songs", docId: song.id, data: song }));
  users.forEach((user: any) =>
    writes.push({
      collectionPath: "users",
      docId: user.id,
      data: { displayName: user.displayName, createdAt: new Date().toISOString() }
    })
  );
  playlists.forEach((playlist: any) => writes.push({ collectionPath: "playlists", docId: playlist.id, data: playlist }));
  events.forEach((event: any) => writes.push({ collectionPath: "events", docId: event.id, data: event }));
  Object.entries(songStats).forEach(([songId, stats]) =>
    writes.push({ collectionPath: "song_stats", docId: songId, data: stats })
  );
  playlistCo.forEach((row: any) =>
    writes.push({ collectionPath: "cooccurrence_playlist", docId: row.songId, data: { neighbors: row.neighbors } })
  );
  searchCo.forEach((row: any) =>
    writes.push({ collectionPath: "cooccurrence_search", docId: row.songId, data: { neighbors: row.neighbors } })
  );

  await commitChunked(db, writes);
  console.log(`Seed and aggregate data written to Firestore (${writes.length} documents).`);
}

void main();


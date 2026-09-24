import type { Selection } from "../shared/options.ts";
import type { Sprite } from "./mascot/process.ts";
import type { PetStats } from "./pet/state.ts";

// The pet lives only in this browser (IndexedDB — sprites are too big for
// localStorage). Your photo is never stored: only the generated mascot.

export interface SavedPet {
  name: string;
  selection: Selection;
  sprite: Sprite;
  stats: PetStats;
  createdAt: number;
  provider: string;
}

const DB = "herogotchi";
const STORE = "pets";
const KEY = "current";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

export async function loadPet(): Promise<SavedPet | null> {
  try {
    return ((await run("readonly", (s) => s.get(KEY))) as SavedPet | undefined) ?? null;
  } catch {
    return null; // private mode / storage blocked: start fresh
  }
}

export async function savePet(pet: SavedPet): Promise<void> {
  try {
    await run("readwrite", (s) => s.put(pet, KEY));
  } catch {
    /* storage blocked — the pet still works for this session */
  }
}

export async function deletePet(): Promise<void> {
  try {
    await run("readwrite", (s) => s.delete(KEY));
  } catch {
    /* ignore */
  }
}

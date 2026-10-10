import { useEffect, useState, useSyncExternalStore } from "react";

import { fetchAuthedBytes } from "@/lib/api";
import { getDeviceToken, subscribePairing, TOKEN_STORAGE_KEY } from "@/lib/pairing";
import { onWipe, WIPE_CHANNEL, WIPE_TAB_ID, type WipeAnnouncement } from "@/lib/wipe";

// ── A BRIDGE SUBRESOURCE, LOADED WITH THE PAIRING TOKEN (ADR 0086) ───────────────────────────────
//
// Reads need the pairing token, and the bridge serves three things a page would naturally load by
// URL: a journal picture (`/api/blobs/<hash>`), the multiplexer's mark (`/api/mux/logo.svg`) and an
// operator font (`/api/fonts/<name>`). An `<img src>` or a CSS `url()` cannot carry an
// `Authorization` header, so each of them would now answer 403. This module fetches the bytes with
// the token (lib/api.ts `fetchAuthedBytes`) and hands the page an object URL instead.
//
// ONE OBJECT URL PER PATH, UNTIL WIPE OR TOKEN CHANGE. A blob is content-addressed and the mark is
// one file, so the bytes behind a path do not change while the page lives; asking twice would only
// cost a second download. The table is bounded: the oldest entry is dropped and its URL revoked past
// the cap, which on a phone is far beyond the pictures one session shows. A failed load is not kept,
// so the next request asks again (after pairing, say).
//
// `data:` URLs are already the bytes and pass through untouched.

const CACHE_MAX = 64;
interface Entry {
  pending: Promise<string>;
  url: string | null;
}

const cache = new Map<string, Entry>();
// Also tracks evicted reads until they settle, so a wipe can abort every old request.
const reading = new Set<AbortController>();
const listeners = new Set<() => void>();
let generation = 0;

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function snapshot(): number {
  return generation;
}

function invalidate(): void {
  generation++;
  for (const controller of reading) controller.abort();
  reading.clear();
  for (const entry of cache.values()) {
    if (entry.url !== null) URL.revokeObjectURL(entry.url);
  }
  cache.clear();
  for (const listener of listeners) listener();
}

let tokenSeen = getDeviceToken();
subscribePairing(() => {
  const token = getDeviceToken();
  if (token === tokenSeen) return;
  tokenSeen = token;
  invalidate();
});

// Pairing subscriptions are document-local. Storage events carry token changes from other tabs,
// including localStorage.clear(); session storage and unrelated preferences are not this boundary.
globalThis.addEventListener?.("storage", (event: StorageEvent) => {
  if (event.storageArea !== localStorage) return;
  if (event.key !== null && event.key !== TOKEN_STORAGE_KEY) return;
  if (event.key !== null && event.oldValue === event.newValue) return;
  tokenSeen = getDeviceToken();
  invalidate();
});

// Reuse the wipe announcement already sent before database deletion. Only retire this tab's URLs:
// running wipeDevice here would rebroadcast and repeat the shared-storage deletion in every tab.
function listenForRemoteWipes(): void {
  try {
    const channel = new BroadcastChannel(WIPE_CHANNEL);
    channel.addEventListener("message", (event: MessageEvent<Partial<WipeAnnouncement> | null>) => {
      const message = event.data;
      if (message?.type !== "wipe" || !message.from || message.from === WIPE_TAB_ID) return;
      if (message.reason !== "unpair" && message.reason !== "revoked" && message.reason !== "expired") return;
      invalidate();
    });
  } catch {
    // Without BroadcastChannel, token removal still arrives through the storage listener above.
  }
}
listenForRemoteWipes();

// Blob paths do not identify a pane. Like file-images, clear all of them even for a password wipe.
function registerWipe(): void {
  onWipe("authed-urls", invalidate);
}
registerWipe();

function remember(path: string, entry: Entry): void {
  cache.set(path, entry);
  if (cache.size <= CACHE_MAX) return;
  const oldest = cache.keys().next().value;
  if (oldest === undefined) return;
  const evicted = cache.get(oldest);
  cache.delete(oldest);
  void evicted?.pending.then((u) => URL.revokeObjectURL(u)).catch(() => undefined);
}

/**
 * An object URL for a root-absolute `/api/...` path, fetched once with the token. Rejects when the
 * bridge refuses or the network fails; nothing is cached then.
 */
export function authedObjectUrl(path: string): Promise<string> {
  const hit = cache.get(path);
  if (hit !== undefined) return hit.pending;
  const started = generation;
  const controller = new AbortController();
  reading.add(controller);
  const entry: Entry = {
    url: null,
    pending: fetchAuthedBytes(path, controller.signal).then((blob) => {
      // Abort is best effort: an already delivered response/body can still finish after a wipe.
      if (started !== generation) throw new DOMException("Image read invalidated", "AbortError");
      entry.url = URL.createObjectURL(blob);
      return entry.url;
    }).finally(() => reading.delete(controller)),
  };
  remember(path, entry);
  entry.pending.catch(() => {
    if (cache.get(path) === entry) cache.delete(path);
  });
  return entry.pending;
}

/** What a component renders: the URL once it is ready, and whether the load failed. */
export interface AuthedUrl {
  url: string | null;
  failed: boolean;
}

/**
 * The displayable URL for `src`: itself for a `data:` URL, an object URL for an `/api` path, and
 * `null` while that is loading or when `src` is `null`. `failed` turns true when the load failed, so
 * a caller can show its own stand-in (an image card's "[Image]" badge, say).
 */
export function useAuthedUrl(src: string | null): AuthedUrl {
  const passThrough = src === null || src.startsWith("data:");
  const current = useSyncExternalStore(subscribe, snapshot, snapshot);
  const [state, setState] = useState<AuthedUrl & { src: string | null; generation: number }>({
    src: null,
    url: null,
    failed: false,
    generation: current,
  });
  // Invalidation clears the display, but must not itself fetch wiped content again. A new source or
  // mount can request fresh bytes; the generation subscription only retires the old display.
  useEffect(() => {
    if (passThrough || src === null) return;
    let live = true;
    const started = snapshot();
    const load = async (): Promise<void> => {
      try {
        const url = await authedObjectUrl(src);
        if (live && started === snapshot()) setState({ src, url, failed: false, generation: started });
      } catch {
        if (live && started === snapshot()) setState({ src, url: null, failed: true, generation: started });
      }
    };
    void load();
    return () => {
      live = false;
    };
  }, [src, passThrough]);
  if (passThrough) return { url: src, failed: false };
  // Neither an earlier source nor an earlier pairing/wipe can supply this render's URL.
  if (state.src !== src || state.generation !== current) return { url: null, failed: false };
  return { url: state.url, failed: state.failed };
}

/** Test helper: retire cached/pending URLs and restore the cleaner after a wipe-registry reset. */
export function __resetAuthedUrls(): void {
  invalidate();
  tokenSeen = getDeviceToken();
  registerWipe();
}

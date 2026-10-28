import { useSyncExternalStore } from "react";

// ── THE DEVICE CREDENTIAL THIS PHONE HOLDS ───────────────────────────────────────────────────────
//
// The bridge's pairing gate (bridge/pairing.ts) is a bearer token minted by `bin/collie pair` and
// claimed once, from Settings. Since ADR 0086 it guards every read as well as every write. This
// module is the client half: where the token lives, how it reaches every request, and the one
// latched bit that says "the bridge just refused this device because it isn't paired".
//
// Two deliberate shapes:
//
//   1. **The token is read from localStorage on every access, never cached in a module variable.**
//      It is written by the pairing card and read by lib/api.ts on every request; a module cache
//      would be a second source of truth that a second tab (or a test's `localStorage.clear()`)
//      could silently desync. A `getItem` per request is nothing next to the fetch it decorates.
//
//   2. **`refused` is a latch, not a poll.** Any request can come back 403 with the body below, the
//      first snapshot of a cold open included (ADR 0086: reads need the token). api.ts latches it at
//      the one place that sees the refusal, and the pair affordances (components/read-only-banner.tsx,
//      the dashboard's empty state) read it. It clears on proof of the opposite: a successful write,
//      a fresh pairing, or a `/api/devices` answer that names this device.
//
// Storage is namespaced like every other client preference (lib/haptics, hooks/use-theme).

/** localStorage key holding this device's bearer token. */
export const TOKEN_STORAGE_KEY = "collie:device-token";

/**
 * The exact body the bridge sends when a write is refused for want of pairing. Distinct from the
 * header-gate's `device not authorised` on purpose — the two gates are independent and their
 * remedies are different (pair this device vs. get onto the proxy's allowlist), so the client must
 * be able to tell them apart from the body alone.
 */
export const NOT_PAIRED_BODY = "device not paired";

/**
 * The body the bridge sends when this device's token is real but its lifetime ran out (M46 spec
 * 01). A third reason, distinct from both above: the remedy is "pair again", and the phone says so.
 */
export const EXPIRED_BODY = "device expired";

// Page-local only.
let pairingRequired = true;

/** Observe the bridge's explicit policy, never infer it from a missing header. */
export function observePairingPolicy(value: string | null): void {
  if (value !== "on" && value !== "off") return;
  const changed = pairingRequired !== (value === "on");
  pairingRequired = value === "on";
  if (!pairingRequired) clearNotPaired();
  if (changed) emit();
}

export function isBrowserPairingEnforced(): boolean {
  return pairingRequired;
}

let refused = false;
/** Set alongside `refused` when the reason was an expired token. Cleared with it. */
let expired = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

/** This device's bearer token, or null when it has never paired (or was revoked here). */
export function getDeviceToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY) || null;
  } catch {
    // Private-mode / locked-down storage: behave exactly like an unpaired device.
    return null;
  }
}

/** Store the token minted by a successful `/api/pair`. Clears the refusal latch — we just proved it. */
export function setDeviceToken(token: string, expiresAt?: number): void {
  try {
    localStorage.setItem(TOKEN_STORAGE_KEY, token);
  } catch {
    // ignore — the in-memory session still works until reload
  }
  // Persist the claim's lifetime before notifying subscribers or revalidating. A devices read
  // may never complete. Older servers and nonexpiring claims omit it, clearing the old cap.
  rememberPairingExpiry(expiresAt ?? null);
  refused = false;
  expired = false;
  emit();
}

/**
 * Forget this device's token. Only the wipe routine (lib/wipe.ts) calls this: a pairing that ends
 * takes more with it than the token, and a caller that cleared the token alone would leave the rest.
 */
export function clearDeviceToken(): void {
  try {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // ignore
  }
  rememberPairingExpiry(null);
  emit();
}

// ── WHEN THIS PAIRING ENDS ──────────────────────────────────────────────────────────────────────
//
// The bridge reports this device's own `expiresAt` with the pairing token and on the `current`
// row of `GET /api/devices` (M46 spec 01). The on-device store caps every record's lifetime at it (lib/store.ts), so nothing
// the phone saved under a pairing outlives that pairing, and a cold open after the expiry draws
// nothing saved. Kept in memory and in localStorage, because a cold open must know it before any
// fetch. Cleared with the token, so the wipe takes it, and by a fresh pairing, which has its own.

/** localStorage key holding this pairing's expiry, epoch ms. Absent: no expiry known. */
export const PAIRING_EXPIRES_KEY = "collie:pairing-expires";

/** undefined: not read from storage yet. null: no expiry known. */
let pairingExpiresAt: number | null | undefined;

/** Remember this pairing's expiry (epoch ms), or forget it with null (no expiry, or no pairing). */
export function rememberPairingExpiry(expiresAt: number | null): void {
  const value = expiresAt !== null && Number.isFinite(expiresAt) ? expiresAt : null;
  pairingExpiresAt = value;
  try {
    if (value === null) localStorage.removeItem(PAIRING_EXPIRES_KEY);
    else localStorage.setItem(PAIRING_EXPIRES_KEY, String(value));
  } catch {
    // ignore: the memory copy still caps this page session
  }
}

/** This pairing's expiry (epoch ms), or null when none is known. */
export function getPairingExpiry(): number | null {
  if (pairingExpiresAt !== undefined) return pairingExpiresAt;
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(PAIRING_EXPIRES_KEY);
  } catch {
    stored = null;
  }
  const parsed = stored === null ? Number.NaN : Number(stored);
  pairingExpiresAt = Number.isFinite(parsed) ? parsed : null;
  return pairingExpiresAt;
}

/**
 * At boot: a token whose remembered expiry has passed latches the pair-again wording before any
 * fetch. It wipes nothing: only the bridge's own confirmed refusal ends a pairing (lib/wipe.ts).
 */
export function checkPairingExpiry(now: number = Date.now()): void {
  const expiresAt = getPairingExpiry();
  if (expiresAt !== null && expiresAt <= now && getDeviceToken() !== null) markExpired();
}

/**
 * The `Authorization` header for an API request, or nothing when this device holds no token. Spread
 * into every fetch by lib/api.ts — the single injection point, so no call site plumbs a header.
 */
export function authHeader(): Record<string, string> {
  const token = getDeviceToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

/** Latch "the bridge refused a write because this device isn't paired". Idempotent. */
export function markNotPaired(): void {
  if (refused) return;
  refused = true;
  emit();
}

/**
 * Latch "the bridge refused this device because its pairing expired". The latch only: the dead token
 * and everything stored under it go through the one wipe routine (lib/wipe.ts `pairingRefused`, M46
 * spec 02), which every refusal site calls instead of this.
 *
 * The latch outlives the token on purpose. Once the token is gone, the next refusal is the plain
 * `device not paired`, and `markNotPaired` leaves `expired` alone — so the pair-again wording stays
 * until a fresh pairing or a proof of acceptance clears it.
 */
export function markExpired(): void {
  if (refused && expired) return;
  refused = true;
  expired = true;
  emit();
}

/** Clear the latch — called wherever we learn this device IS accepted (or pairing is off). */
export function clearNotPaired(): void {
  if (!refused && !expired) return;
  refused = false;
  expired = false;
  emit();
}

/** Whether a write has been refused for want of pairing since the last proof of the opposite. */
export function isNotPaired(): boolean {
  return refused;
}

/** Whether the latched refusal was an expired pairing rather than a missing one. */
export function isPairingExpired(): boolean {
  return expired;
}

export function subscribePairing(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * Test helper — drop the latch (the token itself rides localStorage, which setup.ts clears).
 *
 * Goes through `clearNotPaired` rather than assigning `refused` directly, so a reset NOTIFIES like
 * every other mutation in this module (setDeviceToken/clearDeviceToken/markNotPaired). A silent
 * mutation leaves anything driven by `usePairing`/`useSyncExternalStore` painting the old answer
 * until some unrelated render happens to come along — the identical gap fixed in `connection-health`
 * and `self-update` (commit ec4bcd9), missed here. The guard inside `clearNotPaired` is what keeps
 * it honest in the other direction: a reset that changes nothing emits nothing.
 */
export function __resetPairing(): void {
  const policyChanged = !pairingRequired;
  pairingRequired = true;
  pairingExpiresAt = undefined;
  clearNotPaired();
  if (policyChanged) emit();
}

export interface PairingStatus {
  /** Effective browser policy, defaulting on until the bridge explicitly says otherwise. */
  enforced: boolean;
  /** This device's stored token, or null. */
  token: string | null;
  /** True once a write came back "device not paired" — i.e. the token is missing or rejected. */
  refused: boolean;
  /** True when that refusal was "device expired": the phone shows the pair-again wording. */
  expired: boolean;
}

// One string snapshot rather than a fresh object per read: useSyncExternalStore compares with
// Object.is, and an object built in getSnapshot would differ every call and loop forever.
function snapshot(): string {
  return `${refused ? "1" : "0"}${expired ? "1" : "0"}${pairingRequired ? "1" : "0"} ${getDeviceToken() ?? ""}`;
}

/** Reactive read of the policy, token and refusal latch. */
export function usePairing(): PairingStatus {
  const snap = useSyncExternalStore(subscribePairing, snapshot, snapshot);
  const token = snap.slice(4);
  return { token: token || null, refused: snap[0] === "1", expired: snap[1] === "1", enforced: snap[2] === "1" };
}

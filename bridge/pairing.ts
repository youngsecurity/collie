import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import type { JsonObject, JsonValue } from "./json.ts";

// ── DEVICE PAIRING: A CREDENTIAL THE DEVICE HOLDS, NOT A NAME THE NETWORK ASSERTS ─────────────
//
// The pre-existing write gate (COLLIE_DEVICE_HEADER + COLLIE_DEVICE_ALLOWLIST, bridge/server.ts
// `deviceAuth`) trusts a header a proxy injects: the device is whoever the tailnet says it is. That
// is only as good as the proxy's sanitisation and the identity provider's naming, and it cannot be
// revoked from the phone that lost the device. This module adds the other kind of proof — a bearer
// credential the device itself holds — on the same reasoning the pack link already runs on: network
// position is not identity (ADR 0013).
//
// The two gates are INDEPENDENT and compose by AND. Configuring one says nothing about the other,
// and the header gate's behaviour here is unchanged in every case.
//
// ── ENROLMENT ────────────────────────────────────────────────────────────────────────────────
// `bin/collie pair` mints a one-time code, writes its HASH (never the code) to
// `<stateDir>/pairing-pending.json`, and prints the code to the operator's terminal. The phone posts
// `{code,label}` to `/api/pair`, which mints a 256-bit token, stores only its SHA-256 in
// `<stateDir>/paired-devices.json`, and returns the token exactly once. The bridge re-reads both
// files at request time, so a pairing minted by the CLI needs no `systemctl restart`.
//
// ── WHY EVERY SIDE EFFECT IS INJECTED ────────────────────────────────────────────────────────
// The whole of this module is reachable from `bun test` (CLAUDE.md: Bun.serve/Bun.connect code is
// not). Nothing below opens a file itself — {@link PairingIo} is the only door out, and
// {@link filePairingIo} is the one implementation that touches a disk.

/** File under the state dir holding the pending (unclaimed) pairing code. */
export const PENDING_FILENAME = "pairing-pending.json";
/** File under the state dir holding the paired-device registry. */
export const DEVICES_FILENAME = "paired-devices.json";

/** How long a minted code stays claimable. */
export const CODE_TTL_MS = 10 * 60 * 1000;
/** Wrong-code attempts before the pending pairing is destroyed. */
export const CODE_ATTEMPTS = 5;
/** Codes are this many characters. */
export const CODE_LENGTH = 8;
/**
 * The code alphabet, with every glyph pair a human mistypes removed: no `0`/`O`, no `1`/`I`/`L`,
 * no `U`/`V`. The operator reads this off a terminal and types it on a phone keyboard.
 */
export const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTWXYZ";

/** At most one `lastSeenAt` write per device per this interval — a poll every 1.5s must not be a write. */
export const SEEN_THROTTLE_MS = 60_000;

// ── THE REGISTRY LOCK: ONE WRITER ACROSS PROCESSES, NOT ONE PER PROCESS ───────────────────────
//
// `paired-devices.json` has two writers in two processes: this bridge (enrol, stamp, adopt, revoke
// over the API) and `bin/collie devices revoke` (the CLI, `cli/pairing.ts`). Each write is a
// read-modify-write of the whole file, and the in-process queue below (`PairingStore.serialize`)
// orders only this bridge's own. A CLI revoke landing between the bridge's read and its write was
// overwritten by that write, and the revoked device's token hash came back (youngsecurity/collie#19).
// A credential store may not undo a revocation, so every read-modify-write, in BOTH processes, now
// runs inside one exclusive section: a lock FILE beside the registry, created with O_EXCL, which is
// the one primitive every filesystem answers atomically.
//
// The lock is bounded on both sides. A holder that died mid-write leaves a file; a waiter breaks it
// once it is older than {@link LOCK_STALE_MS}, which is orders of magnitude longer than any registry
// write. A waiter gives up after {@link LOCK_WAIT_MS} and the operation fails loudly rather than
// proceeding unlocked: a write that could not prove itself exclusive is a write that must not land.

/** File under the state dir that serialises registry writes across processes. */
export const LOCK_FILENAME = "paired-devices.lock";
/** A lock older than this was left by a process that died holding it; a waiter may break it. */
export const LOCK_STALE_MS = 10_000;
/** How long a writer waits for the lock before failing. A registry write takes milliseconds. */
export const LOCK_WAIT_MS = 5_000;
/** How often a waiter looks again. */
export const LOCK_POLL_MS = 20;
/**
 * The BREAK marker beside the lock, named in full so `solo-baseline.test.ts`'s scan can guard it. Breaking a stale lock is
 * itself exclusive, through this second O_EXCL file, because two waiters that both read the same
 * stale mtime would otherwise both `remove`, and the second remove could take away the FRESH lock the
 * first had just created. Only the waiter holding the marker removes the lock, and it re-reads the
 * lock's age under the marker first; a marker left by a breaker that died is itself broken once it
 * is stale.
 */
export const LOCK_BREAK_FILENAME = "paired-devices.lock.break";

/**
 * What one failed `createExclusive` means, as a pure decision over the facts a filesystem answers:
 * `wait` (someone holds it and it is recent), `break` (older than the stale bound: its holder is
 * gone), or `retry` (it vanished between the create and the stat, so the next create may win).
 */
export function lockVerdict(mtimeMs: number | null, now: number, staleMs = LOCK_STALE_MS): "wait" | "break" | "retry" {
  if (mtimeMs === null) return "retry";
  return now - mtimeMs >= staleMs ? "break" : "wait";
}

/** What the lock file says, for the operator who finds one: which process, and when. */
export function lockBody(pid: number, now: number): string {
  return `${JSON.stringify({ pid, at: now })}\n`;
}

/** The message a writer fails with when the lock never came free. */
export function lockTimeoutMessage(path: string, waitedMs: number): string {
  return `could not lock the paired-device registry within ${waitedMs}ms — another writer holds ${path}; if no \`collie\` process is running, remove it`;
}

/**
 * The three filesystem facts a lock needs, in the SYNCHRONOUS spelling the CLI's `Files` seam
 * offers. The bridge has its own async loop below over `fs/promises`; the decision both make per
 * attempt is {@link lockVerdict}, so they cannot disagree about when a lock is stale.
 */
export interface LockFsSync {
  /** Create `path` holding `text` only if it does not exist yet. False when it already does. */
  createExclusive(path: string, text: string): boolean;
  /** `path`'s mtime in epoch ms, or null when it is gone. */
  mtimeMs(path: string): number | null;
  /** `path`'s contents, or null when it is gone: the ownership proof {@link RegistryLock.assertHeld} reads. */
  read(path: string): string | null;
  /** Remove `path`; missing is success. */
  remove(path: string): void;
}

/**
 * The lock as the holder sees it. NOT just a release: a lock is taken by age as well as by absence
 * (a holder that died leaves a file, and a waiter breaks it once it is older than
 * {@link LOCK_STALE_MS}), so a holder that is merely PAUSED that long, a stopped process, a machine
 * asleep, comes back holding a lock somebody else has since replaced. Two writers would then be in
 * the section at once, and the old release would delete the new lock. So ownership is proved at
 * write time: {@link assertHeld} reads the file and compares it with the body this holder wrote
 * (pid and stamp, never the pid alone), and {@link release} removes the file only while it is still
 * that body. A holder that lost its lock cannot write, which is the one thing that must hold.
 */
export interface RegistryLock {
  /** Throws when the lock on disk is no longer this holder's. Called immediately before every write. */
  assertHeld(): void;
  /** Remove the lock, only if it is still this holder's. */
  release(): void;
}

/** The sentence a holder that lost its lock fails with. Nothing was written. */
export function lockLostMessage(path: string): string {
  return `the paired-device registry lock at ${path} is no longer this process's: it was held longer than ${LOCK_STALE_MS}ms and another writer took it over; nothing was written`;
}

/**
 * Take the registry lock synchronously and return the release. Throws after {@link LOCK_WAIT_MS};
 * the caller reports and does NOT write. `sleep` and `now` are injected so a test can run the loop
 * without a clock.
 */
export function acquireRegistryLockSync(
  fs: LockFsSync,
  stateDir: string,
  deps: { now: () => number; sleep: (ms: number) => void; pid: number },
  bounds: { staleMs?: number; waitMs?: number; pollMs?: number } = {},
): RegistryLock {
  const path = join(stateDir, LOCK_FILENAME);
  const staleMs = bounds.staleMs ?? LOCK_STALE_MS;
  const waitMs = bounds.waitMs ?? LOCK_WAIT_MS;
  const pollMs = bounds.pollMs ?? LOCK_POLL_MS;
  const started = deps.now();
  for (;;) {
    const body = lockBody(deps.pid, deps.now());
    if (fs.createExclusive(path, body)) {
      const held = (): boolean => fs.read(path) === body;
      return {
        assertHeld: () => {
          if (!held()) throw new Error(lockLostMessage(path));
        },
        release: () => {
          if (held()) fs.remove(path);
        },
      };
    }
    const verdict = lockVerdict(fs.mtimeMs(path), deps.now(), staleMs);
    if (verdict === "break") {
      const marker = join(stateDir, LOCK_BREAK_FILENAME);
      if (fs.createExclusive(marker, lockBody(deps.pid, deps.now()))) {
        // Under the marker, and only then: still the stale lock, or one somebody replaced meanwhile?
        if (lockVerdict(fs.mtimeMs(path), deps.now(), staleMs) === "break") fs.remove(path);
        fs.remove(marker);
      } else if (lockVerdict(fs.mtimeMs(marker), deps.now(), staleMs) === "break") {
        fs.remove(marker);
      }
    }
    // Every verdict pays the poll and counts against the bound, the break included: a remove that
    // silently fails, or a lock that keeps refusing the create while answering no mtime (a directory
    // at the path, a stat that fails), must still end in the refusal below, never in a loop that spins.
    if (deps.now() - started >= waitMs) throw new Error(lockTimeoutMessage(path, waitMs));
    deps.sleep(pollMs);
  }
}

/** The async twin of {@link LockFsSync}, for the bridge. */
export interface LockFsAsync {
  createExclusive(path: string, text: string): Promise<boolean>;
  mtimeMs(path: string): Promise<number | null>;
  read(path: string): Promise<string | null>;
  remove(path: string): Promise<void>;
}

/** {@link RegistryLock}, awaited. */
export interface RegistryLockAsync {
  assertHeld(): Promise<void>;
  release(): Promise<void>;
}

/** The async twin of {@link acquireRegistryLockSync}: same loop, same verdicts, same bounds. */
export async function acquireRegistryLock(
  fs: LockFsAsync,
  stateDir: string,
  deps: { now: () => number; sleep: (ms: number) => Promise<void>; pid: number },
  bounds: { staleMs?: number; waitMs?: number; pollMs?: number } = {},
): Promise<RegistryLockAsync> {
  const path = join(stateDir, LOCK_FILENAME);
  const staleMs = bounds.staleMs ?? LOCK_STALE_MS;
  const waitMs = bounds.waitMs ?? LOCK_WAIT_MS;
  const pollMs = bounds.pollMs ?? LOCK_POLL_MS;
  const started = deps.now();
  for (;;) {
    const body = lockBody(deps.pid, deps.now());
    if (await fs.createExclusive(path, body)) {
      const held = async (): Promise<boolean> => (await fs.read(path)) === body;
      return {
        assertHeld: async () => {
          if (!(await held())) throw new Error(lockLostMessage(path));
        },
        release: async () => {
          if (await held()) await fs.remove(path);
        },
      };
    }
    const verdict = lockVerdict(await fs.mtimeMs(path), deps.now(), staleMs);
    if (verdict === "break") {
      const marker = join(stateDir, LOCK_BREAK_FILENAME);
      if (await fs.createExclusive(marker, lockBody(deps.pid, deps.now()))) {
        if (lockVerdict(await fs.mtimeMs(path), deps.now(), staleMs) === "break") await fs.remove(path);
        await fs.remove(marker);
      } else if (lockVerdict(await fs.mtimeMs(marker), deps.now(), staleMs) === "break") {
        await fs.remove(marker);
      }
    }
    if (deps.now() - started >= waitMs) throw new Error(lockTimeoutMessage(path, waitMs));
    await deps.sleep(pollMs);
  }
}

/** A minted, not-yet-claimed pairing code. Only its hash is ever persisted. */
export type PendingPairing = {
  /** SHA-256 (hex) of the normalised code. */
  codeHash: string;
  /** Epoch ms after which the code is dead. */
  expiresAt: number;
  /** Wrong guesses left before the pending pairing is destroyed. */
  attemptsLeft: number;
};

/** One paired device. The token itself was shown once, at claim time, and is not recoverable. */
export type PairedDevice = {
  /** Operator-facing name, unique across the registry. */
  label: string;
  /** SHA-256 (hex) of the bearer token. */
  tokenHash: string;
  createdAt: number;
  lastSeenAt: number;
};

/** The on-disk registry shape. An object (not a bare array) so it can gain keys without a migration. */
export type PairedRegistry = {
  devices: PairedDevice[];
};

/** A paired device as the API reports it — the hash never leaves the bridge. */
export interface PairedDeviceWire {
  label: string;
  createdAt: number;
  lastSeenAt: number;
  /** True for the device making this request (so the UI can say "this device"). */
  current: boolean;
}

export const EMPTY_REGISTRY: PairedRegistry = { devices: [] };

// ── Pure helpers ─────────────────────────────────────────────────────────────────────────────

/** SHA-256 as lowercase hex. Used for both codes and tokens — never store either in the clear. */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Compare two hex digests without leaking where they diverge. Both are SHA-256 output, so they are
 * always the same length here; a length mismatch (a corrupted file) is a plain `false` rather than a
 * throw from `timingSafeEqual`.
 */
export function hashesEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/**
 * Uppercase and strip everything that isn't in the alphabet, so the operator may type the code with
 * spaces, dashes or in lower case. Deliberately NOT a spelling-correction pass (`O`→`0`): the
 * alphabet has no confusable pairs left, so anything outside it is a typo the attempt counter should
 * see, not a character to guess at.
 */
export function normalizeCode(raw: string): string {
  return raw.toUpperCase().replace(new RegExp(`[^${CODE_ALPHABET}]`, "g"), "");
}

/** Mint a fresh code. `random` is injected so the generator is testable and deterministic. */
export function generateCode(random: (n: number) => Buffer = randomBytes): string {
  // Rejection-free and unbiased enough: one byte per character, modulo an alphabet that divides
  // 256 unevenly, biases the first few glyphs by <1.5% — which changes nothing for a code that
  // lives 10 minutes behind a 5-attempt counter. Drawn a byte at a time so a short read is loud.
  const bytes = random(CODE_LENGTH);
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) out += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  return out;
}

/** Mint a 256-bit bearer token, base64url. This is the only time the token exists in the clear. */
export function generateToken(random: (n: number) => Buffer = randomBytes): string {
  return random(32).toString("base64url");
}

/** A fresh pending pairing for `code`, expiring `ttlMs` from `now`. */
export function newPending(code: string, now: number, ttlMs = CODE_TTL_MS): PendingPairing {
  return { codeHash: sha256Hex(normalizeCode(code)), expiresAt: now + ttlMs, attemptsLeft: CODE_ATTEMPTS };
}

/**
 * The one line a failed `lastSeenAt` stamp is allowed to cost. The operation's own body catches its
 * disk errors; this handles the lock refusing BEFORE the body runs (`serialize` takes it first), so
 * a stamp, which is decoration, is a warning and never an unhandled rejection.
 */
function warnStampFailed<TError>(err: TError): void {
  console.warn(`[pairing] could not stamp lastSeenAt: ${err instanceof Error ? err.message : String(err)}`);
}

/** Coerce an untrusted parsed value into a {@link PendingPairing}, or null if it isn't one. */
export function coercePending(raw: JsonValue | undefined): PendingPairing | null {
  if (typeof raw !== "object" || raw === null || raw === undefined || Array.isArray(raw)) return null;
  const o: JsonObject = raw;
  if (typeof o.codeHash !== "string" || o.codeHash === "") return null;
  if (typeof o.expiresAt !== "number" || !Number.isFinite(o.expiresAt)) return null;
  if (typeof o.attemptsLeft !== "number" || !Number.isFinite(o.attemptsLeft)) return null;
  return { codeHash: o.codeHash, expiresAt: o.expiresAt, attemptsLeft: Math.floor(o.attemptsLeft) };
}

/**
 * Coerce an untrusted parsed value into a registry, dropping any entry that isn't a complete device.
 * A half-written or hand-edited file therefore degrades to "fewer paired devices", never to a device
 * with an empty `tokenHash` — which would otherwise authorise a caller whose token hashes to "".
 */
export function coerceRegistry(raw: JsonValue | undefined): PairedRegistry {
  const o: JsonObject =
    typeof raw === "object" && raw !== null && raw !== undefined && !Array.isArray(raw) ? raw : {};
  const list = Array.isArray(o.devices) ? o.devices : [];
  const devices: PairedDevice[] = [];
  for (const d of list) {
    if (typeof d !== "object" || d === null || Array.isArray(d)) continue;
    if (typeof d.label !== "string" || d.label.trim() === "") continue;
    if (typeof d.tokenHash !== "string" || d.tokenHash.length !== 64) continue;
    if (devices.some((x) => x.label === d.label)) continue;
    devices.push({
      label: d.label,
      tokenHash: d.tokenHash,
      createdAt: typeof d.createdAt === "number" ? d.createdAt : 0,
      lastSeenAt: typeof d.lastSeenAt === "number" ? d.lastSeenAt : 0,
    });
  }
  return { devices };
}

/**
 * Validate and bound a client-supplied label. Returns null when it is unusable — the same answer for
 * "empty" and "1 KB of newlines", because the label is echoed into the audit log and the UI.
 */
export function normalizeLabel(raw: JsonValue | undefined): string | null {
  if (typeof raw !== "string") return null;
  const label = raw.replace(/[\r\n\t]+/g, " ").trim();
  if (label === "" || label.length > 48) return null;
  return label;
}

/** Why a claim failed. `expired`/`exhausted` mean the pending pairing is now gone. */
export type ClaimFailure = "no-pending" | "expired" | "exhausted" | "bad-code" | "duplicate-label";

export type ClaimVerdict =
  | { ok: true }
  /** `pending` is the state to persist, or null when the pending pairing must be deleted. */
  | { ok: false; reason: ClaimFailure; pending: PendingPairing | null };

/**
 * The whole of the code check, as one pure decision: is this claim good, and what should the pending
 * file look like afterwards. The caller persists the verdict; nothing here touches a disk.
 *
 * An expired code is destroyed rather than left to be guessed at leisure, and the last wrong attempt
 * destroys it too — so a code is at most 5 guesses out of 29^8 (~5e11), for 10 minutes.
 */
export function checkClaim(
  pending: PendingPairing | null,
  code: string,
  now: number,
): ClaimVerdict {
  if (!pending) return { ok: false, reason: "no-pending", pending: null };
  if (now >= pending.expiresAt) return { ok: false, reason: "expired", pending: null };
  if (pending.attemptsLeft <= 0) return { ok: false, reason: "exhausted", pending: null };
  if (hashesEqual(pending.codeHash, sha256Hex(normalizeCode(code)))) return { ok: true };
  const attemptsLeft = pending.attemptsLeft - 1;
  if (attemptsLeft <= 0) return { ok: false, reason: "exhausted", pending: null };
  return { ok: false, reason: "bad-code", pending: { ...pending, attemptsLeft } };
}

/** The device whose token hash matches, or null. Every entry is compared, in constant time each. */
export function findByToken(registry: PairedRegistry, token: string | null): PairedDevice | null {
  if (token === null || token === "") return null;
  const hash = sha256Hex(token);
  // Not short-circuited on the first match: `find` would return early, but the loop still visits
  // every entry before that one, so the timing signal is "how far down the list you are" — which is
  // not a secret (labels are readable) and is unrelated to the token bytes.
  let found: PairedDevice | null = null;
  for (const d of registry.devices) {
    if (hashesEqual(d.tokenHash, hash)) found = d;
  }
  return found;
}

/** Add a device, or null when the label is already taken (labels are the revoke handle). */
export function addDevice(
  registry: PairedRegistry,
  device: { label: string; tokenHash: string; now: number },
): PairedRegistry | null {
  if (registry.devices.some((d) => d.label === device.label)) return null;
  return {
    devices: [
      ...registry.devices,
      { label: device.label, tokenHash: device.tokenHash, createdAt: device.now, lastSeenAt: device.now },
    ],
  };
}

/** Drop a device by label. Returns null when there was no such device (so a caller can 404). */
export function removeDevice(registry: PairedRegistry, label: string): PairedRegistry | null {
  if (!registry.devices.some((d) => d.label === label)) return null;
  return { devices: registry.devices.filter((d) => d.label !== label) };
}

/**
 * Stamp `lastSeenAt`, or null when the previous stamp is recent enough that a write would be noise.
 * The throttle is the whole reason this is a function: `resolve()` runs on every request.
 */
export function touchDevice(
  registry: PairedRegistry,
  label: string,
  now: number,
  throttleMs = SEEN_THROTTLE_MS,
): PairedRegistry | null {
  const device = registry.devices.find((d) => d.label === label);
  if (!device) return null;
  if (now - device.lastSeenAt < throttleMs) return null;
  return { devices: registry.devices.map((d) => (d.label === label ? { ...d, lastSeenAt: now } : d)) };
}

/** The wire shape of the registry, for `GET /api/devices`. */
export function toDeviceWire(registry: PairedRegistry, current: string | null): PairedDeviceWire[] {
  return registry.devices.map((d) => ({
    label: d.label,
    createdAt: d.createdAt,
    lastSeenAt: d.lastSeenAt,
    current: d.label === current,
  }));
}

/**
 * The `Authorization: Bearer <token>` value, or null. Case-insensitive on the scheme (RFC 7235) and
 * tolerant of extra spacing, because a proxy may rewrite whitespace.
 */
export function bearerToken(headers: { get(name: string): string | null }): string | null {
  const raw = headers.get("authorization");
  if (!raw) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(raw.trim());
  return match ? match[1]! : null;
}

// ── The store ────────────────────────────────────────────────────────────────────────────────

/**
 * Every disk touch this module makes. Async everywhere except {@link PairingIo.readRegistrySync},
 * which exists because the write gate (`guard()` in bridge/server.ts) is synchronous and must see a
 * revocation made by `bin/collie devices revoke` in another process without a restart.
 */
export interface PairingIo {
  readPending(): Promise<JsonValue | null>;
  writePending(pending: PendingPairing): Promise<void>;
  deletePending(): Promise<void>;
  readRegistry(): Promise<JsonValue | null>;
  writeRegistry(registry: PairedRegistry): Promise<void>;
  /** The registry as of now, read synchronously. Null ⇒ no registry file. */
  readRegistrySync(): JsonValue | null;
  /**
   * Take the cross-process registry lock and resolve to its release. Every read-modify-write of the
   * registry runs between the two ({@link PairingStore.serialize}); a reader never takes it, because
   * a write is one `rename` and a reader sees the old file or the new one.
   */
  lockRegistry(): Promise<RegistryLockAsync>;
}

/**
 * The real, owner-only implementation over `<stateDir>`.
 *
 * `readRegistrySync` stats before it reads and serves a cached parse when nothing changed, so the
 * per-request cost of the gate is one `stat` — not a parse — while a CLI revocation still lands on
 * the very next request.
 */
/** A JSON file's parsed contents, or null when it is missing or unreadable. */
async function readJson(path: string): Promise<JsonValue | null> {
  try {
    // SAFETY: `JSON.parse` output IS a JsonValue by construction; every caller re-coerces it.
    return JSON.parse(await readFile(path, "utf8")) as JsonValue;
  } catch {
    return null;
  }
}

export function filePairingIo(stateDir: string): PairingIo {
  const pendingPath = join(stateDir, PENDING_FILENAME);
  const registryPath = join(stateDir, DEVICES_FILENAME);
  let cache: { key: string; value: JsonValue } | null = null;

  // Every temp name is unique to one write. A shared `${path}.tmp` is only atomic against a reader:
  // two writers both create it, the first `rename` moves it away, and the second gets ENOENT (#159).
  // The pid keeps another PROCESS off the name; the counter keeps another write in THIS one off it.
  let writeSeq = 0;
  const writeAtomic = async (path: string, text: string): Promise<void> => {
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.${++writeSeq}.tmp`;
    await writeFile(tmp, text, { mode: 0o600 });
    try {
      await rename(tmp, path);
    } catch (err) {
      // The temp name is ours alone, so nobody else will ever clear what a failed rename left.
      try {
        await unlink(tmp);
      } catch {
        /* gone already — nothing to clean up */
      }
      throw err;
    }
  };

  return {
    readPending: () => readJson(pendingPath),
    writePending: (pending) => writeAtomic(pendingPath, JSON.stringify(pending, null, 2)),
    async deletePending() {
      try {
        await unlink(pendingPath);
      } catch {
        /* already gone — deleting a spent pairing is idempotent */
      }
    },
    readRegistry: () => readJson(registryPath),
    async writeRegistry(registry) {
      await writeAtomic(registryPath, JSON.stringify(registry, null, 2));
      cache = null;
    },
    async lockRegistry() {
      await mkdir(stateDir, { recursive: true, mode: 0o700 });
      return acquireRegistryLock(
        {
          async createExclusive(path, text) {
            try {
              // `wx`: O_CREAT | O_EXCL. The one atomic "is anyone else here" every filesystem answers.
              await writeFile(path, text, { flag: "wx", mode: 0o600 });
              return true;
            } catch (err) {
              if (err instanceof Error && "code" in err && err.code === "EEXIST") return false;
              throw err;
            }
          },
          async mtimeMs(path) {
            try {
              return (await stat(path)).mtimeMs;
            } catch {
              return null;
            }
          },
          async read(path) {
            try {
              return await readFile(path, "utf8");
            } catch {
              return null;
            }
          },
          async remove(path) {
            try {
              await unlink(path);
            } catch {
              /* gone already */
            }
          },
        },
        stateDir,
        { now: Date.now, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), pid: process.pid },
      );
    },
    readRegistrySync() {
      let key: string;
      try {
        const st = statSync(registryPath);
        key = `${st.mtimeMs}:${st.size}`;
      } catch {
        cache = null;
        return null;
      }
      if (cache?.key === key) return cache.value;
      try {
        // SAFETY: `JSON.parse` output IS a JsonValue by construction; `coerceRegistry` re-checks it.
        const value = JSON.parse(readFileSync(registryPath, "utf8")) as JsonValue;
        cache = { key, value };
        return value;
      } catch {
        return null;
      }
    },
  };
}

/**
 * The bridge's view of pairing: a synchronous gate for the request path, plus the async enrolment
 * and revocation operations.
 *
 * "Enforced" is not a setting — it is `the registry is non-empty`. Pairing nobody keeps Collie
 * exactly as it was; pairing one device turns the requirement on for every device, which is the only
 * ordering that can't lock the operator out of their own bridge halfway through.
 */
export class PairingStore {
  constructor(
    private readonly io: PairingIo,
    private readonly now: () => number = Date.now,
    private readonly random: (n: number) => Buffer = randomBytes,
  ) {}

  /**
   * The tail of this store's registry write chain. Every read-modify-write of the registry runs
   * through {@link serialize}, so two of them never interleave: without it, one poll tick's snapshot
   * request and pane read both read, both decide to stamp, and both write at once (#159).
   */
  private writeQueue: Promise<unknown> = Promise.resolve();

  /**
   * Run `op` after every registry write already queued on this store, INSIDE the cross-process
   * registry lock, and return what it returns. The queue orders this bridge's own writes; the lock
   * orders them against the CLI's (`cli/pairing.ts`, `devices revoke`), which is the other process
   * that writes this file. `op` is passed as BOTH handlers so a failed operation still lets the next
   * one start, and the stored tail can never reject — nothing awaits it for a value, only for its
   * turn. The lock is released whatever `op` does.
   */
  private serialize<T>(op: (commit: (registry: PairedRegistry) => Promise<void>) => Promise<T>): Promise<T> {
    const locked = async (): Promise<T> => {
      const lock = await this.io.lockRegistry();
      // Every registry write goes through `commit`, which proves the lock is still ours immediately
      // before the write (`RegistryLock`): a holder paused past the stale bound has been replaced,
      // and must not write over the replacement's work.
      const commit = async (registry: PairedRegistry): Promise<void> => {
        await lock.assertHeld();
        await this.io.writeRegistry(registry);
      };
      try {
        return await op(commit);
      } finally {
        await lock.release();
      }
    };
    const next = this.writeQueue.then(locked, locked);
    this.writeQueue = next.catch(() => undefined);
    return next;
  }

  /**
   * Resolves once every registry write this store has started has finished. The stamp in
   * {@link resolve} is deliberately fire-and-forget, so this is the only way to observe it landing.
   * Never awaited on the request path.
   */
  async idle(): Promise<void> {
    await this.writeQueue;
  }

  /** The registry as of this instant, straight off disk (cached on mtime). */
  registry(): PairedRegistry {
    return coerceRegistry(this.io.readRegistrySync());
  }

  /** Whether a bearer token is required for writes — i.e. whether anything is paired at all. */
  enforced(): boolean {
    return this.registry().devices.length > 0;
  }

  /**
   * The device this request's bearer token belongs to, or null. Also stamps `lastSeenAt`, throttled
   * and fire-and-forget: a failed stamp must never fail the request it was decorating.
   */
  resolve(token: string | null): PairedDevice | null {
    const registry = this.registry();
    const device = findByToken(registry, token);
    if (!device) return null;
    const touched = touchDevice(registry, device.label, this.now());
    if (touched) {
      // Fire-and-forget: a failed stamp must never fail the request that triggered it.
      void this.serialize(async (commit) => {
        try {
          // ── RE-DERIVED FROM DISK, NEVER WRITTEN FROM THE SNAPSHOT ABOVE ────
          // `touched` was computed from a registry read at the top of this synchronous call, and
          // this write lands later. `bin/collie devices revoke` runs in ANOTHER process and writes
          // the same file, so writing `touched` blind would put a revoked device BACK — a stamp
          // silently undoing a revocation, which is the one thing a credential store may not do.
          // Re-reading here costs one file read at most once per device per minute (the throttle
          // above is what makes this path rare), and a device gone in the meantime is not stamped.
          //
          // The re-read and the throttle check are INSIDE the serialized section on purpose: a
          // second stamp from the same poll tick then reads the first one's timestamp and becomes a
          // no-op, instead of racing it to the same file.
          const current = coerceRegistry(await this.io.readRegistry());
          const fresh = touchDevice(current, device.label, this.now());
          if (fresh === null) return;
          await commit(fresh);
        } catch (err) {
          console.warn(
            `[pairing] could not stamp lastSeenAt: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }).catch(warnStampFailed);
    }
    return device;
  }

  /**
   * Claim the pending code and enrol `label`. On success the token is returned ONCE — it is not
   * stored, recoverable or re-derivable — and the pending pairing is destroyed, so a code is
   * single-use even within its TTL.
   *
   * VALIDATE, ENROL AND CONSUME ARE ONE SERIALIZED SECTION. Checking the code before entering it let
   * two concurrent claims with one code and two labels both pass the check, both enrol, and both
   * walk away with a token (youngsecurity/collie#19). The pending file is read, judged, and deleted
   * or rewritten in the same turn as the registry write, so the second claim reads the record the
   * first one already spent.
   */
  async claim(code: string, label: string): Promise<{ ok: true; token: string } | { ok: false; reason: ClaimFailure }> {
    return this.serialize(async (commit) => {
      const pending = coercePending(await this.io.readPending());
      const verdict = checkClaim(pending, code, this.now());
      if (!verdict.ok) {
        if (verdict.pending === null) await this.io.deletePending();
        else await this.io.writePending(verdict.pending);
        return { ok: false, reason: verdict.reason };
      }
      const token = generateToken(this.random);
      const next = addDevice(coerceRegistry(await this.io.readRegistry()), {
        label,
        tokenHash: sha256Hex(token),
        now: this.now(),
      });
      // A duplicate label leaves the pending pairing alive: the operator retries with another name
      // rather than re-running `collie pair`.
      if (!next) return { ok: false, reason: "duplicate-label" };
      await commit(next);
      await this.io.deletePending();
      return { ok: true, token };
    });
  }

  /**
   * Adopt a lead's synced entries into this machine's own registry — **at takeover commit, and only
   * then** (RFC §6.5, `bridge/pack/standby-devices.ts`).
   *
   * After the commit this machine IS the lead, so the phone must keep working against the very
   * credential it already holds; before it, adopting would silently arm this machine's own write gate
   * for an operator who never ran `collie pair` here. That is why this is a verb the takeover calls
   * rather than something the sync does.
   *
   * Returns the colliding labels, and writes NOTHING when there are any — refuse and report, never
   * namespace-and-merge (RFC §16, decision 6): a label is the revoke handle.
   */
  async adopt(devices: readonly { label: string; tokenHash: string; createdAt: number }[]): Promise<string[]> {
    return this.serialize(async (commit) => {
      const own = coerceRegistry(await this.io.readRegistry());
      const collisions = devices.filter((d) => own.devices.some((x) => x.label === d.label)).map((d) => d.label);
      if (collisions.length > 0) return collisions;
      await commit({
        devices: [
          ...own.devices,
          // `lastSeenAt: 0` — never contacted THIS machine, and copying the lead's stamp would be this
          // machine asserting traffic it never saw.
          ...devices.map((d) => ({ label: d.label, tokenHash: d.tokenHash, createdAt: d.createdAt, lastSeenAt: 0 })),
        ],
      });
      return [];
    });
  }

  /** Drop a device. False ⇒ no such label. */
  async revoke(label: string): Promise<boolean> {
    return this.serialize(async (commit) => {
      const next = removeDevice(coerceRegistry(await this.io.readRegistry()), label);
      if (!next) return false;
      await commit(next);
      return true;
    });
  }
}

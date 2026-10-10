import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HOST } from "./host.ts";
import { ensureOwnerOnlyDir, isOwnerOnly, privateRoot } from "./owner-only.ts";
import {
  acquireRegistryLock,
  acquireRegistryLockSync,
  addDevice,
  enrolDevice,
  bearerToken,
  checkClaim,
  CODE_ALPHABET,
  CODE_ATTEMPTS,
  CODE_LENGTH,
  coercePending,
  coerceRegistry,
  DEVICES_FILENAME,
  EMPTY_REGISTRY,
  filePairingIo,
  findByToken,
  generateCode,
  generateToken,
  hashesEqual,
  LOCK_BREAK_FILENAME,
  LOCK_FILENAME,
  LOCK_STALE_MS,
  lockBody,
  lockPidOf,
  lockVerdict,
  isExpired,
  MAX_LIFETIME_MS,
  newPending,
  normalizeCode,
  normalizeLabel,
  PairingStore,
  parseLifetime,
  parseRegistryText,
  PENDING_FILENAME,
  RegistryUnreadableError,
  removeDevice,
  setDeviceExpiry,
  sha256Hex,
  toDeviceWire,
  touchDevice,
  type LockFsSync,
  type PairedRegistry,
  type PairingIo,
  type PendingPairing,
} from "./pairing.ts";

/** What {@link memoryIo} keeps instead of the two on-disk files, plus a write counter. */
interface MemoryPairingState {
  pending: PendingPairing | null;
  registry: PairedRegistry | null;
  writes: number;
  /** `lock` / `write` / `unlock`, in order: the proof that every write sat inside the lock. */
  trace: string[];
  /** True while the fake lock is taken; a second take while it is set is the bug. */
  locked: boolean;
}

// A fully in-memory PairingIo. The store is written so that this is the ONLY thing standing between
// `bun test` and every branch of enrolment/revocation — no temp dir, no Bun.serve.
function memoryIo(seed: { pending?: PendingPairing | null; registry?: PairedRegistry } = {}) {
  const state: MemoryPairingState = {
    pending: seed.pending ?? null,
    registry: seed.registry ?? null,
    writes: 0,
    trace: [],
    locked: false,
  };
  const io: PairingIo = {
    readPending: async () => state.pending,
    writePending: async (p) => {
      state.pending = p;
    },
    deletePending: async () => {
      state.pending = null;
    },
    readRegistry: async () => state.registry,
    writeRegistry: async (r) => {
      state.registry = r;
      state.writes++;
      state.trace.push("write");
    },
    readRegistrySync: () => state.registry,
    lockRegistry: async () => {
      if (state.locked) throw new Error("the fake lock was taken twice");
      state.locked = true;
      state.trace.push("lock");
      return {
        assertHeld: async () => {
          if (!state.locked) throw new Error("lock lost");
        },
        release: async () => {
          state.locked = false;
          state.trace.push("unlock");
        },
      };
    },
  };
  return { io, state };
}

/** Deterministic "randomness": a repeating byte pattern, so codes and tokens are pinnable. */
const fixedRandom = (byte: number) => (n: number) => Buffer.alloc(n, byte);

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});
async function tempStateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "collie-pairing-"));
  dirs.push(dir);
  return dir;
}

describe("code minting", () => {
  test("a code is CODE_LENGTH characters, all from the unambiguous alphabet", () => {
    for (let i = 0; i < 200; i++) {
      const code = generateCode();
      expect(code).toHaveLength(CODE_LENGTH);
      for (const ch of code) expect(CODE_ALPHABET).toContain(ch);
    }
  });

  test("the alphabet excludes every glyph pair a human confuses", () => {
    for (const banned of ["0", "O", "1", "I", "L", "U", "V"]) {
      expect(CODE_ALPHABET).not.toContain(banned);
    }
  });

  test("normalizeCode is case-insensitive and forgives spacing/dashes", () => {
    expect(normalizeCode("abcd-2345")).toBe(normalizeCode("ABCD 2345"));
    expect(normalizeCode(" a b c d 2 3 4 5 ")).toBe("ABCD2345");
  });

  test("a character outside the alphabet is dropped, not guessed at", () => {
    // '0' is not in the alphabet and is NOT rewritten to 'O' — a typo must reach the attempt counter.
    expect(normalizeCode("ABCD234O")).toBe("ABCD234");
  });

  test("a token is 256 bits, base64url, and never repeats", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const token = generateToken();
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(Buffer.from(token, "base64url")).toHaveLength(32);
      expect(seen.has(token)).toBe(false);
      seen.add(token);
    }
  });

  test("newPending stores the hash, never the code", () => {
    const pending = newPending("ABCD2345", 1000);
    expect(pending.codeHash).toBe(sha256Hex("ABCD2345"));
    expect(JSON.stringify(pending)).not.toContain("ABCD2345");
    expect(pending.attemptsLeft).toBe(CODE_ATTEMPTS);
  });
});

describe("hashesEqual", () => {
  test("equal digests match, different ones don't", () => {
    expect(hashesEqual(sha256Hex("a"), sha256Hex("a"))).toBe(true);
    expect(hashesEqual(sha256Hex("a"), sha256Hex("b"))).toBe(false);
  });

  test("a length mismatch is false, not a throw (timingSafeEqual would throw)", () => {
    expect(hashesEqual("abc", sha256Hex("a"))).toBe(false);
    expect(hashesEqual("", "")).toBe(true);
  });
});

describe("checkClaim — the code lifecycle", () => {
  const now = 10_000;
  const pending = newPending("ABCD2345", now);

  test("the right code, in time, is accepted", () => {
    expect(checkClaim(pending, "abcd-2345", now + 1)).toEqual({ ok: true });
  });

  test("no pending pairing at all", () => {
    expect(checkClaim(null, "ABCD2345", now)).toEqual({ ok: false, reason: "no-pending", pending: null });
  });

  test("an expired code is destroyed, not left to be guessed at leisure", () => {
    const verdict = checkClaim(pending, "ABCD2345", pending.expiresAt);
    expect(verdict).toEqual({ ok: false, reason: "expired", pending: null });
  });

  test("a wrong code decrements the counter and keeps the pairing alive", () => {
    const verdict = checkClaim(pending, "ZZZZ9999", now);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.reason).toBe("bad-code");
    expect(verdict.pending?.attemptsLeft).toBe(CODE_ATTEMPTS - 1);
  });

  test("the last wrong attempt destroys the pairing", () => {
    let current: PendingPairing | null = pending;
    for (let i = 0; i < CODE_ATTEMPTS; i++) {
      const verdict = checkClaim(current, "ZZZZ9999", now);
      expect(verdict.ok).toBe(false);
      if (verdict.ok) throw new Error("unreachable");
      current = verdict.pending;
      if (i < CODE_ATTEMPTS - 1) {
        expect(verdict.reason).toBe("bad-code");
        expect(current).not.toBeNull();
      } else {
        expect(verdict.reason).toBe("exhausted");
        expect(current).toBeNull();
      }
    }
  });

  test("a zero-attempt pending pairing is exhausted before the code is even compared", () => {
    const spent = { ...pending, attemptsLeft: 0 };
    expect(checkClaim(spent, "ABCD2345", now)).toEqual({ ok: false, reason: "exhausted", pending: null });
  });

  test("expiry outranks attempts — an expired pairing never spends a guess", () => {
    expect(checkClaim(pending, "ZZZZ9999", pending.expiresAt + 1)).toEqual({
      ok: false,
      reason: "expired",
      pending: null,
    });
  });
});

describe("registry operations", () => {
  test("addDevice appends with both timestamps stamped", () => {
    const next = addDevice(EMPTY_REGISTRY, { label: "phone", tokenHash: sha256Hex("t"), now: 5 });
    expect(next?.devices).toEqual([
      { label: "phone", tokenHash: sha256Hex("t"), createdAt: 5, lastSeenAt: 5 },
    ]);
  });

  test("labels are unique — a duplicate is refused", () => {
    const one = addDevice(EMPTY_REGISTRY, { label: "phone", tokenHash: sha256Hex("t"), now: 5 })!;
    expect(addDevice(one, { label: "phone", tokenHash: sha256Hex("u"), now: 6 })).toBeNull();
    // …and a different label on the same registry is fine.
    expect(addDevice(one, { label: "tablet", tokenHash: sha256Hex("u"), now: 6 })?.devices).toHaveLength(2);
  });

  test("removeDevice drops one entry; an unknown label is null", () => {
    const two = addDevice(
      addDevice(EMPTY_REGISTRY, { label: "phone", tokenHash: sha256Hex("t"), now: 1 })!,
      { label: "tablet", tokenHash: sha256Hex("u"), now: 2 },
    )!;
    expect(removeDevice(two, "phone")?.devices.map((d) => d.label)).toEqual(["tablet"]);
    expect(removeDevice(two, "laptop")).toBeNull();
  });

  test("addDevice/removeDevice never mutate the registry they were given", () => {
    const one = addDevice(EMPTY_REGISTRY, { label: "phone", tokenHash: sha256Hex("t"), now: 1 })!;
    addDevice(one, { label: "tablet", tokenHash: sha256Hex("u"), now: 2 });
    removeDevice(one, "phone");
    expect(one.devices.map((d) => d.label)).toEqual(["phone"]);
    expect(EMPTY_REGISTRY.devices).toHaveLength(0);
  });

  test("findByToken matches the hash, not the token", () => {
    const registry = addDevice(EMPTY_REGISTRY, {
      label: "phone",
      tokenHash: sha256Hex("secret-token"),
      now: 1,
    })!;
    expect(findByToken(registry, "secret-token")?.label).toBe("phone");
    expect(findByToken(registry, "secret-toke")).toBeNull();
    expect(findByToken(registry, "")).toBeNull();
    expect(findByToken(registry, null)).toBeNull();
    // The stored value is a hash, so presenting the hash itself must not authenticate.
    expect(findByToken(registry, sha256Hex("secret-token"))).toBeNull();
  });

  test("a revoked device's token stops resolving", () => {
    const registry = addDevice(EMPTY_REGISTRY, { label: "phone", tokenHash: sha256Hex("t"), now: 1 })!;
    expect(findByToken(registry, "t")).not.toBeNull();
    expect(findByToken(removeDevice(registry, "phone")!, "t")).toBeNull();
  });

  test("touchDevice throttles: a second stamp inside the window is no write at all", () => {
    const registry = addDevice(EMPTY_REGISTRY, { label: "phone", tokenHash: sha256Hex("t"), now: 1000 })!;
    expect(touchDevice(registry, "phone", 1000 + 500, 60_000)).toBeNull();
    const stamped = touchDevice(registry, "phone", 1000 + 60_000, 60_000);
    expect(stamped?.devices[0]?.lastSeenAt).toBe(61_000);
    expect(touchDevice(registry, "nobody", 999_999, 60_000)).toBeNull();
  });

  test("toDeviceWire never leaks a token hash and marks the current device", () => {
    const registry = addDevice(
      addDevice(EMPTY_REGISTRY, { label: "phone", tokenHash: sha256Hex("t"), now: 1 })!,
      { label: "tablet", tokenHash: sha256Hex("u"), now: 2 },
    )!;
    const wire = toDeviceWire(registry, "tablet");
    expect(JSON.stringify(wire)).not.toContain(sha256Hex("t"));
    expect(wire.map((d) => [d.label, d.current])).toEqual([
      ["phone", false],
      ["tablet", true],
    ]);
    expect(toDeviceWire(registry, null).every((d) => !d.current)).toBe(true);
  });
});

describe("untrusted-input coercion", () => {
  test("coercePending rejects anything that isn't a complete pending pairing", () => {
    expect(coercePending(null)).toBeNull();
    expect(coercePending("nope")).toBeNull();
    expect(coercePending({ codeHash: "", expiresAt: 1, attemptsLeft: 1 })).toBeNull();
    expect(coercePending({ codeHash: "x", expiresAt: "soon", attemptsLeft: 1 })).toBeNull();
    expect(coercePending({ codeHash: "x", expiresAt: 1, attemptsLeft: 3 })).toEqual({
      codeHash: "x",
      expiresAt: 1,
      attemptsLeft: 3,
    });
  });

  test("coerceRegistry drops malformed entries rather than trusting them", () => {
    const raw = {
      devices: [
        { label: "good", tokenHash: sha256Hex("t"), createdAt: 1, lastSeenAt: 2 },
        // An empty/short hash would otherwise authorise a caller whose token hashes to it.
        { label: "no-hash", tokenHash: "", createdAt: 1, lastSeenAt: 2 },
        { label: "short-hash", tokenHash: "abc", createdAt: 1, lastSeenAt: 2 },
        { label: "  ", tokenHash: sha256Hex("u"), createdAt: 1, lastSeenAt: 2 },
        { tokenHash: sha256Hex("v") },
        "not an object",
        // A duplicate label in a hand-edited file keeps the FIRST entry only.
        { label: "good", tokenHash: sha256Hex("w"), createdAt: 9, lastSeenAt: 9 },
      ],
    };
    const registry = coerceRegistry(raw);
    expect(registry.devices.map((d) => d.label)).toEqual(["good"]);
    expect(findByToken(registry, "")).toBeNull();
  });

  test("coerceRegistry turns junk into an empty registry (⇒ pairing simply off)", () => {
    expect(coerceRegistry(null)).toEqual({ devices: [] });
    expect(coerceRegistry({ devices: "everything" })).toEqual({ devices: [] });
    expect(coerceRegistry(42)).toEqual({ devices: [] });
  });

  test("normalizeLabel bounds and flattens what the UI and the audit log will echo", () => {
    expect(normalizeLabel("  Pixel 9  ")).toBe("Pixel 9");
    expect(normalizeLabel("a\nb")).toBe("a b");
    expect(normalizeLabel("")).toBeNull();
    expect(normalizeLabel("   ")).toBeNull();
    expect(normalizeLabel("x".repeat(49))).toBeNull();
    expect(normalizeLabel(42)).toBeNull();
    expect(normalizeLabel(undefined)).toBeNull();
  });
});

describe("bearerToken", () => {
  const h = (value: string | null) => ({ get: () => value });
  test("parses the scheme case-insensitively and tolerates spacing", () => {
    expect(bearerToken(h("Bearer abc123"))).toBe("abc123");
    expect(bearerToken(h("bearer   abc123  "))).toBe("abc123");
    expect(bearerToken(h("BEARER abc123"))).toBe("abc123");
  });
  test("anything else is null", () => {
    expect(bearerToken(h(null))).toBeNull();
    expect(bearerToken(h(""))).toBeNull();
    expect(bearerToken(h("Basic abc123"))).toBeNull();
    expect(bearerToken(h("Bearer"))).toBeNull();
    expect(bearerToken(h("Bearer a b"))).toBeNull();
  });
});

describe("PairingStore", () => {
  // M46 spec 03 (ADR 0086): pairing is always on. An empty registry is a bridge waiting for its
  // first device, not an open one.
  test("always on: an empty registry is enforced", () => {
    const { io } = memoryIo();
    const store = new PairingStore(io);
    expect(store.enforced()).toBe(true);
    // Nothing paired means no token resolves, so every gated route refuses.
    expect(store.resolve(null)).toBeNull();
    expect(store.resolve("anything")).toBeNull();
  });

  test("always on: enforcement does not change when the first device pairs", async () => {
    const { io } = memoryIo({ pending: newPending("ABCD2345", 0) });
    const store = new PairingStore(io, () => 1000);
    expect(store.enforced()).toBe(true);
    const claimed = await store.claim("ABCD2345", "phone");
    expect(claimed.ok).toBe(true);
    expect(store.enforced()).toBe(true);
  });

  test("claim returns the token once and stores only its hash", async () => {
    const { io, state } = memoryIo({ pending: newPending("ABCD2345", 0) });
    const store = new PairingStore(io, () => 1000);
    const claimed = await store.claim("abcd 2345", "phone");
    if (!claimed.ok) throw new Error(`expected success, got ${claimed.reason}`);
    expect(JSON.stringify(state.registry)).not.toContain(claimed.token);
    expect(coerceRegistry(state.registry).devices[0]).toEqual({
      label: "phone",
      tokenHash: sha256Hex(claimed.token),
      createdAt: 1000,
      lastSeenAt: 1000,
    });
    expect(store.resolve(claimed.token)?.label).toBe("phone");
  });

  test("a code is single-use — the pending file is destroyed on success", async () => {
    const { io, state } = memoryIo({ pending: newPending("ABCD2345", 0) });
    const store = new PairingStore(io, () => 1000);
    expect((await store.claim("ABCD2345", "phone")).ok).toBe(true);
    expect(state.pending).toBeNull();
    const second = await store.claim("ABCD2345", "tablet");
    expect(second).toEqual({ ok: false, reason: "no-pending" });
  });

  test("wrong codes burn attempts, and the fifth destroys the pairing", async () => {
    const { io, state } = memoryIo({ pending: newPending("ABCD2345", 0) });
    const store = new PairingStore(io, () => 1000);
    for (let i = 0; i < CODE_ATTEMPTS - 1; i++) {
      expect((await store.claim("ZZZZ9999", "phone")).ok).toBe(false);
      expect(state.pending).not.toBeNull();
    }
    expect(await store.claim("ZZZZ9999", "phone")).toEqual({ ok: false, reason: "exhausted" });
    expect(state.pending).toBeNull();
    // Even the RIGHT code is now useless — the operator must mint a new one.
    expect(await store.claim("ABCD2345", "phone")).toEqual({ ok: false, reason: "no-pending" });
  });

  test("an expired code is refused and cleaned up", async () => {
    const { io, state } = memoryIo({ pending: newPending("ABCD2345", 0) });
    const store = new PairingStore(io, () => 10 * 60 * 1000 + 1);
    expect(await store.claim("ABCD2345", "phone")).toEqual({ ok: false, reason: "expired" });
    expect(state.pending).toBeNull();
  });

  test("a duplicate label is refused and leaves the pending pairing claimable", async () => {
    const { io, state } = memoryIo({ pending: newPending("ABCD2345", 0) });
    const store = new PairingStore(io, () => 1000);
    state.registry = { devices: [{ label: "phone", tokenHash: sha256Hex("t"), createdAt: 1, lastSeenAt: 1 }] };
    expect(await store.claim("ABCD2345", "phone")).toEqual({ ok: false, reason: "duplicate-label" });
    expect(state.pending).not.toBeNull();
    expect((await store.claim("ABCD2345", "tablet")).ok).toBe(true);
  });

  // "Pair again" after an expiry: the person types the name the expired device had. That label is
  // taken over, and the old token is revoked by the same write; a LIVE device's label still refuses.
  test("pairing again under an expired device's label replaces it and revokes its token in one write", async () => {
    const { io, state } = memoryIo({ pending: newPending("ABCD2345", 0) });
    const store = new PairingStore(io, () => 1000);
    state.registry = {
      devices: [
        { label: "phone", tokenHash: sha256Hex("old-token"), createdAt: 1, lastSeenAt: 1, expiresAt: 1000 },
        { label: "tablet", tokenHash: sha256Hex("tab-token"), createdAt: 1, lastSeenAt: 1 },
      ],
    };
    const writesBefore = state.writes;
    const claimed = await store.claim("ABCD2345", "phone");
    if (!claimed.ok) throw new Error(`expected success, got ${claimed.reason}`);
    expect(claimed.replacedExpired).toBe(true);
    expect(state.writes).toBe(writesBefore + 1);
    const devices = coerceRegistry(state.registry).devices;
    expect(devices.map((d) => d.label)).toEqual(["tablet", "phone"]);
    expect(devices.find((d) => d.label === "phone")).toEqual({
      label: "phone",
      tokenHash: sha256Hex(claimed.token),
      createdAt: 1000,
      lastSeenAt: 1000,
    });
    expect(store.resolve("old-token")).toBeNull();
    expect(store.expired("old-token")).toBe(false);
    expect(store.resolve(claimed.token)?.label).toBe("phone");
    expect(store.resolve("tab-token")?.label).toBe("tablet");
    expect(state.pending).toBeNull();
  });

  test("a label whose expiry has not passed yet is still a live duplicate", async () => {
    const { io, state } = memoryIo({ pending: newPending("ABCD2345", 0) });
    const store = new PairingStore(io, () => 1000);
    state.registry = {
      devices: [{ label: "phone", tokenHash: sha256Hex("t"), createdAt: 1, lastSeenAt: 1, expiresAt: 1001 }],
    };
    expect(await store.claim("ABCD2345", "phone")).toEqual({ ok: false, reason: "duplicate-label" });
    expect(store.resolve("t")?.label).toBe("phone");
    expect(state.pending).not.toBeNull();
  });

  test("a fresh label reports no replacement", async () => {
    const { io } = memoryIo({ pending: newPending("ABCD2345", 0) });
    const store = new PairingStore(io, () => 1000);
    const claimed = await store.claim("ABCD2345", "phone");
    expect(claimed.ok && claimed.replacedExpired).toBe(false);
  });

  test("enrolDevice is pure: it neither mutates the registry nor touches other entries", () => {
    const registry: PairedRegistry = {
      devices: [
        { label: "a", tokenHash: sha256Hex("a"), createdAt: 1, lastSeenAt: 1, expiresAt: 5 },
        { label: "b", tokenHash: sha256Hex("b"), createdAt: 1, lastSeenAt: 1, expiresAt: 5 },
      ],
    };
    const before = JSON.stringify(registry);
    const next = enrolDevice(registry, { label: "a", tokenHash: sha256Hex("n"), now: 9 });
    expect(JSON.stringify(registry)).toBe(before);
    expect(next?.replaced).toBe(true);
    // The other expired device stays listed: only the label being claimed is taken over.
    expect(next?.registry.devices.map((d) => d.label)).toEqual(["b", "a"]);
    expect(enrolDevice(registry, { label: "a", tokenHash: sha256Hex("n"), now: 4 })).toBeNull();
  });

  test("resolve stamps lastSeenAt at most once per throttle window", async () => {
    const { io, state } = memoryIo({ pending: newPending("ABCD2345", 0) });
    let now = 1000;
    const store = new PairingStore(io, () => now);
    const claimed = await store.claim("ABCD2345", "phone");
    if (!claimed.ok) throw new Error("claim failed");
    const writesAfterClaim = state.writes;
    now = 1500;
    store.resolve(claimed.token);
    store.resolve(claimed.token);
    expect(state.writes).toBe(writesAfterClaim);
    now = 1000 + 60_000;
    store.resolve(claimed.token);
    await store.idle();
    expect(state.writes).toBe(writesAfterClaim + 1);
    expect(coerceRegistry(state.registry).devices[0]?.lastSeenAt).toBe(61_000);
  });

  test("a wrong or absent token resolves to nothing", async () => {
    const { io } = memoryIo({ pending: newPending("ABCD2345", 0) });
    const store = new PairingStore(io, () => 1000);
    const claimed = await store.claim("ABCD2345", "phone");
    if (!claimed.ok) throw new Error("claim failed");
    expect(store.resolve("not-the-token")).toBeNull();
    expect(store.resolve(null)).toBeNull();
    expect(store.resolve("")).toBeNull();
  });

  test("revoke drops the device and its token stops working immediately", async () => {
    const { io } = memoryIo({ pending: newPending("ABCD2345", 0) });
    const store = new PairingStore(io, () => 1000);
    const claimed = await store.claim("ABCD2345", "phone");
    if (!claimed.ok) throw new Error("claim failed");
    expect(await store.revoke("phone")).toBe(true);
    expect(store.resolve(claimed.token)).toBeNull();
    // …and with the last device gone, pairing stays on (always on, ADR 0086): no state of the
    // registry opens the bridge again. `collie pair` on the host is the way back in.
    expect(store.enforced()).toBe(true);
    expect(await store.revoke("phone")).toBe(false);
  });

  test("the random source is injected end to end (a pinned token)", async () => {
    const { io } = memoryIo({ pending: newPending("ABCD2345", 0) });
    const store = new PairingStore(io, () => 1000, fixedRandom(0x41));
    const claimed = await store.claim("ABCD2345", "phone");
    if (!claimed.ok) throw new Error("claim failed");
    expect(claimed.token).toBe(Buffer.alloc(32, 0x41).toString("base64url"));
  });
});

// ── Token expiry (M46 spec 01) ───────────────────────────────────────────────────────────────

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe("parseLifetime", () => {
  test("a whole number and h, d or w", () => {
    expect(parseLifetime("12h")).toEqual({ ok: true, ms: 12 * HOUR });
    expect(parseLifetime("30d")).toEqual({ ok: true, ms: 30 * DAY });
    expect(parseLifetime("90d")).toEqual({ ok: true, ms: 90 * DAY });
    expect(parseLifetime("2w")).toEqual({ ok: true, ms: 14 * DAY });
    expect(parseLifetime(" 7D ")).toEqual({ ok: true, ms: 7 * DAY });
  });

  test("zero, negative, fractional, unit-less, minutes and junk are refused with a sentence", () => {
    for (const bad of ["0d", "0h", "-1d", "1.5d", "30", "30m", "30 days", "d", "", "abc", "1e3d"]) {
      const parsed = parseLifetime(bad);
      expect({ bad, ok: parsed.ok }).toEqual({ bad, ok: false });
      if (!parsed.ok) expect(parsed.reason.length).toBeGreaterThan(10);
    }
  });

  test("more than ten years is refused — that is what leaving the flag out means", () => {
    expect(parseLifetime("3650d")).toEqual({ ok: true, ms: MAX_LIFETIME_MS });
    expect(parseLifetime("3651d").ok).toBe(false);
    expect(parseLifetime("99999999999999999999w").ok).toBe(false);
  });
});

describe("token expiry in the registry", () => {
  const live = { label: "phone", tokenHash: sha256Hex("t"), createdAt: 1, lastSeenAt: 1 };

  test("isExpired: no expiry never expires; the instant of expiry is already expired", () => {
    expect(isExpired(live, Number.MAX_SAFE_INTEGER)).toBe(false);
    expect(isExpired({ ...live, expiresAt: 1000 }, 999)).toBe(false);
    expect(isExpired({ ...live, expiresAt: 1000 }, 1000)).toBe(true);
  });

  test("coerceRegistry keeps a numeric expiresAt, reads null as none, and garbage as expired", () => {
    const reg = coerceRegistry({
      devices: [
        { ...live, label: "a", expiresAt: 5000 },
        { ...live, label: "b", expiresAt: null },
        { ...live, label: "c", expiresAt: "2030-01-01" },
        { ...live, label: "d" },
      ],
    });
    expect(reg.devices[0]!.expiresAt).toBe(5000);
    expect("expiresAt" in reg.devices[1]!).toBe(false);
    // A garbled limit fails closed: an expiry of 0 is long past.
    expect(reg.devices[2]!.expiresAt).toBe(0);
    expect("expiresAt" in reg.devices[3]!).toBe(false);
  });

  test("a registry with no expiry loads unchanged and is written back byte for byte", async () => {
    // The file exactly as every release before expiry wrote it.
    const dir = await tempStateDir();
    const before = JSON.stringify(
      {
        devices: [
          { label: "pixel", tokenHash: sha256Hex("a"), createdAt: 1_700_000_000_000, lastSeenAt: 1_700_000_100_000 },
          { label: "ipad", tokenHash: sha256Hex("b"), createdAt: 1_700_000_000_001, lastSeenAt: 0 },
        ],
      },
      null,
      2,
    );
    await writeFile(join(dir, DEVICES_FILENAME), before);
    const io = filePairingIo(dir);
    const loaded = coerceRegistry(await io.readRegistry());
    for (const d of loaded.devices) expect(Object.keys(d)).toEqual(["label", "tokenHash", "createdAt", "lastSeenAt"]);
    await io.writeRegistry(loaded);
    expect(await readFile(join(dir, DEVICES_FILENAME), "utf8")).toBe(before);

    // And through the store's own read-modify-write: a lastSeenAt stamp leaves the shape alone.
    const store = new PairingStore(io, () => 1_800_000_000_000);
    expect(store.resolve("a")?.label).toBe("pixel");
    await store.idle();
    const stamped = JSON.parse(await readFile(join(dir, DEVICES_FILENAME), "utf8"));
    expect(Object.keys(stamped.devices[0])).toEqual(["label", "tokenHash", "createdAt", "lastSeenAt"]);
    expect(stamped.devices[0].lastSeenAt).toBe(1_800_000_000_000);
    expect(JSON.stringify(stamped.devices[1])).toBe(JSON.stringify(JSON.parse(before).devices[1]));
  });

  test("a token with no expiry is accepted as before, at any time", async () => {
    const { io } = memoryIo({ pending: newPending("ABCD2345", 0) });
    let now = 1000;
    const store = new PairingStore(io, () => now);
    const claimed = await store.claim("ABCD2345", "phone");
    if (!claimed.ok) throw new Error("claim failed");
    expect(claimed).not.toHaveProperty("expiresAt");
    now = 100 * 365 * DAY;
    expect(store.resolve(claimed.token)?.label).toBe("phone");
    expect(store.expired(claimed.token)).toBe(false);
  });

  test("the pending code's lifetime becomes the token's expiry, counted from the claim", async () => {
    const { io, state } = memoryIo({ pending: newPending("ABCD2345", 0, undefined, 30 * DAY) });
    let now = 5 * 60_000; // claimed five minutes after `collie pair`
    const store = new PairingStore(io, () => now);
    const claimed = await store.claim("ABCD2345", "phone");
    if (!claimed.ok) throw new Error("claim failed");
    const entry = coerceRegistry(state.registry).devices[0]!;
    expect(entry.expiresAt).toBe(5 * 60_000 + 30 * DAY);
    expect(claimed).toHaveProperty("expiresAt", entry.expiresAt);

    now = entry.expiresAt! - 1;
    expect(store.resolve(claimed.token)?.label).toBe("phone");
    now = entry.expiresAt!;
    expect(store.resolve(claimed.token)).toBeNull();
    expect(store.expired(claimed.token)).toBe(true);
  });

  test("an expired device is refused but still listed, and still keeps pairing enforced", async () => {
    const { io, state } = memoryIo({
      registry: { devices: [{ ...live, expiresAt: 1000 }] },
    });
    const store = new PairingStore(io, () => 2000 + SEEN_WINDOW);
    expect(store.resolve("t")).toBeNull();
    expect(store.expired("t")).toBe(true);
    expect(store.expired("other")).toBe(false);
    expect(store.expired(null)).toBe(false);
    expect(store.enforced()).toBe(true);
    // A refused request is not the device being seen: no stamp.
    await store.idle();
    expect(state.writes).toBe(0);
    expect(store.registry().devices).toHaveLength(1);
  });

  test("a pending file's lifetime is kept only when it is a positive number", () => {
    const base = { codeHash: "h", expiresAt: 1, attemptsLeft: 5 };
    expect(coercePending({ ...base, tokenLifetimeMs: DAY })?.tokenLifetimeMs).toBe(DAY);
    for (const bad of [0, -1, "30d", null]) {
      const p = coercePending({ ...base, tokenLifetimeMs: bad });
      expect(p).not.toBeNull();
      expect("tokenLifetimeMs" in p!).toBe(false);
    }
    expect(Object.keys(newPending("ABCD2345", 0))).toEqual(["codeHash", "expiresAt", "attemptsLeft"]);
  });

  test("setDeviceExpiry sets or removes the key on one device; an unknown label is null", () => {
    const reg = { devices: [live, { ...live, label: "tablet" }] };
    const set = setDeviceExpiry(reg, "phone", 9000)!;
    expect(set.devices[0]!.expiresAt).toBe(9000);
    expect("expiresAt" in set.devices[1]!).toBe(false);
    const cleared = setDeviceExpiry(set, "phone", null)!;
    expect(cleared.devices[0]).toEqual(live);
    expect(Object.keys(cleared.devices[0]!)).toEqual(["label", "tokenHash", "createdAt", "lastSeenAt"]);
    expect(setDeviceExpiry(reg, "nope", 1)).toBeNull();
    // Never mutates its input.
    expect("expiresAt" in reg.devices[0]!).toBe(false);
  });

  test("toDeviceWire carries expiresAt (null when none) and an expired flag", () => {
    const reg = { devices: [live, { ...live, label: "old", expiresAt: 500 }, { ...live, label: "new", expiresAt: 5000 }] };
    const wire = toDeviceWire(reg, "phone", 1000);
    expect(wire.map((w) => [w.label, w.expiresAt, w.expired])).toEqual([
      ["phone", null, false],
      ["old", 500, true],
      ["new", 5000, false],
    ]);
    expect(JSON.stringify(wire)).not.toContain(live.tokenHash);
  });

  test("adopt carries a synced expiry, and adds none where there was none", async () => {
    const { io, state } = memoryIo();
    const store = new PairingStore(io, () => 1000);
    expect(
      await store.adopt([
        { label: "a", tokenHash: sha256Hex("a"), createdAt: 1, expiresAt: 7000 },
        { label: "b", tokenHash: sha256Hex("b"), createdAt: 1 },
      ]),
    ).toEqual([]);
    const devices = coerceRegistry(state.registry).devices;
    expect(devices[0]!.expiresAt).toBe(7000);
    expect("expiresAt" in devices[1]!).toBe(false);
  });
});

/** Past the lastSeenAt throttle, so a resolve WOULD stamp if it were going to. */
const SEEN_WINDOW = 61_000;

// ── The crew surface is not a pairing surface ────────────────────────────────────────────────
// A lead is admitted by pinned mutual TLS plus the crew secret (CREW_PROTOCOL.md §6, ADR 0013) and
// holds none of this collie's pairing tokens. If pairing ever leaked into the peer's dispatch, every
// crew link would break the moment its peer paired a phone — and the fix someone would reach for is
// handing a lead a browser credential, which is precisely the thing §6 forbids. The wiring lives
// inside `Bun.serve`, which `bun test` cannot stand up (CLAUDE.md), so it is pinned at the source —
// the same technique bridge/solo-baseline.test.ts uses on the route table.
describe("pairing never crosses the crew seam", () => {
  const source = readFileSync(join(import.meta.dir, "server.ts"), "utf8");

  /** The `opts.crewRouter?.({ … })` call: everything a crew caller is dispatched through. */
  function crewDispatchBlock(): string {
    const start = source.indexOf("const crewHandler = opts.crewRouter?.({");
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf("\n  });", start);
    expect(end).toBeGreaterThan(start);
    return source.slice(start, end);
  }

  test("the peer's dispatch is gated by crewGate and names no pairing at all", () => {
    const block = crewDispatchBlock();
    expect(block).toContain("crewGate(level, cfg, device)");
    expect(block).not.toContain("pairing");
    expect(block).not.toContain("whois(");
    expect(block).not.toContain("bearerToken");
  });

  // ── THE OPTIONAL-PARAMETER FOOTGUN ─────────────────────────────────────────────────────────
  // `guard(req, cfg, level, pairing?)` takes the pairing gate as an OPTIONAL fourth argument, and it
  // has to: the parameter was added to a function with a dozen existing call sites, and the tests
  // that build a server without a store still call it with three. The cost of that convenience is
  // that `guard(req, cfg, "write")` — the spelling every existing route used, and therefore the one
  // a future route will be copy-pasted into — compiles, passes review, and silently skips the whole
  // pairing gate. TypeScript cannot catch it and no runtime test would either: the route would work
  // perfectly, just unguarded.
  //
  // So the arity is pinned here, at the source, exactly as the crew seam above is. If you are
  // reading this because the test failed: you added a `guard(` call without `pairingGate` (the
  // store plus the host's local read credential), and that is the bug. `apiFrontGate` forwards its
  // own `pairing` parameter, which is the same gate one call up.
  test("every guard() call in server.ts passes the pairing gate", () => {
    // Comment lines are dropped first — this file's prose mentions `guard()` and `guard(…, "write")`
    // many times, and those are not call sites.
    const code = source
      .split("\n")
      .filter((line) => {
        const t = line.trim();
        return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
      })
      .join("\n");

    /** The argument text of each `guard(` call, paren-balanced so a nested call can't truncate it. */
    const callArgs: string[] = [];
    for (const match of code.matchAll(/(\bfunction\s+)?\bguard\(/g)) {
      if (match[1] !== undefined) continue; // the definition itself
      let depth = 1;
      let i = match.index + match[0].length;
      for (; i < code.length && depth > 0; i++) {
        if (code[i] === "(") depth++;
        else if (code[i] === ")") depth--;
      }
      callArgs.push(code.slice(match.index + match[0].length, i - 1));
    }

    // A negative control on the scanner itself: if it found nothing, it is broken, and a broken
    // scanner passes this test vacuously forever.
    // Most routes share browserGate; the snapshot, that closure, and apiFrontGate call guard.
    expect(callArgs.length).toBeGreaterThanOrEqual(3);
    expect([...code.matchAll(/\bbrowserGate\(/g)].length).toBeGreaterThanOrEqual(20);
    expect(code).toContain("guard(req, cfg, level, pairingGate, peerAddress)");
    const unguarded = callArgs.filter((args) => !/\bpairing(Gate)?\b/.test(args));
    expect(unguarded).toEqual([]);
    // Every call is the browser gate, and the browser gate is the only caller — a crew caller
    // reaches its own gate (the block above), never this one.
    expect(callArgs.every((args) => args.includes("req, cfg"))).toBe(true);
    expect(callArgs.every((args) => args.includes("peerAddress"))).toBe(true);
  });

  // ── AMENDED 2026-08-20 (RFC §16, decision 5; CREW_PROTOCOL.md §18.14) ────────────────────────
  // This used to be "no crew module names pairing.ts at all", and the standby door made that reading
  // impossible to keep: a deputy has to verify a bearer credential its lead minted, so `standby.ts`
  // parses an `Authorization` header and `standby-devices.ts` hashes a token to compare against a
  // stored digest. Both are PURE helpers, and re-implementing either inside `crew/` would have meant
  // a second `sha256Hex` and a second `Bearer` parser to keep in step with the first — a worse
  // outcome than the coupling it avoided.
  //
  // **What the rule actually protects is unchanged, and it is pinned below instead of inferred:**
  // no crew module may touch `PairingStore` — the class that decides `enforced()`, resolves a token
  // into a device, and writes `paired-devices.json`. That is the object whose reach would make a
  // pairing token admit a crew request, and no crew module has it. The crew surface's two factors
  // (CREW_PROTOCOL.md §8.1) are untouched, and the standby door is a SEPARATE listener that is not on
  // the crew surface at all.
  test("no crew module touches PairingStore, and only the standby pair names pairing.ts", () => {
    /** Crew modules allowed to import pairing's PURE helpers, and what each of them may take. */
    const ALLOWED = new Map<string, readonly string[]>([
      // Hashes and compares a synced token digest; carries pairing's registry TYPES so the projection
      // and the collision check cannot drift from the shape they project.
      // `isExpired` is the one expiry rule, so the standby door refuses an expired token by the same
      // test the lead's write gate uses (M46 spec 01).
      ["standby-devices.ts", ["hashesEqual", "isExpired", "sha256Hex", "PairedDevice", "PairedRegistry"]],
      // Reads `Authorization: Bearer …` off the standby door's confirm. One parser, not two.
      ["standby.ts", ["bearerToken"]],
    ]);

    let named = 0;
    for (const file of readdirSync(join(import.meta.dir, "crew"))) {
      // Production modules only. A test that exercises the sync obviously builds a registry to sync,
      // and a rule that forbade it would forbid testing the thing it protects.
      if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
      const src = readFileSync(join(import.meta.dir, "crew", file), "utf8");
      // Comments are dropped first, exactly as the `guard()` scan above drops them: several of these
      // modules EXPLAIN why they must not merge into `PairingStore`'s registry, and a rule that
      // forbade naming the class in prose would forbid documenting the rule.
      const code = src
        .split("\n")
        .filter((line) => {
          const t = line.trim();
          return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
        })
        .join("\n");
      expect({ file, usesStore: code.includes("PairingStore") }).toEqual({ file, usesStore: false });
      if (!src.includes("pairing.ts")) continue;
      named++;
      const allowed = ALLOWED.get(file);
      expect({ file, allowed: allowed !== undefined }).toEqual({ file, allowed: true });
      // Exactly the named imports, and nothing that was not argued for above.
      const imported = [...src.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"\.\.\/pairing\.ts"/g)]
        .flatMap((m) => m[1]!.split(","))
        .map((name) => name.replace(/^\s*type\s+/, "").trim())
        .filter((name) => name !== "");
      expect({ file, extra: imported.filter((name) => !(allowed ?? []).includes(name)) }).toEqual({ file, extra: [] });
    }
    // A negative control on the scan itself: if it matched nothing, it passed vacuously.
    expect(named).toBe(ALLOWED.size);
  });
});

describe("filePairingIo", () => {
  test("writes are owner-only and land under the state dir", async () => {
    const stateDir = join(await tempStateDir(), "nested");
    // Windows: the bridge gives the state dir an owner-only access list at start (M43 spec 04).
    if (process.platform === "win32") ensureOwnerOnlyDir(stateDir, HOST, { root: privateRoot("state"), repair: true });
    const io = filePairingIo(stateDir);
    await io.writePending(newPending("ABCD2345", 0));
    await io.writeRegistry({ devices: [{ label: "phone", tokenHash: sha256Hex("t"), createdAt: 1, lastSeenAt: 1 }] });
    for (const name of [PENDING_FILENAME, DEVICES_FILENAME]) {
      // NTFS has no 0600 mode bits (stat() says 0o666), so Windows reads the access list instead.
      const { mode } = await stat(join(stateDir, name));
      if (process.platform !== "win32") expect(mode & 0o777).toBe(0o600);
      else expect(isOwnerOnly(join(stateDir, name), HOST)).toEqual({ state: "private" });
    }
    expect(JSON.parse(await readFile(join(stateDir, DEVICES_FILENAME), "utf8")).devices).toHaveLength(1);
  });

  test("a missing file reads as null, sync and async", async () => {
    const io = filePairingIo(await tempStateDir());
    expect(await io.readPending()).toBeNull();
    expect(await io.readRegistry()).toBeNull();
    expect(io.readRegistrySync()).toBeNull();
  });

  // A torn file is NOT "nobody is paired": that reading made every phone wipe itself on the 403.
  test("a file that is there and not a registry throws RegistryUnreadableError, sync and async", async () => {
    const stateDir = await tempStateDir();
    const io = filePairingIo(stateDir);
    // Truncated mid-write, not JSON at all, empty, and JSON that is not an object.
    for (const body of ['{"devices":[{"label":"pho', "{not json", "", "null", "[]", '"x"']) {
      await writeFile(join(stateDir, DEVICES_FILENAME), body);
      expect(() => io.readRegistrySync()).toThrow(RegistryUnreadableError);
      await expect(io.readRegistry()).rejects.toThrow(RegistryUnreadableError);
    }
  });

  for (const body of ['{}', '{"devices":null}', '{"devices":{}}', '{"devices":"oops"}', '{"devices":0}', '{"devices":false}']) {
    test(`malformed registry shape ${body} is unreadable to the parser and both readers`, async () => {
      const stateDir = await tempStateDir();
      const io = filePairingIo(stateDir);
      await writeFile(join(stateDir, DEVICES_FILENAME), body);
      expect(parseRegistryText(body)).toBeNull();
      expect(() => io.readRegistrySync()).toThrow(RegistryUnreadableError);
      await expect(io.readRegistry()).rejects.toThrow(RegistryUnreadableError);
      const store = new PairingStore(io, () => 0);
      await io.writePending(newPending("ABCD2345", 0));
      await expect(store.claim("ABCD2345", "tablet")).rejects.toThrow(RegistryUnreadableError);
      await expect(store.revoke("phone")).rejects.toThrow(RegistryUnreadableError);
      expect(await readFile(join(stateDir, DEVICES_FILENAME), "utf8")).toBe(body);
      expect(await io.readPending()).toEqual(newPending("ABCD2345", 0));
    });
  }

  test("valid arrays keep empty registries, historic entries and per-entry coercion", async () => {
    const io = filePairingIo(await tempStateDir());
    for (const devices of [[], [{ label: "historic", tokenHash: sha256Hex("t") }, null, {}, "bad"]]) {
      const raw = { devices };
      const expected = coerceRegistry(raw);
      const body = JSON.stringify(raw);
      // Write raw entries rather than the coerced registry, to exercise the persistent boundary.
      const dir = await tempStateDir();
      await writeFile(join(dir, DEVICES_FILENAME), body);
      const disk = filePairingIo(dir);
      expect(parseRegistryText(body)).toEqual(expected);
      expect(coerceRegistry(await disk.readRegistry())).toEqual(expected);
      expect(coerceRegistry(disk.readRegistrySync())).toEqual(expected);
    }
    expect(await io.readRegistry()).toBeNull();
    expect(io.readRegistrySync()).toBeNull();
  });

  test("an unreadable read is never cached: the repaired file is read on the next call", async () => {
    const stateDir = await tempStateDir();
    const io = filePairingIo(stateDir);
    const store = new PairingStore(io);
    const good = JSON.stringify({ devices: [{ label: "phone", tokenHash: sha256Hex("t"), createdAt: 1, lastSeenAt: 1 }] });
    await writeFile(join(stateDir, DEVICES_FILENAME), good.slice(0, 20));
    expect(() => store.registry()).toThrow(RegistryUnreadableError);
    expect(() => store.resolve("t")).toThrow(RegistryUnreadableError);
    expect(() => store.expired("t")).toThrow(RegistryUnreadableError);
    // Still broken on a second ask: the error was not turned into a cached "empty".
    expect(() => store.resolve("t")).toThrow(RegistryUnreadableError);
    await writeFile(join(stateDir, DEVICES_FILENAME), good);
    expect(store.resolve("t")?.label).toBe("phone");
    expect(store.registry().devices).toHaveLength(1);
  });

  test("an unreadable registry is never written over: claim and revoke throw and leave the file as it was", async () => {
    const stateDir = await tempStateDir();
    const io = filePairingIo(stateDir);
    const store = new PairingStore(io, () => 0);
    await io.writePending(newPending("ABCD2345", 0));
    const torn = '{"devices":[{"label":"phone","tokenHash":"';
    await writeFile(join(stateDir, DEVICES_FILENAME), torn);
    await expect(store.claim("ABCD2345", "tablet")).rejects.toThrow(RegistryUnreadableError);
    await expect(store.revoke("phone")).rejects.toThrow(RegistryUnreadableError);
    await store.idle();
    expect(await readFile(join(stateDir, DEVICES_FILENAME), "utf8")).toBe(torn);
    // The code was right and is still claimable once the file is whole again.
    expect(await io.readPending()).not.toBeNull();
  });

  test("a missing file is still the empty registry, never an error", async () => {
    const store = new PairingStore(filePairingIo(await tempStateDir()));
    expect(store.registry()).toEqual({ devices: [] });
    expect(store.resolve("t")).toBeNull();
    expect(store.expired("t")).toBe(false);
  });

  test("deletePending is idempotent", async () => {
    const io = filePairingIo(await tempStateDir());
    await io.deletePending();
    await io.writePending(newPending("ABCD2345", 0));
    await io.deletePending();
    expect(await io.readPending()).toBeNull();
  });

  test("a revocation written by another process (the CLI) is seen on the next sync read", async () => {
    const stateDir = await tempStateDir();
    const io = filePairingIo(stateDir);
    const store = new PairingStore(io);
    await io.writeRegistry({ devices: [{ label: "phone", tokenHash: sha256Hex("t"), createdAt: 1, lastSeenAt: 1 }] });
    expect(store.resolve("t")?.label).toBe("phone");
    // `bin/collie devices revoke phone` — a different process, no restart.
    await writeFile(join(stateDir, DEVICES_FILENAME), JSON.stringify({ devices: [] }));
    // Always on: the emptied registry does not open the bridge (ADR 0086).
    expect(store.enforced()).toBe(true);
    expect(store.resolve("t")).toBeNull();
  });
});

// ── One poll tick, two stamps, one file ──────────────────────────────────────────────────────
// A poll tick issues a snapshot request and a pane read; both resolve the same token, both clear
// the 60 s throttle off the same cached registry, and both used to run a read-modify-write against
// `paired-devices.json` at once — sharing the temp name, so the second `rename` found the file the
// first had already moved and the bridge logged ENOENT about once a minute (#159).
describe("concurrent lastSeenAt stamps (#159)", () => {
  /** A real on-disk io with a write counter, plus the store in front of it. */
  async function seeded() {
    const stateDir = await tempStateDir();
    const disk = filePairingIo(stateDir);
    const writes: string[] = [];
    const io: PairingIo = {
      ...disk,
      writeRegistry: async (r) => {
        writes.push("registry");
        await disk.writeRegistry(r);
      },
    };
    await disk.writeRegistry({
      devices: [{ label: "phone", tokenHash: sha256Hex("t"), createdAt: 1, lastSeenAt: 1 }],
    });
    // A frozen clock well past the throttle window, so the FIRST stamp is due and every later one
    // that re-reads inside the serialized section sees a fresh `lastSeenAt` and declines.
    const store = new PairingStore(io, () => 100_000);
    return { stateDir, store, writes };
  }

  /** Every assertion #159 is about: it landed, quietly, once, and left no litter. */
  async function expectOneCleanStamp(stateDir: string, writes: string[], warn: { mock: unknown }) {
    expect(warn).not.toHaveBeenCalled();
    expect(writes).toHaveLength(1);
    const parsed = JSON.parse(await readFile(join(stateDir, DEVICES_FILENAME), "utf8"));
    expect(coerceRegistry(parsed).devices[0]?.lastSeenAt).toBe(100_000);
    expect(readdirSync(stateDir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  }

  test("two stamps from one tick write once, quietly, and leave no temp file", async () => {
    const { stateDir, store, writes } = await seeded();
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(store.resolve("t")?.label).toBe("phone");
      expect(store.resolve("t")?.label).toBe("phone");
      await store.idle();
      await expectOneCleanStamp(stateDir, writes, warn);
    } finally {
      warn.mockRestore();
    }
  });

  test("twenty stamps at once are still one write", async () => {
    const { stateDir, store, writes } = await seeded();
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      for (let i = 0; i < 20; i++) expect(store.resolve("t")).not.toBeNull();
      await store.idle();
      await expectOneCleanStamp(stateDir, writes, warn);
    } finally {
      warn.mockRestore();
    }
  });
});

// ── The registry lock: one writer across processes (#19) ─────────────────────────────────────
// The in-process queue above orders this bridge's writes against each other. `bin/collie devices
// revoke` is another process writing the same file, and a revoke that landed between a stamp's
// re-read and its write came back with the write. Every read-modify-write now sits inside a lock
// file both processes take; these pin the loop, the store's use of it, and the on-disk shape.
describe("the registry lock (#19)", () => {
  /** An in-memory LockFsSync: the lock file is one entry with an mtime; `removed` counts breaks. */
  /**
   * An in-memory LockFsSync over PATHS: the lock and its break marker are two entries, each with the
   * mtime it was created at, so the takeover's own exclusivity can be exercised. `removed` lists
   * every remove, in order.
   */
  function memoryLockFs(seed: { held?: boolean; mtime?: number } = {}, clock: () => number = () => 0) {
    const files = new Map<string, { mtime: number; body: string }>();
    if (seed.held) files.set(LOCK, { mtime: seed.mtime ?? 0, body: '{"pid":999,"at":0}' });
    const removed: string[] = [];
    const state = { files, removed };
    const fs: LockFsSync = {
      createExclusive: (path, text) => {
        if (files.has(path)) return false;
        files.set(path, { mtime: clock(), body: text });
        return true;
      },
      mtimeMs: (path) => files.get(path)?.mtime ?? null,
      read: (path) => files.get(path)?.body ?? null,
      remove: (path) => {
        files.delete(path);
        state.removed.push(path);
      },
    };
    return { fs, state };
  }
  const LOCK = join("/state", LOCK_FILENAME);
  const MARKER = join("/state", LOCK_BREAK_FILENAME);

  test("lockVerdict: a fresh lock is waited on, a dead holder's stale one is broken, a vanished one is retried", () => {
    expect(lockVerdict(1_000, 1_000 + LOCK_STALE_MS - 1, false)).toBe("wait");
    expect(lockVerdict(1_000, 1_000 + LOCK_STALE_MS, false)).toBe("break");
    expect(lockVerdict(null, 5_000, false)).toBe("retry");
    // A LIVE holder holds whatever the age: a paused process is still the holder, and reclaiming its
    // lock by age alone was the one way two writers could reach the section at once.
    expect(lockVerdict(1_000, 1_000 + LOCK_STALE_MS, true)).toBe("wait");
    expect(lockVerdict(1_000, 1_000 + 100 * LOCK_STALE_MS, true)).toBe("wait");
  });

  test("lockPidOf reads the pid off a lock body, and nothing off anything else", () => {
    expect(lockPidOf(lockBody(4242, 7))).toBe(4242);
    expect(lockPidOf('{"at":7}')).toBeNull();
    expect(lockPidOf("garbage")).toBeNull();
    expect(lockPidOf(null)).toBeNull();
  });

  test("sync: a stale lock whose holder is ALIVE is never broken, and the waiter refuses at the bound", () => {
    let clock = LOCK_STALE_MS * 5;
    const { fs, state } = memoryLockFs({ held: true, mtime: 0 }, () => clock);
    expect(() =>
      acquireRegistryLockSync(
        fs,
        "/state",
        { now: () => clock, sleep: (ms) => void (clock += ms), pid: 1, alive: (pid) => pid === 999 },
        { waitMs: 100, pollMs: 20 },
      ),
    ).toThrow("could not lock the paired-device registry within 100ms");
    expect(state.removed).toEqual([]);
    expect(state.files.get(LOCK)?.body).toContain('"pid":999');
  });

  test("async: a live holder holds there too", async () => {
    let clock = LOCK_STALE_MS * 5;
    const { fs: sync, state } = memoryLockFs({ held: true, mtime: 0 }, () => clock);
    await expect(
      acquireRegistryLock(asyncOf(sync), "/state", { now: () => clock, sleep: async (ms) => void (clock += ms), pid: 1, alive: (pid) => pid === 999 }, { waitMs: 100, pollMs: 20 }),
    ).rejects.toThrow("could not lock");
    expect(state.removed).toEqual([]);
  });

  test("sync: free ⇒ taken at once, and the release removes the file", () => {
    const { fs, state } = memoryLockFs();
    const slept: number[] = [];
    const lock = acquireRegistryLockSync(fs, "/state", { now: () => 0, sleep: (ms) => slept.push(ms), pid: 1, alive: () => false });
    expect(state.files.has(LOCK)).toBe(true);
    expect(slept).toEqual([]);
    lock.release();
    expect(state.files.has(LOCK)).toBe(false);
  });

  test("sync: held and fresh ⇒ waits, then takes it the moment the holder lets go", () => {
    const { fs, state } = memoryLockFs({ held: true, mtime: 0 });
    let clock = 0;
    const lock = acquireRegistryLockSync(
      fs,
      "/state",
      {
        now: () => clock,
        sleep: (ms) => {
          clock += ms;
          // The other process finishes after three polls.
          if (clock >= 60) state.files.delete(LOCK);
        },
        pid: 1,
        alive: () => false,
      },
      { pollMs: 20 },
    );
    expect(clock).toBe(60);
    expect(state.removed).toEqual([]); // waited for it, never broke it
    lock.release();
  });

  test("sync: held and stale ⇒ broken under the marker, then taken, so a holder that died cannot wedge the registry", () => {
    const { fs, state } = memoryLockFs({ held: true, mtime: 0 });
    let clock = LOCK_STALE_MS;
    const lock = acquireRegistryLockSync(fs, "/state", { now: () => clock, sleep: (ms) => void (clock += ms), pid: 1, alive: () => false });
    expect(state.removed).toEqual([LOCK, MARKER]);
    expect(state.files.has(LOCK)).toBe(true);
    expect(state.files.has(MARKER)).toBe(false);
    lock.release();
  });

  // Two waiters that both read the same stale mtime used to both `remove`, and the second remove
  // took away the FRESH lock the first had just created: two writers inside the section at once.
  test("sync: a lock replaced between the stale reading and the break is NOT removed", () => {
    let clock = LOCK_STALE_MS;
    const { fs, state } = memoryLockFs({ held: true, mtime: 0 }, () => clock);
    // Between this waiter's stale reading and its remove, another waiter breaks the lock and takes
    // a fresh one. Modelled on the marker's create: the moment this waiter wins the marker, the
    // other has already replaced the lock.
    const create = fs.createExclusive;
    fs.createExclusive = (path, text) => {
      const won = create(path, text);
      if (won && path === MARKER) state.files.set(LOCK, { mtime: clock, body: "theirs" }); // the other's fresh lock
      return won;
    };
    expect(() =>
      acquireRegistryLockSync(fs, "/state", { now: () => clock, sleep: (ms) => void (clock += ms), pid: 1, alive: () => false }, { waitMs: 100, pollMs: 20 }),
    ).toThrow("could not lock");
    // The fresh lock was re-read under the marker, judged live, and left alone; only the marker went.
    expect(state.removed.filter((p) => p === LOCK)).toEqual([]);
    expect(state.files.has(LOCK)).toBe(true);
  });

  test("sync: a break marker left by a breaker that died is itself broken once stale", () => {
    let clock = LOCK_STALE_MS * 2;
    const { fs, state } = memoryLockFs({ held: true, mtime: 0 }, () => clock);
    state.files.set(MARKER, { mtime: 0, body: "dead" }); // a breaker that died holding the marker
    const lock = acquireRegistryLockSync(fs, "/state", { now: () => clock, sleep: (ms) => void (clock += ms), pid: 1, alive: () => false });
    expect(state.removed).toEqual([MARKER, LOCK, MARKER]);
    lock.release();
  });

  test("sync: a remove that silently fails still ends in the refusal, never a spin", () => {
    let clock = LOCK_STALE_MS;
    const { fs, state } = memoryLockFs({ held: true, mtime: 0 }, () => clock);
    fs.remove = (path) => void state.removed.push(path); // the unlink that does nothing
    const polls: number[] = [];
    expect(() =>
      acquireRegistryLockSync(fs, "/state", { now: () => clock, sleep: (ms) => void (polls.push(ms), (clock += ms)) , pid: 1, alive: () => false }, { waitMs: 100, pollMs: 20 }),
    ).toThrow("could not lock the paired-device registry within 100ms");
    expect(polls.length).toBeGreaterThan(0);
    expect(polls.length).toBeLessThanOrEqual(6);
  });

  // A live holder is never reclaimed (above). The proof at write time is the second line, for the one
  // shape the process table cannot see: a holder whose pid it no longer shows (a pid the kernel
  // reused, a wrong view of the table) that nonetheless resumes. It cannot write, and its release
  // removes only its own lock.
  test("sync: a holder the process table reports dead cannot write once replaced, and its release leaves the replacement alone", () => {
    let clock = 0;
    const { fs, state } = memoryLockFs({}, () => clock);
    const paused = acquireRegistryLockSync(fs, "/state", { now: () => clock, sleep: () => {}, pid: 1, alive: () => false });
    paused.assertHeld(); // still ours
    // Ten seconds pass with the holder stopped; a second process breaks the lock and takes it.
    clock = LOCK_STALE_MS;
    const second = acquireRegistryLockSync(fs, "/state", { now: () => clock, sleep: (ms) => void (clock += ms), pid: 2, alive: () => false });
    expect(state.files.get(LOCK)?.body).toContain('"pid":2');
    // The first holder resumes: it may not write, and it may not remove the second's lock.
    expect(() => paused.assertHeld()).toThrow(`the paired-device registry lock at ${LOCK} is no longer this process's`);
    paused.release();
    expect(state.files.get(LOCK)?.body).toContain('"pid":2');
    // The second holder is unaffected on both counts.
    second.assertHeld();
    second.release();
    expect(state.files.has(LOCK)).toBe(false);
  });

  test("async: the same ownership proof", async () => {
    let clock = 0;
    const { fs: sync, state } = memoryLockFs({}, () => clock);
    const fs = asyncOf(sync);
    const paused = await acquireRegistryLock(fs, "/state", { now: () => clock, sleep: async () => {}, pid: 1, alive: () => false });
    clock = LOCK_STALE_MS;
    const second = await acquireRegistryLock(fs, "/state", { now: () => clock, sleep: async (ms) => void (clock += ms), pid: 2, alive: () => false });
    await expect(paused.assertHeld()).rejects.toThrow("is no longer this process's");
    await paused.release();
    expect(state.files.get(LOCK)?.body).toContain('"pid":2');
    await second.release();
    expect(state.files.has(LOCK)).toBe(false);
  });

  test("the store proves the lock before every write, so a replaced holder writes nothing", async () => {
    const { io, state } = memoryIo({ registry: { devices: [{ label: "phone", tokenHash: sha256Hex("t"), createdAt: 1, lastSeenAt: 1 }] } });
    // A lock whose ownership is lost between the take and the write.
    const lost: PairingIo = {
      ...io,
      lockRegistry: async () => ({
        assertHeld: async () => {
          throw new Error("the paired-device registry lock at /state/x is no longer this process's");
        },
        release: async () => {},
      }),
    };
    const store = new PairingStore(lost);
    await expect(store.revoke("phone")).rejects.toThrow("no longer this process's");
    expect(state.writes).toBe(0);
    expect(state.registry?.devices.map((d) => d.label)).toEqual(["phone"]);
  });

  test("sync: never freed ⇒ throws after the wait bound and names the file, and NOTHING is written", () => {
    const { fs, state } = memoryLockFs({ held: true, mtime: 0 });
    let clock = 0;
    expect(() =>
      acquireRegistryLockSync(
        fs,
        "/state",
        { now: () => clock, sleep: (ms) => void (clock += ms), pid: 1, alive: () => false },
        { staleMs: 1_000_000, waitMs: 100, pollMs: 20 },
      ),
    ).toThrow(`could not lock the paired-device registry within 100ms — another writer holds ${LOCK}`);
    expect(state.removed).toEqual([]);
  });

  test("sync: a create that keeps failing with no mtime to read is bounded too, never a spin", () => {
    // A directory at the lock path, or a stat that fails: the create refuses and the verdict is
    // `retry` every time. The loop must still end in the refusal, on the same bound.
    const fs: LockFsSync = { createExclusive: () => false, mtimeMs: () => null, read: () => null, remove: () => {} };
    let clock = 0;
    const slept: number[] = [];
    expect(() =>
      acquireRegistryLockSync(
        fs,
        "/state",
        { now: () => clock, sleep: (ms) => void (slept.push(ms), (clock += ms)), pid: 1, alive: () => false },
        { waitMs: 100, pollMs: 20 },
      ),
    ).toThrow("could not lock the paired-device registry within 100ms");
    expect(slept).toEqual([20, 20, 20, 20, 20]);
  });

  /** The async twin over the same in-memory files. */
  function asyncOf(sync: LockFsSync) {
    return {
      createExclusive: async (p: string, t: string) => sync.createExclusive(p, t),
      mtimeMs: async (p: string) => sync.mtimeMs(p),
      read: async (p: string) => sync.read(p),
      remove: async (p: string) => sync.remove(p),
    };
  }

  test("async: the same loop, the same verdicts", async () => {
    const { fs: sync, state } = memoryLockFs({ held: true, mtime: 0 });
    let clock = 0;
    const lock = await acquireRegistryLock(
      asyncOf(sync),
      "/state",
      {
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
          if (clock >= 40) state.files.delete(LOCK);
        },
        pid: 1,
        alive: () => false,
      },
      { pollMs: 20 },
    );
    expect(clock).toBe(40);
    await lock.release();
    expect(state.files.has(LOCK)).toBe(false);
  });

  test("async: the takeover is exclusive and bounded exactly as the sync one is", async () => {
    let clock = LOCK_STALE_MS;
    const stale = memoryLockFs({ held: true, mtime: 0 }, () => clock);
    const lock = await acquireRegistryLock(asyncOf(stale.fs), "/state", { now: () => clock, sleep: async (ms) => void (clock += ms), pid: 1, alive: () => false });
    expect(stale.state.removed).toEqual([LOCK, MARKER]);
    await lock.release();

    // A remove that silently fails (filePairingIo's `remove` swallows unlink errors) is bounded.
    const stuck = memoryLockFs({ held: true, mtime: 0 }, () => clock);
    stuck.fs.remove = () => {};
    await expect(
      acquireRegistryLock(asyncOf(stuck.fs), "/state", { now: () => clock, sleep: async (ms) => void (clock += ms), pid: 1, alive: () => false }, { waitMs: 100, pollMs: 20 }),
    ).rejects.toThrow("could not lock the paired-device registry within 100ms");
  });

  test("every registry write the store makes sits between a lock and its release", async () => {
    const { io, state } = memoryIo({ pending: newPending("ABCD2345", 0) });
    const store = new PairingStore(io, () => 1_000, fixedRandom(7));
    const claimed = await store.claim("ABCD2345", "phone");
    expect(claimed.ok).toBe(true);
    const token = claimed.ok ? claimed.token : "";
    // A stamp: the clock jumps past the throttle, resolve stamps, and the stamp is a locked write.
    const later = new PairingStore(io, () => 1_000 + 120_000, fixedRandom(7));
    expect(later.resolve(token)?.label).toBe("phone");
    await later.idle();
    expect(await later.adopt([{ label: "laptop", tokenHash: sha256Hex("x"), createdAt: 1 }])).toEqual([]);
    expect(await later.revoke("laptop")).toBe(true);
    expect(state.trace).toEqual([
      "lock", "write", "unlock", // claim
      "lock", "write", "unlock", // stamp
      "lock", "write", "unlock", // adopt
      "lock", "write", "unlock", // revoke
    ]);
  });

  test("a lock is released even when the operation inside it throws", async () => {
    const { io, state } = memoryIo({ registry: EMPTY_REGISTRY });
    const failing: PairingIo = {
      ...io,
      readRegistry: async () => {
        throw new Error("disk full");
      },
    };
    const store = new PairingStore(failing);
    await expect(store.revoke("phone")).rejects.toThrow("disk full");
    expect(state.locked).toBe(false);
    expect(state.trace).toEqual(["lock", "unlock"]);
  });

  test("a stamp whose lock refuses is one warning, never an unhandled rejection", async () => {
    const { io } = memoryIo({
      registry: { devices: [{ label: "phone", tokenHash: sha256Hex("t"), createdAt: 1, lastSeenAt: 1 }] },
    });
    const refusing: PairingIo = {
      ...io,
      lockRegistry: async () => {
        throw new Error("could not lock the paired-device registry within 5000ms");
      },
    };
    const store = new PairingStore(refusing, () => 100_000);
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(store.resolve("t")?.label).toBe("phone"); // the request itself is unaffected
      await store.idle();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain("could not stamp lastSeenAt");
      expect(String(warn.mock.calls[0]?.[0])).toContain("could not lock");
    } finally {
      warn.mockRestore();
    }
  });

  test("two claims with one code and two labels enrol ONE device and hand out ONE token", async () => {
    const { io, state } = memoryIo({ pending: newPending("ABCD2345", 0) });
    const store = new PairingStore(io, () => 1_000);
    const [a, b] = await Promise.all([store.claim("ABCD2345", "phone"), store.claim("ABCD2345", "tablet")]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(a.ok).toBe(true);
    expect(b).toEqual({ ok: false, reason: "no-pending" });
    expect(state.registry?.devices.map((d) => d.label)).toEqual(["phone"]);
    expect(state.pending).toBeNull();
  });

  test("on disk: a revoke waits for the lock another process holds, and neither write undoes the other", async () => {
    const stateDir = await tempStateDir();
    const disk = filePairingIo(stateDir);
    await disk.writeRegistry({
      devices: [
        { label: "phone", tokenHash: sha256Hex("t"), createdAt: 1, lastSeenAt: 1 },
        { label: "laptop", tokenHash: sha256Hex("u"), createdAt: 1, lastSeenAt: 1 },
      ],
    });
    // "The CLI": `devices revoke phone` in another process has taken the lock and is mid-write.
    const cli = await disk.lockRegistry();
    expect(readdirSync(stateDir)).toContain(LOCK_FILENAME);

    // The bridge revokes laptop meanwhile. Without the lock this read [phone, laptop] at once and
    // wrote [phone] over whatever the CLI wrote next; with it, the revoke cannot even read yet.
    const store = new PairingStore(disk);
    let settled = false;
    const revoked = store.revoke("laptop").then((ok) => {
      settled = true;
      return ok;
    });
    await new Promise((r) => setTimeout(r, 60));
    expect(settled).toBe(false);

    // The CLI lands its write and lets go.
    await writeFile(
      join(stateDir, DEVICES_FILENAME),
      JSON.stringify({ devices: [{ label: "laptop", tokenHash: sha256Hex("u"), createdAt: 1, lastSeenAt: 1 }] }),
    );
    await cli.release();

    expect(await revoked).toBe(true);
    expect(coerceRegistry(await disk.readRegistry()).devices).toEqual([]);
    expect(readdirSync(stateDir)).not.toContain(LOCK_FILENAME);
  });

  test("on disk: the lock file is owner-only and names its holder", async () => {
    const stateDir = await tempStateDir();
    // Match bridge startup: Windows files inherit the state directory's private access list.
    if (process.platform === "win32") ensureOwnerOnlyDir(stateDir, HOST, { root: privateRoot("state"), repair: true });
    const disk = filePairingIo(stateDir);
    const lock = await disk.lockRegistry();
    const path = join(stateDir, LOCK_FILENAME);
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
    else expect(isOwnerOnly(path, HOST)).toEqual({ state: "private" });
    expect(JSON.parse(await readFile(path, "utf8")).pid).toBe(process.pid);
    await lock.release();
  });
});

// ── Claims that race (pre-push hardening, 2026-10-08) ────────────────────────────────────────────
// The whole claim runs in the store's write queue, the code check included, so a second claim reads
// what the first one wrote. Run over a real on-disk io, whose awaits interleave as a server's would.
describe("concurrent claims", () => {
  async function seeded(registry: PairedRegistry, lifetimeMs?: number) {
    const stateDir = await tempStateDir();
    const io = filePairingIo(stateDir);
    await io.writeRegistry(registry);
    const pending = newPending("ABCD2345", 0);
    if (lifetimeMs !== undefined) pending.tokenLifetimeMs = lifetimeMs;
    await io.writePending(pending);
    const store = new PairingStore(io, () => 1000);
    return { io, store };
  }
  const expiredPhone: PairedRegistry = {
    devices: [{ label: "phone", tokenHash: sha256Hex("old-token"), createdAt: 1, lastSeenAt: 1, expiresAt: 500 }],
  };

  test("two claims at once for the same expired name end with exactly one device under it", async () => {
    const { io, store } = await seeded(expiredPhone);
    const results = await Promise.all([store.claim("ABCD2345", "phone"), store.claim("ABCD2345", "phone")]);
    const won = results.filter((r) => r.ok);
    expect(won).toHaveLength(1);
    // The loser finds the code already spent: the winner deleted it in the same queued step.
    expect(results.find((r) => !r.ok)).toEqual({ ok: false, reason: "no-pending" });
    const devices = coerceRegistry(await io.readRegistry()).devices;
    expect(devices.map((d) => d.label)).toEqual(["phone"]);
    const winner = won[0];
    if (winner === undefined || !winner.ok) throw new Error("no winner");
    expect(devices[0]?.tokenHash).toBe(sha256Hex(winner.token));
    expect(store.resolve("old-token")).toBeNull();
  });

  test("separate stores share the disk lock while replacing an expired device", async () => {
    const { io, store } = await seeded(expiredPhone, 60_000);
    const other = new PairingStore(io, () => 1000);
    const results = await Promise.all([store.claim("ABCD2345", "phone"), other.claim("ABCD2345", "phone")]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toEqual({ ok: false, reason: "no-pending" });
    const devices = coerceRegistry(await io.readRegistry()).devices;
    expect(devices).toHaveLength(1);
    expect(devices[0]?.expiresAt).toBe(61_000);
    expect(store.resolve("old-token")).toBeNull();
  });

  test("two claims at once on one code under two names enrol one device: a code is single-use", async () => {
    const { io, store } = await seeded({ devices: [] });
    const results = await Promise.all([store.claim("ABCD2345", "phone"), store.claim("ABCD2345", "tablet")]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(coerceRegistry(await io.readRegistry()).devices).toHaveLength(1);
    expect(await io.readPending()).toBeNull();
  });

  test("wrong guesses at once are each counted: five spend the code, and the right one then finds none", async () => {
    const { io, store } = await seeded({ devices: [] });
    const guesses = Array.from({ length: CODE_ATTEMPTS }, (_, i) => store.claim(`WRONG${String(i).padStart(3, "2")}`, "phone"));
    const results = await Promise.all(guesses);
    expect(results.at(-1)).toEqual({ ok: false, reason: "exhausted" });
    expect(await io.readPending()).toBeNull();
    expect(await store.claim("ABCD2345", "phone")).toEqual({ ok: false, reason: "no-pending" });
  });

  test("the new device inherits nothing from the expired one: its own token, times and lifetime only", async () => {
    // The old entry carried an expiry; the new code carries a different lifetime. The new entry is
    // built from the claim alone (`addDevice`): label, the new token's hash, now, now + its lifetime.
    const { io, store } = await seeded(expiredPhone, 60_000);
    const claimed = await store.claim("ABCD2345", "phone");
    if (!claimed.ok) throw new Error(claimed.reason);
    expect(coerceRegistry(await io.readRegistry()).devices).toEqual([
      { label: "phone", tokenHash: sha256Hex(claimed.token), createdAt: 1000, lastSeenAt: 1000, expiresAt: 61_000 },
    ]);
  });

  test("expired is the stored expiry against the bridge's clock: one millisecond before, the name is live", async () => {
    const stateDir = await tempStateDir();
    const io = filePairingIo(stateDir);
    await io.writeRegistry({ devices: [{ label: "phone", tokenHash: sha256Hex("t"), createdAt: 1, lastSeenAt: 1, expiresAt: 1000 }] });
    await io.writePending(newPending("ABCD2345", 0));
    expect(await new PairingStore(io, () => 999).claim("ABCD2345", "phone")).toEqual({ ok: false, reason: "duplicate-label" });
    expect((await new PairingStore(io, () => 1000).claim("ABCD2345", "phone")).ok).toBe(true);
  });
});

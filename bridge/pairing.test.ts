import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  acquireRegistryLock,
  acquireRegistryLockSync,
  addDevice,
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
  LOCK_FILENAME,
  LOCK_STALE_MS,
  lockVerdict,
  newPending,
  normalizeCode,
  normalizeLabel,
  PairingStore,
  PENDING_FILENAME,
  removeDevice,
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
      return async () => {
        state.locked = false;
        state.trace.push("unlock");
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
  test("an empty registry means pairing is not enforced", () => {
    const { io } = memoryIo();
    expect(new PairingStore(io).enforced()).toBe(false);
  });

  test("one paired device turns enforcement on for every device", async () => {
    const { io } = memoryIo({ pending: newPending("ABCD2345", 0) });
    const store = new PairingStore(io, () => 1000);
    expect(store.enforced()).toBe(false);
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
    // …and with the last device gone, pairing switches back off rather than locking everyone out.
    expect(store.enforced()).toBe(false);
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

// ── The pack surface is not a pairing surface ────────────────────────────────────────────────
// A lead is admitted by pinned mutual TLS plus the pack secret (PACK_PROTOCOL.md §6, ADR 0013) and
// holds none of this collie's pairing tokens. If pairing ever leaked into the peer's dispatch, every
// pack link would break the moment its peer paired a phone — and the fix someone would reach for is
// handing a lead a browser credential, which is precisely the thing §6 forbids. The wiring lives
// inside `Bun.serve`, which `bun test` cannot stand up (CLAUDE.md), so it is pinned at the source —
// the same technique bridge/solo-baseline.test.ts uses on the route table.
describe("pairing never crosses the pack seam", () => {
  const source = readFileSync(join(import.meta.dir, "server.ts"), "utf8");

  /** The `opts.packRouter?.({ … })` call: everything a pack caller is dispatched through. */
  function packDispatchBlock(): string {
    const start = source.indexOf("const packHandler = opts.packRouter?.({");
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf("\n  });", start);
    expect(end).toBeGreaterThan(start);
    return source.slice(start, end);
  }

  test("the peer's dispatch is gated by packGate and names no pairing at all", () => {
    const block = packDispatchBlock();
    expect(block).toContain("packGate(level, cfg, device)");
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
  // So the arity is pinned here, at the source, exactly as the pack seam above is. If you are
  // reading this because the test failed: you added a `guard(` call without `pairing`, and unless
  // your route is genuinely not a write path, that is the bug.
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
    expect(callArgs.length).toBeGreaterThanOrEqual(8);
    const unguarded = callArgs.filter((args) => !/\bpairing\b/.test(args));
    expect(unguarded).toEqual([]);
    // Every call is the browser gate, and the browser gate is the only caller — a pack caller
    // reaches its own gate (the block above), never this one.
    expect(callArgs.every((args) => args.includes("req, cfg"))).toBe(true);
  });

  // ── AMENDED 2026-08-20 (RFC §16, decision 5; PACK_PROTOCOL.md §18.14) ────────────────────────
  // This used to be "no pack module names pairing.ts at all", and the standby door made that reading
  // impossible to keep: a deputy has to verify a bearer credential its lead minted, so `standby.ts`
  // parses an `Authorization` header and `standby-devices.ts` hashes a token to compare against a
  // stored digest. Both are PURE helpers, and re-implementing either inside `pack/` would have meant
  // a second `sha256Hex` and a second `Bearer` parser to keep in step with the first — a worse
  // outcome than the coupling it avoided.
  //
  // **What the rule actually protects is unchanged, and it is pinned below instead of inferred:**
  // no pack module may touch `PairingStore` — the class that decides `enforced()`, resolves a token
  // into a device, and writes `paired-devices.json`. That is the object whose reach would make a
  // pairing token admit a pack request, and no pack module has it. The pack surface's two factors
  // (PACK_PROTOCOL.md §8.1) are untouched, and the standby door is a SEPARATE listener that is not on
  // the pack surface at all.
  test("no pack module touches PairingStore, and only the standby pair names pairing.ts", () => {
    /** Pack modules allowed to import pairing's PURE helpers, and what each of them may take. */
    const ALLOWED = new Map<string, readonly string[]>([
      // Hashes and compares a synced token digest; carries pairing's registry TYPES so the projection
      // and the collision check cannot drift from the shape they project.
      ["standby-devices.ts", ["hashesEqual", "sha256Hex", "PairedDevice", "PairedRegistry"]],
      // Reads `Authorization: Bearer …` off the standby door's confirm. One parser, not two.
      ["standby.ts", ["bearerToken"]],
    ]);

    let named = 0;
    for (const file of readdirSync(join(import.meta.dir, "pack"))) {
      // Production modules only. A test that exercises the sync obviously builds a registry to sync,
      // and a rule that forbade it would forbid testing the thing it protects.
      if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
      const src = readFileSync(join(import.meta.dir, "pack", file), "utf8");
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
    const io = filePairingIo(stateDir);
    await io.writePending(newPending("ABCD2345", 0));
    await io.writeRegistry({ devices: [{ label: "phone", tokenHash: sha256Hex("t"), createdAt: 1, lastSeenAt: 1 }] });
    for (const name of [PENDING_FILENAME, DEVICES_FILENAME]) {
      expect((await stat(join(stateDir, name))).mode & 0o777).toBe(0o600);
    }
    expect(JSON.parse(await readFile(join(stateDir, DEVICES_FILENAME), "utf8")).devices).toHaveLength(1);
  });

  test("a missing file reads as null, sync and async", async () => {
    const io = filePairingIo(await tempStateDir());
    expect(await io.readPending()).toBeNull();
    expect(await io.readRegistry()).toBeNull();
    expect(io.readRegistrySync()).toBeNull();
  });

  test("corrupt JSON reads as null rather than throwing into the request path", async () => {
    const stateDir = await tempStateDir();
    await writeFile(join(stateDir, DEVICES_FILENAME), "{not json");
    const io = filePairingIo(stateDir);
    expect(io.readRegistrySync()).toBeNull();
    expect(await io.readRegistry()).toBeNull();
    expect(coerceRegistry(io.readRegistrySync())).toEqual({ devices: [] });
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
    expect(store.enforced()).toBe(false);
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
  function memoryLockFs(seed: { held?: boolean; mtime?: number } = {}) {
    const state = { file: seed.held ? { mtime: seed.mtime ?? 0 } : null, removed: 0 };
    const fs: LockFsSync = {
      createExclusive: () => {
        if (state.file) return false;
        state.file = { mtime: 0 };
        return true;
      },
      mtimeMs: () => state.file?.mtime ?? null,
      remove: () => {
        state.file = null;
        state.removed++;
      },
    };
    return { fs, state };
  }

  test("lockVerdict: a fresh lock is waited on, a stale one is broken, a vanished one is retried", () => {
    expect(lockVerdict(1_000, 1_000 + LOCK_STALE_MS - 1)).toBe("wait");
    expect(lockVerdict(1_000, 1_000 + LOCK_STALE_MS)).toBe("break");
    expect(lockVerdict(null, 5_000)).toBe("retry");
  });

  test("sync: free ⇒ taken at once, and the release removes the file", () => {
    const { fs, state } = memoryLockFs();
    const slept: number[] = [];
    const release = acquireRegistryLockSync(fs, "/state", { now: () => 0, sleep: (ms) => slept.push(ms), pid: 1 });
    expect(state.file).not.toBeNull();
    expect(slept).toEqual([]);
    release();
    expect(state.file).toBeNull();
  });

  test("sync: held and fresh ⇒ waits, then takes it the moment the holder lets go", () => {
    const { fs, state } = memoryLockFs({ held: true, mtime: 0 });
    let clock = 0;
    const release = acquireRegistryLockSync(
      fs,
      "/state",
      {
        now: () => clock,
        sleep: (ms) => {
          clock += ms;
          // The other process finishes after three polls.
          if (clock >= 60) state.file = null;
        },
        pid: 1,
      },
      { pollMs: 20 },
    );
    expect(clock).toBe(60);
    expect(state.removed).toBe(0); // waited for it, never broke it
    release();
  });

  test("sync: held and stale ⇒ broken and taken, so a holder that died cannot wedge the registry", () => {
    const { fs, state } = memoryLockFs({ held: true, mtime: 0 });
    const release = acquireRegistryLockSync(fs, "/state", { now: () => LOCK_STALE_MS, sleep: () => {}, pid: 1 });
    expect(state.removed).toBe(1);
    expect(state.file).not.toBeNull();
    release();
  });

  test("sync: never freed ⇒ throws after the wait bound and names the file, and NOTHING is written", () => {
    const { fs, state } = memoryLockFs({ held: true, mtime: 0 });
    let clock = 0;
    expect(() =>
      acquireRegistryLockSync(
        fs,
        "/state",
        { now: () => clock, sleep: (ms) => void (clock += ms), pid: 1 },
        { staleMs: 1_000_000, waitMs: 100, pollMs: 20 },
      ),
    ).toThrow(`could not lock the paired-device registry within 100ms — another writer holds /state/${LOCK_FILENAME}`);
    expect(state.removed).toBe(0);
  });

  test("sync: a create that keeps failing with no mtime to read is bounded too, never a spin", () => {
    // A directory at the lock path, or a stat that fails: the create refuses and the verdict is
    // `retry` every time. The loop must still end in the refusal, on the same bound.
    const fs: LockFsSync = { createExclusive: () => false, mtimeMs: () => null, remove: () => {} };
    let clock = 0;
    const slept: number[] = [];
    expect(() =>
      acquireRegistryLockSync(
        fs,
        "/state",
        { now: () => clock, sleep: (ms) => void (slept.push(ms), (clock += ms)), pid: 1 },
        { waitMs: 100, pollMs: 20 },
      ),
    ).toThrow("could not lock the paired-device registry within 100ms");
    expect(slept).toEqual([20, 20, 20, 20, 20]);
  });

  test("async: the same loop, the same verdicts", async () => {
    const { fs: sync, state } = memoryLockFs({ held: true, mtime: 0 });
    let clock = 0;
    const fs = {
      createExclusive: async (p: string, t: string) => sync.createExclusive(p, t),
      mtimeMs: async (p: string) => sync.mtimeMs(p),
      remove: async (p: string) => sync.remove(p),
    };
    const release = await acquireRegistryLock(
      fs,
      "/state",
      {
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
          if (clock >= 40) state.file = null;
        },
        pid: 1,
      },
      { pollMs: 20 },
    );
    expect(clock).toBe(40);
    await release();
    expect(state.file).toBeNull();
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
    const cliRelease = await disk.lockRegistry();
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
    await cliRelease();

    expect(await revoked).toBe(true);
    expect(coerceRegistry(await disk.readRegistry()).devices).toEqual([]);
    expect(readdirSync(stateDir)).not.toContain(LOCK_FILENAME);
  });

  test("on disk: the lock file is owner-only and names its holder", async () => {
    const stateDir = await tempStateDir();
    const disk = filePairingIo(stateDir);
    const release = await disk.lockRegistry();
    const path = join(stateDir, LOCK_FILENAME);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, "utf8")).pid).toBe(process.pid);
    await release();
  });
});

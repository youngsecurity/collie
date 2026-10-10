import { join } from "node:path";

import {
  acquireRegistryLockSync,
  CODE_TTL_MS,
  coerceRegistry,
  type RegistryLock,
  DEVICES_FILENAME,
  generateCode,
  isExpired,
  newPending,
  type PairedDevice,
  type PairedRegistry,
  parseLifetime,
  PENDING_FILENAME,
  removeDevice,
  setDeviceExpiry,
} from "../bridge/pairing.ts";
import type { CliContext } from "./context.ts";
import { EXIT, type Io } from "./io.ts";
import { urlToEncode } from "./qr.ts";
import type { Exec, Files } from "./sys.ts";
import { renderQr } from "../scripts/qr.ts";

// `pair`, `devices list`, `devices revoke` — the operator's half of device pairing. The pure
// decisions all live in `bridge/pairing.ts`; this module is the terminal, the two files under the
// state dir, and the words an operator reads.
//
// ── WHY THE TERMINAL MINTS THE CODE, AND NOT THE WEB UI ──────────────────────
// Enrolment is a bootstrap problem: the phone asking to be paired is, by definition, the one party
// that cannot yet prove anything — it holds no token, and the header gate (if configured at all) only
// says what the network asserts about it. A "pair this device" button in Collie's own UI would
// therefore be authorised by nothing, and would hand a write credential to whoever loaded the page.
// The operator's shell on the host IS the proof: reaching it already implies the access pairing is
// there to fence off. So the code is minted where that proof already exists and carried out of band —
// eyes, from a terminal to a phone keyboard — and the UI's only job is to spend it.
//
// ── WHY THE CODE MAY ALSO BE A QR ────────────────────────────────────────────
// `pair` prints the code as a QR that opens Settings with it filled in. That gives away nothing: the
// terminal is already the out-of-band channel the code travels on, and whoever reads the QR is
// whoever reads the line above it. The QR only spares the phone keyboard eight characters. The code
// it carries is the same one — single-use, dead in 10 minutes, stored as a hash and never as itself
// — so a screenshot of this terminal is worth exactly what a photograph of it was already worth.
//
// The same reasoning runs the other way for revocation: a lost phone is revoked from the machine, not
// from the phone. `devices revoke` needs no service restart — the bridge re-reads
// `paired-devices.json` per request (`readRegistrySync` in bridge/pairing.ts), so the device loses
// write access on its very next call.

/** The `devices` sub-verbs, in the order the usage block prints them. */
export const DEVICES_SUBCOMMANDS = ["list", "revoke", "set-expiry", "clear-expiry"] as const;

export interface PairingDeps {
  ctx: CliContext;
  io: Io;
  files: Files;
  /** The tailnet probes `urlToEncode` runs to decide whether the code is worth a QR. */
  exec: Exec;
  /** Injected so a test can pin the printed expiry; production leaves it. */
  now?: () => number;
  /** Injected so a test can pin the minted code; production leaves it. */
  random?: (n: number) => Buffer;
  /** The synchronous wait the registry lock polls with; a test injects a clock, production leaves it. */
  sleep?: (ms: number) => void;
}

/**
 * A synchronous sleep with no busy loop: `Atomics.wait` on a buffer nobody notifies returns on the
 * timeout. The CLI's verbs are synchronous by design (they run under `env -i` from a Herdr action),
 * and the registry lock is the one place one of them has to wait for another process.
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const pendingPath = (ctx: CliContext): string => join(ctx.stateDir, PENDING_FILENAME);
const registryPath = (ctx: CliContext): string => join(ctx.stateDir, DEVICES_FILENAME);

/**
 * The registry as it is on disk. Absent, unreadable or malformed all read as "nothing paired".
 *
 * Exported because `crew deputy` asks the same question for a different reason (RFC §6.4: a lead with
 * nothing paired could never arm a standby door), and two readers of one credential file is two
 * places for "is anything paired?" to answer differently.
 */
export function pairedRegistryOf(files: Files, stateDir: string): PairedRegistry {
  const raw = files.read(join(stateDir, DEVICES_FILENAME));
  if (raw === null) return coerceRegistry(null);
  try {
    return coerceRegistry(JSON.parse(raw));
  } catch {
    return coerceRegistry(null);
  }
}

function readRegistry(deps: PairingDeps): PairedRegistry {
  return pairedRegistryOf(deps.files, deps.ctx.stateDir);
}

/** Owner-only, and the directory too: both files are credentials-in-hash-form. */
function writeOwnerOnly<TDocument>(deps: PairingDeps, path: string, value: TDocument): void {
  deps.files.mkdirp(deps.ctx.stateDir, 0o700);
  deps.files.write(path, `${JSON.stringify(value, null, 2)}\n`, 0o600);
}

const stamp = (ms: number): string => (ms > 0 ? new Date(ms).toISOString() : "never");

/** One device's expiry, as the operator reads it: no expiry, a date ahead, or a date passed. */
function expiryText(device: PairedDevice, now: number): string {
  if (device.expiresAt === undefined) return "no expiry";
  const at = new Date(device.expiresAt).toISOString();
  return isExpired(device, now) ? `EXPIRED ${at}` : `expires ${at}`;
}

/** A moment in the operator's own clock and zone, to the minute: `2026-11-06 14:32`. */
const two = (n: number): string => String(n).padStart(2, "0");

function localStamp(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** A lifetime in the operator's own unit back: `30 days`, `12 hours`, `2 weeks`. */
function lifetimeText(ms: number): string {
  const units: [number, string][] = [
    [7 * 86_400_000, "week"],
    [86_400_000, "day"],
    [3_600_000, "hour"],
  ];
  for (const [size, name] of units) {
    if (ms % size === 0) {
      const n = ms / size;
      return `${n} ${name}${n === 1 ? "" : "s"}`;
    }
  }
  return `${Math.round(ms / 3_600_000)} hours`;
}

/**
 * `pair`'s own arguments: nothing, or `--expires <duration>` (also `--expires=<duration>`). Anything
 * else is refused rather than ignored — `--expire 30d` silently minting a token that never expires
 * is the one typo this verb must not forgive.
 */
function parsePairArgs(args: readonly string[]): { ok: true; lifetimeMs?: number } | { ok: false; reason: string } {
  let raw: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--expires") {
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) return { ok: false, reason: "--expires needs a duration, for example `--expires 30d`" };
      raw = next;
      i += 1;
      continue;
    }
    if (arg.startsWith("--expires=")) {
      raw = arg.slice("--expires=".length);
      continue;
    }
    return { ok: false, reason: `unknown argument \`${arg}\`` };
  }
  if (raw === undefined) return { ok: true };
  const parsed = parseLifetime(raw);
  return parsed.ok ? { ok: true, lifetimeMs: parsed.ms } : { ok: false, reason: parsed.reason };
}

// ── pair ─────────────────────────────────────────────────────────────────────

/**
 * `collie pair` — mint the one-time code the phone spends on `/api/pair`.
 *
 * Only the code's HASH is written, so the string printed here is the only copy that will ever exist;
 * a second `pair` overwrites the pending file, which kills the previous code (that is the intended
 * way to cancel one, and the output says so).
 *
 * The QR below the code is best-effort and never a failure: the pending file is already on disk by
 * the time it is drawn, so a missing URL or a broken renderer would only cost a keyboard shortcut.
 */
export async function cmdPair(deps: PairingDeps, args: readonly string[] = []): Promise<number> {
  const parsed = parsePairArgs(args);
  if (!parsed.ok) {
    deps.io.err(`error: ${parsed.reason}`);
    deps.io.err("usage: collie pair [--expires <duration>]   durations: 12h, 30d, 2w");
    return EXIT.USAGE;
  }
  const now = (deps.now ?? Date.now)();
  const code = generateCode(deps.random);
  const pending = newPending(code, now, CODE_TTL_MS, parsed.lifetimeMs);
  const path = pendingPath(deps.ctx);
  const replaced = deps.files.exists(path);

  try {
    writeOwnerOnly(deps, path, pending);
  } catch (err) {
    deps.io.err(`error: could not write ${path} — ${err instanceof Error ? err.message : String(err)}`);
    return EXIT.FAIL;
  }

  const minutes = Math.round((pending.expiresAt - now) / 60_000);
  deps.io.out(code);
  deps.io.out("");
  deps.io.out(
    `  single-use · expires ${new Date(pending.expiresAt).toISOString()} (${minutes} minutes)`,
  );
  if (parsed.lifetimeMs !== undefined) {
    deps.io.out(
      `  The device this pairs stops working ${lifetimeText(parsed.lifetimeMs)} after it pairs; ` +
        "`collie devices set-expiry` or `clear-expiry` changes that later.",
    );
    deps.io.out(`  Expires ${localStamp(now + parsed.lifetimeMs)} once claimed.`);
  } else {
    deps.io.out("  This token never expires. Add --expires 30d to limit it.");
  }
  deps.io.out("  Open Collie on your phone, go to Settings, and enter this code there.");
  deps.io.out("  Shown once — only its hash is stored, and the bridge picks it up without a restart.");
  if (replaced) {
    deps.io.out("  A code from an earlier `collie pair` was still pending; it is now dead.");
  }
  await printPairQr(deps, code);
  return EXIT.OK;
}

/**
 * The scannable half. `urlToEncode` (cli/qr.ts) owns which URL is worth a QR and has already said on
 * stderr why it refused, so the line here only points at that and reassures: the code above stands
 * on its own, and the operator can still type it.
 */
async function printPairQr(deps: PairingDeps, code: string): Promise<void> {
  const base = urlToEncode({ ctx: deps.ctx, io: deps.io, exec: deps.exec });
  if (base === null) {
    deps.io.out("  No QR: the bridge URL is unknown, see the note above; the code above still works.");
    return;
  }
  // NO `#paired-devices` FRAGMENT, deliberately, even though the Settings card answers to one. HTML
  // runs the focusing steps on a fragment target once it exists, and it does that AFTER the page's
  // scripts — so the browser itself would pull focus onto the card and off the name field, which is
  // the only thing left to type. `pair` alone is the signal: the card scrolls itself into view when
  // it sees it (web/src/components/paired-devices.tsx). Measured in a browser, not reasoned about.
  // `CODE_ALPHABET` is URL-safe, so the encode is a no-op — it is here so it stays true if it isn't.
  const url = `${base.replace(/\/+$/, "")}/settings?pair=${encodeURIComponent(code)}`;
  let drawn: string;
  try {
    drawn = await renderQr(url);
  } catch (err) {
    deps.io.out(`  No QR: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  deps.io.out("");
  for (const line of drawn.split("\n")) deps.io.out(line);
  deps.io.out("");
  deps.io.out(url);
  deps.io.out("  Scan it: Collie opens Settings on the phone with the code filled in.");
}

// ── devices ──────────────────────────────────────────────────────────────────

/** `collie devices list` — who holds a write credential for this bridge. */
export function cmdDevicesList(deps: PairingDeps): number {
  const { devices } = readRegistry(deps);
  if (devices.length === 0) {
    deps.io.out("no devices paired — Collie answers no phone or browser until one is (pairing is always on).");
    deps.io.out("Run `collie pair` to enrol the first device.");
    return EXIT.OK;
  }
  const now = (deps.now ?? Date.now)();
  const width = Math.max(...devices.map((d) => d.label.length));
  for (const d of devices) {
    deps.io.out(
      `${d.label.padEnd(width)}  created ${stamp(d.createdAt)}  last seen ${stamp(d.lastSeenAt)}  ${expiryText(d, now)}`,
    );
  }
  if (devices.some((d) => isExpired(d, now))) {
    deps.io.out(
      "An expired device is refused but still listed; revoke it, or give it a new expiry.",
    );
  }
  return EXIT.OK;
}

/** How a label typed on the command line names a device: exactly one, none, or several. */
type LabelMatch =
  | { kind: "one"; label: string }
  | { kind: "none" }
  | { kind: "many"; labels: string[] };

/**
 * Find the device a typed label names. An exact match always wins. Without one, a case-insensitive
 * match is accepted only when it is unique — `Phone` and `phone` can both exist, and choosing between
 * them is the operator's call, not this verb's.
 */
function matchLabel(registry: PairedRegistry, typed: string): LabelMatch {
  if (registry.devices.some((d) => d.label === typed)) return { kind: "one", label: typed };
  const folded = typed.toLowerCase();
  const labels = registry.devices.filter((d) => d.label.toLowerCase() === folded).map((d) => d.label);
  if (labels.length === 1) return { kind: "one", label: labels[0]! };
  return labels.length === 0 ? { kind: "none" } : { kind: "many", labels };
}

/** Say why a label named nothing (or too much) on stderr, in revoke's words. */
function reportLabelMiss(deps: PairingDeps, registry: PairedRegistry, typed: string, match: LabelMatch): void {
  if (match.kind === "many") {
    deps.io.err(`error: \`${typed}\` matches more than one paired device: ${match.labels.join(", ")}`);
    deps.io.err("  type the label exactly as `collie devices list` prints it.");
    return;
  }
  deps.io.err(`error: no paired device labelled \`${typed}\``);
  deps.io.err(
    registry.devices.length === 0
      ? "  nothing is paired on this machine, see `collie devices list`."
      : `  paired: ${registry.devices.map((d) => d.label).join(", ")}`,
  );
}

/** Write only while the registry lock is still ours. */
function writeRegistryOrReport(deps: PairingDeps, next: PairedRegistry, lock: RegistryLock): boolean {
  try {
    lock.assertHeld();
    writeOwnerOnly(deps, registryPath(deps.ctx), next);
    return true;
  } catch (err) {
    deps.io.err(
      `error: could not write ${registryPath(deps.ctx)}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

/**
 * `collie devices set-expiry <label> <duration>` — give a paired device a lifetime counted from now.
 * Also the way back for an expired device the operator still trusts: a fresh lifetime revives it.
 */
export function cmdDevicesSetExpiry(deps: PairingDeps, args: readonly string[]): number {
  const [typed, duration] = args;
  if (typed === undefined || typed === "" || duration === undefined || duration === "" || args.length > 2) {
    deps.io.err("usage: collie devices set-expiry <label> <duration>   durations: 12h, 30d, 2w");
    return EXIT.USAGE;
  }
  const lifetime = parseLifetime(duration);
  if (!lifetime.ok) {
    deps.io.err(`error: ${lifetime.reason}`);
    return EXIT.USAGE;
  }
  return withRegistryLock(deps, (lock) => {
    const registry = readRegistry(deps);
    const match = matchLabel(registry, typed);
    if (match.kind !== "one") {
      reportLabelMiss(deps, registry, typed, match);
      return EXIT.FAIL;
    }
    const expiresAt = (deps.now ?? Date.now)() + lifetime.ms;
    const next = setDeviceExpiry(registry, match.label, expiresAt);
    if (next === null) {
      reportLabelMiss(deps, registry, typed, { kind: "none" });
      return EXIT.FAIL;
    }
    if (!writeRegistryOrReport(deps, next, lock)) return EXIT.FAIL;
    deps.io.out(
      `✓ "${match.label}" expires ${new Date(expiresAt).toISOString()} (${lifetimeText(lifetime.ms)} from now). No restart needed.`,
    );
    return EXIT.OK;
  });
}

/** `collie devices clear-expiry <label>` — the device's token works until it is revoked. */
export function cmdDevicesClearExpiry(deps: PairingDeps, args: readonly string[]): number {
  const [typed] = args;
  if (typed === undefined || typed === "" || args.length > 1) {
    deps.io.err("usage: collie devices clear-expiry <label>");
    return EXIT.USAGE;
  }
  return withRegistryLock(deps, (lock) => {
    const registry = readRegistry(deps);
    const match = matchLabel(registry, typed);
    if (match.kind !== "one") {
      reportLabelMiss(deps, registry, typed, match);
      return EXIT.FAIL;
    }
    const had = registry.devices.find((d) => d.label === match.label)?.expiresAt;
    if (had === undefined) {
      deps.io.out(`"${match.label}" has no expiry, so there is nothing to clear.`);
      return EXIT.OK;
    }
    const next = setDeviceExpiry(registry, match.label, null);
    if (next === null) {
      reportLabelMiss(deps, registry, typed, { kind: "none" });
      return EXIT.FAIL;
    }
    if (!writeRegistryOrReport(deps, next, lock)) return EXIT.FAIL;
    deps.io.out(`✓ "${match.label}" no longer expires. Its token works until you revoke it.`);
    return EXIT.OK;
  });
}

/**
 * `collie devices revoke <label>` — drop one device's credential.
 *
 * The read, the decision and the write happen INSIDE the registry lock the bridge takes for its own
 * writes (`bridge/pairing.ts`, #19): the bridge stamps `lastSeenAt` and enrols from another process,
 * and a revoke that landed between one of its reads and its write was overwritten by that write, so
 * the revoked device came back. A lock that cannot be taken is a refusal, never an unlocked write.
 */
export function cmdDevicesRevoke(deps: PairingDeps, args: readonly string[]): number {
  const label = args[0];
  if (label === undefined || label === "") {
    deps.io.err("usage: collie devices revoke <label>");
    return EXIT.USAGE;
  }
  return withRegistryLock(deps, (lock) => revokeLocked(deps, label, lock));
}

/** Every CLI registry mutation reads and writes under the bridge's cross-process lock. */
function withRegistryLock(deps: PairingDeps, op: (lock: RegistryLock) => number): number {
  let lock: RegistryLock;
  try {
    // The lock lives beside the registry, so its directory must exist first.
    deps.files.mkdirp(deps.ctx.stateDir, 0o700);
    lock = acquireRegistryLockSync(
      {
        createExclusive: (p, text) => deps.files.createExclusive(p, text, 0o600),
        mtimeMs: (p) => deps.files.mtimeMs(p),
        read: (p) => deps.files.read(p),
        remove: (p) => deps.files.remove(p),
      },
      deps.ctx.stateDir,
      {
        now: deps.now ?? Date.now,
        sleep: deps.sleep ?? sleepSync,
        pid: process.pid,
        alive: (pid) => deps.exec.processCommand(pid) !== null,
      },
    );
  } catch (err) {
    deps.io.err(`error: ${err instanceof Error ? err.message : String(err)}`);
    return EXIT.FAIL;
  }

  try {
    return op(lock);
  } finally {
    lock.release();
  }
}

/** Revoke after acquiring the same lock used for expiry changes. */
function revokeLocked(deps: PairingDeps, label: string, lock: RegistryLock): number {
  let next: PairedRegistry;
  {
    const registry = readRegistry(deps);
    const removed = removeDevice(registry, label);
    if (removed === null) {
      deps.io.err(`error: no paired device labelled \`${label}\``);
      deps.io.err(
        registry.devices.length === 0
          ? "  nothing is paired on this machine — `collie devices list`."
          : `  paired: ${registry.devices.map((d) => d.label).join(", ")}`,
      );
      return EXIT.FAIL;
    }
    next = removed;
    try {
      // Immediately before the write: a revoke that sat past the stale bound (a stopped shell, a
      // machine asleep) has had its lock taken over, and must not write over the new holder's work.
      lock.assertHeld();
      writeOwnerOnly(deps, registryPath(deps.ctx), next);
    } catch (err) {
      deps.io.err(
        `error: could not write ${registryPath(deps.ctx)} — ${err instanceof Error ? err.message : String(err)}`,
      );
      return EXIT.FAIL;
    }
  }

  deps.io.out(`✓ revoked "${label}" — it loses all access on its next request (no restart needed).`);
  if (next.devices.length === 0) {
    deps.io.out("  That was the last paired device: Collie now answers no phone or browser. Run `collie pair` to pair one.");
  }
  return EXIT.OK;
}

export function devicesUsage(): string {
  return `usage: collie devices {${DEVICES_SUBCOMMANDS.join("|")}}`;
}

/**
 * The parent verb. Reached only when no sub-verb matched — a bare `collie devices`, or a misspelt
 * one — and it names each sub-verb with its summary, as `cmdCrew` does.
 */
export function cmdDevices(deps: PairingDeps, args: readonly string[]): number {
  const [sub, ...rest] = args;
  switch (sub) {
    case "list":
      return cmdDevicesList(deps);
    case "revoke":
      return cmdDevicesRevoke(deps, rest);
    case "set-expiry":
      return cmdDevicesSetExpiry(deps, rest);
    case "clear-expiry":
      return cmdDevicesClearExpiry(deps, rest);
    default:
      if (sub !== undefined && sub !== "" && sub !== "help") {
        deps.io.err(`error: unknown devices subcommand \`${sub}\``);
      }
      deps.io.err(devicesUsage());
      deps.io.err("  list           the paired devices, with when each was paired, last seen, and expires");
      deps.io.err("  revoke         drop one device by label: `devices revoke <label>`");
      deps.io.err("  set-expiry     give a device a lifetime from now: `devices set-expiry <label> 30d`");
      deps.io.err("  clear-expiry   remove a device's expiry: `devices clear-expiry <label>`");
      return EXIT.USAGE;
  }
}

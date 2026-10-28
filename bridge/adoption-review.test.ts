import { afterEach, describe, expect, test } from "bun:test";
import { AuditLog } from "./audit.ts";
import { maskSnapshotTitles } from "./answer-mask.ts";
import type { CrewSurface } from "./crew/router.ts";
import { loadConfig, type Config } from "./config.ts";
import { AddedLauncherStore, memoryAddedIo } from "./launchers-added.ts";
import { muxOk } from "./mux/types.ts";
import { startServer } from "./server.ts";
import type { JsonObject } from "./json.ts";
import type { SessionRuntime } from "./sessions.ts";
import type { StateEngine } from "./state-engine.ts";
import type { MuxAdapter } from "./mux/types.ts";
import type { AgentView, Ask, AnswerResponse, SnapshotResponse } from "./types.ts";

const SECRET = `sk-test-placeholder-${"0".repeat(40)}`;
const REQUEST_ID = "0b9e6a1c-3f2d-4c5e-8a7b-1d2e3f4a5b6c";
const ask: Ask = {
  id: SECRET, kind: "permission", toolCallId: SECRET, itemId: SECRET, revision: 3,
  title: `Use ${SECRET}`, reason: SECRET,
  options: [{ id: SECRET, label: SECRET, effect: "allow" }],
  tool: { name: SECRET, summary: SECRET, output: SECRET },
};
const pane: AgentView = {
  paneId: "p", workspaceId: "w", workspaceLabel: "fixture", workspaceNumber: 1,
  tabId: "t", agent: "durable", status: "blocked", cwd: "/synthetic", focused: false,
  terminalTitle: SECRET,
};
const servers: ReturnType<typeof startServer>[] = [];
afterEach(() => { for (const server of servers.splice(0)) server.stop(true); });

type Options = Parameters<typeof startServer>[0];
function fixture<T>(members: Partial<T>): T {
  // SAFETY: test-only stubs supply every member reached by the routes under test. No production
  // instance is constructed and a call outside the declared fixture fails immediately.
  return members as T;
}

/** Only synthetic in-memory adapters and stores. No polling, sockets to a mux, or personal paths. */
function rig(overrides: Partial<Config> = {}) {
  const cfg = {
    ...loadConfig({ COLLIE_STATE_DIR: "/nonexistent/collie-review", HERDR_PLUGIN_CONFIG_DIR: "/nonexistent/collie-review" }),
    port: 0, transcript: false, pairing: false, publicHosts: ["review.invalid"], ...overrides,
  };
  const io = memoryAddedIo();
  const added = new AddedLauncherStore(io);
  const engine = fixture<StateEngine>({
    current: () => ({ agents: [pane], shellPanes: [pane], workspaces: [], tabs: [], bridge: "connected" }),
    noteAttention: () => {}, pokeNow: () => {},
  });
  const runtime = fixture<SessionRuntime>({
    name: "fixture", isPrimary: true, engine,
    herdr: fixture<MuxAdapter>({
      openAsks: () => [ask], paneTurn: () => SECRET,
      answerAsk: () => Promise.resolve(muxOk({ kind: "stale", ask })),
    }),
  });
  let crewSurface: CrewSurface | undefined;
  const options: Options = {
    crewRouter: (surface) => { crewSurface = surface; return async () => null; },
    cfg, version: "1.21.0", audit: new AuditLog(() => {}), crew: fixture<Options["crew"]>({ mode: "solo" }),
    registry: fixture<Options["registry"]>({ get: () => runtime, list: () => [], ordered: () => [runtime] }),
    activity: fixture<Options["activity"]>({ get: () => undefined, noteSeen: () => {} }),
    updateMonitor: fixture<Options["updateMonitor"]>({ status: () => fixture<ReturnType<Options["updateMonitor"]["status"]>>({ current: "1.21.0" }) }),
    snooze: fixture<Options["snooze"]>({ until: () => 0 }),
    push: fixture<Options["push"]>({}), notifyPrefs: fixture<Options["notifyPrefs"]>({}), addedLaunchers: added,
    pairing: fixture<NonNullable<Options["pairing"]>>({ registry: () => ({ version: 1, devices: [] }) }),
    harnesses: fixture<NonNullable<Options["harnesses"]>>({ list: () => Promise.resolve([]) }),
  };
  const server = startServer(options);
  servers.push(server);
  const request = (path: string, body?: JsonObject, headers: Record<string, string> = {}) => server.fetch(new Request(`http://review.invalid${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { host: "review.invalid", origin: "http://review.invalid", "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  const admittedCrewRequest = (path: string, body: JsonObject, headers: Record<string, string>) => {
    if (crewSurface?.dispatch === undefined) throw new Error("missing crew dispatch");
    const url = new URL(`http://review.invalid${path}`);
    return crewSurface.dispatch(new Request(url, { method: "POST", headers, body: JSON.stringify(body) }), url, "lead");
  };
  return { request, admittedCrewRequest, io, added };
}

function checkAsk(masked: Ask) {
  expect(masked.title).not.toContain(SECRET);
  expect(masked.reason).not.toContain(SECRET);
  expect(masked.tool?.name).not.toContain(SECRET);
  expect(masked.tool?.summary).not.toContain(SECRET);
  expect(masked.tool?.output).not.toContain(SECRET);
  expect(masked.options[0]?.label).not.toContain(SECRET);
  expect(masked.id).toBe(SECRET);
  expect(masked.itemId).toBe(SECRET);
  expect(masked.toolCallId).toBe(SECRET);
  expect(masked.revision).toBe(3);
  expect(masked.options[0]?.id).toBe(SECRET);
  expect(masked.options[0]?.effect).toBe("allow");
}

describe("review: durable display masking", () => {
  test.each([true, false])("local snapshots and stale answers, redact=%s", async (redact) => {
    const before = structuredClone(ask);
    const r = rig({ redact });
    const snapshot = await r.request("/api/snapshot");
    expect(snapshot.status).toBe(200);
    // SAFETY: this is the real snapshot route's JSON, with synthetic adapter input only.
    const body = await snapshot.json() as SnapshotResponse;
    for (const p of [...body.agents, ...body.shellPanes]) {
      expect(p.turnId).toBe(SECRET);
      if (redact) {
        checkAsk(p.asks![0]!);
        expect(p.terminalTitle).not.toContain(SECRET);
      } else expect(p.asks?.[0]).toEqual(ask);
    }
    const stale = await r.request("/api/pane/p/answer", {
      requestId: REQUEST_ID, askId: SECRET, revision: 2, optionId: SECRET,
    });
    expect(stale.status).toBe(409);
    // SAFETY: this is the real answer route's JSON, with a scripted stale outcome.
    const answered = await stale.json() as AnswerResponse;
    expect(answered.outcome).toBe("stale");
    if (answered.outcome !== "stale" || answered.ask === undefined) throw new Error("missing stale ask");
    if (redact) checkAsk(answered.ask);
    else expect(answered.ask).toEqual(ask);
    expect(ask).toEqual(before);
  });

  test("crew snapshot remasking covers nested blocks without mutating the cached contribution", () => {
    const extended = { ...ask, tool: { ...ask.tool!, blocks: [{ kind: "text", id: SECRET, text: SECRET, children: [{ text: SECRET }] }] } };
    const snapshot = { agents: [{ ...pane, asks: [extended], turnId: SECRET, host: "member" }], shellPanes: [] };
    const before = structuredClone(snapshot);
    const masked = maskSnapshotTitles(snapshot);
    checkAsk(masked.agents[0]!.asks[0]!);
    const blocks = masked.agents[0]!.asks[0]!.tool.blocks;
    expect(blocks[0]?.id).toBe(SECRET);
    expect(blocks[0]?.text).not.toContain(SECRET);
    expect(blocks[0]?.children[0]?.text).not.toContain(SECRET);
    expect(masked.agents[0]?.host).toBe("member");
    expect(masked.agents[0]?.turnId).toBe(SECRET);
    expect(maskSnapshotTitles(masked)).toEqual(masked);
    expect(snapshot).toEqual(before);
  });
});

describe("review: opt-out launcher attribution", () => {
  test("anonymous run reaches the character rule, but the independent header gate still refuses", async () => {
    const anonymous = rig();
    const invalid = await anonymous.request("/api/launch", { run: "x".repeat(201) });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ code: "launch.bad_line" });
    const gated = rig({ deviceHeader: "x-device", deviceAllowlist: ["proxy-phone"] });
    expect((await gated.request("/api/launch", { run: "make test" })).status).toBe(403);
  });
  test("anonymous adds work after the write gate, replay, and reach disk like any other row", async () => {
    const r = rig();
    const body = { requestId: REQUEST_ID, recipe: { harness: "claude", options: [] } };
    expect((await r.request("/api/launchers/added", body)).status).toBe(200);
    expect((await r.request("/api/launchers/added", body)).status).toBe(200);
    expect(await r.added.list()).toMatchObject([{ device: null, deviceKind: "anonymous" }]);
    expect(r.io.writes).toBe(1);
    expect(await new AddedLauncherStore(r.io).list()).toMatchObject([{ device: null, deviceKind: "anonymous" }]);
  });

  test("crew attribution preserves the peer's independent gate and paired-only revocation", async () => {
    const r = rig({ pairing: true, deviceHeader: "x-device", deviceAllowlist: ["phone"] });
    const recipe = { recipe: { harness: "claude", options: [] }, requestId: REQUEST_ID };
    expect((await r.admittedCrewRequest("/api/launchers/added", recipe, { "x-crew-device-kind": "anonymous" })).status).toBe(403);
    expect((await r.admittedCrewRequest("/api/launchers/added", recipe, {
      "x-crew-device-kind": "header", "x-crew-device": "phone",
    })).status).toBe(200);
    expect((await r.admittedCrewRequest("/api/launchers/added/forget-device", { device: "phone" }, {})).status).toBe(200);
    expect(await r.added.list()).toMatchObject([{ device: null, headerDevice: "phone", deviceKind: "header", via: "crew" }]);
  });

  test("header identity survives a launcher read despite an empty paired registry", async () => {
    const r = rig({ deviceHeader: "x-device", deviceAllowlist: ["proxy-phone"] });
    const body = { requestId: REQUEST_ID, recipe: { harness: "claude", options: [] } };
    expect((await r.request("/api/launchers/added", body)).status).toBe(403);
    expect((await r.request("/api/launchers/added", body, { "x-device": "other" })).status).toBe(403);
    expect((await r.request("/api/launchers/added", body, { "x-device": "proxy-phone", authorization: "Bearer ignored" })).status).toBe(200);
    expect((await r.request("/api/launchers", undefined, { "x-device": "proxy-phone" })).status).toBe(200);
    expect(await new AddedLauncherStore(r.io).list()).toMatchObject([{ device: null, headerDevice: "proxy-phone", deviceKind: "header" }]);
  });
});

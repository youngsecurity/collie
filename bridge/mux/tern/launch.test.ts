import { describe, expect, test } from "bun:test";

import { AuditLog } from "../../audit.ts";
import type { Launcher } from "../../types.ts";
import { launch } from "../../server.ts";
import type { StateEngine } from "../../state-engine.ts";
import { TernMux } from "./adapter.ts";
import type { TernExec } from "./exec.ts";
import { FakeTern } from "./fixture.ts";
import { parseListing } from "./protocol.ts";

const rows: Launcher[] = [
  { command: "first-command", label: "first", cwd: "/first" },
  { command: "second-command", label: "second", cwd: "/second" },
];

function launching(tern: TernMux) {
  const stub: Partial<StateEngine> = {
    pokeNow: () => {},
    current: () => ({
      agents: [],
      shellPanes: [
        { paneId: "101", workspaceId: "1", workspaceLabel: "Default", workspaceNumber: 1,
          tabId: "11", agent: "shell", status: "unknown", cwd: "/original", focused: true },
        { paneId: "201", workspaceId: "2", workspaceLabel: "Work", workspaceNumber: 2,
          tabId: "21", agent: "shell", status: "unknown", cwd: "/original", focused: false },
      ],
      workspaces: [], tabs: [], bridge: "connected",
    }),
  };
  // SAFETY: launch only calls current() for the beside-pane lookup and pokeNow() after creation.
  const engine = stub as StateEngine;
  return (command: string, paneId?: string) => {
    let now = 0;
    return launch(tern, engine, new Request("http://localhost/api/launch", {
      method: "POST", body: JSON.stringify({ command, paneId }),
    }), new AuditLog(() => {}), null, "default", () => Promise.resolve(rows), {
      now: () => now,
      sleep: (ms) => { now += ms; return Promise.resolve(); },
    });
  };
}

describe("Tern creation ownership through the launcher", () => {
  const pairs: [string | undefined, string | undefined][] = [
    ["101", "101"], ["101", "201"], [undefined, undefined], ["101", undefined], [undefined, "201"],
  ];
  for (const [firstBeside, secondBeside] of pairs) {
    test(`concurrent launches beside ${firstBeside ?? "dashboard"}/${secondBeside ?? "dashboard"} type and submit only to their own pane`, async () => {
      const fake = new FakeTern();
      const tern = new TernMux(fake);
      const start = launching(tern);
      const responses = await Promise.all([
        start("first-command", firstBeside), start("second-command", secondBeside),
      ]);
      for (const response of responses) expect(await response.json()).toMatchObject({ ok: true });
      const snapshot = await tern.snapshot();
      for (const label of ["first", "second"]) {
        const pane = snapshot.panes.find((p) => p.cwd === `/${label}`);
        expect(pane).toBeDefined();
        if (!pane) throw new Error(`missing ${label} pane`);
        expect(fake.writes().filter((w) => w.paneId === pane.paneId)).toEqual([
          { paneId: pane.paneId, kind: "text", payload: [`${label}-command`] },
          { paneId: pane.paneId, kind: "keys", payload: ["enter"] },
        ]);
      }
      expect(fake.writes()).toHaveLength(4);
    });
  }

  test("a concurrent failed launch rolls back only its own pane", async () => {
    const fake = new FakeTern();
    const closed: string[] = [];
    const exec: TernExec = {
      events: (handlers) => fake.events(handlers),
      run: async (args) => {
        if (args[0] === "close") closed.push(args[1]!);
        if (args[0] === "send" && args[2] === "keys") {
          const listing = parseListing((await fake.run(["ls", "--json"])).stdout);
          const pane = listing.sessions.flatMap((s) => s.tabs).flatMap((t) => t.blocks)
            .find((b) => String(b.id) === args[1]);
          if (pane?.cwd === "/second") return { code: 1, stdout: "", stderr: "injected submit failure" };
        }
        return fake.run(args);
      },
    };
    const tern = new TernMux(exec);
    const start = launching(tern);
    const [first, second] = await Promise.all([start("first-command", "101"), start("second-command", "101")]);
    expect(await first.json()).toMatchObject({ ok: true });
    expect(await second.json()).toMatchObject({ ok: false, code: "reply.not_submitted" });
    const snapshot = await tern.snapshot();
    const failedPane = snapshot.panes.find((p) => p.cwd === "/second");
    expect(failedPane?.alive).toBe(false);
    if (!failedPane) throw new Error("missing failed pane");
    expect(closed).toEqual([failedPane.paneId]);
    expect(snapshot.panes.filter((p) => !p.alive)).toHaveLength(1);
    expect(snapshot.panes.find((p) => p.cwd === "/first")?.alive).toBe(true);
  });

  for (const beside of ["101", undefined]) {
    test(`ambiguous ${beside ? "tab" : "space"} creation never reaches launcher typing, Enter or rollback`, async () => {
      const fake = new FakeTern();
      const recorded: string[][] = [];
      const exec: TernExec = {
        events: (handlers) => fake.events(handlers),
        run: async (args) => {
          recorded.push([...args]);
          if (args[0] === "new") await fake.run(["new", "tab", "Default"]);
          return fake.run(args);
        },
      };
      const response = await launching(new TernMux(exec))("first-command", beside);
      expect(await response.json()).toMatchObject({ ok: false, code: "workspace.create_failed" });
      expect(fake.writes()).toEqual([]);
      expect(recorded.some((args) => ["send", "close", "rename"].includes(args[0] ?? ""))).toBe(false);
    });
  }
});

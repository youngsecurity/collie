import { describe, expect, test } from "bun:test";

import type { MuxCreatedPane, MuxOutcome } from "../types.ts";
import { TernMux } from "./adapter.ts";
import type { TernExec, TernRunResult } from "./exec.ts";
import { FakeTern } from "./fixture.ts";
import { parseListing } from "./protocol.ts";

type Creation = "tab-1" | "tab-2" | "space";

function create(tern: TernMux, kind: Creation, label: string): Promise<MuxOutcome<MuxCreatedPane>> {
  const cwd = `/${label}`;
  return kind === "space"
    ? tern.createSpace({ label, cwd })
    : tern.createTab({ spaceId: kind === "tab-1" ? "1" : "2", label, cwd });
}

/** Interpose at a precise CLI boundary, without clocks, live processes or invented new output. */
function rig(intercept?: (args: readonly string[], fake: FakeTern) => Promise<TernRunResult>) {
  const fake = new FakeTern();
  const recorded: string[][] = [];
  const exec: TernExec = {
    run: (args) => {
      recorded.push([...args]);
      return intercept ? intercept(args, fake) : fake.run(args);
    },
    events: (handlers) => fake.events(handlers),
  };
  // Keep assertions on the CLI sequence separate from the fake's terminal writes.
  return { fake, calls: recorded, tern: new TernMux(exec) };
}

function created(answer: MuxOutcome<MuxCreatedPane>): MuxCreatedPane {
  expect(answer.ok).toBe(true);
  if (!answer.ok) throw new Error(answer.detail);
  return answer.value;
}

describe("Tern creation ownership", () => {
  const pairs: [Creation, Creation][] = [
    ["tab-1", "tab-1"],
    ["tab-1", "tab-2"],
    ["space", "space"],
    ["tab-1", "space"],
    ["space", "tab-2"],
  ];
  for (const [firstKind, secondKind] of pairs) {
    test(`concurrent ${firstKind}/${secondKind} keep distinct panes, scope, cwd and labels`, async () => {
      const { tern, calls } = rig();
      const answers = await Promise.all([
        create(tern, firstKind, "first"),
        create(tern, secondKind, "second"),
      ]);
      const first = created(answers[0]!);
      const second = created(answers[1]!);
      expect(first.paneId).not.toBe(second.paneId);
      expect(first.tabId).not.toBe(second.tabId);
      const snapshot = await tern.snapshot();
      for (const [kind, label, pane] of [
        [firstKind, "first", first], [secondKind, "second", second],
      ] as const) {
        expect(pane.cwd).toBe(`/${label}`);
        if (kind === "space") expect(pane.spaceLabel).toBe(label);
        else {
          expect(pane.spaceId).toBe(kind === "tab-1" ? "1" : "2");
          expect(snapshot.tabs.find((tab) => tab.tabId === pane.tabId)?.label).toBe(label);
        }
      }
      // The second before-snapshot must follow the first after-snapshot AND optional rename.
      const verbs = (kind: Creation) => ["ls", "new", "ls", ...(kind === "space" ? [] : ["rename"])];
      expect(calls.map((args) => args[0])).toEqual([...verbs(firstKind), ...verbs(secondKind), "ls"]);
    });
  }

  for (const kind of ["tab-1", "space"] as const) {
    for (const externalKind of ["tab-1", "tab-2", "space"] as const) {
      test(`${kind} refuses an overlapping external ${externalKind}, before rename or return`, async () => {
        let inject = true;
        const { tern, calls } = rig(async (args, fake) => {
          if (args[0] === "new" && inject) {
            inject = false;
            // Even an external pane with the SAME cwd/label must not be mistaken for ours.
            await create(new TernMux(fake), externalKind, "wanted");
          }
          return fake.run(args);
        });
        expect(await create(tern, kind, "wanted")).toMatchObject({ ok: false, reason: "refused" });
        expect(calls.some((args) => args[0] === "rename")).toBe(false);
        // The failed operation does not poison either method's queue.
        expect(await create(tern, "tab-2", "next-tab")).toMatchObject({ ok: true });
        expect(await create(tern, "space", "next-space")).toMatchObject({ ok: true });
      });
    }

    test(`${kind} counts an exited external pane as ambiguity too`, async () => {
      const { tern, calls } = rig(async (args, fake) => {
        if (args[0] === "new") {
          const external = created(await new TernMux(fake).createTab({ spaceId: "1" }));
          await fake.endPane(external.paneId);
        }
        return fake.run(args);
      });
      expect(await create(tern, kind, "wanted")).toMatchObject({ ok: false, reason: "refused" });
      expect(calls.some((args) => args[0] === "rename")).toBe(false);
    });

    test(`${kind} refuses when the only new pane is outside the requested scope`, async () => {
      const { tern, calls } = rig((args, fake) => fake.run(args[0] === "new"
        ? (kind === "space" ? ["new", "session", "wrong"] : ["new", "tab", "Work"])
        : args));
      expect(await create(tern, kind, "wanted")).toMatchObject({ ok: false, reason: "refused" });
      expect(calls.some((args) => args[0] === "rename")).toBe(false);
    });

    test(`${kind} refuses a pane added to an existing tab`, async () => {
      let after = false;
      const { tern, calls } = rig(async (args, fake) => {
        if (args[0] === "new") {
          after = true;
          return { code: 0, stdout: "", stderr: "" };
        }
        const result = await fake.run(args);
        if (after && args[0] === "ls") {
          const listing = parseListing(result.stdout);
          const tab = listing.sessions[0]!.tabs[0]!;
          tab.blocks.push({ ...tab.blocks[0]!, id: 9000 });
          return { ...result, stdout: JSON.stringify(listing) };
        }
        return result;
      });
      expect(await create(tern, kind, "wanted")).toMatchObject({ ok: false, reason: "refused" });
      expect(calls.some((args) => args[0] === "rename")).toBe(false);
    });

    test(`${kind} refuses concurrent removal of an existing pane`, async () => {
      const { tern, calls } = rig(async (args, fake) => {
        if (args[0] === "new") await fake.endPane("101");
        return fake.run(args);
      });
      expect(await create(tern, kind, "wanted")).toMatchObject({ ok: false, reason: "refused" });
      expect(calls.some((args) => args[0] === "rename")).toBe(false);
    });

    for (const failure of ["before", "command", "throw", "after", "missing"] as const) {
      test(`${kind} releases the shared queue after ${failure} failure`, async () => {
        let reads = 0;
        let failed = false;
        const { tern } = rig(async (args, fake) => {
          if (args[0] === "ls") reads += 1;
          const atFailure = (failure === "before" && reads === 1 && args[0] === "ls")
            || (failure === "after" && reads === 2 && args[0] === "ls")
            || (["command", "throw", "missing"].includes(failure) && args[0] === "new");
          if (!failed && atFailure) {
            failed = true;
            if (failure === "throw") throw new Error("injected spawn failure");
            if (failure === "missing") return { code: 0, stdout: "", stderr: "" };
            if (failure === "after") return { code: 0, stdout: "not JSON", stderr: "" };
            return { code: 1, stdout: "", stderr: "injected failure" };
          }
          return fake.run(args);
        });
        const [bad, tab, space] = await Promise.all([
          create(tern, kind, "failed"), create(tern, "tab-2", "tab"), create(tern, "space", "space"),
        ]);
        expect(bad.ok).toBe(false);
        expect(created(tab).cwd).toBe("/tab");
        expect(created(space).cwd).toBe("/space");
      });
    }
  }

  test("a missing or blank tab scope never falls back to the default session", async () => {
    const { tern, calls } = rig();
    for (const spaceId of ["", "999"]) {
      expect(await tern.createTab({ spaceId, label: "wanted" })).toMatchObject({ ok: false, reason: "gone" });
    }
    expect(calls.some((args) => args[0] === "new")).toBe(false);
  });

  test("duplicate session names cannot address a tab unambiguously", async () => {
    const { tern, fake, calls } = rig();
    await fake.run(["new", "session", "Default"]);
    expect(await tern.createTab({ spaceId: "1", label: "wanted" })).toMatchObject({ ok: false, reason: "refused" });
    expect(calls.some((args) => args[0] === "new")).toBe(false);
  });

  test("an existing session name is refused before creating a space", async () => {
    const { tern, calls } = rig();
    expect(await tern.createSpace({ label: " Default ", cwd: "/wanted" })).toMatchObject({ ok: false, reason: "refused" });
    expect(calls.some((args) => args[0] === "new")).toBe(false);
  });

  test("a failed tab rename releases queued space and tab creation", async () => {
    const { tern } = rig((args, fake) => args[0] === "rename" && args[2] === "failed"
      ? Promise.reject(new Error("rename failed")) : fake.run(args));
    const [tab, space, next] = await Promise.all([
      create(tern, "tab-1", "failed"), create(tern, "space", "space"), create(tern, "tab-1", "next"),
    ]);
    // Naming remains best-effort, but only ever targets the identified tab.
    expect(created(tab).cwd).toBe("/failed");
    expect(created(space).cwd).toBe("/space");
    expect(created(next).cwd).toBe("/next");
  });
});

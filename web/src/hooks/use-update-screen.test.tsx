import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { UpdateScreen } from "@/components/update-screen";
import { UpdateRunStrip } from "@/components/update-run-strip";
import { StripHost } from "@/components/ui/strip-host";
import { clearStatus, useStatus } from "@/lib/status";
import { UPDATE_MODE_HOLD, __resetReloadGuard, isReloadHeldBy } from "@/lib/reload-guard";
import {
  __resetUpdateRunStore,
  ACCEPTED_RUN_GRACE_MS,
  noteCrewRunBegun,
  noteSnapshotCrew,
  noteSnapshotRun,
  readUpdateState,
} from "@/lib/update-run-store";
import { clearUpdateStarted, getUpdateClaim, noteUpdateStarted } from "@/lib/update-ribbon";
import { __resetUpdateAsk, beginAskedUpdate, getUpdateAsk } from "@/lib/update-ask";
import type { UpdateCheckResponse, UpdateInfo, UpdatePeerLeg, UpdateRun } from "@/lib/types";
import { server } from "@/test/setup";
import { useUpdateScreen } from "./use-update-screen";

// UPDATE MODE, FED BY THE REAL STORES (ADR 0064, and M32 for a run that moves only the members).
//
// The reducer's table is in `lib/update-screen.test.ts`. This file proves what the table cannot: that
// the hook, fed by the real stores, makes the app behind the panel INERT on the device that started
// the run, keeps the mode up until "Back to the app" on its last step, holds this phone's reload while
// machines still move, and never takes the app on a device that only heard about the run. The harness
// is `App.tsx`'s own wiring, cut down to the two siblings that matter: the wrapper whose `inert` is
// `screen.blocking`, and the panel beside it.

function Harness() {
  const updateScreen = useUpdateScreen();
  const status = useStatus();
  return (
    <>
      <div style={{ display: "contents" }} inert={updateScreen.blocking}>
        {/* The band is inside the router in the real app, so it is inside the wrapper here too —
            which is also what proves the strip goes inert with everything else while a run this
            device started is blocking. */}
        <StripHost>
          <UpdateRunStrip screen={updateScreen} />
          <button type="button">The app behind</button>
        </StripHost>
      </div>
      <UpdateScreen screen={updateScreen} onOpenUpdates={() => {}} onStarted={() => {}} />
      <p>{status?.text ?? ""}</p>
    </>
  );
}

const status = (over: Partial<UpdateInfo> = {}): UpdateInfo => ({
  current: "1.9.1",
  latest: "1.9.1",
  latestUrl: null,
  releaseAvailable: false,
  majorAvailable: null,
  majorUrl: null,
  bridgeStale: false,
  checkedAt: Date.now(),
  ...over,
});

const MOVING: UpdatePeerLeg[] = [{ name: "minibuch", state: "updating", version: "1.9.0", updatedAt: Date.now() }];
const FAILED: UpdatePeerLeg[] = [
  { name: "minibuch", state: "rolled-back", version: "1.9.0", reason: "health gate timed out", updatedAt: Date.now() },
];
const DONE: UpdatePeerLeg[] = [{ name: "minibuch", state: "done", version: "1.9.1", updatedAt: Date.now() }];

/** Is the app behind the sheet inert? Asked of the DOM, as the e2e case asks it. */
function appIsInert(container: HTMLElement): boolean {
  return container.querySelector("[inert]") !== null;
}

beforeEach(() => {
  __resetUpdateRunStore();
  __resetReloadGuard();
  __resetUpdateAsk();
  clearUpdateStarted();
  clearStatus();
  localStorage.clear();
  // The store's first read. The census says minibuch is a release behind, which is why the retry ran.
  server.use(
    http.get("/api/update/check", () =>
      HttpResponse.json({
        ...status(),
        preflight: { schema: 1, verdict: "green", checks: [] },
        crew: [{ name: "minibuch", version: "1.9.0", verdict: "green", reasons: [], asOf: Date.now() }],
      } satisfies UpdateCheckResponse),
    ),
  );
});

afterEach(() => {
  vi.useRealTimers();
  __resetUpdateAsk();
  __resetUpdateRunStore();
  clearUpdateStarted();
  clearStatus();
});

describe("a crew-only run, on the device that tapped it", () => {
  it("takes the screen in the same tap, locks the app, and ends on Done with the member named", async () => {
    const user = userEvent.setup();
    const { container } = render(<Harness />);
    expect(appIsInert(container)).toBe(false);

    // What "Start update" does on the 202 of a peers-only start.
    act(() => {
      noteUpdateStarted(Date.now(), null, { target: "1.9.1", peersOnly: true, bundleAtStart: "x" });
      noteCrewRunBegun("1.9.1");
    });
    const panel = screen.getByRole("dialog", { name: "Updating the other machines" });
    expect(appIsInert(container)).toBe(true);
    // The lead is honest about itself: already on the version, not part of this run.
    expect(within(panel).getByText(/already on 1\.9\.1/)).toBeInTheDocument();
    expect(screen.getByText(/The app is locked until this finishes/)).toBeInTheDocument();

    // The first sweep folds the run: the member is moving, and the app stays locked.
    act(() => noteSnapshotCrew(status({ peers: MOVING, peersTo: "1.9.1" })));
    expect(within(screen.getByRole("dialog")).getByText("minibuch")).toBeInTheDocument();
    expect(isReloadHeldBy(UPDATE_MODE_HOLD)).toBe(true);

    // It ends badly. The mode ends on Done, never on a toast, and names who is left behind.
    act(() => noteSnapshotCrew(status({ peers: FAILED, settledAt: Date.now(), peersTo: "1.9.1" })));
    const done = screen.getByRole("dialog", { name: "Update finished" });
    expect(within(done).getByText("minibuch did not update.", { exact: false })).toBeInTheDocument();
    expect(within(done).getByRole("button", { name: "Try minibuch again" })).toBeInTheDocument();
    expect(screen.queryByText(/Members updated/)).toBeNull();
    expect(isReloadHeldBy(UPDATE_MODE_HOLD)).toBe(false);

    // Back to the app spends the claim and hands the app back.
    await user.click(within(done).getByRole("button", { name: "Back to the app" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(appIsInert(container)).toBe(false);
    expect(getUpdateClaim()).toBeNull();
  });

  it("a good run ends on Done too, never a toast alone", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    act(() => {
      noteUpdateStarted(Date.now(), null, { target: "1.9.1", peersOnly: true, bundleAtStart: "x" });
      noteCrewRunBegun("1.9.1");
    });
    act(() => noteSnapshotCrew(status({ peers: MOVING, peersTo: "1.9.1" })));
    act(() => noteSnapshotCrew(status({ peers: DONE, settledAt: Date.now(), peersTo: "1.9.1" })));
    const done = screen.getByRole("dialog", { name: "Update finished" });
    expect(within(done).getByText(/minibuch and this phone run 1\.9\.1\./)).toBeInTheDocument();
    await user.click(within(done).getByRole("button", { name: "Back to the app" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Skip is remembered with the claim, so a reload does not ask again", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    act(() => {
      noteUpdateStarted(Date.now(), null, { target: "1.9.1", peersOnly: true, bundleAtStart: "x" });
      noteCrewRunBegun("1.9.1");
    });
    const quiet: UpdatePeerLeg[] = [{ name: "minibuch", state: "waiting", version: "1.9.0", updatedAt: Date.now() - 90_000 }];
    act(() => noteSnapshotCrew(status({ peers: quiet, peersTo: "1.9.1" })));
    await user.click(screen.getByRole("button", { name: "Skip minibuch" }));
    expect(getUpdateClaim()?.skipped).toEqual(["minibuch"]);
    expect(screen.getByRole("dialog", { name: "Update finished" })).toBeInTheDocument();
  });
});

describe("a crew-only run, on every other device", () => {
  it("shows the strip, never locks the app, and says nothing at the end", async () => {
    const user = userEvent.setup();
    const { container } = render(<Harness />);
    // No confirm was tapped here: the run arrives on the poll.
    act(() => noteSnapshotCrew(status({ peers: MOVING, peersTo: "1.9.1" })));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(appIsInert(container)).toBe(false);
    expect(screen.getByText(/started on another device/)).toBeInTheDocument();

    // View opens the panel read-only: no lock line, and Back to the app folds it again.
    await user.click(screen.getByRole("button", { name: "View" }));
    const panel = screen.getByRole("dialog");
    expect(within(panel).queryByText(/The app is locked/)).toBeNull();
    await user.click(within(panel).getByRole("button", { name: "Back to the app" }));
    expect(screen.queryByRole("dialog")).toBeNull();

    // And the end is not announced to a device that did not start the run.
    act(() => noteSnapshotCrew(status({ peers: DONE, settledAt: Date.now(), peersTo: "1.9.1" })));
    expect(screen.queryByRole("dialog")).toBeNull();
    // The band holds its last line through its 240ms exit (`ui/collapse.tsx`), then lets it go.
    await vi.waitFor(() => expect(screen.queryByText(/started on another device/)).toBeNull());
  });
});

describe("the accepted full run owns update mode", () => {
  it.each([
    { state: "done", runId: "old-run" },
    { state: "rolled-back", runId: "old-run" },
    { state: "done", runId: undefined },
    { state: "rolled-back", runId: undefined },
  ] as const)("a reload expires an unmatched claim behind $state with ID $runId", async ({ state, runId }) => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const at = Date.now();
    noteUpdateStarted(at, "unreported-run", { target: "1.13.1+ys.1", peersOnly: false, bundleAtStart: "test" });
    noteSnapshotRun({
      schema: 2, state, from: "1.12.0+ys.1", to: "1.12.1+ys.1", runId,
      startedAt: at - 60_000, updatedAt: at - 1, attempt: 0,
    });
    render(<Harness />);
    await act(() => readUpdateState());
    await act(() => vi.advanceTimersByTimeAsync(20_001));
    expect(getUpdateClaim()).toBeNull();
    expect(screen.getByText("Progress for the update you started is unavailable. Check its log before trying again.")).toBeInTheDocument();
  });

  it.each([false, true])("releases an unreported start with a persistent notice, old failure=%s", async (previous) => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const at = Date.now();
    const accepted: UpdateRun = {
      schema: 2, state: "preflight", from: "1.12.1+ys.1", to: "1.13.1+ys.1",
      runId: "unreported-run", startedAt: at, updatedAt: at, attempt: 0,
    };
    if (previous) noteSnapshotRun({ ...accepted, runId: "old-failure", state: "rolled-back", updatedAt: at - 1 });
    server.use(http.post("/api/update", () => HttpResponse.json({ ok: true, to: accepted.to, major: false, run: accepted }, { status: 202 })));
    const { container } = render(<Harness />);
    await act(() => beginAskedUpdate({ kind: "single", current: "1.12.1+ys.1", version: "1.13.1+ys.1", major: false, peersOnly: false }));
    expect(appIsInert(container)).toBe(true);
    await act(() => vi.advanceTimersByTimeAsync(ACCEPTED_RUN_GRACE_MS + 1));
    await act(() => vi.advanceTimersByTimeAsync(20_001));
    expect(getUpdateClaim()).toBeNull();
    expect(appIsInert(container)).toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("Progress for the update you started is unavailable. Check its log before trying again.")).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(screen.getByText("Progress for the update you started is unavailable. Check its log before trying again.")).toBeInTheDocument();
  });

  it.each([false, true])("keeps ownership through a staging abort, previous record=%s", async (previous) => {
    const at = Date.now();
    const accepted: UpdateRun = {
      schema: 2, state: "preflight", from: "1.12.1+ys.1", to: "1.13.1+ys.1",
      runId: "accepted-run", startedAt: at, updatedAt: at, attempt: 0,
    };
    if (previous) noteSnapshotRun({ ...accepted, runId: "previous-run", state: "done", updatedAt: at - 1 });
    server.use(http.post("/api/update", () => HttpResponse.json({
      ok: true, to: accepted.to, major: false, run: accepted,
    }, { status: 202 })));
    const { container } = render(<Harness />);
    await act(() => beginAskedUpdate({
      kind: "single", current: "1.12.1+ys.1", version: "1.13.1+ys.1", major: false, peersOnly: false,
    }));
    expect(getUpdateClaim()?.runId).toBe("accepted-run");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(appIsInert(container)).toBe(true);
    act(() => noteSnapshotRun({ ...accepted, state: "staging", updatedAt: at + 1 }));
    expect(appIsInert(container)).toBe(true);
    expect(screen.queryByText(/started on another device/)).toBeNull();
    act(() => noteSnapshotRun({ ...accepted, state: "idle", reason: "build failed", updatedAt: at + 2 }));
    const failed = screen.getByRole("dialog", { name: /The update failed on/ });
    expect(within(failed).getByText("build failed")).toBeInTheDocument();
    await userEvent.click(within(failed).getByRole("button", { name: "Back to the app" }));
    expect(getUpdateClaim()).toBeNull();
    expect(appIsInert(container)).toBe(false);
  });
});

describe("late update records", () => {
  it("cancel orphan cleanup when the claimed run appears during its grace", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const at = Date.now();
    const accepted: UpdateRun = {
      schema: 2, state: "preflight", from: "1.12.1+ys.1", to: "1.13.1+ys.1",
      runId: "late-run", startedAt: at, updatedAt: at, attempt: 0,
    };
    server.use(http.post("/api/update", () => HttpResponse.json({ ok: true, to: accepted.to, major: false, run: accepted }, { status: 202 })));
    const { container } = render(<Harness />);
    await act(() => beginAskedUpdate({ kind: "single", current: "1.12.1+ys.1", version: "1.13.1+ys.1", major: false, peersOnly: false }));
    await act(() => vi.advanceTimersByTimeAsync(ACCEPTED_RUN_GRACE_MS + 1));
    act(() => noteSnapshotRun({ ...accepted, state: "staging", updatedAt: at + 1 }));
    await act(() => vi.advanceTimersByTimeAsync(20_001));
    expect(getUpdateClaim()?.runId).toBe("late-run");
    expect(appIsInert(container)).toBe(true);
    expect(screen.queryByText(/Progress for the update you started is unavailable/)).toBeNull();
  });
});

describe("retry consent", () => {
  it.each([
    { from: "1.13.1+ys.1", target: "2.0.0+ys.1", major: true },
    { from: "1.13.1+ys.1", target: "1.13.1+ys.2", major: false },
    { from: "v1.13.1+ys.1", target: "1.13.1+ys.2", major: false },
    { from: "v1.13.1+ys.1", target: "v1.13.1+ys.2", major: false },
    { from: "v1.13.1+ys.1", target: "v2.0.0+ys.1", major: true },
  ])("asks again with the correct consent for $from to $target", async ({ from, target, major }) => {
    const startedAt = Date.now() - 120_000;
    const failed: UpdateRun = {
      schema: 2, state: "rolled-back", from, to: target,
      startedAt, updatedAt: startedAt + 60_000, attempt: 1, runId: "failed-run",
    };
    render(<Harness />);
    act(() => {
      noteUpdateStarted(startedAt, failed.runId, { target, peersOnly: false, bundleAtStart: "old" });
      noteSnapshotRun(failed);
    });
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Try again" }));
    expect(getUpdateAsk()).toMatchObject({
      kind: major ? "major" : "crew", current: "1.13.1+ys.1", version: target.replace(/^v/, ""), major, peersOnly: false,
    });
    expect(getUpdateClaim()).toBeNull();
    let posted = false;
    server.use(http.post("/api/update", async ({ request }) => {
      expect(await request.json()).toEqual({ confirm: true, target: target.replace(/^v/, ""), major });
      posted = true;
      return HttpResponse.json({ ok: true, to: target.replace(/^v/, ""), major, run: null }, { status: 202 });
    }));
    const retry = getUpdateAsk();
    if (retry === null) throw new Error("Retry did not open a confirmation");
    await act(() => beginAskedUpdate(retry));
    expect(posted).toBe(true);
  });
});

describe("a failed full run's Back to the app", () => {
  const failed = (startedAt: number): UpdateRun => ({
    schema: 1,
    state: "rolled-back",
    from: "1.9.0",
    to: "1.9.1",
    startedAt,
    updatedAt: startedAt + 60_000,
    pid: 1,
    attempt: 0,
    reason: "health gate timed out",
  });

  it("closes that failure on this device, remembers it across a reload, and shows the next one", async () => {
    const user = userEvent.setup();
    const first = failed(Date.now() - 120_000);
    const { unmount } = render(<Harness />);
    act(() => noteSnapshotRun(first));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Back to the app" }));
    expect(screen.queryByRole("dialog")).toBeNull();

    // A new document (the hook reads the closed key back from storage) does not show it again.
    unmount();
    render(<Harness />);
    expect(screen.queryByRole("dialog")).toBeNull();

    // A later failure is a different one, and it is shown again.
    act(() => noteSnapshotRun(failed(Date.now())));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

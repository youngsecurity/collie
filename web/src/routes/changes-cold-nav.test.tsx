import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { afterEach, describe, expect, it } from "vitest";

import { resetChangeCountCache } from "@/hooks/use-workspace-change-counts";
import { resetChangesListCache } from "@/lib/changes-list-cache";
import { en } from "@/lib/i18n/messages/en";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { parentChain } from "@/lib/nav";
import { fixtureAgents } from "@/test/handlers";
import { withHeaderHost } from "@/test/header-host";

import { ChangesRoute } from "./changes";

const connected = (): HomeData => ({
  bridge: "connected", agents: fixtureAgents, shellPanes: [], workspaces: [], tabs: [],
  device: undefined, sessions: [], servers: [], ts: 0, scope: {}, viewAll: false,
  snoozedUntil: null, update: undefined, error: false, authError: false,
});

function renderSeeded(href: string) {
  const url = new URL(href, "https://collie.test");
  const paths = [...parentChain(url.pathname, url.search), href];
  const entries = paths.map((path, index) => {
    const at = new URL(path, url);
    return { pathname: at.pathname, search: at.search, state: index === 0 ? null : { from: paths[index - 1] } };
  });
  const router = createMemoryRouter([{
    id: ROOT_ROUTE_ID, path: "/", loader: connected, element: withHeaderHost(<Outlet />),
    children: [
      { index: true, element: <div>dashboard screen</div> },
      { path: "pane/:paneId", element: <div>pane screen</div> },
      { path: "space/:spaceId", element: <div>space screen</div> },
      { path: "pane/:paneId/changes/*", element: <ChangesRoute /> },
      { path: "space/:spaceId/changes/*", element: <ChangesRoute /> },
    ],
  }], { initialEntries: entries, initialIndex: entries.length - 1 });
  render(<RouterProvider router={router} />);
  return router;
}

afterEach(() => {
  localStorage.clear();
  resetChangesListCache();
  resetChangeCountCache();
});

describe.each(["/pane/w1%3Ap1", "/space/w1"])("cold Changes navigation under %s", (parent) => {
  it.each([false, true])("returns to the seeded parent without duplicating it, commit=%s", async (commit) => {
    const base = `${parent}/changes`;
    const list = commit ? `${base}/commit?repo=.` : base;
    const href = `${list}${commit ? "&" : "?repo=.&"}path=src%2Froutes%2Fcheckout.tsx`;
    const router = renderSeeded(href);
    const back = commit ? en["changes.commit.backAria"] : en["changes.listBackAria"];
    await userEvent.click(await screen.findByRole("button", { name: back }));
    await waitFor(() => expect(`${router.state.location.pathname}${router.state.location.search}`).toBe(list));
    await act(() => router.navigate(-1));
    expect(router.state.location.pathname).toBe(commit ? base : parent);
    if (commit) await act(() => router.navigate(-1));
    expect(router.state.location.pathname).toBe(parent);
    await act(() => router.navigate(-1));
    expect(router.state.location.pathname).toBe("/");
  });
});

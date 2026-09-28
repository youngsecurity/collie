import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { fixtureAgents } from "@/test/handlers";
import { currentPins, setPinned } from "@/lib/pins";
import type { AgentView, SessionSummary } from "@/lib/types";
import { AgentList } from "./agent-list";
import { ThreadSidebar } from "./agent-sidebar";
import { PaneActionsSheet } from "./pane-actions-sheet";
import { CrewProvider } from "./crew-provider";

const pane = { ...fixtureAgents[0]!, workspaceLabel: "same-project" };
const sessions: SessionSummary[] = [
  { name: "main", isPrimary: true, reachable: true, agents: 1, working: 0, blocked: 0 },
  { name: "work", isPrimary: false, reachable: true, agents: 1, working: 0, blocked: 0 },
];
const props = { open: true, onClose: vi.fn(), onRenamed: vi.fn(), onClosed: vi.fn() };

it("a narrow named-session pin follows its pane to All, not a same-ID other session", async () => {
  const user = userEvent.setup();
  const sheet = render(<PaneActionsSheet {...props} pane={pane} scope={{ session: "work" }} />);
  await user.click(screen.getByRole("button", { name: "Pin to top" }));
  sheet.unmount();
  const tagged = { ...pane, session: "work" };
  const pins = currentPins();
  const view = render(<AgentList agents={[tagged]} pins={pins} onOpen={vi.fn()} />);
  expect(screen.getByRole("heading", { name: "Pinned" })).toBeInTheDocument();
  view.rerender(<AgentList agents={[pane]} scope={{ session: "other" }} pins={pins} onOpen={vi.fn()} />);
  expect(screen.queryByRole("heading", { name: "Pinned" })).toBeNull();
  view.rerender(<AgentList agents={[pane]} scope={{ session: "work" }} pins={pins} onOpen={vi.fn()} />);
  expect(screen.getByRole("heading", { name: "Pinned" })).toBeInTheDocument();
  view.unmount();
  render(<ThreadSidebar agents={[pane]} scope={{ session: "work" }} pins={pins} currentPaneKey="" onSelect={vi.fn()} />);
  expect(screen.getByRole("heading", { name: "Pinned" })).toBeInTheDocument();
});

it.each(["Unpin", "Close pane"])("a widened pin is found by narrow detail %s", async (action) => {
  setPinned({ ...pane, session: "work" }, true, []);
  const user = userEvent.setup();
  render(<PaneActionsSheet {...props} pane={pane} scope={{ session: "work" }} />);
  expect.soft(screen.queryByRole("button", { name: "Unpin" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: action }));
  if (action === "Close pane") await user.click(screen.getByRole("button", { name: "Tap again to close" }));
  await waitFor(() => expect(currentPins()).toEqual([]));
});

it("primary-session pins stay pinned when widening adds the registry name", async () => {
  const user = userEvent.setup();
  const view = render(<CrewProvider servers={undefined} sessions={sessions}>
    <PaneActionsSheet {...props} pane={pane} scope={{}} />
  </CrewProvider>);
  await user.click(screen.getByRole("button", { name: "Pin to top" }));
  view.unmount();
  render(<AgentList agents={[{ ...pane, session: "main" }]} sessions={sessions} pins={currentPins()} onOpen={vi.fn()} />);
  expect(screen.getByRole("heading", { name: "Pinned" })).toBeInTheDocument();
});

it("a different primary session cannot inherit a same-ID pin", async () => {
  const user = userEvent.setup();
  const view = render(<CrewProvider servers={undefined} sessions={sessions}>
    <PaneActionsSheet {...props} pane={pane} />
  </CrewProvider>);
  await user.click(screen.getByRole("button", { name: "Pin to top" }));
  view.unmount();
  const changed = sessions.map((s) => Object.assign({}, s, { isPrimary: s.name === "work" }));
  render(<AgentList agents={[pane]} sessions={changed} pins={currentPins()} onOpen={vi.fn()} />);
  expect(screen.queryByRole("heading", { name: "Pinned" })).toBeNull();
});

it("pinning a peer primary never inherits the lead's named session", () => {
  const peer: AgentView = { ...pane, host: "peer" };
  setPinned(peer, true, [peer]);
  render(<AgentList agents={[peer]} scope={{ session: "work" }} pins={currentPins()} onOpen={vi.fn()} />);
  const heading = screen.getByRole("heading", { name: "Pinned" });
  expect(within(heading.parentElement!.parentElement!).getByRole("button")).toBeInTheDocument();
});

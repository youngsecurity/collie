import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";

import { fetchSnapshot } from "@/lib/api";
import { fixtureSnapshot } from "@/test/handlers";
import { server } from "@/test/setup";
import { getDeviceToken, markNotPaired, observePairingPolicy, setDeviceToken } from "@/lib/pairing";
import { ConnectionInfo } from "./connection-info";

// The diagnostics panel translates the polled snapshot into a read-only "why isn't X working" view.
// The device-access row is the interesting bit — it must mirror the deviceAuth matrix on the bridge.

describe("ConnectionInfo — device access row", () => {
  // Most cases describe a paired phone; the unpaired ones clear the token themselves.
  beforeEach(() => setDeviceToken("tok-placeholder"));

  it("a paired device with the header gate off reads as enforced and paired, never 'Not enforced'", () => {
    render(<ConnectionInfo bridge="connected" device={undefined} />);
    expect(screen.getByText("Enforced, this device is paired")).toBeInTheDocument();
    expect(screen.queryByText("Not enforced")).toBeNull();
    expect(screen.getByText("Connected")).toBeInTheDocument();
  });

  it("a browser with no token reads as enforced and not paired", () => {
    localStorage.clear();
    render(<ConnectionInfo bridge={undefined} device={undefined} />);
    expect(screen.getByText("Enforced, this device is not paired")).toBeInTheDocument();
  });

  it("replaces the off label when a protected request is refused after re-enabling pairing", async () => {
    localStorage.clear();
    render(<ConnectionInfo bridge={undefined} device={undefined} />);
    server.use(http.get("/api/snapshot", () => HttpResponse.json(fixtureSnapshot, {
      headers: { "X-Collie-Pairing": "off" },
    })));
    await act(async () => { await fetchSnapshot(); });
    expect(screen.getByText("Pairing off on this host")).toBeInTheDocument();
    server.use(http.get("/api/snapshot", () => new HttpResponse("device not paired", {
      status: 403, headers: { "X-Collie-Pairing": "on" },
    })));
    await act(async () => {
      await expect(fetchSnapshot()).rejects.toThrow("403 device not paired");
    });
    expect(screen.queryByText("Pairing off on this host")).toBeNull();
    expect(screen.getByText("Enforced, this device is not paired")).toBeInTheDocument();
    expect(screen.getByText("Reachable, not paired")).toBeInTheDocument();
  });

  for (const token of [null, "retained-token"]) {
    it(`reports the effective policy reactively with token=${token}, including re-enforcement`, () => {
      localStorage.clear();
      if (token) setDeviceToken(token);
      const { container } = render(<ConnectionInfo bridge={undefined} device={undefined} />);
      const rows = container.querySelectorAll("dl > div").length;
      act(() => observePairingPolicy("off"));
      expect(screen.getByText("Pairing off on this host")).toHaveClass("text-status-working");
      expect(screen.queryByText(/Enforced,/)).toBeNull();
      expect(screen.queryByText("Reachable, not paired")).toBeNull();
      expect(screen.getByText("Connecting…")).toBeInTheDocument();
      expect(getDeviceToken()).toBe(token);
      expect(container.querySelectorAll("dl > div")).toHaveLength(rows);
      act(() => observePairingPolicy("on"));
      expect(screen.queryByText("Pairing off on this host")).toBeNull();
      expect(screen.getByText(token ? "Enforced, this device is paired" : "Enforced, this device is not paired"))
        .toBeInTheDocument();
    });
  }

  for (const authorized of [true, false]) {
    it(`keeps the independent header gate visible while pairing is off, authorized=${authorized}`, () => {
      localStorage.clear();
      observePairingPolicy("off");
      render(<ConnectionInfo bridge="connected" device={{ enforced: true, device: "proxy-phone", authorized }} />);
      expect(screen.getByText(`Pairing off on this host; ${authorized ? "Full access" : "Read-only"} · proxy-phone`))
        .toBeInTheDocument();
      expect(screen.queryByText(/Enforced,/)).toBeNull();
      expect(screen.getByText("Connected")).toBeInTheDocument();
    });
  }

  it("ignores a retained refusal when the host explicitly disables pairing", () => {
    markNotPaired();
    render(<ConnectionInfo bridge="connected" device={{ enforced: false, device: null, authorized: true }} />);
    act(() => observePairingPolicy("off"));
    expect(screen.getByText("Pairing off on this host")).toBeInTheDocument();
    expect(screen.queryByText(/Enforced,/)).toBeNull();
  });

  it("a refusal latched after a self-unpair or revoke reads as not paired, even with a token", () => {
    render(<ConnectionInfo bridge="connected" device={{ enforced: true, device: "my-phone", authorized: true }} />);
    act(() => markNotPaired());
    expect(screen.getByText("Enforced, this device is not paired")).toBeInTheDocument();
  });

  it("shows full access with the device id for an authorised device", () => {
    render(
      <ConnectionInfo bridge="connected" device={{ enforced: true, device: "my-phone", authorized: true }} />,
    );
    expect(screen.getByText(/full access · my-phone/i)).toBeInTheDocument();
  });

  it("shows read-only with the device id for an unauthorised device", () => {
    render(
      <ConnectionInfo bridge="connected" device={{ enforced: true, device: "spare", authorized: false }} />,
    );
    expect(screen.getByText(/read-only · spare/i)).toBeInTheDocument();
  });

  it("labels an authorised device with no header as local (on-host operator)", () => {
    render(
      <ConnectionInfo bridge="connected" device={{ enforced: true, device: null, authorized: true }} />,
    );
    expect(screen.getByText(/full access \(local\)/i)).toBeInTheDocument();
  });

  it("an unpaired phone reads 'reachable, not paired' on the bridge row, never 'Connecting…'", () => {
    localStorage.clear();
    render(<ConnectionInfo bridge={undefined} device={undefined} />);
    expect(screen.getByText("Reachable, not paired")).toBeInTheDocument();
    expect(screen.queryByText("Connecting…")).toBeNull();
  });

  it("a refused phone reads 'reachable, not paired' on the bridge row", () => {
    render(<ConnectionInfo bridge={undefined} device={undefined} />);
    expect(screen.getByText("Connecting…")).toBeInTheDocument();
    act(() => markNotPaired());
    expect(screen.getByText("Reachable, not paired")).toBeInTheDocument();
    expect(screen.queryByText("Connecting…")).toBeNull();
  });

  it("a paired phone keeps 'Connecting…' only while no answer has arrived", () => {
    const { rerender } = render(<ConnectionInfo bridge={undefined} device={undefined} />);
    expect(screen.getByText("Connecting…")).toBeInTheDocument();
    rerender(<ConnectionInfo bridge="connected" device={undefined} />);
    expect(screen.getByText("Connected")).toBeInTheDocument();
  });

  it("shows a connecting state and the server build when provided", () => {
    render(<ConnectionInfo bridge={undefined} device={undefined} build="abc1234" />);
    expect(screen.getByText("Connecting…")).toBeInTheDocument();
    expect(screen.getByText("abc1234")).toBeInTheDocument();
  });
});

// The masking switch lives on the bridge. This row only SHOWS it, read-only, so the three states are
// the whole contract: on, off in the caution tone, and a dash (same height) while unknown.
describe("ConnectionInfo — secret masking row", () => {
  beforeEach(() => setDeviceToken("tok-placeholder"));

  it("says On when the bridge masks, and offers no control", () => {
    render(<ConnectionInfo bridge="connected" device={undefined} redact={true} />);
    expect(screen.getByText("Secret masking")).toBeInTheDocument();
    expect(screen.getByText("On, set on the bridge")).toBeInTheDocument();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("says Off in the caution tone when the bridge does not mask", () => {
    render(<ConnectionInfo bridge="connected" device={undefined} redact={false} />);
    const off = screen.getByText("Off, set on the bridge");
    expect(off).toHaveClass("text-status-working");
  });

  it("shows a dash while unknown, or for an older bridge, so the card never changes height", () => {
    render(<ConnectionInfo bridge="connected" device={undefined} />);
    const row = screen.getByText("Secret masking").closest("div")!;
    expect(row).toHaveTextContent("—");
    expect(screen.queryByText(/set on the bridge/)).toBeNull();
  });
});

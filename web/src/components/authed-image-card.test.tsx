import { act, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { AuthedImageCard } from "@/components/authed-image-card";
import * as api from "@/lib/api";
import { __resetAuthedUrls } from "@/lib/authed-url";
import { setDeviceToken } from "@/lib/pairing";
import { wipeDevice } from "@/lib/wipe";

afterEach(() => {
  __resetAuthedUrls();
  vi.restoreAllMocks();
});

it.each(["token", "unpair", "revoked", "expired", "password"] as const)(
  "removes both the mounted image and its link on %s, without fetching wiped content again",
  async (reason) => {
    setDeviceToken("old-token");
    const fetch = vi.spyOn(api, "fetchAuthedBytes").mockResolvedValue(new Blob(["picture"], { type: "image/png" }));
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    const onError = vi.fn();
    const card = <AuthedImageCard src="/api/blobs/picture" alt="Journal picture" caption="Picture" onError={onError} />;
    const { rerender, unmount } = render(card);
    const image = await screen.findByRole("img", { name: "Journal picture" });
    const url = image.getAttribute("src");
    expect(screen.getByRole("link")).toHaveAttribute("href", url);
    await act(async () => {
      if (reason === "token") setDeviceToken("new-token");
      else if (reason === "password") await wipeDevice(reason, { scope: { host: "peer" }, paneId: "pane" });
      else await wipeDevice(reason);
    });
    expect(revoke).toHaveBeenCalledWith(url);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    rerender(card);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    unmount();
    // A new mount makes a new authenticated read, rather than reusing the retired URL.
    render(card);
    expect(await screen.findByRole("img", { name: "Journal picture" })).not.toHaveAttribute("src", url);
    expect(fetch).toHaveBeenCalledTimes(2);
  },
);

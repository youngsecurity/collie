import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as api from "@/lib/api";
import { __resetAuthedUrls, authedObjectUrl, useAuthedUrl } from "@/lib/authed-url";
import { getDeviceToken, markNotPaired, setDeviceToken, TOKEN_STORAGE_KEY } from "@/lib/pairing";
import { WIPE_CHANNEL, wipeDevice } from "@/lib/wipe";

interface UrlSource {
  src: string | null;
}

const PATH = "/api/blobs/picture";
const picture = () => new Blob(["picture"], { type: "image/png" });

function deferred() {
  let resolve!: (blob: Blob) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Blob>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

beforeEach(() => setDeviceToken("old-token"));
afterEach(() => {
  __resetAuthedUrls();
  vi.restoreAllMocks();
});

describe("authenticated object URL lifetime", () => {
  it("shares a pending read and cached URL, without mounting the request path here", async () => {
    const read = deferred();
    const fetch = vi.spyOn(api, "fetchAuthedBytes").mockReturnValue(read.promise);
    const first = authedObjectUrl(PATH);
    expect(authedObjectUrl(PATH)).toBe(first);
    read.resolve(picture());
    const url = await first;
    expect(await authedObjectUrl(PATH)).toBe(url);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(PATH, expect.any(AbortSignal));
  });

  it("retries a failed read", async () => {
    const fetch = vi.spyOn(api, "fetchAuthedBytes")
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(picture());
    await expect(authedObjectUrl(PATH)).rejects.toThrow("offline");
    expect(await authedObjectUrl(PATH)).toMatch(/^blob:/);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps the 64-entry FIFO bound and revokes the evicted URL", async () => {
    vi.spyOn(api, "fetchAuthedBytes").mockResolvedValue(picture());
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    const first = await authedObjectUrl(PATH);
    for (let i = 0; i < 64; i++) await authedObjectUrl(`${PATH}/${String(i)}`);
    expect(revoke).toHaveBeenCalledExactlyOnceWith(first);
    expect(await authedObjectUrl(PATH)).not.toBe(first);
  });

  it("revokes on token replacement, but not an unchanged token or refusal latch alone", async () => {
    const fetch = vi.spyOn(api, "fetchAuthedBytes").mockResolvedValue(picture());
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    const old = await authedObjectUrl(PATH);
    setDeviceToken("old-token");
    markNotPaired();
    expect(await authedObjectUrl(PATH)).toBe(old);
    expect(revoke).not.toHaveBeenCalled();
    setDeviceToken("new-token");
    expect(revoke).toHaveBeenCalledExactlyOnceWith(old);
    expect(await authedObjectUrl(PATH)).not.toBe(old);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each(["unpair", "revoked", "expired", "password"] as const)("revokes cached URLs on %s", async (reason) => {
    vi.spyOn(api, "fetchAuthedBytes").mockResolvedValue(picture());
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    const old = await authedObjectUrl(PATH);
    const report = reason === "password"
      ? await wipeDevice(reason, { scope: { host: "peer" }, paneId: "pane" })
      : await wipeDevice(reason);
    expect(report.failed).not.toContain("authed-urls");
    expect(revoke).toHaveBeenCalledExactlyOnceWith(old);
    expect(getDeviceToken()).toBe(reason === "password" ? "old-token" : null);
    expect(await authedObjectUrl(PATH)).not.toBe(old);
  });

  it.each(["token", "unpair", "revoked", "expired", "password"] as const)("aborts and rejects a late response after %s without displacing a new read", async (reason) => {
    const old = deferred();
    const fresh = deferred();
    const fetch = vi.spyOn(api, "fetchAuthedBytes")
      .mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const create = vi.spyOn(URL, "createObjectURL");
    const pending = authedObjectUrl(PATH);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    const signal = fetch.mock.calls[0]?.[1];
    expect(signal?.aborted).toBe(false);
    if (reason === "token") setDeviceToken("new-token");
    else if (reason === "password") await wipeDevice(reason, { scope: undefined, paneId: "pane" });
    else await wipeDevice(reason);
    expect(signal?.aborted).toBe(true);
    const next = authedObjectUrl(PATH);
    // Deliberately ignore the aborted signal, like a body that was already delivered.
    old.resolve(picture());
    await rejected;
    expect(create).not.toHaveBeenCalled();
    expect(authedObjectUrl(PATH)).toBe(next);
    fresh.resolve(picture());
    expect(await next).toMatch(/^blob:/);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("aborts evicted pending reads too, and the test reset revokes resolved URLs", async () => {
    const old = deferred();
    const fetch = vi.spyOn(api, "fetchAuthedBytes").mockReturnValueOnce(old.promise).mockResolvedValue(picture());
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    const pending = authedObjectUrl(PATH);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    for (let i = 0; i < 64; i++) await authedObjectUrl(`${PATH}/${String(i)}`);
    __resetAuthedUrls();
    expect(fetch.mock.calls[0]?.[1]?.aborted).toBe(true);
    expect(revoke).toHaveBeenCalledTimes(64);
    old.resolve(picture());
    await rejected;
  });
});

describe("cross-tab storage changes", () => {
  it.each(["unpair", "revoked", "expired"] as const)("a remote %s broadcast aborts a read without clearing shared credentials or rebroadcasting", async (reason) => {
    const read = deferred();
    const fetch = vi.spyOn(api, "fetchAuthedBytes").mockReturnValue(read.promise);
    const create = vi.spyOn(URL, "createObjectURL");
    const pending = authedObjectUrl(PATH);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    const channel = new BroadcastChannel(WIPE_CHANNEL);
    const post = vi.spyOn(BroadcastChannel.prototype, "postMessage");
    try {
      const send = channel.postMessage.bind(channel);
      send({ type: "wipe", reason, from: "other-test-tab" });
      await waitFor(() => expect(fetch.mock.calls[0]?.[1]?.aborted).toBe(true));
      read.resolve(picture());
      await rejected;
      expect(create).not.toHaveBeenCalled();
      expect(getDeviceToken()).toBe("old-token");
      expect(post).toHaveBeenCalledTimes(1);
    } finally {
      channel.close();
    }
  });

  it.each(["remove", "replace", "clear"] as const)("retires mounted content on a remote token %s without refetching", async (change) => {
    const fetch = vi.spyOn(api, "fetchAuthedBytes").mockResolvedValue(picture());
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    const { result } = renderHook(() => useAuthedUrl(PATH));
    await waitFor(() => expect(result.current.url).toMatch(/^blob:/));
    const old = result.current.url;
    act(() => {
      // Change shared storage without calling this document's pairing subscription.
      if (change === "clear") localStorage.clear();
      else if (change === "remove") localStorage.removeItem(TOKEN_STORAGE_KEY);
      else localStorage.setItem(TOKEN_STORAGE_KEY, "other-tab-token");
      window.dispatchEvent(new StorageEvent("storage", {
        storageArea: localStorage,
        key: change === "clear" ? null : TOKEN_STORAGE_KEY,
        oldValue: change === "clear" ? null : "old-token",
        newValue: change === "replace" ? "other-tab-token" : null,
      }));
    });
    expect(revoke).toHaveBeenCalledWith(old);
    expect(result.current.url).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await authedObjectUrl(PATH)).not.toBe(old);
  });

  it("aborts a pending read and refuses its late body after a remote token change", async () => {
    const read = deferred();
    const fetch = vi.spyOn(api, "fetchAuthedBytes").mockReturnValue(read.promise);
    const create = vi.spyOn(URL, "createObjectURL");
    const pending = authedObjectUrl(PATH);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    window.dispatchEvent(new StorageEvent("storage", {
      storageArea: localStorage, key: TOKEN_STORAGE_KEY, oldValue: "old-token", newValue: null,
    }));
    expect(fetch.mock.calls[0]?.[1]?.aborted).toBe(true);
    read.resolve(picture());
    await rejected;
    expect(create).not.toHaveBeenCalled();
  });

  it("ignores preferences, session storage and unchanged token events", async () => {
    vi.spyOn(api, "fetchAuthedBytes").mockResolvedValue(picture());
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    const old = await authedObjectUrl(PATH);
    for (const event of [
      { storageArea: localStorage, key: "collie:locale:v1", oldValue: "en", newValue: "de" },
      { storageArea: sessionStorage, key: TOKEN_STORAGE_KEY, oldValue: "old-token", newValue: null },
      { storageArea: localStorage, key: TOKEN_STORAGE_KEY, oldValue: "old-token", newValue: "old-token" },
    ]) window.dispatchEvent(new StorageEvent("storage", event));
    expect(await authedObjectUrl(PATH)).toBe(old);
    expect(revoke).not.toHaveBeenCalled();
  });
});

describe("mounted consumers", () => {
  it("drops a fulfilled URL even if its consumer continuation has not run yet", async () => {
    vi.spyOn(api, "fetchAuthedBytes").mockResolvedValue(picture());
    const { result } = renderHook(() => useAuthedUrl(PATH));
    await act(async () => {
      await authedObjectUrl(PATH);
      setDeviceToken("new-token");
    });
    expect(result.current).toEqual({ url: null, failed: false });
  });

  it("does not refill a mounted consumer from a late body after a password wipe", async () => {
    const read = deferred();
    const fetch = vi.spyOn(api, "fetchAuthedBytes").mockReturnValue(read.promise);
    const { result } = renderHook(() => useAuthedUrl(PATH));
    await act(async () => {
      await wipeDevice("password", { scope: undefined, paneId: "pane" });
      read.resolve(picture());
    });
    expect(result.current).toEqual({ url: null, failed: false });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("an unmounted consumer does not cancel another consumer's shared read", async () => {
    const read = deferred();
    const fetch = vi.spyOn(api, "fetchAuthedBytes").mockReturnValue(read.promise);
    const first = renderHook(() => useAuthedUrl(PATH));
    const second = renderHook(() => useAuthedUrl(PATH));
    first.unmount();
    expect(fetch.mock.calls[0]?.[1]?.aborted).toBe(false);
    await act(async () => read.resolve(picture()));
    await waitFor(() => expect(second.result.current.url).toMatch(/^blob:/));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("ignores an old source's late completion and preserves data/null passthrough", async () => {
    const read = deferred();
    const fetch = vi.spyOn(api, "fetchAuthedBytes").mockReturnValue(read.promise);
    const initialProps: UrlSource = { src: PATH };
    const { result, rerender } = renderHook(({ src }) => useAuthedUrl(src), { initialProps });
    rerender({ src: "data:image/png;base64,AA==" });
    await act(async () => read.resolve(picture()));
    expect(result.current).toEqual({ url: "data:image/png;base64,AA==", failed: false });
    rerender({ src: null });
    expect(result.current).toEqual({ url: null, failed: false });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

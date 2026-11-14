import { useRef } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { clearStatus } from "@/lib/status";
import { graphemes, joinLines, keysForLineChange, useDirectTyping } from "./use-direct-typing";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

interface HarnessProps {
  sendKeys: (keys: string[]) => Promise<boolean>;
  suspended?: boolean;
  agentKey?: string;
  paneKey?: string;
  /** Receives the verdict `sendPaneKeys` answers for a tap on the dock button. */
  onDock?: (ok: boolean) => void;
}

function Harness({ sendKeys, suspended = false, agentKey = "claude", paneKey = "pane-1", onDock }: HarnessProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const direct = useDirectTyping({
    paneKey,
    inputRef,
    replyDraft: () => "",
    canActivate: () => !suspended,
    suspended,
    sendKeys,
    onActivate: () => {},
    focusInput: () => inputRef.current?.focus(),
    agentKey,
  });
  return (
    <>
      <button type="button" onClick={direct.activate}>Start typing</button>
      <button type="button" onClick={direct.deactivate}>Stop typing</button>
      <button type="button" onClick={() => void direct.sendPaneKeys(["Tab"]).then(onDock)}>Dock key</button>
      <button type="button" onClick={direct.sendHeldAsOneLine}>One line</button>
      <button type="button" onClick={direct.sendHeldLineByLine}>Line by line</button>
      <button type="button" onClick={direct.discardHeld}>Discard</button>
      <output aria-label="Typing mode">{direct.active ? "active" : "inactive"}</output>
      <output aria-label="Held lines">{direct.heldLines}</output>
      <textarea
        aria-label="Terminal input"
        ref={inputRef}
        value={direct.value}
        onChange={direct.onChange}
        onCompositionStart={direct.onCompositionStart}
        onCompositionEnd={direct.onCompositionEnd}
        onKeyDown={direct.onKeyDown}
      />
    </>
  );
}

const visibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
afterEach(() => {
  clearStatus();
  vi.useRealTimers();
  if (visibility !== undefined) Object.defineProperty(document, "visibilityState", visibility);
  else Reflect.deleteProperty(document, "visibilityState");
});

// A browser has the composed text in the field by the time compositionend fires.
function compose(box: HTMLElement, text: string) {
  fireEvent.compositionStart(box);
  fireEvent.input(box, { target: { value: text }, inputType: "insertCompositionText", isComposing: true });
  fireEvent.compositionEnd(box, { data: text });
}

function startTyping() {
  fireEvent.click(screen.getByRole("button", { name: "Start typing" }));
  return screen.getByRole("textbox", { name: "Terminal input" });
}

describe("useDirectTyping: disarming drops unsent keys", () => {
  it.each(["stop", "hidden", "suspended", "agent", "timeout", "pane", "unmount"] as const)(
    "%s never drains keys queued behind an in-flight batch",
    async (reason) => {
      vi.useFakeTimers();
      const first = deferred<boolean>();
      const sendKeys = vi.fn<(keys: string[]) => Promise<boolean>>()
        .mockImplementationOnce(() => first.promise)
        .mockResolvedValue(true);
      const view = render(<Harness sendKeys={sendKeys} />);
      const box = startTyping();
      fireEvent.change(box, { target: { value: "a" } });
      fireEvent.change(box, { target: { value: "b" } });
      fireEvent.keyDown(box, { key: "Enter" });
      expect(sendKeys).toHaveBeenCalledExactlyOnceWith(["a"]);

      if (reason === "stop") fireEvent.click(screen.getByRole("button", { name: "Stop typing" }));
      if (reason === "hidden") {
        Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
        fireEvent(document, new Event("visibilitychange"));
      }
      if (reason === "suspended") view.rerender(<Harness sendKeys={sendKeys} suspended />);
      if (reason === "agent") view.rerender(<Harness sendKeys={sendKeys} agentKey="shell" />);
      if (reason === "timeout") act(() => vi.advanceTimersByTime(60_000));
      if (reason === "pane") view.rerender(<Harness sendKeys={sendKeys} paneKey="pane-2" />);
      if (reason === "unmount") view.unmount();

      if (reason !== "unmount") expect(screen.getByLabelText("Typing mode")).toHaveTextContent("inactive");
      await act(async () => first.resolve(true));
      expect(sendKeys).toHaveBeenCalledExactlyOnceWith(["a"]);
    },
  );

  it("an old failed batch cannot disarm or discard a newly armed session", async () => {
    const first = deferred<boolean>();
    const sendKeys = vi.fn<(keys: string[]) => Promise<boolean>>()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue(true);
    render(<Harness sendKeys={sendKeys} />);
    const box = startTyping();
    fireEvent.change(box, { target: { value: "old" } });
    fireEvent.keyDown(box, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Stop typing" }));
    startTyping();
    fireEvent.change(box, { target: { value: "new" } });

    await act(async () => first.resolve(false));
    expect(sendKeys.mock.calls).toEqual([[["o", "l", "d"]], [["n", "e", "w"]]]);
    expect(screen.getByLabelText("Typing mode")).toHaveTextContent(/^active$/);
  });

  it("ignores late keyboard and composition events after disarming", () => {
    const sendKeys = vi.fn<(keys: string[]) => Promise<boolean>>().mockResolvedValue(true);
    render(<Harness sendKeys={sendKeys} />);
    const box = startTyping();
    fireEvent.compositionStart(box);
    fireEvent.input(box, { target: { value: "한" }, inputType: "insertCompositionText", isComposing: true });
    fireEvent.click(screen.getByRole("button", { name: "Stop typing" }));
    fireEvent.compositionEnd(box, { data: "한" });
    fireEvent.keyDown(box, { key: "Enter" });
    fireEvent.change(box, { target: { value: "late" } });
    expect(sendKeys).not.toHaveBeenCalled();
  });
});

describe("useDirectTyping: physical IME keys belong to the candidate", () => {
  it.each(["Enter", "Backspace", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Escape", "Tab"])(
    "does not intercept %s during Korean composition",
    async (key) => {
      const sendKeys = vi.fn<(keys: string[]) => Promise<boolean>>().mockResolvedValue(true);
      render(<Harness sendKeys={sendKeys} />);
      const box = startTyping();
      fireEvent.compositionStart(box);
      fireEvent.input(box, { target: { value: "한" }, inputType: "insertCompositionText", isComposing: true });
      expect(fireEvent.keyDown(box, { key, isComposing: true })).toBe(true);
      expect(sendKeys).not.toHaveBeenCalled();
      fireEvent.compositionEnd(box, { data: "한" });
      await act(async () => {});
      expect(sendKeys).toHaveBeenCalledExactlyOnceWith(["한"]);
    },
  );

  it("also protects composition when keydown omits isComposing", () => {
    const sendKeys = vi.fn<(keys: string[]) => Promise<boolean>>().mockResolvedValue(true);
    render(<Harness sendKeys={sendKeys} />);
    const box = startTyping();
    fireEvent.compositionStart(box);
    expect(fireEvent.keyDown(box, { key: "Enter" })).toBe(true);
    expect(sendKeys).not.toHaveBeenCalled();
  });

  it("keeps native Backspace in the candidate even when beforeinput omits isComposing", () => {
    const sendKeys = vi.fn<(keys: string[]) => Promise<boolean>>().mockResolvedValue(true);
    render(<Harness sendKeys={sendKeys} />);
    const box = startTyping();
    fireEvent.compositionStart(box);
    expect(fireEvent(box, new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      inputType: "deleteContentBackward",
    }))).toBe(true);
    expect(sendKeys).not.toHaveBeenCalled();
  });

  it("does not send Safari's IME-confirming Enter after compositionend", async () => {
    const sendKeys = vi.fn<(keys: string[]) => Promise<boolean>>().mockResolvedValue(true);
    render(<Harness sendKeys={sendKeys} />);
    const box = startTyping();
    compose(box, "한");
    expect(fireEvent.keyDown(box, { key: "Enter", keyCode: 229 })).toBe(true);
    await act(async () => {});
    expect(sendKeys).toHaveBeenCalledExactlyOnceWith(["한"]);

    fireEvent.keyDown(box, { key: "Enter" });
    await act(async () => {});
    expect(sendKeys.mock.calls).toEqual([[["한"]], [["Enter"]]]);
  });

  it("sends a real Enter (keyCode 13) right after compositionend", async () => {
    const sendKeys = vi.fn<(keys: string[]) => Promise<boolean>>().mockResolvedValue(true);
    render(<Harness sendKeys={sendKeys} />);
    const box = startTyping();
    compose(box, "한");
    expect(fireEvent.keyDown(box, { key: "Enter", keyCode: 13 })).toBe(false);
    await act(async () => {});
    expect(sendKeys.mock.calls).toEqual([[["한"]], [["Enter"]]]);
  });

  // The composed text is in the field, so a real Backspace right after compositionend deletes it
  // there, and that edit is what sends the Backspace.
  it.each(["keydown", "beforeinput"] as const)(
    "sends a real Backspace %s right after compositionend through the field's edit",
    async (via) => {
      const sendKeys = vi.fn<(keys: string[]) => Promise<boolean>>().mockResolvedValue(true);
      render(<Harness sendKeys={sendKeys} />);
      const box = startTyping();
      compose(box, "한");
      const fired = via === "keydown"
        ? fireEvent.keyDown(box, { key: "Backspace", keyCode: 8 })
        : fireEvent(box, new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          inputType: "deleteContentBackward",
        }));
      expect(fired).toBe(true);
      fireEvent.change(box, { target: { value: "" } });
      await act(async () => {});
      expect(sendKeys.mock.calls).toEqual([[["한"]], [["Backspace"]]]);
    },
  );

  // Android Gboard reports keyCode 229 with key "Unidentified" for every virtual key; none of
  // those has a wire name, and the real Backspace and Enter arrive as beforeinput instead.
  it("sends nothing for a keyCode 229 keydown with key Unidentified", async () => {
    const sendKeys = vi.fn<(keys: string[]) => Promise<boolean>>().mockResolvedValue(true);
    render(<Harness sendKeys={sendKeys} />);
    const box = startTyping();
    expect(fireEvent.keyDown(box, { key: "Unidentified", keyCode: 229 })).toBe(true);
    await act(async () => {});
    expect(sendKeys).not.toHaveBeenCalled();
  });

  // Only the echo right after compositionend is the IME's. A 229 keydown that maps to a wire key
  // later on is a real key, and an unprevented Tab would move focus out of the field.
  it.each(["ArrowUp", "Escape", "Tab"])(
    "sends a keyCode 229 %s only after the confirm window closes",
    async (key) => {
      vi.useFakeTimers();
      const sendKeys = vi.fn<(keys: string[]) => Promise<boolean>>().mockResolvedValue(true);
      render(<Harness sendKeys={sendKeys} />);
      const box = startTyping();
      compose(box, "한");
      await act(async () => {});
      expect(sendKeys).toHaveBeenCalledExactlyOnceWith(["한"]);

      act(() => vi.advanceTimersByTime(499));
      expect(fireEvent.keyDown(box, { key, keyCode: 229 })).toBe(true);
      await act(async () => {});
      expect(sendKeys).toHaveBeenCalledExactlyOnceWith(["한"]);

      act(() => vi.advanceTimersByTime(2));
      expect(fireEvent.keyDown(box, { key, keyCode: 229 })).toBe(false);
      await act(async () => {});
      expect(sendKeys).toHaveBeenCalledTimes(2);
    },
  );

  it("sends a keyCode 229 arrow when no composition ever ended", async () => {
    const sendKeys = vi.fn<(keys: string[]) => Promise<boolean>>().mockResolvedValue(true);
    render(<Harness sendKeys={sendKeys} />);
    const box = startTyping();
    expect(fireEvent.keyDown(box, { key: "ArrowLeft", keyCode: 229 })).toBe(false);
    await act(async () => {});
    expect(sendKeys).toHaveBeenCalledExactlyOnceWith(["Left"]);
  });

  it("lets Backspace and arrows through again after a blur ends a lost composition", async () => {
    const sendKeys = vi.fn<(keys: string[]) => Promise<boolean>>().mockResolvedValue(true);
    render(<Harness sendKeys={sendKeys} />);
    const box = startTyping();
    const backspace = () => fireEvent(box, new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      inputType: "deleteContentBackward",
    }));
    // compositionend never fires: the flag would stay set and swallow these.
    fireEvent.compositionStart(box);
    expect(backspace()).toBe(true);
    expect(fireEvent.keyDown(box, { key: "ArrowUp" })).toBe(true);
    expect(sendKeys).not.toHaveBeenCalled();

    fireEvent.blur(box);
    expect(backspace()).toBe(false);
    expect(fireEvent.keyDown(box, { key: "ArrowUp" })).toBe(false);
    await act(async () => {});
    expect(sendKeys.mock.calls).toEqual([[["Backspace"]], [["Up"]]]);
  });
});

// Issue 534. A keyboard keeps its own copy of the text before the caret. Emptying the field under it
// after every word made SwiftKey commit that copy again, so `cd cd` reached the shell as
// `cdcd cdcdcd`. The field now keeps what was typed until Enter, and only the difference is sent.
describe("useDirectTyping: the field keeps the line the keyboard believes is there", () => {
  function sent(sendKeys: { mock: { calls: [string[]][] } }) {
    return sendKeys.mock.calls.flatMap(([keys]) => keys);
  }

  it("sends a word once when the keyboard composes the next word over the whole line", async () => {
    const sendKeys = vi.fn<(keys: string[]) => Promise<boolean>>().mockResolvedValue(true);
    render(<Harness sendKeys={sendKeys} />);
    const box = startTyping();
    fireEvent.compositionStart(box);
    fireEvent.input(box, { target: { value: "cd" }, inputType: "insertCompositionText", isComposing: true });
    fireEvent.compositionEnd(box, { data: "cd" });
    fireEvent.change(box, { target: { value: "cd " } });
    fireEvent.compositionStart(box);
    fireEvent.input(box, { target: { value: "cd cd" }, inputType: "insertCompositionText", isComposing: true });
    fireEvent.compositionEnd(box, { data: "cd" });
    await act(async () => {});
    expect(sent(sendKeys)).toEqual(["c", "d", "Space", "c", "d"]);
    expect(box).toHaveValue("cd cd");
  });

  it("sends only the characters a change adds, and a Backspace for each it removes", async () => {
    const sendKeys = vi.fn<(keys: string[]) => Promise<boolean>>().mockResolvedValue(true);
    render(<Harness sendKeys={sendKeys} />);
    const box = startTyping();
    fireEvent.change(box, { target: { value: "l" } });
    fireEvent.change(box, { target: { value: "ls" } });
    fireEvent.change(box, { target: { value: "l" } });
    fireEvent.change(box, { target: { value: "la" } });
    fireEvent.change(box, { target: { value: "ab" } });
    await act(async () => {});
    expect(sent(sendKeys)).toEqual(["l", "s", "Backspace", "a", "Backspace", "Backspace", "a", "b"]);
  });

  it("empties the field at Enter, and a later word is not sent again", async () => {
    const sendKeys = vi.fn<(keys: string[]) => Promise<boolean>>().mockResolvedValue(true);
    render(<Harness sendKeys={sendKeys} />);
    const box = startTyping();
    fireEvent.change(box, { target: { value: "ls" } });
    expect(box).toHaveValue("ls");
    expect(fireEvent.keyDown(box, { key: "Enter" })).toBe(false);
    expect(box).toHaveValue("");
    fireEvent.change(box, { target: { value: "pwd" } });
    await act(async () => {});
    expect(sent(sendKeys)).toEqual(["l", "s", "Enter", "p", "w", "d"]);
  });

  it("leaves a Backspace on typed text to the field, and sends one on an empty field", async () => {
    const sendKeys = vi.fn<(keys: string[]) => Promise<boolean>>().mockResolvedValue(true);
    render(<Harness sendKeys={sendKeys} />);
    const box = startTyping();
    const backspace = () => fireEvent(box, new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      inputType: "deleteContentBackward",
    }));
    fireEvent.change(box, { target: { value: "x" } });
    expect(backspace()).toBe(true);
    expect(fireEvent.keyDown(box, { key: "Backspace" })).toBe(true);
    fireEvent.change(box, { target: { value: "" } });
    expect(backspace()).toBe(false);
    expect(fireEvent.keyDown(box, { key: "Backspace" })).toBe(false);
    await act(async () => {});
    expect(sent(sendKeys)).toEqual(["x", "Backspace", "Backspace", "Backspace"]);
  });
});

describe("useDirectTyping: the line-end rule, pastes, graphemes and the keyboard's write-back", () => {
  function sent(sendKeys: { mock: { calls: [string[]][] } }) {
    return sendKeys.mock.calls.flatMap(([keys]) => keys);
  }
  function mockSend() {
    return vi.fn<(keys: string[]) => Promise<boolean>>().mockResolvedValue(true);
  }
  function composingEnter(box: HTMLElement) {
    return fireEvent(box, new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      inputType: "insertParagraph",
      isComposing: true,
    }));
  }

  it("a Tab ends the line, so a later edit never erases the completion the shell typed", async () => {
    const sendKeys = mockSend();
    render(<Harness sendKeys={sendKeys} />);
    const box = startTyping();
    fireEvent.change(box, { target: { value: "cd Doc" } });
    expect(fireEvent.keyDown(box, { key: "Tab" })).toBe(false);
    expect(box).toHaveValue("");
    // The shell now holds "cd Documents/". Autocorrect or a word delete only reaches what follows.
    fireEvent.change(box, { target: { value: "teh" } });
    fireEvent.change(box, { target: { value: "the" } });
    fireEvent.change(box, { target: { value: "" } });
    await act(async () => {});
    expect(sent(sendKeys)).toEqual([
      "c", "d", "Space", "D", "o", "c", "Tab",
      "t", "e", "h", "Backspace", "Backspace", "h", "e", "Backspace", "Backspace", "Backspace",
    ]);
  });

  it.each([["ArrowLeft", "Left"], ["ArrowUp", "Up"], ["Escape", "Escape"]])(
    "%s ends the line like Enter: unsent text first, then the key, then an empty field",
    async (key, wire) => {
      const sendKeys = mockSend();
      render(<Harness sendKeys={sendKeys} />);
      const box = startTyping();
      fireEvent.change(box, { target: { value: "ab" } });
      expect(fireEvent.keyDown(box, { key })).toBe(false);
      expect(box).toHaveValue("");
      fireEvent.change(box, { target: { value: "x" } });
      fireEvent.change(box, { target: { value: "" } });
      await act(async () => {});
      expect(sent(sendKeys)).toEqual(["a", "b", wire, "x", "Backspace"]);
    },
  );

  it("a Keys dock key ends the line too, and queues behind the text a batch in flight still holds", async () => {
    const first = deferred<boolean>();
    const sendKeys = vi.fn<(keys: string[]) => Promise<boolean>>()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue(true);
    render(<Harness sendKeys={sendKeys} />);
    const box = startTyping();
    fireEvent.change(box, { target: { value: "git" } });
    expect(sendKeys).toHaveBeenCalledExactlyOnceWith(["g", "i", "t"]);
    // " sta" waits behind the batch on the wire; the dock's Tab must not overtake it (issue 534).
    fireEvent.change(box, { target: { value: "git sta" } });
    fireEvent.click(screen.getByRole("button", { name: "Dock key" }));
    expect(box).toHaveValue("");
    expect(sendKeys).toHaveBeenCalledTimes(1);
    await act(async () => first.resolve(true));
    expect(sent(sendKeys)).toEqual(["g", "i", "t", "Space", "s", "t", "a", "Tab"]);
    // The field holds only what follows the Tab from here.
    fireEvent.change(box, { target: { value: "s" } });
    await act(async () => {});
    expect(sent(sendKeys)).toEqual(["g", "i", "t", "Space", "s", "t", "a", "Tab", "s"]);
  });

  it("a Keys dock key sends a composition still open before the key, and empties the field", async () => {
    const sendKeys = mockSend();
    render(<Harness sendKeys={sendKeys} />);
    const box = startTyping();
    fireEvent.change(box, { target: { value: "git " } });
    fireEvent.compositionStart(box);
    fireEvent.change(box, { target: { value: "git sta" } });
    fireEvent.click(screen.getByRole("button", { name: "Dock key" }));
    await act(async () => {});
    expect(sent(sendKeys)).toEqual(["g", "i", "t", "Space", "s", "t", "a", "Tab"]);
    expect(box).toHaveValue("");
  });

  it("outside Type mode a Keys dock key takes the plain path and answers its verdict", async () => {
    const sendKeys = vi.fn<(keys: string[]) => Promise<boolean>>().mockResolvedValue(false);
    const onDock = vi.fn<(ok: boolean) => void>();
    render(<Harness sendKeys={sendKeys} onDock={onDock} />);
    fireEvent.click(screen.getByRole("button", { name: "Dock key" }));
    await act(async () => {});
    expect(sendKeys).toHaveBeenCalledExactlyOnceWith(["Tab"]);
    expect(onDock).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("deleting one emoji sends one Backspace, whatever code points it is made of", async () => {
    const sendKeys = mockSend();
    render(<Harness sendKeys={sendKeys} />);
    const box = startTyping();
    fireEvent.change(box, { target: { value: "ok 👍🏽" } });
    sendKeys.mockClear();
    fireEvent.change(box, { target: { value: "ok " } });
    await act(async () => {});
    expect(sent(sendKeys)).toEqual(["Backspace"]);
    expect(keysForLineChange("a👨‍👩‍👧🇩🇪", "a")).toEqual(["Backspace", "Backspace"]);
    expect(keysForLineChange("cafe\u0301", "caf")).toEqual(["Backspace"]);
  });

  it("falls back to code points where the engine has no Intl.Segmenter", () => {
    const own = Object.getOwnPropertyDescriptor(Intl, "Segmenter");
    Reflect.deleteProperty(Intl, "Segmenter");
    try {
      expect(graphemes("a👍🏽")).toEqual(["a", "👍", "🏽"]);
      expect(keysForLineChange("👍🏽", "")).toEqual(["Backspace", "Backspace"]);
    } finally {
      if (own !== undefined) Object.defineProperty(Intl, "Segmenter", own);
    }
  });

  it("Enter during a composition sends the word once: the compositionend after it writes nothing back", async () => {
    const sendKeys = mockSend();
    render(<Harness sendKeys={sendKeys} />);
    const box = startTyping();
    fireEvent.compositionStart(box);
    fireEvent.input(box, { target: { value: "cd" }, inputType: "insertCompositionText", isComposing: true });
    expect(composingEnter(box)).toBe(false);
    expect(box).toHaveValue("");
    // The keyboard finishes the composition it still believes is open, into the emptied field.
    fireEvent.input(box, { target: { value: "cd" }, inputType: "insertCompositionText", isComposing: true });
    fireEvent.compositionEnd(box, { data: "cd" });
    expect(box).toHaveValue("");
    compose(box, "ls");
    await act(async () => {});
    expect(sent(sendKeys)).toEqual(["c", "d", "Enter", "l", "s"]);
  });

  it("drops a keyboard re-committing the last word in a fresh composition right after Enter", async () => {
    const sendKeys = mockSend();
    render(<Harness sendKeys={sendKeys} />);
    const box = startTyping();
    compose(box, "cd");
    fireEvent.change(box, { target: { value: "cd " } });
    compose(box, "cd cd");
    expect(fireEvent.keyDown(box, { key: "Enter" })).toBe(false);
    compose(box, "cd");
    expect(box).toHaveValue("");
    await act(async () => {});
    expect(sent(sendKeys)).toEqual(["c", "d", "Space", "c", "d", "Enter"]);
  });

  it("still sends the same word typed again after the write-back window, or on a hardware keyboard", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    try {
      const sendKeys = mockSend();
      render(<Harness sendKeys={sendKeys} />);
      const box = startTyping();
      fireEvent.change(box, { target: { value: "ls" } });
      fireEvent.keyDown(box, { key: "Enter" });
      // A hardware keyboard does not compose, so a fast repeat is the person's.
      fireEvent.change(box, { target: { value: "ls" } });
      fireEvent.keyDown(box, { key: "Enter" });
      // A composing keyboard past the window: a person, not a write-back.
      now.mockReturnValue(1_000_000 + 600);
      compose(box, "ls");
      await act(async () => {});
      expect(sent(sendKeys)).toEqual(["l", "s", "Enter", "l", "s", "Enter", "l", "s"]);
    } finally {
      now.mockRestore();
    }
  });
});

// Issue #134. A pasted line break is data: it reaches the pane as Enter only through a labelled action.
describe("useDirectTyping: text with a line break is held until an explicit action", () => {
  const PASTE = "echo a\r\nls -l\npw";
  function sent(sendKeys: { mock: { calls: [string[]][] } }) {
    return sendKeys.mock.calls.flatMap(([keys]) => keys);
  }
  function mockSend() {
    return vi.fn<(keys: string[]) => Promise<boolean>>().mockResolvedValue(true);
  }
  function tap(name: string) {
    fireEvent.click(screen.getByRole("button", { name }));
  }
  /** Type `echo a`, then paste two more lines after it. */
  function typeThenPaste(sendKeys: (keys: string[]) => Promise<boolean>) {
    render(<Harness sendKeys={sendKeys} />);
    const box = startTyping();
    fireEvent.change(box, { target: { value: "echo a" } });
    fireEvent.change(box, { target: { value: PASTE } });
    return box;
  }

  it("a paste with line breaks sends nothing and stays in the field whole", async () => {
    const sendKeys = mockSend();
    const box = typeThenPaste(sendKeys);
    await act(async () => {});
    // A textarea reports its value with every line ending normalised to LF.
    expect(box).toHaveValue("echo a\nls -l\npw");
    expect(screen.getByLabelText("Held lines")).toHaveTextContent(/^3$/);
    expect(sent(sendKeys)).toEqual(["e", "c", "h", "o", "Space", "a"]);
  });

  it.each([["LF", "one\ntwo"], ["CRLF", "one\r\ntwo"], ["CR", "one\rtwo"]])(
    "a two-line %s paste into an empty field sends no key at all",
    async (_name, text) => {
      const sendKeys = mockSend();
      render(<Harness sendKeys={sendKeys} />);
      const box = startTyping();
      fireEvent.change(box, { target: { value: text } });
      await act(async () => {});
      expect(sendKeys).not.toHaveBeenCalled();
      expect(box).toHaveValue("one\ntwo");
      expect(screen.getByLabelText("Held lines")).toHaveTextContent(/^2$/);
    },
  );

  it("refuses Enter, an arrow, Escape, Tab and a dock key while text is held", async () => {
    const sendKeys = mockSend();
    const onDock = vi.fn<(ok: boolean) => void>();
    render(<Harness sendKeys={sendKeys} onDock={onDock} />);
    const box = startTyping();
    fireEvent.change(box, { target: { value: "one\ntwo" } });
    // Refused, but still not left to the field: a default Enter would only add another break.
    for (const key of ["Enter", "ArrowUp", "Escape", "Tab"]) {
      expect(fireEvent.keyDown(box, { key })).toBe(false);
    }
    expect(fireEvent(box, new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      inputType: "insertLineBreak",
    }))).toBe(false);
    tap("Dock key");
    await act(async () => {});
    expect(sendKeys).not.toHaveBeenCalled();
    expect(onDock).toHaveBeenCalledExactlyOnceWith(false);
    expect(box).toHaveValue("one\ntwo");
    expect(screen.getByLabelText("Typing mode")).toHaveTextContent(/^active$/);
  });

  it("One line sends the lines joined by spaces with no Enter, and a typed Enter then sends one", async () => {
    const sendKeys = mockSend();
    const box = typeThenPaste(sendKeys);
    tap("One line");
    expect(box).toHaveValue("echo a ls -l pw");
    expect(screen.getByLabelText("Held lines")).toHaveTextContent(/^0$/);
    await act(async () => {});
    expect(sent(sendKeys)).toEqual([
      "e", "c", "h", "o", "Space", "a",
      "Space", "l", "s", "Space", "-", "l", "Space", "p", "w",
    ]);
    fireEvent.keyDown(box, { key: "Enter" });
    await act(async () => {});
    expect(sent(sendKeys).filter((key) => key === "Enter")).toEqual(["Enter"]);
    expect(box).toHaveValue("");
  });

  it("joins lines without a space at either end, whatever the line ending", () => {
    expect(joinLines("a\r\n  b\n\nc\n")).toBe("a b c");
    expect(joinLines("\nfoo")).toBe("foo");
    expect(joinLines("a \t\r b")).toBe("a b");
    expect(joinLines(" kept \n")).toBe(" kept");
  });

  it("Line by line sends an Enter at each break and keeps the line after the last one", async () => {
    const sendKeys = mockSend();
    const box = typeThenPaste(sendKeys);
    tap("Line by line");
    expect(box).toHaveValue("pw");
    fireEvent.change(box, { target: { value: "p" } });
    await act(async () => {});
    expect(sent(sendKeys)).toEqual([
      "e", "c", "h", "o", "Space", "a",
      "Enter", "l", "s", "Space", "-", "l", "Enter", "p", "w",
      "Backspace",
    ]);
  });

  it("Discard puts back the line the pane already has and sends nothing", async () => {
    const sendKeys = mockSend();
    const box = typeThenPaste(sendKeys);
    tap("Discard");
    expect(box).toHaveValue("echo a");
    fireEvent.change(box, { target: { value: "echo ab" } });
    await act(async () => {});
    expect(sent(sendKeys)).toEqual(["e", "c", "h", "o", "Space", "a", "b"]);
  });

  it("editing the breaks out by hand resumes sending, with the right difference", async () => {
    const sendKeys = mockSend();
    const box = typeThenPaste(sendKeys);
    fireEvent.change(box, { target: { value: "echo a\nls" } });
    fireEvent.change(box, { target: { value: "echo als" } });
    await act(async () => {});
    expect(sent(sendKeys)).toEqual(["e", "c", "h", "o", "Space", "a", "l", "s"]);
    expect(screen.getByLabelText("Held lines")).toHaveTextContent(/^0$/);
  });

  it("holds a composition that ends with a line break in the field", async () => {
    const sendKeys = mockSend();
    render(<Harness sendKeys={sendKeys} />);
    const box = startTyping();
    compose(box, "one\ntwo");
    await act(async () => {});
    expect(sendKeys).not.toHaveBeenCalled();
    expect(box).toHaveValue("one\ntwo");
  });

  it("the three actions do nothing when no text is held, or when the mode is off", async () => {
    const sendKeys = mockSend();
    render(<Harness sendKeys={sendKeys} />);
    for (const name of ["One line", "Line by line", "Discard"]) tap(name);
    const box = startTyping();
    fireEvent.change(box, { target: { value: "ls" } });
    for (const name of ["One line", "Line by line", "Discard"]) tap(name);
    await act(async () => {});
    expect(sent(sendKeys)).toEqual(["l", "s"]);
    expect(box).toHaveValue("ls");
  });

  it.each(["stop", "timeout", "agent"] as const)("a %s disarm drops held text unsent", async (reason) => {
    vi.useFakeTimers();
    const sendKeys = mockSend();
    const view = render(<Harness sendKeys={sendKeys} />);
    const box = startTyping();
    fireEvent.change(box, { target: { value: "one\ntwo" } });
    if (reason === "stop") tap("Stop typing");
    if (reason === "timeout") act(() => vi.advanceTimersByTime(60_000));
    if (reason === "agent") view.rerender(<Harness sendKeys={sendKeys} agentKey="shell" />);
    await act(async () => {});
    expect(screen.getByLabelText("Typing mode")).toHaveTextContent("inactive");
    expect(box).toHaveValue("");
    expect(sendKeys).not.toHaveBeenCalled();
  });

  it("editing held text keeps the idle watchdog from disarming mid-decision", () => {
    vi.useFakeTimers();
    const sendKeys = mockSend();
    render(<Harness sendKeys={sendKeys} />);
    const box = startTyping();
    act(() => vi.advanceTimersByTime(50_000));
    fireEvent.change(box, { target: { value: "one\ntwo" } });
    act(() => vi.advanceTimersByTime(50_000));
    expect(screen.getByLabelText("Typing mode")).toHaveTextContent(/^active$/);
    expect(box).toHaveValue("one\ntwo");
  });

  it("a failed send during One line disarms, and no Enter ever goes out", async () => {
    const sendKeys = vi.fn<(keys: string[]) => Promise<boolean>>().mockResolvedValue(false);
    render(<Harness sendKeys={sendKeys} />);
    const box = startTyping();
    fireEvent.change(box, { target: { value: "one\ntwo" } });
    tap("One line");
    await act(async () => {});
    expect(screen.getByLabelText("Typing mode")).toHaveTextContent("inactive");
    expect(box).toHaveValue("");
    expect(sent(sendKeys)).not.toContain("Enter");
  });
});

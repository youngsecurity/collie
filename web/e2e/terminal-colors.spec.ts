import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";

import { installApiStub } from "./fixtures/api";
import { collieHalves } from "./fixtures/collie-theme";

// CSS variables and filters need an engine. Exercise the real lifted menu's RawMirror, not a
// synthetic element: persisted device paint must beat theme paint on plain AND inverse text.
const web = resolve(import.meta.dirname, "..");
// Collie's two halves with the required tokens only (e2e/fixtures/collie-theme.ts): since schema
// version 3 the shipped file names `pane-active`, which a version 2 fixture may not carry.
const theme = {
  version: 2,
  id: "terminal-test",
  name: "Terminal test",
  light: collieHalves.light,
  dark: collieHalves.dark,
  ansi: {
    "0": "#000000", "1": "#cd3131", "2": "#0dbc79", "3": "#e5e510",
    "4": "#2472c8", "5": "#bc3fbc", "6": "#11a8cd", "7": "#e5e5e5",
    "8": "#666666", "9": "#f14c4c", "10": "#23d18b", "11": "#f5f543",
    "12": "#3b8eea", "13": "#d670d6", "14": "#29b8db", "15": "#ffffff",
    ink: "#ededed", ground: "#14141e",
  },
};
const picker = readFileSync(resolve(web, "src/fixtures/panes/claude--menu-model-picker.txt"), "utf8");
// Patch only a menu description; its real anchors, options and footer still select the card.
const screen = picker.replace("Most capable for your hardest and longest-running tasks",
  "\x1b[0mplain probe\x1b[7minverse probe\x1b[0m\x1b[38;2;12;34;56mexplicit probe\x1b[0m");
const choices = [
  { name: "foreground", foreground: "#112233", background: "", ink: "rgb(17, 34, 51)" },
  { name: "background", foreground: "", background: "#aabbcc", ground: "rgb(170, 187, 204)" },
  { name: "both", foreground: "#112233", background: "#aabbcc", ink: "rgb(17, 34, 51)", ground: "rgb(170, 187, 204)" },
  { name: "Matrix", foreground: "#00ff00", background: "#000000", ink: "rgb(0, 255, 0)", ground: "rgb(0, 0, 0)" },
  { name: "unset", foreground: "", background: "" },
];

test.use({ serviceWorkers: "block" });

for (const mode of ["light", "dark"] as const) {
  for (const themed of [false, true]) {
    for (const choice of choices) {
      test(`${mode}, ${themed ? "theme" : "literal"} fallback, ${choice.name} device colors`, async ({ page }) => {
        await installApiStub(page);
        await page.addInitScript(({ mode: appearance, themed: useTheme, theme: imported, choice: colors }) => {
          localStorage.setItem("collie:locale:v1", "en");
          localStorage.setItem("collie:theme:v1", appearance);
          localStorage.setItem("collie:dash-prefs:v1", JSON.stringify({ paneView: "terminal" }));
          localStorage.setItem("collie:display-prefs:v4", JSON.stringify({
            terminalForeground: colors.foreground, terminalBackground: colors.background,
            fontFamily: colors.name === "Matrix" ? "meslo" : "system",
          }));
          if (useTheme) {
            localStorage.setItem("collie:design:v1", JSON.stringify({ font: "aldrich", theme: imported.id }));
            localStorage.setItem("collie:themes:v1", JSON.stringify({ version: 1, themes: [imported] }));
          }
        }, { mode, themed, theme, choice });
        await page.route((url) => /^\/api\/pane\/[^/]+$/.test(url.pathname), (route) => route.fulfill({
          status: 200, contentType: "application/json",
          body: JSON.stringify({ paneId: "w1:p1", text: screen, truncated: false, revision: 1 }),
        }));
        await page.goto("/pane/w1:p1");
        // This control belongs to the lifted menu. Its presence distinguishes RawMirror from
        // the pane's ordinary AnsiOutput, so a lost card cannot accidentally make this pass.
        await expect(page.getByRole("button", { name: "Hide this card's buttons, keep the terminal" })).toBeVisible();
        const inverse = page.getByText("inverse probe", { exact: true });
        await expect(inverse).toBeVisible();
        const ink = choice.ink ?? (themed ? "rgb(237, 237, 237)" : "rgb(250, 250, 250)");
        const ground = choice.ground ?? (themed ? "rgb(20, 20, 30)" : "rgb(10, 10, 10)");
        await expect(page.getByText("plain probe", { exact: true })).toHaveCSS("color", ink);
        await expect(inverse).toHaveCSS("color", ground);
        await expect(inverse).toHaveCSS("background-color", ink);
        await expect(page.getByText("explicit probe", { exact: true })).toHaveCSS("color", "rgb(12, 34, 56)");
        const paint = await inverse.evaluate((el) => {
          const pre = el.closest("pre");
          if (pre === null) throw new Error("inverse text is not in a mirror");
          const style = getComputedStyle(pre);
          const ancestorFilters: string[] = [];
          for (let parent = pre.parentElement; parent !== null; parent = parent.parentElement) {
            const filter = getComputedStyle(parent).filter;
            if (filter !== "none") ancestorFilters.push(filter);
          }
          return { ink: style.color, ground: style.backgroundColor, filter: style.filter, ancestorFilters };
        });
        expect(paint.ink).toBe(ink);
        expect(paint.ground).toBe(ground);
        expect(paint.ancestorFilters).toEqual([]);
        expect(paint.filter).toBe(mode === "light" && choice.name === "unset"
          ? "invert(1) hue-rotate(180deg)" : "none");
      });
    }
  }
}

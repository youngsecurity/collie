import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// Vitest runs without the PWA/Tailwind plugins (tests don't need a service worker or compiled CSS).
// jsdom + Testing Library + MSW cover components and the /api fetch layer; no headless browser.
export default defineConfig({
  // Stub the build stamp (real values are injected by vite.config.ts at build time).
  define: {
    __BUILD_INFO__: JSON.stringify({
      version: "0.0.0-test",
      sha: "test",
      time: "1970-01-01T00:00:00.000Z",
      id: "test",
    }),
  },
  plugins: [react()],
  resolve: {
    alias: {
      "@": resolve(import.meta.dirname, "src"),
      // No VitePWA plugin under Vitest, so the virtual register module is stubbed (see the stub).
      "virtual:pwa-register": resolve(import.meta.dirname, "src/test/pwa-register-stub.ts"),
    },
  },
  test: {
    environment: "jsdom",
    // Node ≥25 ships its own Web Storage globals (nodejs/node#57666), which shadow jsdom's
    // localStorage in the test workers — every `localStorage.clear()` then explodes on a
    // broken global (vitest-dev/vitest#8757). Hand the flag to the workers so jsdom's
    // implementation is the only one in the room. Node <25 has no such global and rejects
    // the flag outright ("bad option"), so it is gated on the running major.
    execArgv: Number(process.versions.node.split(".")[0]) >= 25 ? ["--no-webstorage"] : [],
    globals: true,
    css: false,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
  },
});

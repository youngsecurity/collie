import { describe, expect, it } from "vitest";

import { buildInfoFor } from "../vite-build";
import { channelFor, manifestFor, type Channel } from "../vite-icons";
import { prereleaseLabel } from "./lib/build";

describe("frontend build stamps", () => {
  const time = "2026-01-02T12:00:00.000Z";
  const seconds = Date.parse(time) / 1000;

  it.each<{ version: string; channel: Channel; stamped: string; metadata: string }>([
    { version: "1.9.0+ys.1", channel: "release", stamped: "1.9.0+ys.1", metadata: "ys.1." },
    { version: "1.9.0+ys.1", channel: "dev", stamped: "1.9.0-dev+ys.1", metadata: "ys.1." },
    { version: "1.9.0-beta.2+ys.1", channel: "dev", stamped: "1.9.0-beta.2-dev+ys.1", metadata: "ys.1." },
    { version: "1.9.0", channel: "release", stamped: "1.9.0", metadata: "" },
    { version: "1.9.0", channel: "dev", stamped: "1.9.0-dev", metadata: "" },
  ])("$version on $channel preserves one metadata separator", ({ version, channel, stamped, metadata }) => {
    const info = buildInfoFor({ version, channel, sha: "abc1234-dirty", time });
    expect(info.version).toBe(stamped);
    expect(info.id).toBe(`${stamped.split("+")[0]}+${metadata}abc1234-dirty.${seconds}`);
    expect(info.id.match(/\+/g)).toHaveLength(1);
    expect(info).toMatchObject({ channel, sha: "abc1234-dirty", time });
  });

  it.each([
    { head: null, tagCommit: null, tagCount: null },
    { head: "abc", tagCommit: null, tagCount: 0 },
    { head: "abc", tagCommit: "abc", tagCount: 2 },
    { head: "abc", tagCommit: null, tagCount: 2 },
    { head: "abc", tagCommit: "def", tagCount: 2 },
  ])("the stamp and icon manifest agree for evidence %j", (evidence) => {
    const channel = channelFor(evidence);
    const info = buildInfoFor({ version: "1.9.0+ys.1", channel, sha: "abc1234", time });
    const dev = manifestFor(channel).name === "Collie (dev)";
    expect(info.version).toBe(dev ? "1.9.0-dev+ys.1" : "1.9.0+ys.1");
    expect(prereleaseLabel(info.version)).toBeUndefined();
  });
});

import type { Channel } from "./vite-icons";

/** Build stamps share the icon channel and preserve existing SemVer metadata. */
export function buildInfoFor({ version, sha, time, channel }: {
  version: string;
  sha: string;
  time: string;
  channel: Channel;
}) {
  // The fork's +ys.N stays metadata. A dev marker belongs before it, while the hash and build
  // time extend it with dotted identifiers instead of introducing a second plus.
  const plusAt = version.indexOf("+");
  const core = plusAt < 0 ? version : version.slice(0, plusAt);
  const metadata = plusAt < 0 ? [] : [version.slice(plusAt + 1)];
  const stampedCore = channel === "release" ? core : `${core}-dev`;
  return {
    version: [stampedCore, ...metadata].join("+"),
    sha,
    time,
    id: `${stampedCore}+${[...metadata, sha, Math.floor(Date.parse(time) / 1000)].join(".")}`,
    channel,
  };
}

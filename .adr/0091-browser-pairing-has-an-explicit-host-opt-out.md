# 0091: Browser pairing has an explicit host opt-out

- **Status:** Accepted
- **Shipped in:** pending
- **Amends in scope:** [ADR 0086](./0086-reads-need-the-pairing-token.md), mandatory browser pairing only.
- **Trail:** the trusted fork operator's request to "restore the ability to disable pairing",
  against ADR 0086's always-on browser policy; `bridge/config.ts`, `bridge/config-schema.ts`,
  `bridge/config-source.ts`, `bridge/server.ts`, `cli/`, `web/src/lib/pairing.ts`,
  `web/src/lib/store.ts`, `web/src/components/paired-devices.tsx`.

## Context

The operator intentionally trusts this deployment's remaining access boundaries and requests a
host-side opt-out. ADR 0086 correctly closed the accidental opt-out caused by an empty registry.
Restoring that behavior would make revocation or a fresh install silently expose transcripts and
remote shell access. An explicit setting is a different decision from counting credentials.

The registry also supplies independent standby credentials. Making the store itself optional
would couple browser policy to a second listener. Anonymous live reads also cannot acquire the
persistent offline session cache that ADR 0087 introduced for paired reads.

## Decision

1. Default browser pairing on, with an empty or missing registry included. Only an explicit false
   host setting disables it: `COLLIE_PAIRING=off` or `[access] pairing=false`. Use the existing
   boolean vocabulary: `off`, `0`, `false`, `no`; accept case and surrounding whitespace. Unknown
   environment values warn and resolve on. TOML requires a boolean; a malformed pairing value
   resolves on rather than inheriting a lower file's opt-out. An explicitly empty environment
   value means the secure default, including over a file's false value.
2. Apply this policy in the browser guard, after access and device-header checks. Ignore bearer
   tokens for live admission while off, so stale or expired tokens cannot block reads or writes.
   Attribute such requests using only the independent device header, or no device label.
3. Keep Host, Origin, actual TCP-peer, trusted-user, Cloudflare Access, Files device-read header
   checks, filesystem containment and masking unchanged. Crew and standby admission are unchanged.
   `PairingStore.enforced()` is not the browser policy and remains unchanged.
4. Keep every registry entry and credential. Re-enabling after a restart restores checks against
   that registry, including expiry. Device management remains available behind the remaining
   gates; turning the setting off does not itself revoke, mint or delete anything.
5. Report the running policy in device-list and revoke metadata and the API response header
   `X-Collie-Pairing`. An explicit protected response with `off` clears the UI's refusal latch,
   never the token or its expiry. It suppresses offline session store reads and writes for that
   page until reload, including after enforcement returns, so late saves cannot persist anonymous
   content. Existing expiry caps and wipes stand;
   [ADR 0087](./0087-the-on-device-store-is-one-thing.md) is not relaxed.
6. Warn at startup, in status and doctor, and in Settings about transcript and remote shell
   exposure. CLI reports resolved host configuration and the need to restart; API and UI report
   the running policy. Do not require pairing while it is off. A host-issued QR still permits
   optional enrolment.

## Consequences

- The opt-out is deliberate and reversible, but grants reads and writes to callers passing the
  remaining gates. Revoking a token cannot remove tokenless access. Other local users may reach
  the loopback port, so loopback alone is not a replacement for pairing.
- Off applies to browser API access, including registry management, not to crew or standby
  credentials. An unreadable registry can still prevent device management without blocking
  ordinary live use while off.
- Offline session caching is unavailable while off, even to a browser that still holds a token.
  Credentials and previously paired records are not erased by the policy change; existing records
  retain their lifetime and wipe rules. Drafts and preferences are unchanged.
- ADR 0086 remains the default contract. Its original text is preserved; only the mandatory
  browser-policy scope is amended here. Registry emptiness must never become an opt-out again.

# Pi version-unread investigation: issue 137

Investigation date: 2026-11-07. Issue: <https://github.com/youngsecurity/collie/issues/137>.
Worktree: `dev-joe-issue-137`, based on `19b956939`. Sections through
"Approved follow-up needed" record the initial investigation. The authorized
2026-11-09 follow-up below supersedes its pending operational items: the service
environment is repaired and the phone marker reached the active agent, but its
receipt was `unknown/no_evidence`, not confirmed `steered`. The subsequent
"Steering-witness follow-up" records a reproduced Windows/WSL hint mismatch and
its local profile fix. It does not retroactively confirm that phone receipt.
At the investigation handoff, source changes were uncommitted and undeployed.
Committing this report does not deploy the changes or complete live verification.

## Finding

The current service environment cannot run Pi's script interpreter.

The installed Pi launcher resolves to `$HOME/.bun/bin/pi` and begins with
`#!/usr/bin/env node`. Node resolves in the investigator's shell to
`/home/linuxbrew/.linuxbrew/bin/node`. That directory is absent from the service's
PATH and from the PATH returned by its noninteractive login shell.

A fresh read through Collie's actual version-reader code, under the serving
process's environment and working directory, returns **null, exit 127**. The same
read from the agent shell returns **1.5.0, exit 0**. Adding only the Node directory
to a diagnostic child's PATH makes the service-environment read return 1.5.0.
Removing that addition restores the failure. No live process environment changed.

The installed Collie binary independently confirms this distinction. Its
`doctor --json`, launched under the service environment, reports:

```text
harness-pi: unread (exit 127: /usr/bin/env: ‘node’: No such file or directory)
integration-pi: installed and current
```

That doctor invocation exits 0 despite the harness warning. Exit 0 and a current
integration do not establish that the version probe succeeded.

> **Caution.** This demonstrates a present, repeatable cause of the discrepancy.
> It does not identify the reporter's exact original request or prove the state of
> the live bridge's in-memory cache at that request's timestamp.

## Environment and evidence boundaries

Fresh evidence differs from the earlier handoff in Pi's installed version.

| Item | Fresh observation |
| --- | --- |
| Running Collie | `1.24.2+ys.1.19b956939` |
| Service PID | `3703339`, unchanged during investigation |
| Service start | 2026-10-28 19:36:40 EDT |
| Executable and cwd | Installed `versions/v1.24.2+ys.1/bin/collie` and its version directory |
| Current Pi CLI | `1.5.0`; the handoff and issue recorded `1.4.0` historically |
| Herdr CLI | `0.9.3` |
| Service shell and home | `/bin/bash`, the same home as the investigator |
| Service PATH | Standard system directories, including `/snap/bin`, but no Linuxbrew bin |
| Probe duration | Failure 6 to 8 ms; successful reads about 160 to 166 ms |
| Source comparison | No difference from tag `v1.24.2+ys.1` in the probe, login-path, pane-binary or harness-findings modules before edits |
| Graph | All eight indexed projects checked; none covers Collie. No graph generation, symbols, traces or coverage claim is available |

The graph check was followed by targeted source discovery and reads. Relevant
ADRs read: [0091](../../.adr/0091-launch-by-id-with-a-request-id.md),
[0117](../../.adr/0117-a-steer-is-the-persons-choice-never-the-default.md),
[0122](../../.adr/0122-a-queued-message-is-a-card-until-the-journal-shows-it.md), and
[0124](../../.adr/0124-a-sends-bound-starts-after-its-profile.md).

Only allowlisted metadata and sanitized diagnostics were printed. Process
environments were passed directly to diagnostic children in memory, never dumped
or written to evidence files. Receipt text, hashes, request IDs and pane contents
were excluded from output. No pane input or production write API was used.

## Reproduction

Two independent probes reproduce the same environment-dependent failure.

The following local scratch files remain under the gitignored `.cache/` directory
in this worktree. They are investigation artifacts, not shipped utilities. The
source regression tests described below are the portable reproduction.

```bash
pid=$(systemctl --user show collie --property=MainPID --value)
bun .cache/issue-137-probe-6ab2.ts shell
bun .cache/issue-137-probe-6ab2.ts service "$pid"
bun .cache/issue-137-probe-6ab2.ts service "$pid" /home/linuxbrew/.linuxbrew/bin
bun .cache/issue-137-probe-6ab2.ts service "$pid"
bun .cache/issue-137-probe-6ab2.ts service "$pid" doctor
```

| Invocation | Result |
| --- | --- |
| Shell source probe | Same Pi launcher; 1.5.0; exit 0; send cache reads 1.5.0 |
| Service-environment source probe | Same Pi launcher; null; exit 127; missing Node; send cache reads null; script exits 1 |
| Service-environment probe with only Node directory added | Same launcher; 1.5.0; exit 0; send cache reads 1.5.0 |
| Service-environment source probe again | Null; exit 127; missing Node again |
| Installed doctor under service environment | `harness-pi` warns with the specific missing-Node diagnostic; doctor exits 0 |
| Installed doctor under agent shell | `harness-pi` reports 1.5.0 provisional, above verified range |

The source probe executes `createBinaryReader`, `createVersionReader` and
`VersionCache`. The installed-binary comparison removes uncertainty about the
source runner explaining the result by itself. Neither reads or resets the live
bridge's in-memory cache.

### Why the login shell does not repair PATH

The login shell is noninteractive, and Homebrew setup is interactive-only here.

`createLoginPath` runs `/bin/bash -lc 'printf %s "$PATH"'`. The user's `.profile`
sources `.bashrc`, but `.bashrc` returns at its noninteractive guard on lines 8 to
12. The Homebrew `shellenv` initialization is later, on line 39. The agent shell
already inherited Linuxbrew's directory, whereas the service did not.

`findTool` can still locate Pi through its `$HOME/.bun/bin` fallback. Finding the
launcher does not supply Node to `/usr/bin/env`. `createBinarySearch` passes the
merged login/service PATH to the version child. Neither contains Node's directory.
This explains an installed launcher with a failed version read without assuming a
broken Pi installation or a slow version command.

## Hypotheses tested

The ranked hypotheses were stated before the distinguishing tests.

| Rank | Hypothesis and prediction | Result |
| --- | --- | --- |
| 1 | Missing script interpreter on effective PATH; adding only its directory should restore the same probe | Confirmed for fresh service-environment probes, including the installed doctor |
| 2 | Another shell-only setting is required; PATH-only repair should still fail | Not required to explain this reproduction: PATH-only repair succeeds |
| 3 | Pane-program selection chooses another failing executable; PATH recovery alone should not explain pane-specific probing | No selected program in the current 12-pane Herdr sample: foreground argv is absent, and `paneBinaryOf` returns null. The original request's selection is not captured |
| 4 | Timeout or a persistent failed cache is the primary cause; fresh reads or expiry should recover without environment repair | Fresh failures finish in milliseconds and repeat. Cache expiry cannot repair a still-missing interpreter. Tests demonstrate recovery after the interpreter becomes reachable |

The pane sample used `pane.list` and `pane.process_info`, not `pane.read`. The local
artifact is `.cache/issue-137-pane-program-52cf.ts`. It reports counts and selected
programs only, never arbitrary argv. This sample is not a historical capture of
the reporter's pane.

## Probe, cache and hold lifecycle

The version guard behaves as designed for a genuinely unread version.

| Boundary | Verified implementation |
| --- | --- |
| Resolution | `bridge/surface/binary-version.ts`: login PATH first, own PATH second, tool fallback for the launcher; pane command when available |
| Runtime bound | `bridge/login-path.ts`: bounded child execution; version command 3 s, whole send-version read 4 s |
| Send cache | `VersionCache`: successes 10 minutes; null failures 60 seconds; concurrent reads share work; pane-program keys include file stamp |
| Login PATH cache | `createLoginPath`: once per reader/process; changing shell startup files does not refresh an existing cached PATH |
| Poll cache | `bridge/surface/shadow.ts`: separate 10-minute version cache, including unread results; not the send cache |
| Guard | `versionUnread`: null version plus a profile that supports in-turn queueing yields the version-unread hold explanation |
| Existing hold | Remains a held intent after version recovery; normal idle/release checks still apply |
| Cancellation | Stored cancellation remains authoritative; a replay of its ID does not send it |
| Doctor | Fresh PATH-based probes in the doctor's process, not a query of serving-bridge probe state |

A repaired login file alone is not evidence that the current bridge recovered.
An approved fresh bridge process may be necessary to receive corrected environment
and discard its cached login PATH. Waiting 60 seconds with an unchanged PATH will
simply repeat the missing-interpreter failure.

### Steering is not ordinary Send

The report describes steering intent, but its exact request payload is missing.

ADR 0117 makes ordinary Send queue by default. Explicit steering requires
`when: "steer"` and the phone caller flag. An explicit steer on an unread version
is refused as `steer_unsupported`, not held; a steer must never be replayed into a
later turn. The reported version-unread held message therefore does not establish
that the original request used the explicit-steer path.

This investigation preserves both behaviors. The regression that recovers an
ordinary Send proves delivery into the fake Pi queue during a turn, not steering.
Separate tests assert `outcome: "steered"` and Enter for explicit steering on a
supported captured screen with readable provisional versions 1.4.0 and 1.5.0.
Those tests reuse Pi 1.3.0 captures; they are not live evidence for newer Pi screens.

## Historical receipts and remaining capture gap

Persisted evidence supports unread versions but cannot recover the original hold.

The read-only receipt scan found 66 Pi send records, all with null versions and no
pane-specific binary field. Three had settled as cancelled, accepted at
2026-11-06 02:00:29.000Z, 02:01:06.570Z and 07:18:50.645Z. Their profile gaps were
1, 1 and 3 ms. No Pi held entry remained at inspection. Cancellation had replaced
the prior receipt, so the original version-unread hold explanation was not present.
No claim is made that any one of these is the reporter's exact request.

Fresh doctor counters cover a rolling historical window and differ from the
handoff: unread poll counts were free 2129, unknown 125 and modal 519; send counters
still showed held 3, held-sent 0 and held-cancelled 3. These are aggregates, not an
exact trace and not proof of successful steering. The report intentionally does
not use screen-recognition refusals to explain this version failure.

Still needed for closure: the affected pane/session and request timestamp, the
sanitized request's mode/when fields, receipt version/binary/profile gap, hold
reason before cancellation, relevant active screen state, and an approved phone
rehearsal. Browser/phone details and the original Pi extension set remain unrecorded.

## Changes and validation

Only diagnostics, regression coverage and documentation change in this worktree.

| File | Change |
| --- | --- |
| `cli/doctor.ts` | Add a `version-probe-scope` finding separating fresh doctor probes from serving environment/cache/pane program and historical counters |
| `cli/harness-findings.ts` | Suggest checking a script interpreter's PATH; qualify unread-send guidance as conditional on the serving bridge also failing |
| `cli/doctor.test.ts` | Pin the new scope explanation in JSON and plain output and the interpreter remedy |
| `bridge/surface/protocol.test.ts` | Real env-shebang fixture through version readers, cache, pane profile and protocol; recovery/cancellation/exactly-once coverage; provisional explicit-steer replay cases |
| `CHANGELOG.md` | One diagnostic-fix bullet under Unreleased; no version bump |
| This report | Durable evidence and honest acceptance-criteria status |

The two new diagnostic assertions failed before the diagnostic changes, then
passed. The missing-interpreter reproduction continues to fail its version-health
check under the unchanged service environment; that production condition is not
claimed fixed. Its isolated recovery case passes after the PATH-only correction.

```bash
bun test bridge/surface/protocol.test.ts cli/doctor.test.ts -t 'issue 137'
bun test bridge/surface/protocol.test.ts bridge/surface/binary-version.test.ts \
  bridge/pane-binary.test.ts bridge/surface/holds.test.ts \
  bridge/surface/requests.test.ts cli/doctor.test.ts
bun run typecheck
bun run --cwd web typecheck
bun run lint
bash scripts/check-version.sh
git diff --check
```

| Validation | Result |
| --- | --- |
| Issue-specific tests | 6 passed; includes two provisional version cases |
| Relevant test files | 1,056 passed across six files; 0 failed |
| Root typecheck and contract check | Passed |
| Web typecheck and worker check | Passed |
| Full-tree oxlint | Passed |
| Version consistency | Passed at unchanged 1.24.2+ys.1 |
| Whitespace check | Passed |
| Dependency installation | Both local trees installed from frozen Bun lockfiles; lockfiles unchanged |
| Fallow | Not run: no local installation; no borrowed or global installation used |
| Review | Direct diff review only; no extra agents or model-spending review/rig sessions |
| Live phone rehearsal | Not run; not authorized by this investigation |

The initial multi-file test command also named nonexistent
`bridge/login-path.test.ts`; Bun ignored that argument. The reported six-file
count excludes it. `binary-version.test.ts` contains the bounded-run tests.
No frontend behavior changed and no full frontend suite or build was run.

## Acceptance criteria

No issue checkbox is changed and the issue remains open. A sanitized
[evidence comment](https://github.com/youngsecurity/collie/issues/137#issuecomment-6708303241)
was posted and its presence and the issue's open state were verified.

| Issue criterion | Status and evidence |
| --- | --- |
| Deterministic regression reproduces unread hold and detection failure | Demonstrated for the present failure mechanism: real env-shebang fixture exits 127, real reader returns null, protocol holds with `versionUnread`. Original request identity remains missing |
| Affected bridge detects readable Pi and recovers | Partial: diagnostic child and cache tests recover after interpreter PATH repair. The live service environment is unchanged and not repaired |
| Intended steering reaches Pi during the turn | Partial: explicit-steer replay tests pass for readable provisional versions on supported captures. No live Pi/phone rehearsal |
| Recovery preserves held messages and cancellations without duplicates | Covered locally: wrong-session cancel refused, cancellation replay stays cancelled, existing hold waits for idle and releases once, same-ID retries do not duplicate. No production queue mutation |
| Genuinely unread version retains safety and specific actionable diagnosis | Guard retained; installed doctor under service environment exposes missing Node. Local diagnostic wording adds interpreter guidance; no live probe-state endpoint added |
| Doctor distinguishes serving evidence from shell probe | Implemented and tested locally through explicit scope finding; not deployed |
| Tests cover provisional/unread/recovery and phone rehearsal | Test portion complete within the stated fixture scope. Phone rehearsal outstanding |

## Approved follow-up needed

The environment correction is operational work outside this investigation's authority.

1. Choose the owning service configuration or noninteractive login profile to make
   Node's directory reachable. Here it is `/home/linuxbrew/.linuxbrew/bin`.
2. Obtain approval for that configuration change and the appropriate service
   reload/restart. Do not rely on the once-cached login PATH updating itself.
3. Re-run the read-only version comparison under the new serving process environment.
4. Approve a controlled phone rehearsal with a fresh intent and record the exact
   request/receipt fields. Explicitly choose Steer, not ordinary Send.
5. Verify current holds and cancellation state without converting an old held
   intent into a new steer or automatically replaying cancelled text.

No arbitrary PATH guessing, alternate interpreter substitution, version hardcode,
guard bypass or queue-policy change is proposed. A future serving-probe diagnostic
could retain sanitized failure reason and resolution provenance so operators do not
need `/proc` access to distinguish these contexts.

During the initial 2026-11-07 investigation, no service restart, deployment, plugin
update, symlink/global-settings change, production queue mutation, commit, push,
merge, PR or issue closure was performed. Issues 133, 134 and 135 remain outside
this change.

## Authorized operational follow-up, 2026-11-09

The operator subsequently approved a service PATH correction, restart and live phone rehearsal.

Preflight discovered a separate operational blocker: Herdr registered Collie at
removed `versions/v1.18.1+ys.2`, with a missing manifest and no available actions.
The operator chose to repair that registration rather than restart systemd directly.

The registry was backed up to the private, gitignored artifact
`.cache/issue-137-herdr-registry-before-91f2.json`. Running `herdr plugin link`
against the existing install's `current` path restored the enabled plugin and its
11 actions. No symlink was changed and no code was updated. Herdr 0.9.3 resolved
`current` to `versions/v1.24.2+ys.1` in the registration, so this restores the current
actions but does not establish that registration will follow future symlink flips.

The existing unit was backed up to
`.cache/issue-137-service-before-e73c.unit`. A new service-specific drop-in at
`~/.config/systemd/user/collie.service.d/20-node-path.conf` prepends
`/home/linuxbrew/.linuxbrew/bin` to the previously observed service PATH. All
previous entries remain in their original order. Shell startup files, plugin
credentials and the base unit's configured executable were not manually edited.

```bash
systemctl --user daemon-reload
herdr plugin action invoke restart --plugin herdr.collie
```

Herdr action log `plugin-log-10` reports `succeeded`, exit 0. The new service PID is
`2912410`, started at 2026-11-09 01:03:54 EST, with the same installed Collie
`1.24.2+ys.1.19b956939` executable and cwd. This worktree's diagnostic code changes
have not been deployed.

Both the source probe and the installed binary's doctor, run under the new service
environment, read Pi **1.5.0**, exit 0, with no missing-interpreter error. The
running bridge also recorded a `surface-pi-1.5.0` observation. The latter is
serving-process poll evidence, not just a successful shell probe, but does not by
itself prove steering.

The operator opened the investigation pane `w2E:p1` on the phone. A read-only
receipt observer started at 2026-11-09 07:54:02.374Z, watching for a fresh request
on that pane. The single-use rehearsal marker is `STEER-137-5D9A`. Its sanitized
receipt is retained at `.cache/issue-137-phone-receipt-5d9a.json` (mode 0600).
An instruction to tap Steer is not evidence of its outcome.

### Phone rehearsal result

The marker reached the active agent, but Collie did not recognize its screen witness.

| Field | Captured value |
| --- | --- |
| Request ID | `dfa4e0a3-3da4-4481-b290-4023e2f431c5` |
| Accepted | 2026-11-09 07:54:59.033Z |
| Receipt captured | 2026-11-09 07:55:01.855Z |
| Target | Session `default`, pane `w2E:p1` |
| Mode and phase | `send`, `settled` |
| Version/status | `1.5.0`, `provisional` |
| Pane-specific binary | Absent; PATH lookup |
| Keys | `probe`, `Backspace`, `Enter` |
| Profile gap | 221 ms |
| Outcome/reason | `unknown`, `no_evidence` |
| Queued flag | Absent, recorded as false by the observer |
| Marker match | True |

The user message `STEER-137-5D9A` arrived in this investigation session during the
ongoing test turn, and the agent acknowledged it. The receipt independently names
the same marker, the now-readable version and the Enter submission. There was no
version-unread hold. The observer exits 1 because it requires a `steered` receipt;
this is a confirmation failure, not evidence that the message failed to arrive.

The operator subsequently confirmed the phone displayed this exact explanation:

> Collie cannot tell if this was sent. Read the screen, then send again if it did
> not go. Your draft is kept. The steer key went out, but the screen did not show
> whether the agent took it.

The offered actions were `Screen` and `Open Keys`. This corroborates the captured
`unknown/no_evidence` receipt. It does not negate the independent observation that
the marker reached the agent. The retained draft must not be resent for this test.

The stored request does not retain `when`, so no captured raw HTTP payload is
claimed. The user was instructed to choose explicit Steer, not ordinary Send.
The receipt's missing screen witness remains unresolved. This investigation does
not label it as the same cause as issue 135 or change recognition predicates.
The operator was told not to resend; no automated retry or queue edit was made.

### Updated acceptance-criteria evidence

The operational version failure is repaired; issue closure is still not justified.

| Criterion | Updated evidence |
| --- | --- |
| Deterministic reproduction | Existing real-interpreter fixture and original failed service-environment probes retained |
| Affected bridge reads version and recovery | Live send receipt now contains Pi 1.5.0 after the approved PATH correction and restart; cache recovery remains unit-tested |
| Live in-turn delivery | Marker reached the active investigation session during the test; receipt confirmation remains `unknown/no_evidence` |
| Held/cancelled safety | Local recovery, ownership, cancellation and exactly-once tests pass; no old intent was manually replayed; no live cancellation scenario was exercised |
| Genuinely unread safety and diagnosis | Existing guard and local diagnostic tests retained; diagnostic source changes are not deployed |
| Doctor scope | Local source fix tested, not deployed; service-environment verification and live receipt are recorded separately |
| Tests and phone rehearsal | 1,056 relevant tests and both typechecks passed previously; one live phone attempt recorded, including its unresolved witness result |

The service remains on the same installed release. No code update, build,
version bump, commit, push, PR, issue closure, or modification to the `current`
symlink was performed. The approved changes outside the worktree are the Herdr
registration repair and the service PATH drop-in, followed by the plugin restart.
Backups and sanitized evidence remain in `.cache/`; none were removed. A sanitized
[operational follow-up comment](https://github.com/youngsecurity/collie/issues/137#issuecomment-6735069138)
records the repair and the unresolved receipt witness on the open issue.

## Steering-witness follow-up, 2026-11-09

### Reproduction before the fix

A controlled replay changes only the edit-queue hint in the existing Pi 1.3.0
capture from `Alt+Up` to `Alt+Q`. It runs the actual send protocol with an explicit
phone steer, a readable provisional Pi 1.5.0 profile and deterministic read timing.
Before the fix:

```bash
bun test bridge/surface/protocol.test.ts -t 'Windows and WSL Alt\+Q'
```

The assertion expected `steered` with keys `probe`, `Backspace`, `Enter`, but
received `unknown/no_evidence` with those same keys. Repeating the issue-specific
suite confirmed the failure. Adding follow-up-only and mixed steering/follow-up
replays produced three failing positive cases; the five negative cases passed.
These are controlled variants of existing captures, not newly captured Pi 1.5.0
terminal screens.

Ranked hypotheses and predictions were recorded before the follow-up probes:

1. A platform-dependent hint mismatch. Recognizing the actual WSL hint should
   make the same screen confirm without changing key delivery or read timing.
2. Pi consumes the pending steer before the first read. A corrected hint would
   not help a screen on which no pending block remains.
3. Wrapping or extensions change the layout. Correcting only the hint would not
   repair those independent layout differences.

### Independent renderer evidence

Installed Pi 1.5.0 source provides the following chain:

- `dist/core/keybindings.js:8-11` selects Windows-style keys for `win32` or Linux
  with `WSL_DISTRO_NAME` or `WSL_INTEROP`.
- The same file's `app.message.dequeue` definition uses `alt+q` for that case,
  otherwise `alt+up`.
- `dist/modes/interactive/interactive-mode.js:3943-3958`,
  `updatePendingMessagesDisplay`, draws the steering rows, follow-up rows and
  `↳ ${dequeueHint} to edit all queued messages`.
- `dist/modes/interactive/components/keybinding-hints.js` capitalizes the display
  key through `keyDisplayText`.

A read-only keybinding probe returned `windowsKeybindings: true` and
`dequeue: ["alt+q"]`. The user's override concerns `app.message.followUp`, not
`app.message.dequeue`; it does not explain away the edit hint.

A scratch script then invoked Pi's installed
`InteractiveMode.prototype.updatePendingMessagesDisplay` with an isolated
container and a synthetic pending-message getter, using its actual keybinding
manager, theme and TUI renderer. At width 120 it produced these plain rows:

```text
 Steering: also say hello at the end
 ↳ Alt+Q to edit all queued messages
```

The script constructed no agent session, made no model request, sent no terminal
keys and touched no production queue. It is a renderer observation, not a live
phone capture. Private, gitignored artifacts:

- `.cache/issue-137-render-pi-witness-82e1.ts`
- `.cache/issue-137-pi-witness-block-82e1.txt`

### Minimal fix and unchanged safety

Both `keys.steerWitness[0].hint` and `keys.queuedRow.hint` in
`web/src/lib/surface/profiles/pi.json` accepted only `Alt+Up`. They now accept
`Alt+(?:Up|Q)`, preserving the complete anchored hint sentence. Both blocks share
Pi's one hint, so the follow-up recognizer needs the same correction to avoid
misreporting a queued message as unconfirmed.

`bridge/surface/protocol.ts` is unchanged. `steerWitnessed` still requires the
exact message in a block that was absent before Enter. Reads remain at 400,
1,200 and 2,000 ms. There is no empty-box success shortcut, transcript fallback,
extra Enter, automatic retry, profile-status promotion, version hardcode or
queue-policy change.

New regression cases cover the Alt+Q steering block, a follow-up-only block
(`sent` with `queued: true`, never `steered`), a steering block above another
follow-up, wrong text, a missing hint, an unknown key, no pending block and an
already-present steering block. The original Alt+Up captures remain covered.
The profile test separately pins both accepted hints and rejects unrelated text.

### Validation and limits

```bash
bun test bridge/surface/protocol.test.ts cli/doctor.test.ts -t 'issue 137'
bun test bridge/surface/protocol.test.ts bridge/surface/binary-version.test.ts \
  bridge/pane-binary.test.ts bridge/surface/holds.test.ts \
  bridge/surface/requests.test.ts bridge/surface/shadow.test.ts cli/doctor.test.ts
bun run --cwd web test src/lib/surface
bun run typecheck
bun run --cwd web typecheck
bun run lint
bash scripts/check-version.sh
git diff --check
```

- Issue-specific regressions: **14 passed across two files**, zero failures.
- Backend regression scope: **1,095 passed across seven files**, zero failures.
- Frontend surface scope: **3,459 passed across 19 files**, one existing expected
  failure and one existing todo. Both are the documented Claude multiline-draft
  cases in `fold.pi-omp.test.ts`, not introduced by this change.
- Root/contract and web/worker typechecks, full-tree lint, unchanged-version
  consistency and whitespace checks passed.
- The first backend command accidentally named nonexistent
  `cli/harness-findings.test.ts`; Bun ignored it. The seven-file rerun above uses
  only existing paths and includes the harness findings tests in `doctor.test.ts`.
- No full frontend suite, build, live rig or model-spending review ran. Direct
  diff review only. Fallow is not locally installed and was not run.
- Graph project listing has no Collie index. Evidence comes from targeted source
  reads and deterministic tests, not a graph-completeness claim.

The replay confirms hypothesis 1 for screens containing the default Windows/WSL
pending block. Hypotheses 2 and 3 are not excluded for the original phone attempt:
its post-Enter screen bytes were not retained. Custom dequeue bindings, truncated
messages and other layout changes are not generalized into supported witnesses.

**Deployment and live verification remain outstanding.** No new phone send,
service restart, deployment, queue manipulation, commit, push or issue closure
was performed during this follow-up. The earlier marker must not be resent.
A separately approved rehearsal after deployment must use a fresh intent and
retain sanitized post-key screen evidence as well as the receipt. Issue 135's
screen-recognition refusal is still not attributed to this hint mismatch.

The [witness follow-up comment](https://github.com/youngsecurity/collie/issues/137#issuecomment-6735227750)
records these results. Its posted content and the issue's open state were verified;
acceptance-criteria checkboxes remain unchanged.

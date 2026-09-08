// A REAL snapshot off this machine's dev bridge (`GET http://127.0.0.1:8788/api/snapshot`), frozen
// for the dashboard-row experiment card. DEV-ONLY, like the rest of `src/playground/`.
//
// WHY A `.ts` MODULE AND NOT THE `.json` FILE IT STARTED AS: `web/tsconfig.json` does not set
// `resolveJsonModule`, so `import data from "./dashboard-live.json"` type-checks as an error even
// though Vite would serve it happily. Rather than widen a compiler option for a dev-only page, the
// body is inlined here and annotated with the app's own `SnapshotResponse` — which is strictly
// better anyway: a wire change now breaks this file at `tsc` instead of at a confusing render.
//
// WHAT WAS TAKEN OUT: `device`, `notifications` and `update` (three keys that say something about
// THIS browser and THIS install rather than about the herd), plus a scan for any token-like key,
// which found none. WHAT WAS THEN REPLACED (youngsecurity/collie#28): every `cwd`, label, pane
// title, session name, host id and host name that named the capturing machine, its user or its
// projects now carries a synthetic value OF THE SAME LENGTH, so the row widths, which are the whole
// point of the card, are exactly what the bridge sent, and the developer's workstation is not.
// Re-capturing: replace the same fields the same way before committing.
//
// It is a PHOTOGRAPH: the timestamps are frozen at capture, so the rows' "how long ago" ages drift
// further into the past the longer this file lives. Re-capture it when the ages stop being useful.

import type { SnapshotResponse } from "@/lib/types";

export const dashboardLive: SnapshotResponse = {
    "bridge": "connected",
    "agents": [
      {
        "paneId": "w1T:p2K",
        "workspaceId": "w1T",
        "workspaceLabel": "workspace-scoreboard",
        "workspaceNumber": 2,
        "tabId": "w1T:tR",
        "agent": "claude",
        "status": "working",
        "cwd": "/var/home/ellen/projects/workspace-scoreboard",
        "focused": false,
        "kind": "agent",
        "tabLabel": "work",
        "terminalTitle": "xhigh parser improvements",
        "readableLines": 61,
        "sessionName": "xhigh parser improvements",
        "lastActiveAt": 1788341961188,
        "lastSeenAt": 1788338370094,
        "hasSession": true,
        "host": "collie-x7k2p9"
      },
      {
        "paneId": "w2H:p1",
        "workspaceId": "w2H",
        "workspaceLabel": "ledgerbox",
        "workspaceNumber": 3,
        "tabId": "w2H:t1",
        "agent": "claude",
        "status": "working",
        "cwd": "/var/home/ellen/projects/ledgerbox",
        "focused": false,
        "kind": "agent",
        "terminalTitle": "fix loop",
        "readableLines": 61,
        "sessionName": "fix loop",
        "lastActiveAt": 1788317508177,
        "lastSeenAt": 1788158662810,
        "hasSession": true,
        "host": "collie-x7k2p9"
      },
      {
        "paneId": "w2T:p34",
        "workspaceId": "w2T",
        "workspaceLabel": "collie-workspace",
        "workspaceNumber": 4,
        "tabId": "w2T:t1",
        "agent": "claude",
        "status": "working",
        "cwd": "/var/home/ellen/projects/collie-workspace",
        "focused": false,
        "kind": "agent",
        "tabLabel": "work",
        "terminalTitle": "PR work",
        "readableLines": 59,
        "sessionName": "PR work",
        "lastActiveAt": 1788344851213,
        "lastSeenAt": 1788344117453,
        "hasSession": true,
        "host": "collie-x7k2p9"
      },
      {
        "paneId": "w2T:p39",
        "workspaceId": "w2T",
        "workspaceLabel": "collie-workspace",
        "workspaceNumber": 4,
        "tabId": "w2T:t1",
        "agent": "claude",
        "status": "working",
        "cwd": "/var/home/ellen/projects/collie-workspace",
        "focused": false,
        "kind": "agent",
        "tabLabel": "work",
        "terminalTitle": "translating docs",
        "readableLines": 59,
        "sessionName": "translating docs",
        "lastActiveAt": 1788343834487,
        "lastSeenAt": 1788344061957,
        "hasSession": true,
        "host": "collie-x7k2p9"
      },
      {
        "paneId": "w2Y:p1H",
        "workspaceId": "w2Y",
        "workspaceLabel": "workspace-northwind",
        "workspaceNumber": 5,
        "tabId": "w2Y:tH",
        "agent": "claude",
        "status": "working",
        "cwd": "/var/home/ellen/projects/workspace-northwind",
        "focused": false,
        "kind": "agent",
        "tabLabel": "translate",
        "terminalTitle": "Vocabulary translation PWA",
        "readableLines": 59,
        "lastActiveAt": 1788341934249,
        "lastSeenAt": 1788297318046,
        "hasSession": true,
        "host": "collie-x7k2p9"
      },
      {
        "paneId": "w2Y:p7",
        "workspaceId": "w2Y",
        "workspaceLabel": "workspace-northwind",
        "workspaceNumber": 5,
        "tabId": "w2Y:t2",
        "agent": "claude",
        "status": "working",
        "cwd": "/var/home/ellen/projects/workspace-northwind",
        "focused": true,
        "kind": "agent",
        "tabLabel": "menuboard",
        "terminalTitle": "Menuboard release polish",
        "readableLines": 61,
        "lastActiveAt": 1788343171900,
        "lastSeenAt": 1788294982573,
        "hasSession": true,
        "host": "collie-x7k2p9"
      },
      {
        "paneId": "w2Z:p2",
        "workspaceId": "w2Z",
        "workspaceLabel": "harbor-notes",
        "workspaceNumber": 6,
        "tabId": "w2Z:t1",
        "agent": "claude",
        "status": "working",
        "cwd": "/var/home/ellen/projects/harbor-notes",
        "focused": false,
        "kind": "agent",
        "terminalTitle": "seo",
        "readableLines": 61,
        "sessionName": "seo",
        "lastActiveAt": 1788344586813,
        "lastSeenAt": 1786626095176,
        "hasSession": true,
        "host": "collie-x7k2p9"
      },
      {
        "paneId": "w9:p2",
        "workspaceId": "w9",
        "workspaceLabel": "workspace-ash",
        "workspaceNumber": 1,
        "tabId": "w9:t1",
        "agent": "claude",
        "status": "working",
        "cwd": "/home/ellen/projects/workspace-ash",
        "focused": true,
        "kind": "agent",
        "terminalTitle": "ash work",
        "readableLines": 1382,
        "sessionName": "ash work",
        "lastActiveAt": 1788342074956,
        "lastSeenAt": 1788295926286,
        "host": "notebook"
      },
      {
        "paneId": "wA:p1",
        "workspaceId": "wA",
        "workspaceLabel": "machine-config-repo",
        "workspaceNumber": 2,
        "tabId": "wA:t1",
        "agent": "claude",
        "status": "idle",
        "cwd": "/home/ellen/machine-config-repo",
        "focused": false,
        "kind": "agent",
        "tabLabel": "1",
        "terminalTitle": "ThinkPad T14 setup",
        "readableLines": 825,
        "lastActiveAt": 1788299958988,
        "lastSeenAt": 1788299849328,
        "hasSession": true,
        "host": "notebook"
      },
      {
        "paneId": "wA:p5",
        "workspaceId": "wA",
        "workspaceLabel": "machine-config-repo",
        "workspaceNumber": 2,
        "tabId": "wA:t2",
        "agent": "claude",
        "status": "idle",
        "cwd": "/home/ellen/machine-config-repo",
        "focused": false,
        "kind": "agent",
        "tabLabel": "2 👜",
        "terminalTitle": "Claude Code",
        "readableLines": 61,
        "lastActiveAt": 1788299454315,
        "lastSeenAt": 1788299837748,
        "hasSession": true,
        "host": "notebook"
      },
      {
        "paneId": "w2Y:p1S",
        "workspaceId": "w2Y",
        "workspaceLabel": "workspace-northwind",
        "workspaceNumber": 5,
        "tabId": "w2Y:tJ",
        "agent": "claude",
        "status": "done",
        "cwd": "/var/home/ellen/projects/workspace-fen",
        "focused": false,
        "kind": "agent",
        "tabLabel": "bay",
        "terminalTitle": "Fen 0.3.0 release and consumer deployment",
        "readableLines": 61,
        "lastActiveAt": 1788344852329,
        "lastSeenAt": 1788337068446,
        "hasSession": true,
        "host": "collie-x7k2p9"
      }
    ],
    "shellPanes": [
      {
        "paneId": "w654f9f0c0dd67e:pS",
        "workspaceId": "w654f9f0c0dd67e",
        "workspaceLabel": "tgl",
        "workspaceNumber": 1,
        "tabId": "w654f9f0c0dd67e:t1",
        "agent": "shell",
        "status": "unknown",
        "cwd": "/var/home/ellen/projects/workspace-northwind/tgl",
        "focused": false,
        "kind": "shell",
        "readableLines": 61,
        "lastActiveAt": 1788295611453,
        "lastSeenAt": 1786108030061,
        "host": "collie-x7k2p9"
      },
      {
        "paneId": "w2Y:p1P",
        "workspaceId": "w2Y",
        "workspaceLabel": "workspace-northwind",
        "workspaceNumber": 5,
        "tabId": "w2Y:tH",
        "agent": "shell",
        "status": "unknown",
        "cwd": "/var/home/ellen/projects/workspace-northwind/platform",
        "focused": false,
        "kind": "shell",
        "tabLabel": "translate",
        "readableLines": 59,
        "lastActiveAt": 1788299870743,
        "lastSeenAt": 1788299870743,
        "host": "collie-x7k2p9"
      },
      {
        "paneId": "wA:p7",
        "workspaceId": "wA",
        "workspaceLabel": "machine-config-repo",
        "workspaceNumber": 2,
        "tabId": "wA:t1",
        "agent": "shell",
        "status": "unknown",
        "cwd": "/home/ellen/machine-config-repo",
        "focused": false,
        "kind": "shell",
        "tabLabel": "1",
        "readableLines": 59,
        "lastActiveAt": 1788301027771,
        "lastSeenAt": 1788301027771,
        "host": "notebook"
      }
    ],
    "workspaces": [
      {
        "workspaceId": "w654f9f0c0dd67e",
        "number": 1,
        "label": "tgl",
        "focused": false,
        "activeTabId": "w654f9f0c0dd67e:t1",
        "tabCount": 1,
        "paneCount": 1,
        "host": "collie-x7k2p9"
      },
      {
        "workspaceId": "w1T",
        "number": 2,
        "label": "workspace-scoreboard",
        "focused": false,
        "activeTabId": "w1T:tR",
        "tabCount": 1,
        "paneCount": 1,
        "host": "collie-x7k2p9"
      },
      {
        "workspaceId": "w2H",
        "number": 3,
        "label": "ledgerbox",
        "focused": false,
        "activeTabId": "w2H:t1",
        "tabCount": 1,
        "paneCount": 1,
        "host": "collie-x7k2p9"
      },
      {
        "workspaceId": "w2T",
        "number": 4,
        "label": "collie-workspace",
        "focused": false,
        "activeTabId": "w2T:t1",
        "tabCount": 1,
        "paneCount": 2,
        "host": "collie-x7k2p9"
      },
      {
        "workspaceId": "w2Y",
        "number": 5,
        "label": "workspace-northwind",
        "focused": true,
        "activeTabId": "w2Y:t2",
        "tabCount": 3,
        "paneCount": 4,
        "host": "collie-x7k2p9"
      },
      {
        "workspaceId": "w2Z",
        "number": 6,
        "label": "harbor-notes",
        "focused": false,
        "activeTabId": "w2Z:t1",
        "tabCount": 1,
        "paneCount": 1,
        "host": "collie-x7k2p9"
      },
      {
        "workspaceId": "w9",
        "number": 1,
        "label": "workspace-ash",
        "focused": true,
        "activeTabId": "w9:t1",
        "tabCount": 1,
        "paneCount": 1,
        "host": "notebook"
      },
      {
        "workspaceId": "wA",
        "number": 2,
        "label": "machine-config-repo",
        "focused": false,
        "activeTabId": "wA:t1",
        "tabCount": 2,
        "paneCount": 3,
        "host": "notebook"
      }
    ],
    "tabs": [
      {
        "tabId": "w654f9f0c0dd67e:t1",
        "workspaceId": "w654f9f0c0dd67e",
        "number": 1,
        "label": "1",
        "focused": false,
        "paneCount": 1,
        "host": "collie-x7k2p9"
      },
      {
        "tabId": "w1T:tR",
        "workspaceId": "w1T",
        "number": 24,
        "label": "work",
        "focused": false,
        "paneCount": 1,
        "host": "collie-x7k2p9"
      },
      {
        "tabId": "w2H:t1",
        "workspaceId": "w2H",
        "number": 1,
        "label": "1",
        "focused": false,
        "paneCount": 1,
        "host": "collie-x7k2p9"
      },
      {
        "tabId": "w2T:t1",
        "workspaceId": "w2T",
        "number": 1,
        "label": "work",
        "focused": false,
        "paneCount": 2,
        "host": "collie-x7k2p9"
      },
      {
        "tabId": "w2Y:t2",
        "workspaceId": "w2Y",
        "number": 2,
        "label": "menuboard",
        "focused": true,
        "paneCount": 1,
        "host": "collie-x7k2p9"
      },
      {
        "tabId": "w2Y:tH",
        "workspaceId": "w2Y",
        "number": 17,
        "label": "translate",
        "focused": false,
        "paneCount": 2,
        "host": "collie-x7k2p9"
      },
      {
        "tabId": "w2Y:tJ",
        "workspaceId": "w2Y",
        "number": 18,
        "label": "fen",
        "focused": false,
        "paneCount": 1,
        "host": "collie-x7k2p9"
      },
      {
        "tabId": "w2Z:t1",
        "workspaceId": "w2Z",
        "number": 1,
        "label": "1",
        "focused": false,
        "paneCount": 1,
        "host": "collie-x7k2p9"
      },
      {
        "tabId": "w9:t1",
        "workspaceId": "w9",
        "number": 1,
        "label": "1",
        "focused": true,
        "paneCount": 1,
        "host": "notebook"
      },
      {
        "tabId": "wA:t1",
        "workspaceId": "wA",
        "number": 1,
        "label": "1",
        "focused": false,
        "paneCount": 2,
        "host": "notebook"
      },
      {
        "tabId": "wA:t2",
        "workspaceId": "wA",
        "number": 2,
        "label": "2 👜",
        "focused": false,
        "paneCount": 1,
        "host": "notebook"
      }
    ],
    "sessions": [
      {
        "name": "default",
        "isPrimary": true,
        "reachable": true,
        "agents": 8,
        "working": 7,
        "blocked": 0,
        "host": "collie-x7k2p9"
      },
      {
        "name": "collie-demo",
        "isPrimary": false,
        "reachable": true,
        "agents": 5,
        "working": 0,
        "blocked": 0,
        "host": "collie-x7k2p9"
      },
      {
        "name": "default",
        "isPrimary": true,
        "reachable": true,
        "agents": 3,
        "working": 1,
        "blocked": 0,
        "host": "notebook"
      }
    ],
    "ts": 1788344864196,
    "servers": [
      {
        "id": "collie-x7k2p9",
        "name": "bluefin",
        "isLead": true,
        "reachable": true,
        "protocol": "ok",
        "lastSeenAt": 1788344864196
      },
      {
        "id": "notebook",
        "name": "notebook",
        "isLead": false,
        "reachable": true,
        "protocol": "ok",
        "lastSeenAt": 1788344862730
      }
    ]
  };

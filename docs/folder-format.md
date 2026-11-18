# The folder format

The queue is plain files in `~/.bateson/` (or `$BATESON_HOME`). This is the contract: any producer can write an item, and the app, the hooks and the CLI all read the same files. `lib/store.ts` is the reference implementation.

```
~/.bateson/
  items/<id>/                 waiting, or decided but not yet received by an agent
    item.json                 written by the producer
    session.json              the agent session that sent it: { agent, sessionId, cwd, transcriptPath } (written by
                              `bateson send` and the rewake hook). While that session runs, only it gets the decision.
    waiter.json               a live hook waiting on it: { pid, sessionId, n }. The hook touches it every second;
                              one untouched for 15 seconds counts as gone.
    later.json                put off with Later: { at }
    withdrawn.json            its agent cancelled it (`bateson cancel`), because you called it off in chat: { at, by, n }.
                              The item is filed under done, the app refuses a decision on it, and an answer given
                              before it was cancelled is marked delivered so nothing hands it on. A next version
                              sent with `--item` removes it and puts the item back in the queue.
    v<N>/
      body.md | body.txt | body.diff | body.json
      files/                  attachments
      replies.json            on a revision: the agent's answer to each comment on the version before
      decision.json           written by the reviewer
      delivered.json          written when an agent was handed the decision: { at, by, sessionId?, transcript? }
      confirmed.json          a wake-up's delivery was found in its session's transcript
      redelivered.json        a wake-up's delivery was not, and the decision was handed over again (once)
  done/<id>/                  the same layout, once delivered
  pasted/<id>/v<N>/<name>     screenshots pasted or dropped into your own answer. Kept outside the item's folder, so
                              the path the agent is given still holds once the item is filed under done.
  hooks.log                   one line per hook error (the hooks never stop a session to report one)
  server.log                  the server's output, when it runs at login
  server.error                why the server cannot start (a Node too old for it), for the Mac app; gone once it starts
  server.pid                  on Windows, scripts/keepalive.ts while it keeps the server running
  update.json                 where updating bateson stands: the new version's changes, a step, or why it cannot (lib/update.ts)
```

`<id>` matches `q_[a-z0-9]+`.

## item.json

```json
{
  "id": "q_8ni4c25ade7",
  "kind": "decision",
  "title": "Auth for the admin area",
  "createdAt": "2026-11-08T19:41:47.821Z",
  "updatedAt": "2026-11-08T19:41:47.821Z",
  "source": { "agent": "claude-code", "cwd": "/Users/you/Documents/app", "repo": "app", "branch": "main" },
  "versions": [
    { "n": 1, "bodyType": "questions", "title": "Auth for the admin area", "note": "Q1 is the real one.", "createdAt": "..." }
  ]
}
```

- `kind` is `review` or `decision`.
- `source.agent` is the agent that sent it: `claude-code`, or `unknown` when the command cannot tell. Other producers write their own name.
- `bodyType` is `markdown`, `text`, `diff`, `questions` or `findings`. The body file's extension follows from it (`md`, `txt`, `diff`, `json`, `json`).
- A new version appends to `versions`. If the last version has no `decision.json`, it is replaced in place instead, and `replaced: true` is set on the new one.

## body.json (questions)

```json
{ "questions": [ { "id": "Q1", "title": "...", "body": "markdown", "options": [ { "label": "...", "description": "..." } ], "recommended": 0 } ] }
```

## body.json (findings)

```json
{ "findings": [ { "id": "F1", "title": "...", "severity": "high" | "medium" | "low", "body": "markdown", "fix": "optional markdown",
                  "file": "src/a.ts", "line": 42, "excerpt": { "start": 36, "lines": ["...", "..."] } } ] }
```

Sorted highest severity first and numbered by the CLI, which also captures `excerpt`, the lines around `line` as they were when sent.

## decision.json

```json
{ "decision": "approve" | "send-back" | "drop" | "answer" | "findings", "decidedAt": "...", "versionAt": "...",
  "comments": [ { "id": "...", "text": "...", "anchor": { "kind": "text" | "item", "quote": "...", "prefix": "...", "suffix": "...", "start": 0, "end": 10, "file": "src/a.ts", "line": 42, "side": "new" } } ],
  "answers":  [ { "id": "Q1", "choice": 0, "accepted": true }, { "id": "Q2", "choice": null, "other": "free text", "images": ["mwkr151s469fe0.png"] } ] }
```

An answer's `images` name screenshots in `pasted/<id>/v<N>/`; the agent is told each one's full path and opens it. Your own answer can be a screenshot alone, with `other` empty.

`versionAt` is the `createdAt` of the version the reviewer decided. A version replaced in place keeps its number, so a decision whose `versionAt` is not the version's `createdAt` was made on the text it replaced, and does not count (a decision without `versionAt` is taken as it is). `comments` come with `send-back`, `answers` with `answer` (a round sent with Send now leaves out the questions not answered yet; the agent asks them again), and with `findings` the marks: `"marks": [ { "id": "F1", "mark": "keep", "comment": "..." }, { "id": "F2", "mark": "dismiss", "reason": "..." } ]`. A finding with no mark counts as kept. The version after it answers each kept finding by id in `replies.json`.

## Writing an item without the CLI

1. Make `items/<id>/v1/`.
2. Write the body.
3. Write `item.json` last, atomically: write a temp file, then rename it. The app ignores a folder until `item.json` exists.

## replies.json

A version sent after a send-back answers every comment on the version before it, numbered in the order the agent was told them (1-based):

```json
[ { "comment": 1, "addressed": true, "text": "Moved to Tuesday." },
  { "comment": 2, "addressed": false, "text": "Kept out: passkeys need the new auth library." } ]
```

The CLI writes it from `--done "1: ..."` and `--not "2: ..."`, and refuses a revision that leaves a comment unanswered. The app shows the revision with what is new since the version before tinted, and each comment with its answer in the margin.

## config.json

Settings, written by the app's settings page (⌘, or Ctrl+,) and read by the app, the Mac shell and the hooks. Agents may change it too. Missing keys take these defaults:

```json
{
  "name": "",                     // what agents call you ("Sam reviews it first"); empty: "the user". BATESON_REVIEWER overrides it
  "blocked": "notify",            // when a session is blocked on you: "notify" | "notify-forward" | "none"
  "sound": true,                  // notification sound
  "hotkey": "ctrl+option+space",  // "ctrl+option+space" | "option+q" | "cmd+shift+space" | "off" (Mac app only)
  "undoSeconds": 4,               // how long a decision can be undone before the agent hears it
  "stopCheck": true,              // remind agents, on turns you did not start, that your calls go to the queue (hooks/remind.ts)
  "bring": { "decisions": true, "plans": false, "findings": false, "code": false }, // what agents send you (Settings or /setup-bateson)
  "theme": "system",              // "system" | "light" | "dark"
  "preview": false,               // the panel beside a question for its `show`; off, questions are centred and `bateson send` refuses pictures on them
  "updates": true                 // once a day, ask GitHub whether there is a newer version; nothing is installed until you press Update
}
```

## sessions/

`sessions/<session id>.json`: `{ sessionId, cwd, repo, state: "working" | "idle", at, since, heard }`. Written by the hooks, so the empty queue can show which agents are at work. `heard` is the `bring` setting the session was last told; when it changes, the session hears what changed on its next prompt (`hooks/catchup.ts`).

`sessions/<session id>.tree`: the repository's HEAD and every changed or untracked file with its status, modified time and size, recorded when a prompt arrives and when a turn ends (`lib/worktree.ts`). The reminder (`hooks/remind.ts`) compares against it, so edits made through the shell count as much as the Edit tool's. Removed after a day.

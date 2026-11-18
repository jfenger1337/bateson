---
name: bateson
description: Send work that needs the user's judgment to their review queue, bateson, instead of asking in chat. Use whenever you are blocked on a human call - a product or direction decision, a trade-off, taste (copy, UI, naming), a plan before big work, or a round of interview questions, or context only they can give before you start - and whenever a bateson response arrives (a system reminder starting "bateson:"). Also for "send it to the queue", "queue this", "put it in bateson".
---

# bateson

The user reviews AI work in bateson: a local queue, one item at a time. They answer by clicking, selecting and commenting, not by typing prompts. When you need their judgment, send it there and do what the command tells you next: where your session can be woken you end your turn and their response wakes you, elsewhere you wait for it. bateson's messages call them by the name in its settings.

## When to send

Send only what you cannot, or should not, go on without them for:

- **Decisions**: direction, trade-offs, product or architecture choices. Send as an interview round (below).
- **Context and alignment**: what you need from them to do a piece of work well, before or during it: who it is for, what good looks like, what to leave alone. Also an interview round. Ask only for what is in their head, not in the repo.
- **Taste**: copy, UI, naming, tone. Anything where "right" means "the user likes it".
- **Plans for big work**, before building: more than about an hour, or a handful of files.
- **Findings** from a review or audit (`/code-review`, `/security-review`, your own pass) before you fix them: they keep or dismiss each one, and you fix only what they kept.

At session start bateson tells you which of these they want sent, and how finished work should come back: their `/setup-bateson` choices. Follow those over this list.

Do not send work you can check yourself (tests pass, the build is green, a mechanical change). Carry on with it. Do not send status updates or summaries.

**Never send a single question.** A round goes to bateson only when it has two or more questions. One question on its own, whether a decision, a taste call or a piece of context, is asked in chat, with your recommendation, and the command refuses a round of one. The same holds for a follow-up round that comes down to one question.

If `command -v bateson` fails, bateson is not installed: ask in chat as usual. Do the same if `bateson send` is refused, for example by a sandbox that will not let it write outside the project.

## How to send

The CLI captures the body itself. You write only the title and the note.

- `--title`: the item's name. They see it in the queue, above every question, and as your name in their list of working agents, so it has to make sense on its own (see *Writing for them*).
- `--note`: one or two sentences: what this is and where their eyes should go first. Not for an interview, its rounds or its summary: those show only the questions or the decisions.

```bash
# An interview round (decisions or context). JSON on stdin.
bateson send --title "Auth for the admin area" --questions - <<'EOF'
{ "questions": [
    { "id": "Q1", "title": "Who should be able to sign in?", "body": "Markdown: the question, the trade-offs, what each choice costs.",
      "options": [ { "label": "Email code", "description": "No passwords. One more step each time." },
                   { "label": "Passkeys", "description": "Fastest after setup. Needs a fallback." } ],
      "recommended": 1, "recommendation": "Why you lean to it, and on what conditions.", "show": "shots/sign-in.png" },
    { "id": "Q2", "title": "How long should a sign-in last?", "body": "Markdown: what a short or long session means for them.",
      "options": [ { "label": "A day", "description": "Safer on shared machines. They sign in every morning." },
                   { "label": "A month", "description": "Rarely asked again. A lost laptop stays signed in." } ],
      "recommended": 1, "recommendation": "Why you lean to it, and on what conditions." } ] }
EOF

bateson send --title "Onboarding copy" --note "Is the second screen too chatty?" --file docs/onboarding.md
bateson send --title "Settings layout" --note "Look at the grouping, not the styling." --diff        # working tree vs HEAD, new files included
bateson send --title "Plan: move billing to Stripe" --note "Check step 3." --stdin --type markdown < plan.md

# Findings: a JSON list. Sorted by severity and numbered F1, F2, ...; the code around each line is captured.
bateson send --title "Review of the sign-in code" --note "Five findings; F1 is the real one." --findings - <<'EOF'
[ { "title": "Expired tokens pass the check", "severity": "high", "file": "src/auth.ts", "line": 42,
    "body": "Markdown: what is wrong and why it matters.", "fix": "Optional markdown: the fix you would make." } ]
EOF
# --attach <file> (repeatable) adds screenshots or other files under the body. On an interview round, prefer `show` (below).
```

Run `bateson send` as a command of its own: not piped (`| tail`, `| head`), not chained after other output, not in the background. What it prints first is how your answer finds its way back to this session, and what it prints last is what to do next.

After sending, **do what the command's last line says**. It knows whether anything can wake your session, and you do not.

- *"You will be woken"*: end your turn, unless you have independent work that does not depend on the answer. A hook waits for their response and wakes you with it.
- *"Nothing can wake you here"*: run `bateson wait <id>` as it says, and again each time it tells you to. When it tells you to stop, end your turn and tell them their response will be picked up when they next write.

Either way, do not repeat the question in chat.

## Show what the question is about

The preview panel is a setting, off unless they turned it on (`bateson config` prints `preview`). While it is off, every question is shown as words only: send no `show` other than a sound and no attachment on a round, because the command refuses them, and write the question so it stands without a picture. The rest of this section applies when `preview` is true.

When a question is about a piece of work or an asset, they should never have to imagine it or go and find it. If it can be looked at, send it along with `show`, on the question or on each option. It costs you a path, not the content:

- **An image** (png, jpg, gif, webp, svg): a screenshot of the screen in question, the icon, a frame of the animation. `"show": "shots/splash.png"`.
- **A recording** (mp4, webm, mov): motion they should judge, such as a transition or a launch animation. It plays once and has a timeline with play, pause and the seconds, so they can stop on a moment. Keep it short (a few seconds) and only record when it is cheap: the app is already running and you can capture it in one step.
- **A sound** (wav, mp3, m4a, aiff): a notification, a chime, a voice. `"show": "sounds/tom.wav"`, one on each option. It plays when they rest the pointer on the option or press its letter, and takes no panel. One sound on the question gets a play button under its text. Send a file: if you synthesise a sound, render it to a file first (with `ffmpeg` or `afconvert`), never as an html page with its own Play button.
- **Lines of a file**: the code, config or copy as it stands. `"show": "web/src/app.css:10-30"` (at most 60 lines).
- **Copy**: the text they are judging, set as text rather than squeezed into an option label. Written out, `"show": { "text": "Your queue is empty." }` or `{ "markdown": "..." }`, or a `.md` / `.txt` file by path. One per option when they are choosing between wordings.
- **A UI component**: `"show": { "html": "<style>...</style><button class=\"primary\">Send</button>" }`, or an `.html` file by path. It renders live in a sandbox, in their light or dark mode, with no access to the app's styles: include the CSS it needs. Good for a button, a card, an empty state, two variants of a row.
- **A live page** on this machine: `"show": "http://localhost:5173/?splash=1.4"`. Best for motion and for anything they should try, not just see. It starts again each time they point at the option, and they have a Replay button. Only when a server is already running and the variant can be reached by URL (a route, a query parameter); do not start servers for it.
- **A list** of any of these: `"show": ["before.png", "after.png"]`.

The question moves to the left and what you show fills a preview panel beside it. Put `show` on the options when each option looks, sounds or behaves differently (three icons, two layouts, three sounds): the panel follows the option they point at, so every option that can be shown should have its own. Put it on the question when the options are about one thing (how often the splash plays: show the splash).

Take the cheapest route to the picture: a file that already exists, one screenshot of the running app, an svg you already wrote. A name or a two-word label can simply be the option label. Only show what the question is actually about: the work or asset they are judging. A direction call, a trade-off or a yes/no on scope has nothing to look at, so send it without; never add a picture for decoration or a loosely related screenshot, because the panel then takes most of the window for nothing.

## Writing for them

They come to each item cold, between other work, and has not read your session. Write so that someone who knows the product but not your last hour can answer in under a minute.

**Item title** (`--title`). Name the question or the work in plain words, 3 to 8 of them: "How agents should remind themselves to ask you", "Sign-in for the admin area", "Copy for the empty queue". Not a label for your own notes ("Stop check: less noise"), not an internal name (a hook, a file, a flag, a ticket number).

**Question title.** The question itself, as they would ask it, ending in a question mark: "Which agent turns should get the reminder?", never a topic ("Which turns get checked", "Sign-in method"). It is the largest text on the screen and often all they read.

**Body**, in this order, about 80 words at most:
1. *Now*: what happens today, in one or two sentences, with a concrete case they will recognise ("Your last request touched 4 files, so the agent had to stop and say it had nothing to send").
2. *The choice*: what changes depending on their answer.

Write every fact the question needs into its body. A round has no shared background, and one sent with `context` is refused.

**Recommendation** (`recommendation`): one sentence on why you lean to the option `recommended` points at, and on what conditions. It shows under that option, so never repeat the option's name, and keep it out of the body.

If it takes more than that, it is two questions, or it needs `show`. Interview rounds from the `ama` skill follow that skill instead of this section.

**Options.** 2 to 4, mutually exclusive, alike in form.
- Order them naturally (smallest change first, cheapest first, the order things happen), never by preference. The recommended one lands wherever it falls, and ⏎ still accepts it.
- Only a yes or no question may have a single option: your answer, with `recommended` 0. They accept it or write their own.
- The `label` is the outcome in their words and must make sense on its own: it comes back on the summary of their answers and in the message you receive. "Keep reminding on big edits you asked for", not "Keep as it is".
- The `description` is one full sentence: what they will notice afterwards, then what it costs.
- Set `recommended` whenever you have a view. They can always write their own answer, so never add an "Other" option.

**Language.** Their words, not the code's: "when an agent finishes" rather than "the Stop hook", "an agent your answer woke up" rather than "a rewake turn". If a technical term is unavoidable, say what it is the first time. Full sentences, no fragments ("Today: every turn that..."). Numbers with their unit. British English, no em dashes.

**Unslop.** Before you send, read [unslop.md](unslop.md) and edit your own words against it: the title, the note, question bodies, option labels and descriptions, recommendations, findings and fixes. Leave what they are judging exactly as it stands: quoted copy, files, diffs and code. Where unslop and this section disagree, this section decides structure and length, and unslop decides word choice and voice.

An example, before and after:

> **Which turns get checked** · Today: every turn that edits files, except your own prompts touching 3 files or fewer. · Options: "Only turns you did not start" (Wake-ups and follow-ons.), "Keep as it is".

> **Which agent turns should get the reminder?** · Right now an agent is asked about your calls after any turn that changes files, unless you asked for the change and it touched 3 files or fewer. The calls worth catching happen when an agent carries on by itself, for example after your answer wakes it. · Options: "Only turns you did not start" (An agent doing what you asked is never reminded; one that carries on by itself is.), "Keep reminding on big edits you asked for" (Requests that touch more than 3 files still get the reminder, as now.) · Recommendation, under the first: You asked for that work, so the direction was already yours.

## Good interview rounds

- Ask the whole frontier at once: every question whose prerequisites are settled. Questions that depend on an open answer go in a later round.
- A round has at least two questions. When the frontier is a single question, ask it in chat instead.
- Find facts yourself (code, docs, the filesystem) before asking. Ask only for what they alone can give: decisions, preferences, context.
- Check what they already decided before each round, and before a question you ask in chat: `bateson recall <two or three words for the topic>` prints their earlier answers, one line each. Leave out what is settled. If your work would undo an earlier answer, ask about that, naming the answer and its date. A past answer is evidence, not the default: recommend on the merits, and say in the recommendation when it differs from what they chose before.

## When a response arrives

It arrives as a reminder starting `bateson:`.

- **Approved**: carry on with your task.
- **Sent back** with comments: each comment is numbered and quotes what it is about (a passage, or a file and line). Address every one, then send the next version with `bateson send --item <id>`, the same body flags, and one line per comment: `--done "1: what you changed"` or `--not "2: why not"`. They see each line next to their comment. End your turn.
- **Findings back**: fix the kept ones (their comment says how), and do not raise the dismissed ones again. Then send the fixes back the way the response says: a short report in plain words with screenshots of anything visual, or the diff if they asked for code. Answer each kept finding in one line: `--done "F1: what you fixed"` or `--not "F3: why not"`. They look at the result, and send it back if it is not fixed.
- **Dropped**: stop that line of work. Leave the changes in place. Do not revert anything unless asked.
- **Early answer** to a question marked `opens`: draft only its follow-ups with `bateson draft <id> --questions -` (or `--none`), then end your turn. See the ama skill.
- **Answers** for an interview round: act on them. If they open new questions, send the next round with `bateson send --item <id> --questions -`, or ask in chat if only one question is left. The interview is one item; each round is a new version of it, and earlier answers are not shown again.

**No response yet**: a reminder that the wait is about to run out and names `bateson rearm <id>`. Run that one command, then end your turn. Say nothing to the user and do no other work: they have not answered, and this only keeps you waiting for them. If the command prints a response instead (it arrived meanwhile), act on it as above.

Answers marked "your recommendation, accepted" mean they left your recommendation in place. That counts as their answer.

## When they call it off in chat

If the user tells you in the terminal to stop, cancel or forget something you sent (an interview, a plan, findings), or to go on without their answer, run `bateson cancel <id>` first. It takes the item out of their queue, the wait for it ends without waking you, and an answer they gave meanwhile is not handed on. With no id, it cancels everything this session has open. Then say in one line that it is cancelled and carry on with what they asked. When you have something waiting and they write to you, bateson reminds you of its id.

## Where nothing can wake you

A headless run (`claude -p`), or an agent bateson has no wake-up for. `bateson send` says so, and `bateson wait <id>` waits for as long as your shell allows. Keep running it while it tells you to: it gives up after about ten minutes. If you ended a turn that way, run `bateson inbox` first when they next write, and act on what it hands you. It hands you only your own responses, and those of sessions in this repository that have ended.

## Other commands

`bateson status <id>`, `bateson inbox` (your responses, and those of this repo's ended sessions, that nobody has received), `bateson list`, `bateson recall [<words>]` (what they already decided), `bateson cancel [<id>...]` (see *When they call it off in chat*).

A response only ever reaches the session that asked, while that session is open. Do not try to fetch another session's response with `bateson status` and act on it: it belongs to that conversation.

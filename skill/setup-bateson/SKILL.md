---
name: setup-bateson
description: Set up what agents bring to the user in bateson besides questions and decisions - plans, review findings, code review. Asks in chat (it is one question, and a single question never goes to bateson) and writes ~/.bateson/config.json. Use for /setup-bateson, "set up bateson", "change how bateson works", or right after installing bateson.
---

# Setup bateson

Ask the user, in chat, what agents should bring to them besides questions and decisions, and write the answer to `~/.bateson/config.json`. bateson tells every new session these choices at the start, and they override the bateson skill's own list of what to send.

## Steps

### 1. Check bateson and read the current settings

If `command -v bateson` fails, bateson is not installed: say so in one line and stop. Otherwise run `bateson config` and keep the JSON. The key this skill sets:

- `bring`: `decisions`, `plans`, `findings`, `code`, each `true` or `false`. What agents send them. `decisions` is questions and decisions, taste calls included, as interview rounds; it is the core of bateson and stays on. With `code` off, finished work that needs a look comes back as a short report with screenshots, never as a diff.

### 2. Ask the question in chat

This is a single question, so it is asked in chat, never sent to bateson. Use the AskUserQuestion tool where you have it, otherwise ask in plain text with the options numbered. Mark as recommended the option that matches the current settings, so on a re-run they change only what they want to change. On a first run (the settings are still the defaults) that is the option marked *default*. If the current settings match no option, recommend none and add one sentence saying what is set now. Keep the wording below; it is written for them.

**Besides questions and decisions, what should agents bring to you?**
Questions and decisions always come to you. Anything you leave out here, agents do themselves and tell you what they did.

1. **Nothing else**: Just questions and decisions. Agents plan, fix and change code on their own, and show you finished work as a short report with screenshots.
2. **Also plans before big work**: You approve a plan before an agent starts anything large. Code still never comes to you.
3. **Plans and code review too**: Plans, review findings before they are fixed, and code changes as diffs. You see everything, line by line.

The options map to settings like this. *default* marks a first run's recommendation.

| Answer | Patch |
|---|---|
| Q1 Nothing else (*default*) | `"bring": { "decisions": true, "plans": false, "findings": false, "code": false }` |
| Q1 Also plans before big work | `"bring": { "decisions": true, "plans": true, "findings": false, "code": false }` |
| Q1 Plans and code review too | `"bring": { "decisions": true, "plans": true, "findings": true, "code": true }` |

Then wait for their answer.

### 3. Write the answers

Write the answer's patch with `bateson config --set -`, the JSON on stdin. It prints the settings as saved; check that every key you set reads back as you wrote it. A key the command ignored was the wrong shape: fix it and write again.

An answer in their own words: choose the patch that fits it best, key by key. For example "plans and findings, but no diffs" is `plans` and `findings` on, `code` off. If an answer fits no setting (say, "only on weekdays"), leave that key as it is and tell them in one sentence that bateson cannot do it yet.

Do not send a summary of the answers for review afterwards: the answers are the settings.

### 4. Confirm

Tell them in one or two sentences what is now set, in their words, and that every session follows it, running ones from their next prompt. From now on they change it in Settings in the app (`⌘,`, or `Ctrl+,` on Windows), under Agents, where everything else lives too.

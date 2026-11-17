---
name: ama
description: Grill the user relentlessly about a plan, decision or idea, one round of questions at a time in bateson, until you reach a shared understanding. Use for /ama, when the user says "ama" or "ask me anything", or whenever the user wants to stress-test their thinking before work starts.
---

# ama

This is Matt Pocock's `grilling` skill (MIT), with the rounds sent to **bateson**, the user's review queue, instead of written in chat. Load the `bateson` skill for how sending works.

Interview the user relentlessly until you reach a shared understanding. Map this as a **design tree**: every decision branches into the decisions that hang off it.

Work the tree in **rounds**. The **frontier** is every decision whose prerequisites are already settled: the questions you can ask _now_ without guessing at answers you haven't heard yet. Ask the whole frontier in one round: number each question and give your recommended answer. Then wait for the user's answers before the next round.

Round one opens with one extra question: your reading of what they are trying to do, with one or two other readings as options. Mark it `"opens": true` (see *Early answers*).

Each round the user answers reshapes the tree: settled decisions push the frontier outward and unblock questions that depended on them. Recompute the frontier and ask the next round. A question whose answer depends on another question still open in this round belongs to a _later_ round, not this one.

Finding _facts_ is your job, never the user's. When a frontier question needs a fact from the environment (filesystem, tools, their earlier answers in `~/.bateson/done`), dispatch a sub-agent with a fresh context window to find it; don't ask the user for anything you could look up yourself. Don't block on it: a running exploration is an unsettled prerequisite, so only the questions downstream of it wait for the sub-agent to report; ask the rest of the frontier now. The _decisions_ are the user's: put each to them and wait.

The session is done when the frontier is empty: every branch of the design tree visited, nothing left silently assumed. Do not act on it until the user confirms you have reached a shared understanding.

## A round in bateson

Write each question the way you would in chat. bateson only needs it split into fields:

- `title`: the question, ending in a question mark.
- `body`: markdown, as long as the question needs, multiple paragraphs if it takes them. The choices go in `options`, not here.
- `options`: the choices, 2 to 4. Each `label` should make sense on its own, because it is what comes back to you as their answer. `description` is optional. A yes or no question can have a single option, your answer, with `recommended` 0. Never add an "Other" option: they can always write their own.
- `recommended`: the option you would pick. Pressing ⏎ accepts it.
- `recommendation`: your recommended answer and why. It shows under that option.

Number questions across the whole interview (Q1 to Q5, then Q6 onwards in round two). The whole interview is one item: the first round creates it, each later round is its next version.

```bash
bateson send --title "<what we are deciding>" --questions - <<'EOF_ROUND'
{ "questions": [
    { "id": "Q1", "title": "<the question?>", "body": "<markdown>",
      "options": [ { "label": "<a choice>", "description": "<optional>" }, ... ],
      "recommended": 0, "recommendation": "<your answer and why>" } ] }
EOF_ROUND

bateson send --item <id> --questions - <<'EOF_ROUND'
...
EOF_ROUND
```

A round needs at least two questions: when the frontier is a single question, ask it in chat instead.

After sending, do what the command's last line says: end your turn where their answers can wake you, wait where it tells you to. In chat, say only that the round is in their queue; don't repeat the questions.

## Reading answers

- "Your recommendation, accepted" is a decision, and includes everything your recommendation said.
- A written answer means your options missed. Read it closely: it often opens a branch, or shows the question was framed wrong.

## Early answers

An answer to a question marked `opens` reaches you while they are still on the rest of the round. Draft only the follow-ups that depend on it (no research, no building), save them with `bateson draft <id> --questions -`, or run `bateson draft <id> --none` if nothing follows. Always run one: it keeps you waiting for the rest. Then end your turn. When the full round arrives, read your drafts with `bateson draft <id> --show`, check them against every answer, and send the next round.

## Confirming

When the frontier is empty, send the shared understanding as the interview's last version. Approving it is their confirmation:

```bash
bateson send --item <id> --title "<what we decided>" --note "Approve to confirm, or send it back with what to correct." --stdin --type markdown <<'EOF_SUM'
<the decisions>
EOF_SUM
```

Sent back means corrections: apply them and send it again. Do not act on the interview until it is approved.

## Stopping

If the user tells you in chat to stop the interview (stop, cancel, enough questions, never mind, just build it), run `bateson cancel <id>` before anything else, so the round leaves their queue and nothing waits on it. Without the id at hand, `bateson cancel` takes everything this session has open. Then say in one line that it is cancelled, and do what they asked instead. Do not send another round unless they ask for one.

## Without bateson

If `command -v bateson` fails, run the rounds in chat, formatted like so, and wait for the answers before the next round:

```
❓ **Q1** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>
```

Word each question so "yes" accepts your recommended answer.

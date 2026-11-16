---
name: ama
description: Think a plan, decision or idea through with the user, one round of questions at a time in bateson, until every call that matters is theirs and written down. Use for /ama, when the user says "ama" or "ask me anything", or whenever the user wants their thinking tested before work starts.
---

# ama

The user asks you to ask them anything. Your job is to find every decision hiding in their plan and think each one through with them. They read every question, edge cases included, even when they end up taking your recommendation. The thinking is the point, so never cut a question to save them time.

They answer in **bateson**, their review queue, by clicking and pressing ⏎. Load the `bateson` skill for how sending works.

## Map the decisions first

Before the first round, write down for yourself every decision the plan involves:

- the main choice and its alternatives
- how it should look and behave
- the edge cases: empty, huge, failing, concurrent, undone
- what it replaces, and what happens to what is already there
- what comes after it ships
- how it could fail, and who it is not for

Some decisions hang on others. A decision is **ready** when nothing it depends on is still open.

## Rounds

Each round asks every ready decision. There is no target size. A round can be three hard questions or nine quick ones; give each the depth it needs.

A question that depends on one still open in the same round waits for a later round, unless it builds on your recommendation. Most recommendations are taken, so ask it now and open its body with the answer it assumes ("If you keep the table in Q3: ..."). If they choose otherwise, rework it next round.

Every round carries one or two **challenge questions** that attack the plan itself: what is most likely to make it fail, what it costs that nobody has priced, who it is wrong for, what would make it unnecessary. They look like any other question and carry a recommendation like any other.

## Writing a question

Write the item title, question titles and options as the `bateson` skill's *Writing for them* says, with one exception: interview questions are as long as the thinking needs, not 80 words.

Long has to stay easy to read:

- Open the body with one sentence on what is at stake, as its own paragraph: the app sets it larger, so it is read first.
- Lay out the scenarios and edge cases you see as a short list, one or two lines each, with what you found in the code or in earlier decisions.
- No paragraph runs past three sentences. Cut anything that would not change the answer.
- Keep your recommendation out of the body. It has its own field.
- Leave your own process out: say what is true and what it means for the choice, not how you found it ("hooks start 28 ms slower", not "I measured it over 30 runs in a scratch copy"). Mark a guess with the word "guess", nothing more.

Every question gets a **recommendation**, written out in `recommendation`, with `recommended` set to the option it leans to. It shows as one line after the question, before the options, the way you would say it across a table. This is you thinking with them, never a placeholder: your actual answer, conditions included ("A month, but ask again before anything destructive"), and why. Pressing ⏎ accepts all of it.

Options: 2 to 4, mutually exclusive, each label making sense on its own. Each description explains the option in two or three sentences: what happens if they pick it, what they will notice day to day, and what it costs. This is where most of the explaining belongs, not in the body. Never add an "Other" option: they can always write their own.

Number questions across the whole interview (Q1 to Q6, then Q7 onwards in round two). Mark `"opens": true` on a question whose answer decides later ones, and only on those.

## Sending

The whole interview is one item. The first round creates it; each later round is its next version. Send no note and no recap: put shared facts in `context` only when a question cannot be answered without them.

```bash
bateson send --title "<what we are deciding>" --questions - <<'EOF_ROUND'
{ "context": "Optional markdown, only what the questions need.",
  "questions": [
    { "id": "Q1", "title": "<the question, ending in a question mark>",
      "body": "<what is at stake, then the scenarios>",
      "options": [ { "label": "<outcome>", "description": "<what they notice, what it costs>" }, ... ],
      "recommended": 0,
      "recommendation": "<your answer, conditions and all, and why>" } ] }
EOF_ROUND

bateson send --item <id> --questions - <<'EOF_ROUND'
...
EOF_ROUND
```

After sending, do what the command's last line says: end your turn where their answers can wake you, wait where it tells you to.

## What to say in the chat

The questions live in bateson, so never repeat them where the user talks to you (the terminal, the editor). After sending a round, one line is enough: that it is in their queue.

What belongs in the chat is the outcome. When answers come back, say plainly what was decided and what you will do next because of it, and when the interview ends, what you will now build or change. That is the part they look for there.

## Facts are yours

Never ask them what you can find out. When a question needs a fact from the code, the docs or the machine, send a subagent for it and send the rest of the round meanwhile. Only the questions that need that fact wait for it.

## Reading answers

- "Your recommendation, accepted" is a decision, and it includes everything your written recommendation said.
- A written answer means your options missed. Read it closely: it often opens a branch, or shows the question was framed wrong. If it can be read more than one way, ask next round, with the readings as options.

## Early answers

An answer to a question marked `opens` reaches you while they are still on the rest of the round. Then:

1. Draft only the follow-ups that depend on it. No research and no building: this must stay cheap.
2. Save them with `bateson draft <id> --questions -`, or run `bateson draft <id> --none` if nothing follows. Always run one: it keeps you waiting for the rest.
3. End your turn.

When the full round arrives, read your drafts with `bateson draft <id> --show`, check them against every answer, add whatever else is now ready, and send the next round.

## Before the summary

When nothing is left to decide, send one last question that lists what you are assuming without having asked: "It runs on desktop only", "Existing items stay as they are". Recommend the reading you believe, and let them correct the rest.

## Ending

If they took your recommendation on every question, the assumptions question included, there is nothing left to confirm. Send no summary: it would only repeat their answers and cost them a click. Say in the chat what was decided and start the work.

If any answer was their own, a different option or something they wrote, send the shared understanding as the interview's last version, for review. Approving it confirms that you read them right:

```bash
bateson send --item <id> --title "<what we decided>" --note "Approve to confirm, or send it back with what to correct." --stdin --type markdown <<'EOF_SUM'
<the decisions, under short headings>
EOF_SUM
```

- List only what changes, each decision as one plain sentence that makes sense without its question. No bold.
- End with one line for what stays: "Stays as it is: ...".
- Add a "Still open" section last whenever anything is unsettled, so approving never hides it.

Approved means confirmed. Sent back means corrections: apply them and send the summary again. Do not act on the interview until it is approved.

## Without bateson

If `command -v bateson` fails, ask in chat: number each question, write your recommendation under it, and wait for the answers before the next round.

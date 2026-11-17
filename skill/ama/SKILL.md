---
name: ama
description: Think a plan, decision or idea through with the user, one round of questions at a time in bateson, until every call that matters is theirs and written down. Use for /ama, when the user says "ama" or "ask me anything", or whenever the user wants their thinking tested before work starts.
---

# ama

The user asks you to ask them anything. Your job is to find the questions that shape where their plan goes, ask them early, and include the ones they have not thought of. They read every question, edge cases included, even when they take your recommendation. The thinking is the point, so never cut a question that would change the answer.

They answer in **bateson**, their review queue, by clicking and pressing ⏎. Load the `bateson` skill for how sending works.

## Before round one

**Read what they already decided.** Run `bateson recall` with a few words for the area the plan touches (once per area if it touches several), and search the repository history the same way. Each line is one earlier answer; the whole item is in `~/.bateson/done/<id>` if a line is not enough. A plan that undoes an earlier answer gets its own question, naming that answer and its date.

**Map the decisions** for yourself: the main choice and its alternatives, how it should look and behave, the edge cases (empty, huge, failing, concurrent, undone), what it replaces and what happens to what is there, what comes after it ships, how it could fail and who it is not for. A decision is **ready** when nothing it depends on is still open.

**Sort each one** before it becomes a question:

- A fact (in the code, the docs, the machine) is yours to find. Never ask it.
- A small call that is easy to undo is yours to settle. List it in the finished report, not the interview.
- Direction, taste and calls that are hard to undo go to them. Judge which is which by who would notice and what it would take to reverse.
- A look that changes the feel of a screen is asked in words. A small visual detail is built and shown in the finished report.

**On engineering work**, also work out for yourself what a top professional would do here that they did not ask for, and what would show the result works, a check a run can pass or fail. An addition that would change the plan becomes a question. Elsewhere (copy, naming, product direction) skip this.

## Rounds

Round one opens with **the frame**: your reading of their goal and the problem behind it, with one or two other readings as options. On engineering work it also says how they will know it worked. Mark it `"opens": true`. Later rounds do not repeat it.

Each round then asks every ready decision. There is no target size: three hard questions or nine quick ones, each with the depth it needs. The floor is two: a round that would hold a single question is asked in chat instead, never sent to bateson. A question that depends on one still open waits for a later round, unless it builds on your recommendation: ask it now and open its body with the answer it assumes ("If you keep the table in Q3: ..."). If they choose otherwise, rework it next round.

Every round carries one or two **challenge questions** that attack the plan: what is most likely to make it fail, what it costs that nobody has priced, who it is wrong for, what would make it unnecessary. They carry a recommendation like any other.

## Writing a question

Write the item title, question titles and options as the `bateson` skill's *Writing for them* says, with one exception: interview questions are as long as the thinking needs, not 80 words. Long has to stay easy to read:

- Open the body with one sentence on what is at stake, as its own paragraph.
- Lay out the scenarios and edge cases as a short list, one or two lines each, with what you found in the code or in earlier decisions.
- No paragraph runs past three sentences. Cut anything that would not change the answer.
- Leave your own process out: say what is true and what it means for the choice ("hooks start 28 ms slower", not "I measured it over 30 runs"). Mark a guess with the word "guess", nothing more.

Every question gets a **recommendation**, written out in `recommendation`, with `recommended` set to the option it leans to. It shows under that option, after its description, so write only the reason and any conditions ("Ask again before anything destructive") and never repeat the option's name or put it in the body. This is you thinking with them, never a placeholder. Pressing ⏎ accepts the option and what you wrote with it.

Options: 2 to 4, mutually exclusive, each label making sense on its own. Put them in a natural order (smallest change first, cheapest first, the order things happen), never by preference: ⏎ still accepts the recommended one wherever it lands. Only a yes or no question may have a single option: your answer, with `recommended` 0. Each description says in two or three sentences what happens if they pick it, what they will notice day to day, and what it costs. Most of the explaining belongs here. Never add an "Other" option: they can always write their own.

Number questions across the whole interview (Q1 to Q6, then Q7 onwards in round two). Mark `"opens": true` only on a question whose answer decides later ones.

## Sending

The whole interview is one item. The first round creates it; each later round is its next version. Send no note and no recap. A round has no shared background: write each fact into the question that needs it, even when two questions need the same one.

```bash
bateson send --title "<what we are deciding>" --questions - <<'EOF_ROUND'
{ "questions": [
    { "id": "Q1", "title": "<the question, ending in a question mark>",
      "body": "<what is at stake, then the scenarios>",
      "options": [ { "label": "<outcome>", "description": "<what they notice, what it costs>" }, ... ],
      "recommended": 0,
      "recommendation": "<why, and on what conditions>" } ] }
EOF_ROUND

bateson send --item <id> --questions - <<'EOF_ROUND'
...
EOF_ROUND
```

After sending, do what the command's last line says: end your turn where their answers can wake you, wait where it tells you to.

Keep it cheap. When a question needs a fact you have not found yet, look it up and send the rest of the round meanwhile; only that question waits. Send a subagent only for a lookup too big to do yourself.

## What to say in the chat

Never repeat the questions where the user talks to you (the terminal, the editor). After sending a round, one line is enough: that it is in their queue. When answers come back, say plainly what was decided and what you will do next because of it.

## Reading answers

- "Your recommendation, accepted" is a decision, and it includes everything your written recommendation said.
- A written answer means your options missed. Read it closely: it often opens a branch, or shows the question was framed wrong. If it can be read more than one way, ask next round, with the readings as options.
- A dropped round, or two written answers that reject the same thing, means the frame is off. Do not rework the round. Write down the belief the questions shared, and send one question naming it, with your guesses at the real problem as options. Nothing else until it is answered.

## Early answers

An answer to a question marked `opens` reaches you while they are still on the rest of the round. Then:

1. Draft only the follow-ups that depend on it. No research and no building: this must stay cheap.
2. Save them with `bateson draft <id> --questions -`, or run `bateson draft <id> --none` if nothing follows. Always run one: it keeps you waiting for the rest.
3. End your turn.

When the full round arrives, read your drafts with `bateson draft <id> --show`, check them against every answer, add whatever else is now ready, and send the next round.

## Ending

When nothing is left to decide, send one last question that lists what you are assuming about scope and direction without having asked: "It runs on desktop only", "Existing items stay as they are". Recommend the reading you believe, and let them correct the rest.

If they took your recommendation on every question, the assumptions question included, send no summary: it would only repeat their answers. Say in the chat what was decided and start the work.

If any answer was their own, a different option or something they wrote, send the shared understanding as the interview's last version, for review. Approving it confirms that you read them right:

```bash
bateson send --item <id> --title "<what we decided>" --note "Approve to confirm, or send it back with what to correct." --stdin --type markdown <<'EOF_SUM'
<the decisions, under short headings>
EOF_SUM
```

- List only what changes, each decision as one plain sentence that makes sense without its question. No bold.
- End with one line for what stays: "Stays as it is: ...". Add a "Still open" section last whenever anything is unsettled, so approving never hides it.

Approved means confirmed. Sent back means corrections: apply them and send the summary again. Do not act on the interview until it is approved.

## Without bateson

If `command -v bateson` fails, ask in chat: number each question, write your recommendation under it, and wait for the answers before the next round.

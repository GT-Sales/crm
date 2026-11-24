# Ask AI answer blocks (plan)

Status: planned, not built (24 Nov 2026). The idea comes from A2UI
(a2ui.org): the agent asks for UI from a locked catalogue and the app draws
it with its own components. We take the idea, not the library.

## Goal

Some answers read better as a small table or a few numbers than as prose:
"which orders are stuck", "how did last month go", "where do leads come
from". Ask AI can show one of three blocks under its text. Nothing else
changes: every change to data still goes through the signed confirm cards.

## The rule that keeps it safe

**The model chooses a block; the server fills it.** A new tool,
`showBlock({ kind, from })`, names one of the reads the model already made
in this turn (`from` is that call's id). The server builds the block from
that read's result, which it already holds in memory, with the same access
projection the read used. The model never writes a number, a name or a link
into a block, so a block cannot show a made-up figure or another site's
data. A `from` that is not a read of this turn, or a kind that does not fit
that read, is refused and the answer goes on as text.

## The catalogue (three blocks, nothing more)

| Block     | From which reads                                                       | Shows                                                                                                                                       | Cap          |
| --------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `leads`   | `findLeads`, `listOpenTasks`, `getDocumentQueue`                       | One row per lead: name (or reference without contact access), stage chip, one fact (due date, assignee or document), and a link to the lead | 8 rows       |
| `stats`   | `getSiteOverview`, `getAnalytics`, `getInboxCounts`, `getWebAnalytics` | Number tiles: label, value, change against the period before                                                                                | 2 to 6 tiles |
| `ranking` | `getSourcePerformance`, `getAnalytics` top lists                       | Label, count and a plain bar (CSS width)                                                                                                    | 8 rows       |

At most two blocks per answer. No forms, no buttons that change data, no
charts, no free layout.

## Performance

- **No new library.** No A2UI renderer, no chart library: three small React
  components in the existing admin bundle, bars are a `div` width.
- **No extra queries.** A block is built from a read the turn already made;
  the tool call costs no database round trip.
- **Small, once.** One stream part per block (`blocks`), sent when it is
  built, never streamed token by token; about 4 KB at most per block.
- **Cheap for the model.** The tool takes two short fields; the prompt says
  to use a block only for three or more items or for figures, and to keep the
  text around it to one or two sentences.

## Storage and privacy

- `stats` and `ranking` hold no personal data: they are stored with the
  answer (as `sources` are) and redrawn on reload, labelled with the time
  they were read.
- `leads` holds names, so it is **not stored**, like cards: a reloaded answer
  shows its text and a line that the list is not kept, ask again for a fresh
  one. A customer's erasure therefore never has to reach into old answers.

## Wire

A new stream part `{ type: 'blocks', blocks: AiBlock[] }` in
`packages/contracts/src/ai-assistant.ts` (strict schemas, caps as above). An
older admin ignores a part type it does not know, as with `action_cards`.
Links in `leads` rows are server-built paths, re-checked with
`safeInternalHref` like sources.

## Where it shows

The full Ask AI page and the side panel. In the panel, `leads` keeps two
columns (name, stage) and `stats` wraps to two tiles a row.

## Work

1. **Backend and contract (one PR):** the `blocks` part and `AiBlock`
   schemas; the per-turn read cache; `showBlock` and its builders for the
   three kinds; prompt lines; storage of `stats` and `ranking`; tests for
   every refusal (unknown `from`, wrong kind, caps, no contact access).
2. **Admin (one PR):** `AnswerBlocks` with the three components, light and
   dark, panel and page widths; the "list not kept" line on reload; tests.
3. **Check:** re-run the model test's lookup and reasoning prompts to see
   that models use blocks only where they help.

## Not planned

Forms and inputs in answers, charts, editing in a block, and adopting the
A2UI library. Revisit only with a concrete need.

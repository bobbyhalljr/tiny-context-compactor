# tiny-context-compactor

A tiny context compactor for agent loops, in one TypeScript file.
It replays one scripted coding-agent run under four context policies and counts the input tokens each one sends to the model: cap big tool results, keep failure lines in the preview, elide old results, and drop (never rewrite) the oldest messages above 85% of the window.
The tools, their output and the token counter (about 4 characters per token) are mocked. The run, the 32,000-token window and the thresholds are example inputs. No model, no API key.

## Why it matters

The last three weeks of agent news kept pointing at context management:

- Sep 17, 2026: [An Empirical Study of Harness Design for Coding Agents](https://arxiv.org/abs/2609.20804) found most of the benefit of context management comes from preventing context-overflow failures, and rule-based elision before LLM summarization gave the best overall efficiency.
- Sep 21, 2026: [Strands harness](https://strandsagents.com/blog/introducing-strands-harness/) reported 28% lower token cost across six benchmarks (the team's own benchmark), largely driven by its default context management: truncate tool results over about 1,500 tokens and compact above 85% of the window.
- Sep 22, 2026: [CliffCompaction](https://arxiv.org/abs/2609.26779) reported up to 50% lower cost under a bounded context by only truncating or dropping content, never rephrasing it.
- Oct 3, 2026: DeepSeek published [Harness v0.2.1-alpha.1](https://github.com/deepseek-ai/deepseek-harness/releases), its open-source plugin-based harness.

## Run it

You need Node.js 18 or newer.

```bash
npm install
npx tsx compact.ts
```

## Example output

This is real output from `npx tsx compact.ts`:

```text
10 model calls, 9 tool results, window 32,000 tokens (example run)

policy          billed        peak   fits           FAIL seen at call 3
naive          290,208      58,205   no (call 7)    yes
cap             22,905       4,242   yes            no
cap+errors      23,057       4,261   yes            yes
full             9,367       1,637   yes            yes

retrieve("offload://turn-2", /FAIL/):
  FAIL src/checkout.test.ts > applies 10% coupon: expected 90, received 100
```

- `naive` would read 290,208 input tokens across ten calls, but it passes the 32,000-token window on call 7.
- `cap` fits, but its head-and-tail preview cuts the one `FAIL` line out of the first test log.
- `cap+errors` spends 152 more tokens across the run and keeps the failure line.
- `full` adds elision and the 85% drop rule: 9,367 tokens across the run, peak 1,637. The drop rule never fires in this run.

## How it works

```text
Full log (never edited)
  ↓
Cap: big tool results become a preview + a ref
  ↓
Keep: failure lines always survive the cut
  ↓
Elide: old tool results become one-line stubs
  ↓
Drop: over 85% of the window, drop the oldest whole messages
  ↓
View (what the model reads this turn)
```

| File | What it does |
| --- | --- |
| `compact.ts` | Scripted run, token heuristic, cap and preview rules, elision, view builder, replay |
| `output.txt` | Captured stdout from one run |

To use it with a real agent, build each model request from `view()` and swap `tokens()` for your provider's token counter.

## Write-up

Full tutorial: SUBSTACK_URL

Also: DEV_URL

## License

MIT

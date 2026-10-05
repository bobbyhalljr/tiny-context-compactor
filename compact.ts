// compact.ts: a tiny context compactor for an agent loop.
// Everything is mocked: the tools, their output, and the token counter (about 4 characters per token).
// The run, the 32,000-token window and the thresholds are example inputs. No model, no API key.

// Step 1: a scripted agent run and a rough token counter
type Msg = { turn: number; role: "system" | "user" | "assistant" | "tool"; tool?: string; text: string };

const tokens = (s: string) => Math.ceil(s.length / 4); // a heuristic, not a real tokenizer
const lines = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i)).join("\n");
const FAIL = "FAIL src/checkout.test.ts > applies 10% coupon: expected 90, received 100";

const testLog = (failAt: number | null) =>
  lines(1800, (i) => (i === failAt ? FAIL : `PASS src/suite-${i % 97}.test.ts > case ${i} (${(i * 37) % 90 + 3} ms)`));
const source = (name: string, n: number) =>
  lines(n, (i) => `  const ${name}${i} = applyRule(cart.items[${i % 12}], rules.${name}); // line ${i + 1}`);

const RUN: [tool: string, call: string, output: string][] = [
  ["list_files", "list_files src/", lines(40, (i) => `src/module-${i}.ts`)],
  ["run_tests", "run_tests", testLog(1137)],
  ["read_file", "read_file src/checkout.ts", source("checkout", 220)],
  ["grep", "grep -n coupon src/", lines(30, (i) => `src/module-${i}.ts:${i * 7 + 3}: coupon`)],
  ["read_file", "read_file src/coupon.ts", source("coupon", 160)],
  ["read_file", "read_file CHANGELOG.md", lines(900, (i) => `- v2.${900 - i}.0: internal release notes, item ${i}`)],
  ["edit_file", "edit_file src/coupon.ts", "ok: 1 line changed"],
  ["run_tests", "run_tests", testLog(null)],
  ["git_diff", "git diff", "- return price;\n+ return price * (1 - coupon.percent / 100);"],
];

const LOG: Msg[] = [
  { turn: 0, role: "system", text: "You are a coding agent. Use tools. Verify before you finish." },
  { turn: 0, role: "user", text: "The checkout test is failing. Find the bug and fix it." },
  ...RUN.flatMap(([tool, call, output], i): Msg[] => [
    { turn: i + 1, role: "assistant", text: `call ${call}` },
    { turn: i + 1, role: "tool", tool, text: output },
  ]),
];
const CALLS = RUN.length + 1; // the model is called once per turn, plus once to write the answer

// Step 2: cap big tool results and keep the full text out of the context
const store = new Map<string, string>();
const CAP = 1500; // offload a tool result above this many tokens
const PREVIEW = 750; // keep this many tokens of it in context

function headTail(text: string, keep: string[] = []): string {
  const all = text.split("\n");
  const pick = (from: string[]) => {
    const out: string[] = [];
    for (const l of from) {
      if (tokens(out.join("\n")) + tokens(l) > PREVIEW / 2) break;
      out.push(l);
    }
    return out;
  };
  const head = pick(all);
  const tail = pick([...all].reverse()).reverse();
  const hidden = all.length - head.length - tail.length;
  return [...head, `... ${hidden} lines offloaded ...`, ...keep, ...tail].join("\n");
}
// Same budget, but lines that look like failures always survive the cut.
const isFailure = (line: string) => /FAIL|ERROR/.test(line);
const errorsFirst = (text: string) =>
  headTail(text, text.split("\n").filter(isFailure).slice(0, 5));

function capped(m: Msg, preview: (t: string) => string): string {
  if (m.role !== "tool" || tokens(m.text) <= CAP) return m.text;
  const ref = `offload://turn-${m.turn}`;
  store.set(ref, m.text);
  return `${preview(m.text)}\n[full result: ${tokens(m.text)} tokens at ${ref}]`;
}

// A tool the model can call to get back what was cut.
const retrieve = (ref: string, pattern: RegExp) =>
  (store.get(ref) ?? "").split("\n").filter((l) => pattern.test(l)).slice(0, 5);

// Step 3: elide old tool results with a rule, before any summarizing
function elided(m: Msg, now: number, keepRecent: number): string | null {
  if (m.role !== "tool" || now - m.turn <= keepRecent) return null;
  store.set(`offload://turn-${m.turn}`, m.text);
  return `[elided: ${m.tool} from turn ${m.turn}, ${tokens(m.text)} tokens, ref offload://turn-${m.turn}]`;
}

// Step 4: build the view for each model call. Truncate or drop. Never rewrite.
type Policy = { name: string; preview?: (t: string) => string; keepRecent?: number; window?: number };
const WINDOW = 32_000;

function view(call: number, p: Policy): Msg[] {
  // Always rebuilt from the original log,
  // so a compaction never compacts a compaction.
  let v = LOG.filter((m) => m.turn < call).map((m) => {
    const stub = p.keepRecent === undefined ? null : elided(m, call, p.keepRecent);
    return { ...m, text: stub ?? (p.preview ? capped(m, p.preview) : m.text) };
  });
  const size = () => v.reduce((n, m) => n + tokens(m.text), 0);
  const pinned = (m: Msg) => m.turn === 0 || call - m.turn <= (p.keepRecent ?? 0);
  const over = () => !!p.window && size() > p.window * 0.85;
  while (over() && v.some((m) => !pinned(m))) {
    v.splice(v.findIndex((m) => !pinned(m)), 1); // drop oldest, whole
  }
  return v;
}

// Step 5: replay the same run under each policy and count what the model actually reads
const POLICIES: Policy[] = [
  { name: "naive" },
  { name: "cap", preview: headTail },
  { name: "cap+errors", preview: errorsFirst },
  { name: "full", preview: errorsFirst, keepRecent: 2, window: WINDOW },
];

console.log(`${CALLS} model calls, ${RUN.length} tool results, window ${WINDOW.toLocaleString("en-US")} tokens (example run)\n`);
console.log(`${"policy".padEnd(12)} ${"billed".padStart(9)}   ${"peak".padStart(9)}   ${"fits".padEnd(14)} FAIL seen at call 3`);
for (const p of POLICIES) {
  let billed = 0, peak = 0, overflow = 0;
  let sawFail = false;
  for (let call = 1; call <= CALLS; call++) {
    const v = view(call, p);
    const size = v.reduce((n, m) => n + tokens(m.text), 0);
    billed += size;
    peak = Math.max(peak, size);
    if (size > WINDOW && !overflow) overflow = call;
    if (call === 3) sawFail = v.some((m) => m.text.includes(FAIL));
  }
  const fits = overflow ? `no (call ${overflow})` : "yes";
  const n = (x: number) => x.toLocaleString("en-US").padStart(9);
  console.log(`${p.name.padEnd(12)} ${n(billed)}   ${n(peak)}   ${fits.padEnd(14)} ${sawFail ? "yes" : "no"}`);
}

console.log(`\nretrieve("offload://turn-2", /FAIL/):`);
for (const l of retrieve("offload://turn-2", /FAIL/)) console.log(`  ${l}`);

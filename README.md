# HealthWise Platform 2.0 — working prototype

A thin, running version of the Platform 2.0 thesis: **the rules engine stays the source of truth; AI agents propose, never decide.** It runs real GPT-5 and Whisper calls against a real dietitian plan document, and every call is traced.

## Run it

```bash
cp .env.example .env        # then put your OPENAI_API_KEY in it
npm install
npm run dev                 # API on :4000, app on http://localhost:5173
```

On first start, the server parses every `.docx` in `plans/` with GPT-5. It makes one call per document and caches the result by file hash, then seeds three users with 21 days of history. Without a key the app still runs on fallback plans, and every screen that calls a model says so.

| Command | What it does |
|---|---|
| `npm run dev` | API (auto-restarts on server changes) + Vite |
| `npm run import` | Parse any new or changed plan documents |
| `npm run import -- --force` | Re-parse every document |
| `node server/reset.js` | Reset demo state, keeping parsed plans (free) |
| `node server/reset.js --reparse` | Reset everything, including re-parsing (one call per document) |

The **Reset demo** button in the app does the free reset.

**[FUNCTIONAL-SPEC.md](FUNCTIONAL-SPEC.md)** documents every screen: what it shows, and how each
number on it is calculated.

## Plan documents

Put dietitian `.docx` files in `plans/`. The assignment of documents to users is written to `data/plan-map.json` on first run, and you can edit it by hand. With fewer documents than users, documents are shared round-robin.

The parser (`server/planImport.js`) is built for what these documents actually look like:

- **Transposed tables.** Rows are meal slots and columns are days, split across several tables.
- **Glued quantities** such as `Idli-3no` and `Curd-1/2cup`.
- **Alternatives** written as "or", and preparation notes in parentheses.
- **Regional food names**, kept exactly as written.

Items the parser is unsure about (confidence < 0.75), and plan items that conflict with a user's allergy or diet, go to the **Dietitian Queue**. They are never applied silently.

## Five-minute demo

1. **Overview.** There are three personas, the parsed plan documents, and the cohort funnel.
2. **Ananya · Daily Check-in.** Pick the meal slot, upload a meal photo → items appear with per-item confidence → the plan ticks green → reward + streak. Then type *"handful of roasted peanuts"*. It is logged (what a user ate is a fact), shown in red on her day, and raised to the dietitian as an allergy alert. That flag is a rule, and no model output can override it. The guardrail that *blocks* sits on what the platform recommends (swap additions), not on what users report.
3. **Rohit · Plan Change Loop.** Tap *Chicken biryani*. The swap agent proposes an adjustment, the engine prices it, and it either auto-applies or goes to the queue.
4. **Dietitian Queue.** Approve it. The engine re-validates before writing, and the plan changes.
5. **Meera · Re-engagement.** The engine's drop-off signals fire from rules. *Generate nudges* has the Trigger agent write copy and timing, each with its rationale.
6. **Assistant.** As Rohit: *"I had chicken biryani for lunch"*. You'll see the assistant call `log_meal`, then `propose_plan_change`, which is two sub-agents behind one conversation.
7. **Trace Console.** It shows every call just made, with model, effort, latency, tokens, estimated cost, and guardrail verdict.
8. **Partner Config.** Switch the top-bar partner to *Apollo*. The app re-skins, and disabled use cases return `403` from the API.

## Where things live

```
server/
  engine.js        deterministic rules: matching, conflicts, swap validation, gating, score. No model calls.
  planImport.js    DOCX → mammoth → GPT-5 structured output → SQLite
  openai.js        the only file that talks to OpenAI: tracing, cost, degraded-mode cache
  guardrails.js    prompt-injection + PII on input; allergy/diet gate on output
  agents/          logging, planswap, trigger, reward, insights (score + explain + funnel), assistant
  index.js         routes + partner scoping / rate limits (x-partner-id)
src/screens/       one file per screen
```

`engine.applySwap` is the only function that writes to a user's plan. It runs only after `engine.gate`, or after a dietitian approves and the engine re-validates.

## What is real and what isn't

- **Real:** GPT-5 vision and extraction, Whisper transcription, the parsed plan document, the tracing, the guardrails, and the partner gate.
- **Estimated:** every calorie and macro figure. The source document states none, so the engine estimates from a food table and labels each figure with `*`.
- **Synthetic:** the 21-day user histories and the cohort funnel numbers.
- **Configured, not live:** cost uses list prices set in `server/openai.js`.
- **Degraded mode:** if a live call fails, the last good response for that step is served, marked in amber. It never replaces a working live call.

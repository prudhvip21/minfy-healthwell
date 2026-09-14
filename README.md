# HealthWise Platform 2.0 — working prototype

A thin, running version of the Platform 2.0 thesis: **the rules engine stays the source of truth; AI agents propose, never decide.** It runs real GPT-5 and Whisper calls against a real dietitian plan document, and every call is traced.

**Stack:** Python 3.12 + FastAPI backend · React + Vite frontend · SQLite · OpenAI (GPT-5, Whisper).

**[FUNCTIONAL-SPEC.md](FUNCTIONAL-SPEC.md)** documents every screen: what it shows, and how each number on it is calculated.

## Run it

Needs Python 3.12 with [uv](https://docs.astral.sh/uv/) for the backend, and Node for the frontend.

```bash
cp .env.example .env        # then put your OPENAI_API_KEY in it
uv sync                     # backend dependencies
npm install                 # frontend dependencies
npm run dev                 # API on :4000, app on http://localhost:5173
```

On first start, the API parses every `.docx` in `plans/` with GPT-5. It makes one call per document and caches the result by file hash, then seeds three users with 21 days of history. Without a key the app still runs on fallback plans, and every screen that calls a model says so.

| Command | What it does |
|---|---|
| `npm run dev` | FastAPI (uvicorn) + Vite |
| `npm run dev:api:watch` | API that reloads when `backend/` changes |
| `npm run import` | Parse any new or changed plan documents |
| `npm run import -- --force` | Re-parse every document |
| `npm run reset` | Reset demo state, keeping parsed plans (free) |
| `npm run reset -- --reparse` | Reset everything, including re-parsing (one call per document) |
| `npm test` | Engine golden test |

The **Reset demo** button in the app does the free reset. If the demo is left running overnight, the API rebuilds the seeded history at its next start, so streaks and scores stay correct.

## Plan documents

Put dietitian `.docx` files in `plans/`. The assignment of documents to users is written to `data/plan-map.json` on first run, and you can edit it by hand. With fewer documents than users, documents are shared round-robin.

The parser (`backend/plan_import.py`) is built for what these documents actually look like:

- **Transposed tables.** Rows are meal slots and columns are days, split across several tables.
- **Glued quantities** such as `Idli-3no` and `Curd-1/2cup`.
- **Alternatives** written as "or", and preparation notes in parentheses.
- **Regional food names**, kept exactly as written.

Items the parser is unsure about (confidence < 0.75), and plan items that conflict with a user's allergy or diet, go to the **Dietitian Queue**. They are never applied silently.

## Five-minute demo

1. **Overview.** Three personas, the parsed plan documents, and the cohort funnel.
2. **Ananya · Daily Check-in.** Pick the meal slot and log with the menu, a photo, voice or text. Items appear with per-item confidence and the plan ticks green. Then type *"handful of roasted peanuts"*: it is logged (what a user ate is a fact), shown in red on her day, and raised to the dietitian as an allergy alert. That flag is a rule, and no model output can override it.
3. **Rohit · Readjust Plan.** After an off-plan lunch, the swap agent reads the day and proposes the smallest change: moving untouched dishes to a later day, or dropping them. The engine prices it and either auto-applies or sends it to the dietitian with a handover summary.
4. **Dietitian Queue.** Approve it. The engine re-validates before writing, and the plan changes.
5. **Meera · Re-engagement.** Drop-off signals fire from rules; the tone band comes from adherence. Use the what-if selector to show every band, including the RM call at under 10%.
6. **Assistant.** As Rohit: *"I had two samosas at the office"*. The assistant calls `log_meal`, then `propose_plan_change` — two sub-agents behind one conversation.
7. **Trace Console.** Every call just made, with model, effort, latency, tokens, estimated cost and guardrail verdict.
8. **Partner Config.** Switch the top-bar partner to *Apollo*. The app re-skins, and disabled use cases return `403` from the API.

## Where things live

```
backend/
  engine.py         deterministic rules: matching, conflicts, swap validation, gating, score. No model calls.
  plan_import.py    DOCX → mammoth → GPT-5 structured output → SQLite
  llm.py            the only module that talks to OpenAI: tracing, cost, replay cache
  guardrails.py     prompt-injection + PII on input; allergy/diet gate on output
  agents/           logging, planswap, trigger, reward, insights (score, explain, funnel), assistant
  main.py           FastAPI routes + partner scoping and rate limits (x-partner-id)
  db.py · seed.py   SQLite schema and helpers · demo personas and history
src/                React UI
tests/              engine golden test
```

`engine.apply_swap` is the only function that writes to a user's plan. It runs only after `engine.gate`, or after a dietitian approves and the engine re-validates.

The backend was ported from Node/Express to Python/FastAPI with an identical API contract. Before the Node code was removed, both ran side by side on copies of the same database and every endpoint was diffed; `tests/golden/` keeps the original engine's outputs so the Python engine is held to them.

## What is real and what isn't

- **Real:** GPT-5 vision and extraction, Whisper transcription, the parsed dietitian document, the tracing, the guardrails, and the partner gate.
- **Estimated:** every calorie and macro figure. The source document states none, so the engine estimates from a food table and labels each figure with `*`.
- **Synthetic:** the 21-day user histories and the cohort funnel numbers.
- **Configured, not live:** cost uses list prices set in `backend/llm.py`.
- **Replay mode:** if a live call fails, the stored response to an identical earlier request is replayed, marked in amber. It never answers a different question.

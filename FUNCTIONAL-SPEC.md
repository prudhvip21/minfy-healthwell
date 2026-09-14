# HealthWise Platform 2.0 — functional spec

What each screen shows, and how every number on it is produced.

The governing rule throughout: **the engine decides, agents propose.** `backend/engine.py`
holds every calculation and every write path. Agents (GPT-5) turn unstructured input into
structure and English, and can never write to a plan.

Three sources of numbers, distinguished everywhere they appear:

| Source | Meaning | Marked as |
|---|---|---|
| **Plan** | from the dietitian's document | plain |
| **Estimated** | engine's food table, because the document states no macros | `*` and "estimated" |
| **Model** | a confidence score produced by GPT-5 | shown as a confidence bar |

---

## 0. Foundations

### 0.1 Plan import — `backend/plan_import.py`

Runs at first boot, on `npm run import`, or from Overview → Re-parse.

1. `plans/*.docx` → **mammoth** → HTML (tables preserved).
2. One **GPT-5** call per document (`route: plan.parse`, effort `medium`, `max_output_tokens` 48000,
   timeout 300s) with a strict JSON schema.
3. Result cached by **SHA-256 of the file** (first 16 hex chars). Unchanged file ⇒ no second call.
   Users sharing a document share one parse.
4. Engine post-processing: slot normalisation, macro estimation, materialisation.

The parser is told the document shape explicitly: transposed tables (rows = meal slots,
columns = days), glued quantities (`Idli-3no`), alternatives (`Curd … or Buttermilk …`),
parenthetical preparation notes, and regional names to keep verbatim.

**Per-item `confidence` (0–1)** comes from the model. Below **0.75** the item is raised to the
dietitian queue, grouped by identical source text.

### 0.2 Slots

Canonical order: `Wake up, Breakfast, Mid-Morning, Lunch, Snack, Post Exercise, Dinner, Post Dinner`.
Free-text slot names are mapped through an alias table; anything unrecognised becomes `Snack`.

### 0.3 Materialisation

The authored cycle (6 days in the sample document) is expanded onto calendar dates from the
user's `start_date` for **35 days** (21 history + 14 forward). Day *i* uses cycle day
`i % cycleLength`.

### 0.4 Entry statuses

Every row on a day is a `plan_entries` record with one of:

| Status | Meaning | Counts as planned? | Counts as consumed? |
|---|---|---|---|
| `planned` | on the plan, not yet eaten | yes | no |
| `eaten` | on the plan, ticked off | yes | yes |
| `added` | put on the plan by an approved swap | yes | no |
| `swapped` | removed/moved by an approved swap | no | no |
| `offplan` | eaten but never on the plan | **no** | yes |

This table is the reason off-plan food raises your calories without lowering adherence.

### 0.5 Macro estimation — `estimate_macros(name, qty, unit)`

The source document contains **no macros at all**, so every calorie figure in the app is an
engine estimate and is labelled `*`.

- A regex table (~45 entries) maps a food name to macros **per one of the unit the plan uses**:
  per piece for idli, roti, egg and individual nuts; per cup for rice, dal, curry, curd;
  per tbsp for chutney; per glass for drinks.
- First regex match wins, so specific entries precede general ones (`smoothie` before `cucumber`).
- Optional **unit overrides**: biryani per `plate` 580 kcal vs per `cup` 290; nuts per `handful`
  (peanuts 170) vs per piece (peanut 6).
- Unknown food ⇒ 80 kcal / 2 P / 10 C / 3 F.
- Result × `qty`, rounded to 1 decimal.

Examples: `Almonds 5 no` = 5 × 7 = **35 kcal**. `Idli 3 no` = 3 × 58 = **174 kcal**.
`Chicken biryani 1 plate` = **580 kcal**.

### 0.6 Food matching — `similarity(a, b)`

Used to decide whether a logged food is a plan item.

1. Normalise: lowercase, drop parentheses, digits, punctuation, and noise words
   (`add, of, with, cup, tsp, no, roasted, boiled…`).
2. Tokenise, keep tokens > 2 chars, singularise (`chapatis → chapati`), then apply a synonym map
   (`pappu→dal, raitha→raita, chapati→roti, chai→tea, badam→almond, bendakaya→okra…`).
3. Score = `shared/min(|A|,|B|) × (shared/max(|A|,|B|))^0.5`.
4. **Match if ≥ 0.50** (`MATCH_THRESHOLD`).

Deliberate outcomes: `tomato dal ↔ Tomato Pappu` = 1.00 (match);
`brown rice ↔ Single Polish Rice` = 0.29 (no match).

Matching is attempted **within the chosen meal slot first**, then across the rest of the day.

### 0.7 Profile conflicts — `profile_conflicts(user, items)`

A hard, deterministic gate. No model involvement, and no model confidence can overrule it.

- Checks **name + preparation notes** together, because allergens hide in notes
  ("add 1tsp of ghee").
- **Allergen groups**: peanut, treenut, dairy, gluten, egg, soy, shellfish — each a term list
  including regional names (`groundnut, moongphali, palli`).
- **Dairy has a `low` tier**: ghee is dairy-derived but effectively lactose-free, so it is flagged
  for confirmation, not blocked.
- **Diet rules**: `vegan → no dairy/egg/meat`, `vegetarian` and `lacto-vegetarian → no egg/meat`,
  `ovo-vegetarian`/`eggetarian → no meat`.

Two different consequences, by design:

| Where | Consequence |
|---|---|
| Food the **user reports eating** | **Flagged**, logged, counted, and raised to the dietitian. Never discarded — what someone ate is a fact. |
| Food the **platform would add** (swap additions) | **Blocked.** The proposal is rejected outright. |

---

## 1. Daily Check-in

### What is shown

**Left (phone panel)** — meal slot bar, four input modes, and a completion state.

| Element | Source |
|---|---|
| Slot pills with dots | grey = nothing logged, amber = partly, green = all plan items in that slot eaten |
| Default selected slot | the latest slot whose time has started, with 60 minutes' grace, from the plan's `time_hint` |
| Done state | ✓ + "<slot> logged", reward headline, per-item verdicts, then one "Log another meal" |

**Right** — today's plan as a timetable (4 meal cards per row), macros, then the pipeline diagram.

| Element | Calculation |
|---|---|
| Meal card time | single time, or `first–last` when a slot spans several (`6:00AM–7:00AM`) |
| Item dot colour | green eaten · blue added by swap · orange off-plan · red off-plan with conflict · grey planned |
| `Calories 639 / 1798` | consumed / planned, from `day_totals` |
| `incl. 300 kcal off-plan` | sum of `offplan` entries |
| `*` / "estimated" | any entry with `macro_source = 'estimated'` |

### Input modes

| Mode | Model call | Notes |
|---|---|---|
| **Menu** | none for ticked items | Pure engine. Ticks plan items straight to `eaten`. Instant. |
| **Menu extras** | `logging.text` | Free text parsed by the agent |
| **Photo** | `logging.photo`, effort `low` | Base64 JPEG, downscaled to 1600px client-side |
| **Voice** | `whisper-1` then `logging.text` | MediaRecorder → base64 → transcript → same extraction |
| **Text** | `logging.text`, effort `minimal` | ~2–3s |

The photo prompt asks for **every food and drink with a quantity**, explicitly including side
dishes, chutneys, pickles, curd, papad, drinks, garnishes and visible added fat; to count what is
countable and estimate the rest; and to list partly hidden items with low confidence rather than
omit them.

### Pipeline, in order

`Input guardrail → GPT-5 / Whisper → Engine match → Allergy gate → Reward → Swap agent → Engine gate → Dietitian`

1. **Input guardrail** (`backend/guardrails.py`): prompt-injection patterns flagged; email, Indian
   phone, Aadhaar-like and PAN-like strings redacted before the call.
2. **Extraction**: model returns items with `name, qty, unit, confidence, notes` + an
   `overall_confidence` and a one-line observation. It is explicitly told not to estimate calories.
3. **Engine match**: slot first, then the day.
4. **Allergy gate**: conflicting items are flagged, recorded as `offplan` with the reason, and an
   `exposure` row is raised to the dietitian.
5. **Reward** (`reward.message`, effort `minimal`).
6. **Swap agent** — only if something was off-plan; runs as a second request so the user sees
   their result immediately.

### Per-item verdicts

| Verdict | Meaning | Engine action |
|---|---|---|
| `matched` | matched a planned item ≥ 0.50 | that entry → `eaten` |
| `unplanned` | no match | new `offplan` entry |
| `flagged` | conflicts with allergy/diet | new `offplan` entry + flag + dietitian alert |

---

## 2. Readjust Plan

### What is shown

| Element | Calculation |
|---|---|
| `eaten` / `off-plan` / `still to come` | counts of today's entries by status |
| Macro bars | `day_totals` consumed vs planned |
| "N kcal over the day's plan" | `consumed.kcal − planned.kcal`, shown when positive |
| Off-plan list | `offplan` entries with slot, kcal, and conflict label |

There is **no logging input here** — the agent reads what the check-in already recorded.

### The agent — `planswap.propose`, effort `low`, max 12000 tokens

Given: user profile, the day's totals, what was already eaten (never to be touched), what went
off-plan, everything still to come with entry ids, and **the next 3 days' plans** so it can judge
whether a move is a genuine replacement.

It returns: `remove_entry_ids`, `move_items [{entry_id, to_date, why}]`, `add_items`,
`confidence`, a user message (≤ 18 words), a rationale (≤ 25 words), and a
**dietitian handover summary** (≤ 45 words).

Instructed to prefer **moving** an untouched dish to a later day over dropping it, to compensate
only in later meals, and never to touch anything already eaten.

### Engine validation — `validate_swap`

- **Moves** are accepted only if the entry is `planned`/`added`, the target is **after today** and
  **within 14 days**.
- **Removals** only if `planned`/`added`.
- **Additions** get estimated macros and are checked against allergies and diet.
- `delta` = additions − (removals + moves), for each macro.
- `kcalDriftPct` = `|delta.kcal| / budget`, where budget = stated plan target, else today's
  planned kcal, else 1800.

**Engine objections** (each one forces dietitian review):
- any high-severity conflict in an addition;
- `kcalDriftPct > 15%`;
- proposal changes nothing;
- any added item's macros are estimated.

### The gate — `gate()`

| Condition | Outcome |
|---|---|
| any blocking conflict | **rejected** — model confidence is irrelevant |
| `confidence ≥ 0.85` **and** zero objections | **auto_applied** |
| otherwise | **pending** → dietitian queue |

On dietitian approval the engine **re-validates before writing**, because the day may have moved on.

`apply_swap` is the only function that changes a plan: removals → `swapped`; moves → source
`swapped` + a copy on the target date as `planned`; additions → new `added` entries.

---

## 3. Re-engagement Nudges

### Tone bands — a rule, from 7-day adherence

| 7-day adherence | Band | Register |
|---|---|---|
| **< 10%** | Reach out | Every message is about the person, none asks them to log. First message offers an **RM call**. |
| **10–30%** | Restart | Every message acknowledges it has been hard; lower the bar to one meal; clean slate. |
| **30–70%** | Nudge | Light, curious, playful, no pressure. |
| **≥ 70%** | Celebrate | Proud, about who they are becoming, protective of the streak. |

The **what-if selector** (5% / 20% / 50% / 85%) recomputes the band from a simulated adherence so
every band can be shown on one user; generated nudges are marked `simulated`.

### Engine signals (deterministic)

| Signal | Condition | Severity |
|---|---|---|
| `never_logged` | no check-in ever | high |
| `lapsed` | ≥ 5 days silent | high |
| `slipping` | ≥ 2 days silent | medium |
| `low_adherence` | 7-day adherence < 30% | high |
| `declining` | 7-day more than 10 points below 28-day | medium |
| `streak_live` | streak ≥ 7 days | low |
| `today_unlogged` | nothing eaten today | low |

Cohort context: week-2 retention for the user's cohort, from `cohort_stats`.

### The agent — `trigger.nudges`, effort `low`

Writes 3 messages: `title` (≤ 40 chars), `body` (≤ 110), `cta` (2–5 words), `angle`, `send_at_local`,
`channel`, and a one-line `why`.

Craft rules enforced by the prompt: never lead with a statistic; at most one number and only if it
is a win; every message carries the band's register; each takes a different angle; no shaming
words (`failed, missed, behind, should`); no dietary advice; timing matched to the meal
(breakfast 08:30, lunch 12:45, dinner 19:45, reflective 20:30), never before 07:00 or after 21:30.

Tapping the RM call-to-action sets the nudge to `escalated` and records an `rm_callback_requested`
event.

---

## 4. Digital Wellness Assistant

Streaming chat (`assistant.turn`, effort `low`), conversation continuity via
`previous_response_id`, up to **5 tool rounds** per turn.

| Tool | Kind | Returns |
|---|---|---|
| `get_plan`, `get_day_totals` | engine | today's entries / rollups |
| `get_progress` | engine | score, band, components, streak target |
| `get_recent_checkins` | engine | up to 60 rows, 1–14 days |
| `check_food` | engine | conflict check — required before suggesting any food |
| `log_meal` | **agent** | hands to the Logging agent |
| `propose_plan_change` | **agent** | hands to the Swap agent → engine gate |

**No tool writes to the plan.** Each sub-agent call is separately traced, so
"I had biryani for lunch" produces a visible chain: assistant → logging → engine → swap → gate.

---

## 5. Behaviour Change Score

Pure arithmetic. GPT-5 may narrate it and is given only the numbers on the page.

All windows **end yesterday**, because scoring a partly-eaten day would penalise every user each
morning. Streak and silence are still measured from today.

### Components

| Component | Weight | Value | Shown |
|---|---|---|---|
| Plan adherence | **45** | mean of daily adherence over 7 days | `90%` |
| Logging consistency | **30** | distinct days with a check-in ÷ 7 | `7 of 7 days` |
| Current streak | **15** | `min(streak / 21, 1)` | `21 days` |
| Momentum | **10** | `clamp01(0.5 + (adh7 − adh28) × 2)` | `up 11` / `steady` / `down 37` |

- **Daily adherence** = planned items eaten ÷ planned items that day. Off-plan food is excluded
  from both sides.
- **Points** = `round(weight × value)`. **Score = the sum of those points**, so the parts on screen
  always add up to the headline.
- **Momentum** is half marks when steady; a 25-point swing either way reaches the ends.
  Labels: `up N` above +5, `down N` below −5, otherwise `steady`.

### Band

`Lapsed` if silent ≥ 5 days regardless of score; otherwise `Strong` ≥ 75, `Building` ≥ 50,
`At risk` ≥ 25, `Lapsed` below.

### Streak milestones — a separate, motivational device

From 14-day adherence: `< 35% → [3,5,7]`, `< 65% → [7,14,21]`, else `[14,30,60]`.
The next milestone is the first rung above the current streak.

**The score grades every user out of 21 unbroken days; the ladder is personal.** They are
deliberately different: scoring against a moving target would drop a user's score the moment they
reached a milestone and the next appeared.

### Six-week trend

The same scoring rules replayed at each week's end. Weeks before the user's `start_date` are
omitted, so "no data yet" is not drawn as a near-zero score.

### Dietary variety — removed, and why

It counted distinct foods logged and scored **10/10 for all three users, including a lapsed one**.
Against a repeating 6-day plan it measures the dietitian's plan, not the person, so it could not
move. Its weight went to adherence and logging.

---

## 6. Explainable Recommendations

Select a **whole meal** (tap its title) or **individual items**, then ask a free-text question.

### The rule trail — assembled by the engine, no model

| Step | Content |
|---|---|
| Source | authored by a dietitian, parsed from their document |
| Selected | each item with qty, unit, slot, time, and status |
| Macros | summed across the selection, marked ESTIMATED where applicable |
| Day context | share of the day's planned kcal, and what else is planned |
| Profile check | cleared against diet and allergies, or `CONFLICT:` with the reason |

### The model — `explain.entry`, effort `low`

May use **only** the trail. Required to answer the question in the first sentence; to say plainly
when the trail cannot answer it and point to the dietitian; to caveat estimated macros; and to
lead with any conflict.

Observed: *"Is there too much rice in this meal?"* → "I can't tell from the plan whether that's too
much. This lunch includes 1 cup of rice; your dietitian can confirm." The refusal is the feature.

---

## 7. Dietitian Queue

One line per item: icon, summary, user, Approve / reject. Details only when a row is opened.

| Kind | Raised when | Icon |
|---|---|---|
| `swap` | a proposal is `pending` | 🔁 |
| `exposure` | a user logged food conflicting with their profile | ⚠ |
| `parse_review` (conflict) | plan contents conflict with the profile | ⛔ high, ⚠ low |
| `parse_review` (unclear) | parse confidence < 0.75 | 📄 |

**Grouping** keeps the queue short: extraction doubts are grouped by identical source text and
raised **once per document, not per user** (`"Fruit" · Mid-Morning ×3`); profile conflicts are
grouped by the matched ingredient (`ghee in 6 items · dairy allergy`).

Approving a swap **re-runs `validate_swap`** first; if the day has changed such that it is no longer
valid, it is rejected instead of applied.

---

## 8. Trace Console

Every model call, captured at the single chokepoint in `backend/llm.py`.

| Column | Source |
|---|---|
| route | e.g. `logging.photo`, `planswap.propose` |
| model · effort | `gpt-5` / `whisper-1`, reasoning effort |
| latency | wall clock around the call |
| tokens | `usage.input_tokens → usage.output_tokens` |
| est. cost | `in/1e6 × $1.25 + out/1e6 × $10.00` for gpt-5; Whisper `minutes × $0.006` |
| status | ok · degraded · error · blocked |

Pricing is a **configured constant** in `backend/llm.py`, not a live lookup — hence "est.".

**Degraded mode**: a failed call replays the stored response for an **identical** request only —
same route, same user, same input hash. It is never a stand-in answer for a different question,
and the UI marks it in amber.

---

## 9. Partner Config

Every request may carry `x-partner-id`. The middleware maps the URL to a use case
(`checkin, planloop, nudges, assistant, score, explain`) and returns **403** if the partner has not
enabled it; a per-partner counter over a 60-second window returns **429** past the limit, with
`x-ratelimit-limit` / `x-ratelimit-remaining` headers on every response.

Seeded partners: HealthWise (all 6 use cases, 10000/min), Apollo Wellness
(checkin, planloop, explain — 2000/min), CorpFit (checkin, nudges, score — 500/min).

Switching partner in the top bar re-skins the UI from the partner's brand colour and greys out
use cases it cannot reach. "Probe API" sends real requests and shows which return 403.

---

## 10. Overview

| Element | Source |
|---|---|
| Persona cards | live score, band, streak, days silent, pending reviews |
| Plan documents table | source file, parse status, cycle length, parse notes |
| Engagement funnel | `cohort_stats` — synthetic: Dec-2025 412 users (100/58/41/33%), Jan-2026 486 (100/61/44/36%), Feb-2026 523 (100/64/48/39%) |

---

## 11. Demo data

Three personas, 21 days of seeded history, rebuilt automatically at boot if it is older than
yesterday (a demo left overnight would otherwise show a 20-day streak as 0).

| User | Profile | Curve | Carries |
|---|---|---|---|
| **Ananya Sharma**, 32 | PCOS, fat loss, lacto-vegetarian, **peanut allergy** | adherence 0.62 → 0.95, logs daily | streaks, rewards, allergy flagging |
| **Rohit Menon**, 41 | Pre-diabetic, non-vegetarian, travels | `0.4 + 0.3·|sin(1.1i)|`, skips 2 days a week, off-plan meal every 4th day | readjustment, dietitian queue |
| **Meera Iyer**, 27 | Maintenance, vegetarian, **lactose intolerant** | 0.85 declining, then silent for the last 6 days | re-engagement, RM escalation |

Seeded check-ins mark the first `round(items × adherence)` items of each day as eaten.

**Reset** (top bar) clears check-ins, proposals, nudges, events and traces, then re-seeds history.
It keeps the parsed plans, so it costs nothing at the API. `npm run reset -- --reparse`
goes all the way back to the documents.

---

## 12. What is real, and what is not

- **Real**: GPT-5 vision and extraction, Whisper transcription, the parsed dietitian document,
  tracing, guardrails, the partner gate, and every engine calculation.
- **Estimated**: every calorie and macro. The source document states none.
- **Synthetic**: the 21-day histories and the cohort funnel.
- **Configured**: token pricing.
- **Not built**: authentication, real push/WhatsApp delivery, Langfuse/Redshift/MSK
  (the Trace Console stands in for Langfuse).

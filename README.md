# Resume ↔ JD Fit Bot

A chat bot you send a resume and a job description to. It replies with a fit
score out of 100, the specific gaps, courses that close them, rewritten
bullets — and if you send several of each, a grid showing which resume wins
for which job.

Built to the contracts in `round1_build_guide.md`.

---

## Run it

```bash
npm run setup          # installs server + client deps

# offline demo — no API key, no network, no Mongo. Everything works.
USE_STUB=1 NO_MONGO=1 npm run dev

# live
cp .env.example .env   # add ANTHROPIC_API_KEY
npm run dev

npm run client         # React UI on :5173, proxies /api to :3001
npm test               # scorer unit tests
```

`GET /api/health` tells you which mode you are in.

---

## Test it on Telegram

The bot token is the only thing needed — you do **not** need an Anthropic key
to try the Telegram flow, because `USE_STUB=1` runs the offline parser.

```bash
# 1. Get a token: message @BotFather -> /newbot -> copy the token
#    It looks like 123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw

# 2. Put it in .env (this file is gitignored - the token never gets committed)
echo 'TELEGRAM_BOT_TOKEN=paste-your-token-here' >> .env

# 3. Run. Stub mode = no Anthropic key, no network, no Mongo needed.
USE_STUB=1 NO_MONGO=1 npm run dev
```

On success the log prints the bot's handle and a direct link:

```
[telegram] connected as @your_bot — open https://t.me/your_bot and send /start
```

If the token is wrong you get a plain diagnostic instead, the HTTP server
stays up, and web chat keeps working:

```
[telegram] NOT connected: telegram getMe: Unauthorized
[telegram] that token was rejected — re-copy it from @BotFather
```

`GET /api/health` reports `channels.telegram.connected`, which is true only
once Telegram has accepted the token — a typo'd token would otherwise read as
"on" merely because the variable is set.

**In the chat:** send `/start`, then your resume (PDF, DOCX, or pasted text),
then a job description. `/matrix` enters multi-mode (up to 5 × 5, `/done` to
run the grid), `/reset` clears, `/help` lists everything.

Verified end to end: a real PDF uploaded as a Telegram document parses and
scores; a genuinely scanned (image-only) PDF is rejected with the
export-a-text-PDF message rather than being scored as garbage.

*Known limitation:* `pdf-parse` can throw `bad XRef entry` on unusually small
or sparse PDFs that other readers accept. Real resumes from Word, Google Docs,
LaTeX and LibreOffice all parse correctly; the failure message tells the user
to re-export, which resolves it.

---

## The three decisions

**1. Channels.** Telegram (long polling — no webhook, no public URL, no tunnel
at a venue) and a web chat widget as the wifi-failure fallback. Both drive the
*same* state machine in `server/lib/conversation.js`; a channel is transport
and nothing else. WhatsApp is a stub that implements the interface and throws:
it needs Meta Business verification, which takes days. That is ~40 lines once
the account exists — see `server/channels/whatsapp.js`.

**2. Where the model is allowed to act.** It parses, it judges semantic
equivalence, and it writes prose. **It never computes the score.** The score is
a pure function in `server/lib/score.js` — same inputs, identical number,
every time. ATS hygiene is pure rules. Course suggestions are *selected* from
`server/data/courses.json` by id, and any id not in that file is dropped, so a
hallucinated course cannot reach the user.

**3. Parse once, compare many.** Each resume and each JD is parsed by one model
call and cached by sha256 of its text. Matching works on the two structured
objects. M resumes × N JDs costs **M+N** expensive calls, not M×N — 2×4 is 6
calls instead of 8, and 10×10 is 20 instead of 100. `/api/matrix` returns the
call count so you can show it rather than claim it.

---

## Scoring

```
must_have_coverage    = Σ(credit × weight) / Σ(weight)   over must_have
nice_to_have_coverage = Σ(credit × weight) / Σ(weight)   over nice_to_have
experience_fit        = min(1, months / max(1, min_months))
ats_hygiene           = 1 − (weighted violations / weighted checks)

overall = round(100 × (0.50·must + 0.20·nice + 0.20·experience + 0.10·ats))
verdict: ≥75 strong · 50–74 moderate · <50 weak
```

**Credit ladder**

| Match | Credit | Meaning |
|---|---|---|
| exact, evidenced | 1.0 | named on the resume *and* shown in use |
| semantic | 0.8 | demonstrated under a different name, with a quotable sentence |
| exact, unevidenced | 0.7 | listed in a skills dump, never shown in use |
| adjacent | 0.5 | related and transferable, not the same thing |
| absent | 0.0 | no evidence |

*Why semantic is 0.8 and not 1.0:* claimed-equivalent evidence is genuinely
weaker than the named skill, and a hiring manager would agree.

### Three deliberate deviations from the paper spec

Each is a place the literal formula produced a wrong answer. All three are
commented at the code that implements them.

1. **`claimed` = 0.7** (`lib/score.js`). The spec gives any exact keyword 1.0.
   That credits a word in a skills dump *above* a skill you demonstrably used
   under another name — backwards, given the whole premise. The parser already
   extracts `strength`; this is the code that reads it. Worth +13 points of
   verdict accuracy on the eval set.
2. **`experience_fit` returns 1 when a JD requires 0 months** (`lib/score.js`).
   The literal formula divides by `max(1,0)=1` and hands a fresher **0.0** for
   an internship that explicitly asks for no experience.
3. **A must-have gate on the verdict** (`lib/score.js`). `experience_fit` and
   `ats_hygiene` contribute 30 points unconditionally, so a clean resume
   matching *none* of a role's must-haves still scores 30, and a little
   nice-to-have overlap pushes it past 50 = "moderate". The gate caps the
   verdict at weak below 0.4 must-have coverage, and blocks "strong" below 0.7.
   The score is untouched; only the verdict changes.

---

## Rules before model

Three tiers, cheapest first. `_meta.resolved_by_rule` / `resolved_by_model` on
every result reports the split.

1. **Exact keyword** — pure JS set comparison, free.
2. **Equivalence table** (`lib/equivalences.js`) — WebSockets ⇒ event-driven,
   Docker ⇒ containers, GitHub Actions ⇒ CI/CD. Free, and every hit is a model
   call not made.
3. **One batched model call** for whatever is left — one call per (resume, JD)
   pair regardless of how many requirements are unresolved, never one per
   requirement.

A semantic verdict that arrives without a quoted evidence sentence is
downgraded to absent. If the model can't point at a line, it doesn't count.

---

## Evaluation — the honest numbers

`GET /api/eval`, 15 hand-labelled pairs (3 resumes × 5 JDs) in
`server/data/labels.json`, labelled **before** the scorer existed.

Measured in offline/stub mode (`USE_STUB=1`), 2026-09-10:

| Metric | Ours | Keyword baseline | Majority class | Random |
|---|---|---|---|---|
| Verdict accuracy | **86.7%** | **93.3%** | 53.3% | 33.3% |
| Pairwise ranking agreement | **90%** | **90%** | — | — |
| Parse validity | 100% | — | — | — |

**Read that table honestly: on this set, the keyword baseline beats us on
verdict accuracy.** Do not claim otherwise on stage. Why it happens, and what
it does and does not mean:

- The eval above runs in **stub mode, where both sides use the offline
  heuristic parser.** That parser can only extract requirements that are
  literal vocabulary terms in the JD — which is exactly the set of
  requirements keyword overlap handles well. It structurally cannot surface
  the conceptual requirements ("state management", "component composition")
  where keyword matching collapses. **Run `GET /api/eval` with a real API key
  to get the number that matters**; that path uses model parsing and the full
  semantic tier, and the numbers in this table should be regenerated from it.
- The baseline is given *our* canonical parsed requirement list, which is a
  harder control than a real ATS (which does raw-text-to-raw-text overlap).
  That was deliberate — a control you beat by weakening it proves nothing.
- n=15, self-authored labels, skewed 8 weak / 4 strong / 3 moderate. The
  confidence interval is wide enough to swallow a 6.6-point gap.
- The two remaining misses fall in **opposite** directions (one too generous,
  one too harsh), which suggests boundary noise rather than systematic bias.
- Ranking agreement — the metric that actually answers "which resume for which
  job" — is 90%, tied.

The honest one-liner: *"On our 15 pairs, ranking agreement ties at 90% and
verdict accuracy is 87% against a keyword baseline at 93%. The baseline is
strong here because our offline parser feeds it exactly the literal keywords
it's good at. The next thing I'd do is label 200 pairs and re-measure with
model parsing, because n=15 can't separate these."*

Volunteering that is worth more than a number you can't defend.

---

## What is deliberately not built

No auth or accounts (session = Telegram chat id, or a browser-local id).
Matrix capped at 5×5, enforced server-side. Course catalogue is a seeded JSON
file, not a live API. No OCR — an image-only PDF is detected (under 100
extracted characters) and rejected with a plain message. "JD from a URL" means
pasted text; no scraping. No cover letters, no PDF rewriting, no salary or
location matching.

---

## Failure behaviour

Every model response goes through `validate()` in `lib/schema.js`: unknown
enums fall back, numbers clamp, missing fields get safe defaults. On an API
error or unparseable JSON the parse falls back to the offline heuristic
parser, flags `_fallback: true`, and the UI renders it as low confidence.

Verified: with a deliberately invalid `ANTHROPIC_API_KEY`, every endpoint still
returns a complete renderable result — nothing 500s, nothing renders blank.

---

## Layout

```
server/
  index.js              Express, routes, channel wiring
  routes/               parse.js  match.js  matrix.js  eval.js
  lib/
    model.js            ask() / askJson() — never throw, structured outputs
    schema.js           validate() per contract; skill normalisation
    jsonSchemas.js      JSON Schemas handed to structured outputs
    score.js            PURE. The whole score. Unit-tested.
    equivalences.js     aliases + the free semantic tier
    atsRules.js         deterministic hygiene checks, no model
    extract.js          PDF (pdf-parse) / DOCX (mammoth) / text
    cache.js            sha256 -> parse, Mongo with in-memory fallback
    parse.js            the two parse prompts, cache-aware
    semantic.js         the one batched judgement call
    advice.js           courses (catalogue-only) + truthful rewrites
    pipeline.js         one (resume, JD) pair end to end
    heuristicParse.js   the offline parser that makes USE_STUB real
    conversation.js     the bot's brain, channel-agnostic
  channels/             base.js  telegram.js  web.js  whatsapp.js (stub)
  data/                 courses.json  labels.json  samples/
  test/score.test.js
client/                 React + Vite: chat, gauge, gaps, courses, heatmap
```

## API

| Endpoint | Does |
|---|---|
| `GET /api/health` | mode, model, cache backend, channel status |
| `POST /api/parse/resume` | `{text}` or `{file, filename}` → ParsedResume + ATS report |
| `POST /api/parse/jd` | → ParsedJD |
| `POST /api/match` | `{resume_text, jd_text}` → MatchResult |
| `POST /api/matrix` | `{resumes[], jds[]}` → grid, best-per-job, call stats |
| `GET /api/eval` | the table above (`?offline=1` forces rules-only) |
| `POST /api/chat` | the web channel; same brain as Telegram |

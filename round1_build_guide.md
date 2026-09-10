# Round 1 — Resume ↔ JD Fit Bot (MERN)

Everything for the build: the paper draft you produce in the first 30 minutes, the architecture and data contracts, and the prompts you actually paste into the AI.

---

# PART 0 — THREE DECISIONS TO MAKE BEFORE YOU START

Get these wrong and you lose an hour you can't get back.

## 0.1 Which chat channel

You said "WhatsApp, Discord, Telegram, Google". You cannot ship all of them in one round, and one of them is impossible on the day.

| Channel | Time to a working bot | Verdict |
|---|---|---|
| **Telegram** | ~5 min. Message @BotFather, get a token, done. Handles file uploads natively. | **Build this. It is the live demo.** |
| **Discord** | ~15 min. Developer portal, bot token, invite to a server. | Second, only if time allows. |
| **Web chat widget** | ~20 min. It's just your React app with a message list. | **Build this too — it's your fallback if venue wifi blocks Telegram's API.** |
| **WhatsApp** | Meta Business account + phone verification + template approval. **Days, not hours.** | Do NOT attempt. Build the adapter interface and say so. |
| Google Chat | Workspace admin access required | Skip. |

**The move that wins this:** write a thin `ChannelAdapter` interface with `receive()` and `send()`, implement Telegram and Web, and leave a stub file `whatsapp.js` with the interface implemented and a `TODO: Meta Business API` comment. Then in the demo say: *"WhatsApp needs Meta Business verification, which takes days, so it isn't in today's build. But the adapter interface is there and it's about forty lines to add once the account exists."* That's an engineering judgement statement, not an excuse, and judges read it as maturity.

## 0.2 Where the AI earns its cost — and where it must not be used

This is the single most important design decision, and it's what makes you "better than an ATS checker" rather than a wrapper.

**Rules only, no model:**
- ATS hygiene checks — is the PDF text-extractable, is there a phone and email, are section headings standard, are dates present and parseable, is it one page, are there tables or images that break parsers, is the filename sane.
- Exact keyword presence — does the literal string "Kubernetes" appear.
- All arithmetic — the weighted score, sorting, the matrix.

**Model, because it needs reading comprehension:**
- Turning a messy JD into structured requirements with must-have vs nice-to-have.
- Turning a resume into structured skills, experience and evidence spans.
- Deciding whether "built a real-time chat over WebSockets" satisfies a requirement for "experience with event-driven systems" — **an ATS scores that zero; you score it as strong evidence. That's your entire differentiation, in one sentence.**
- Writing the improvement suggestions and the rationale for each course.

**Never the model:** the final score. Compute it deterministically from the structured match, so the same inputs always give the same number. If a judge runs it twice and gets 71 then 68, you're finished. **Say this out loud in the demo.**

## 0.3 The scaling insight — the thing that makes the matrix feature possible

Naive approach: M resumes × N JDs = M×N model calls. 3 resumes × 4 JDs = 12 calls, slow and expensive, and it grows quadratically.

**Correct approach: parse once, compare many.**

- Parse each resume once → structured profile. **M calls.**
- Parse each JD once → structured requirements. **N calls.**
- Match each pair from the two structured objects. This is mostly deterministic set comparison plus one *small* model call for the semantic-equivalence cases.

**M + N expensive calls instead of M × N.** For 3 resumes and 4 JDs that's 7 instead of 12, and at 10×10 it's 20 instead of 100.

Cache the parse results by content hash so re-running a resume against a fifth JD costs one call, not two. **This is the strongest technical point in your whole submission. Put it on the architecture slide and lead with it in Q&A.**

---

# PART 1 — THE PAPER DRAFT

Do this before opening an editor. Twenty minutes, on paper. This is the artifact that shows judgement, and if the round turns out to be design-only, it *is* your submission.

## 1.1 Problem, in one sentence

> "A final-year student applying to fifteen companies has no idea which of their two resume versions fits which job, and finds out only by being rejected."

## 1.2 The specific user

> **Ananya, final-year CSE, has two resume versions — one leaning full-stack, one leaning ML — and eleven job descriptions saved in a WhatsApp folder. She wants to know, in the app she's already in, which resume to send where and what she should learn before the next drive.**

Not "job seekers". One person, one bad afternoon.

## 1.3 One-sentence solution

> "A chat bot you send a resume and a job description to, which replies with a fit score, the specific gaps, courses that close them, and — if you send several of each — a grid showing which resume wins for which job."

## 1.4 Scope table

| In scope (4 hours) | Explicitly cut |
|---|---|
| Telegram bot + web chat, both hitting one API | WhatsApp (needs Meta verification — adapter stub only) |
| PDF and DOCX resume upload, plus pasted text | Scanned-image resumes / OCR |
| JD as pasted text or a pasted URL's text | Live JD scraping from LinkedIn (auth walls) |
| Structured parse of both sides, cached by content hash | User accounts, login, history |
| Deterministic weighted score, 0–100, with 4 sub-scores | ML-trained ranking model |
| Gap list: missing must-haves, weak evidence | Salary or location matching |
| Course suggestions selected from a seeded catalog | Live course-catalogue API |
| Per-resume improvement suggestions with rewritten bullets | Resume auto-rewriting into a new PDF |
| **M × N matrix mode with a best-fit recommendation** | More than 5 resumes × 5 JDs (hard cap, stated in the UI) |
| Rules-based ATS hygiene report | Cover-letter generation |
| Eval endpoint over 15 hand-labelled pairs | — |

**The cut list is a slide, not an apology.**

## 1.5 Architecture — draw this, photograph it

```
  Telegram          Web chat widget         [whatsapp.js — stub]
      │                    │                          │
      └────────── ChannelAdapter interface ───────────┘
                           │
                  ┌────────▼─────────┐
                  │  Express API     │
                  │                  │
                  │  /api/parse/resume ─┐
                  │  /api/parse/jd     ─┤ 1 model call each, CACHED by
                  │                     │ sha256(content) in MongoDB
                  │  /api/match       ──┤ deterministic scoring over the
                  │                     │ two structured objects
                  │  /api/matrix      ──┤ M+N parses, then M*N cheap matches
                  │  /api/eval        ──┘ 15 labelled pairs -> ranking quality
                  └────────┬─────────┘
                           │
        ┌──────────────────┼────────────────────┐
        │                  │                    │
   MongoDB            LLM (parse +         courses.json
   parse cache         semantic            (seeded catalog —
   results             equivalence          model SELECTS,
   labels              only)                never invents)
        │
        ▼
   React dashboard: score gauge, gap list, courses, matrix heatmap
```

## 1.6 The JSON contracts — write these before any code

Everything else is negotiable. These are not.

**Parsed resume**
```json
{
  "name": "string",
  "contact": { "email": "", "phone": "", "links": [] },
  "skills": [{ "name": "react", "evidence": "Built Oryx frontend", "strength": "strong|mentioned" }],
  "experience": [{ "title": "", "org": "", "duration_months": 0, "highlights": [] }],
  "projects": [{ "name": "", "tech": [], "one_line": "" }],
  "education": { "degree": "", "field": "", "institution": "", "graduation": "" },
  "total_experience_months": 0,
  "_parse_confidence": "high|medium|low"
}
```

**Parsed JD**
```json
{
  "role_title": "string",
  "seniority": "intern|junior|mid|senior",
  "must_have": [{ "skill": "", "why": "", "weight": 3 }],
  "nice_to_have": [{ "skill": "", "why": "", "weight": 1 }],
  "responsibilities": [],
  "domain": "string",
  "min_experience_months": 0,
  "_parse_confidence": "high|medium|low"
}
```

**Match result — the output of deterministic scoring, not of a model**
```json
{
  "resume_id": "", "jd_id": "",
  "overall_score": 0,
  "sub_scores": { "must_have_coverage": 0, "nice_to_have_coverage": 0,
                  "experience_fit": 0, "ats_hygiene": 0 },
  "verdict": "strong|moderate|weak",
  "matched": [{ "requirement": "", "evidence": "", "match_type": "exact|semantic", "credit": 1.0 }],
  "gaps": [{ "requirement": "", "severity": "blocking|important|minor", "why_it_matters": "" }],
  "suggested_courses": [{ "course_id": "c004", "title": "", "provider": "",
                          "closes_gap": "", "rationale": "" }],
  "resume_improvements": [{ "target": "bullet or section", "issue": "",
                            "suggested_rewrite": "" }],
  "ats_issues": ["no phone number found", "two-column layout may not parse"]
}
```

## 1.7 The scoring function — decide the weights on paper

```
must_have_coverage    = Σ(credit × weight) / Σ(weight)     over must_have
nice_to_have_coverage = Σ(credit × weight) / Σ(weight)     over nice_to_have
experience_fit        = min(1, candidate_months / max(1, min_experience_months))
ats_hygiene           = 1 − (weighted rule violations / total rules)

credit: exact keyword match     = 1.0
        semantic match (model)  = 0.8
        adjacent/transferable   = 0.5
        absent                  = 0.0

overall = 100 × (0.50·must_have + 0.20·nice_to_have + 0.20·experience_fit + 0.10·ats_hygiene)

verdict: ≥75 strong · 50–74 moderate · <50 weak
```

**Why semantic matches get 0.8 not 1.0:** claimed-equivalent evidence is genuinely weaker than the named skill, and a hiring manager would agree. Being able to justify that number is worth more than the number itself.

## 1.8 What you will fake, and say so

- No auth, no accounts. Session = Telegram chat ID or a browser-local ID.
- Matrix capped at 5×5, enforced in the UI.
- Course catalogue is a seeded JSON file, not a live API.
- No OCR — image-only PDFs are rejected with a clear message.
- JD "from a URL" means pasted text; no scraping.

## 1.9 Evaluation — plan it before you build it

Hand-label **15 (resume, JD) pairs** as `strong` / `moderate` / `weak` before you write the scorer. Then:

- **Verdict accuracy** — does the computed verdict match your label?
- **Ranking quality** — for one resume across 4 JDs, does the tool's order match your hand-ranked order? Report pairwise agreement.
- **Parse validity rate** — what fraction of parses returned schema-valid JSON with no fallback?
- **Baselines to state:** random verdict over 3 classes ≈ 33%. A **pure keyword-overlap baseline** — implement it, it's 10 lines — is the honest comparison, because that's what an ATS does. *"We beat plain keyword matching by X points on the same 15 pairs"* is the sentence that proves your premise.

---

# PART 2 — THE MASTER PROMPT

Paste this first. It sets the contracts and the constraints. Then use the staged prompts in Part 3 to build module by module — **do not ask for the whole app in one go**, you'll get a plausible-looking mess you can't debug or explain.

```
You are helping me build a hackathon project in 4 hours. MERN stack.
Optimise for: working end-to-end, debuggable, and explainable by me to a
judging panel. Do NOT optimise for completeness or elegance. Prefer boring,
readable code over clever code. No TypeScript, no build tooling beyond Vite.

=== WHAT WE ARE BUILDING ===

A chat bot that scores how well a resume fits a job description, and tells the
user what to fix and what to learn. It runs inside chat apps (Telegram first)
and as a web chat widget. It is deliberately better than a keyword ATS checker,
in one specific way: it credits SEMANTIC evidence. If a JD asks for
"event-driven systems" and the resume says "built real-time chat over
WebSockets", an ATS scores zero and we score 0.8.

User: a final-year student with 2 resume versions and 11 job descriptions who
wants to know which resume to send where, and what to learn before the next one.

=== NON-NEGOTIABLE ARCHITECTURE ===

1. PARSE ONCE, COMPARE MANY.
   - Each resume is parsed by ONE model call into a structured profile.
   - Each JD is parsed by ONE model call into structured requirements.
   - Matching a (resume, JD) pair works on the two STRUCTURED objects.
   - So M resumes x N JDs costs M+N expensive calls, not M*N.
   - Cache every parse in MongoDB keyed by sha256 of the input text.
     A repeat upload must cost zero model calls.

2. THE MODEL NEVER COMPUTES THE SCORE.
   The score is a deterministic function in JavaScript over the structured
   match result. Same inputs must always produce the identical number.
   The model is used ONLY for: parsing, judging semantic equivalence of one
   requirement against evidence, and writing prose rationales.

3. RULES BEFORE MODEL.
   ATS hygiene checks (missing phone/email, unparseable PDF, non-standard
   section headings, missing dates, multi-column layout, length) are pure
   JavaScript. Exact keyword presence is pure JavaScript. Only ambiguous
   semantic judgement goes to the model. Track and expose how many checks
   were resolved without a model call.

4. NEVER INVENT COURSES.
   Course suggestions must be SELECTED from data/courses.json, which I will
   supply. The model picks course IDs from that list and writes a one-line
   rationale. It must never output a course title or URL not in the file.
   If nothing in the catalogue fits a gap, return an empty list for that gap.

5. NEVER TRUST MODEL OUTPUT.
   Every model response goes through a validate() function that coerces it
   into the schema: unknown enum values fall back to a default, numbers are
   clamped to range, missing fields get safe defaults, and on an API error or
   unparseable JSON we return a record flagged _fallback: true that the UI can
   still render. The app must never crash or show a blank screen because the
   model misbehaved.

=== DATA CONTRACTS (do not change these) ===

ParsedResume:
{ name, contact:{email,phone,links[]},
  skills:[{name, evidence, strength:"strong"|"mentioned"}],
  experience:[{title, org, duration_months, highlights[]}],
  projects:[{name, tech[], one_line}],
  education:{degree, field, institution, graduation},
  total_experience_months, _parse_confidence:"high"|"medium"|"low" }

ParsedJD:
{ role_title, seniority:"intern"|"junior"|"mid"|"senior",
  must_have:[{skill, why, weight}], nice_to_have:[{skill, why, weight}],
  responsibilities[], domain, min_experience_months,
  _parse_confidence:"high"|"medium"|"low" }

MatchResult:
{ resume_id, jd_id, overall_score,
  sub_scores:{must_have_coverage, nice_to_have_coverage, experience_fit, ats_hygiene},
  verdict:"strong"|"moderate"|"weak",
  matched:[{requirement, evidence, match_type:"exact"|"semantic", credit}],
  gaps:[{requirement, severity:"blocking"|"important"|"minor", why_it_matters}],
  suggested_courses:[{course_id, title, provider, closes_gap, rationale}],
  resume_improvements:[{target, issue, suggested_rewrite}],
  ats_issues:[string] }

=== SCORING (implement exactly) ===

credit: exact keyword match = 1.0, semantic match = 0.8,
        adjacent/transferable = 0.5, absent = 0.0

must_have_coverage    = sum(credit*weight)/sum(weight) over must_have
nice_to_have_coverage = sum(credit*weight)/sum(weight) over nice_to_have
experience_fit        = min(1, total_experience_months / max(1, min_experience_months))
ats_hygiene           = 1 - (weighted violations / total checks)

overall_score = round(100 * (0.50*must_have_coverage + 0.20*nice_to_have_coverage
                           + 0.20*experience_fit + 0.10*ats_hygiene))

verdict: >=75 "strong", 50-74 "moderate", <50 "weak"

=== STACK AND LAYOUT ===

server/
  index.js            Express app, CORS, routes
  routes/             parse.js, match.js, matrix.js, eval.js
  lib/model.js        ask() and askJson() — never throw, strip ``` fences,
                      return {_error,_raw} on failure
  lib/schema.js       validate() per contract above
  lib/score.js        PURE FUNCTIONS, no I/O, no model — unit-testable
  lib/atsRules.js     deterministic hygiene checks
  lib/extract.js      PDF/DOCX text extraction (pdf-parse, mammoth)
  lib/cache.js        sha256 -> parse result, in MongoDB
  channels/base.js    ChannelAdapter interface: receive(), send()
  channels/telegram.js
  channels/web.js
  channels/whatsapp.js  STUB ONLY — implements the interface, throws
                        "not enabled: requires Meta Business verification"
  data/courses.json
  data/labels.json    15 hand-labelled pairs for /api/eval
client/               React + Vite, plain CSS or Tailwind

=== DEMO INSURANCE ===

Support USE_STUB=1 which returns canned parse results with zero network calls,
so the whole app demos with no internet. Every endpoint must work in stub mode.

=== HOW TO WORK WITH ME ===

Build ONE module at a time. After each, show me the file and a one-line
explanation of the key decision in it. Do not scaffold the entire app at once.
Do not add features I did not ask for. If a design choice is ambiguous, ask me
rather than guessing. Keep every file under 200 lines.

Acknowledge this and wait. Do not write code yet.
```

---

# PART 3 — THE STAGED PROMPTS

Run these in order. Each is a checkpoint where you read the code, run it, and understand it before moving on.

**Prompt 1 — skeleton (target: 25 min)**
```
Build the Express skeleton: server/index.js with CORS and JSON body parsing,
a MongoDB connection with a graceful fallback to an in-memory Map if Mongo is
unreachable, and stub routes for /api/parse/resume, /api/parse/jd, /api/match,
/api/matrix, /api/eval that each return hardcoded example data matching the
contracts. Plus lib/model.js with ask() and askJson() per the rules above.
Nothing else. I want the whole pipe running against fake data first.
```

**Prompt 2 — extraction + parsing (target: 40 min)**
```
Now lib/extract.js: text out of PDF (pdf-parse) and DOCX (mammoth), plus a
plain-text path. If a PDF yields under 100 characters, return an error saying
it looks like a scanned image — do not attempt OCR.

Then the real /api/parse/resume and /api/parse/jd: extract text, hash it,
check the cache, and only call askJson() on a miss. Write the two prompts to
emit exactly the ParsedResume and ParsedJD schemas. Add validate() in
lib/schema.js for both. Show me the two prompt strings separately so I can
tune them.
```

**Prompt 3 — the scorer (target: 35 min) — the module you must understand line by line**
```
lib/score.js as pure functions, no I/O and no model calls:
  exactMatches(resumeSkills, requirement) -> boolean
  computeCredit(requirement, resumeProfile, semanticVerdicts) -> 0|0.5|0.8|1.0
  scoreMatch(resumeProfile, jdRequirements, semanticVerdicts, atsReport) -> MatchResult
Implement the weights exactly as specified. Also write a keywordBaseline()
function that scores using ONLY exact keyword overlap — I need it to prove
we beat a plain ATS. Add a small test file with 3 hand-built cases I can run
with `node --test`.
```

**Prompt 4 — semantic matching + ATS rules (target: 30 min)**
```
lib/atsRules.js: deterministic checks — email present, phone present,
extractable text, standard section headings (Education/Experience/Skills/
Projects), parseable dates, single-column heuristic, length. Each returns
{id, passed, severity, message}. No model.

Then, in the match route: for each must_have not matched exactly, batch ALL of
them into ONE askJson() call that returns, per requirement, whether the resume
evidence semantically satisfies it — {requirement, verdict:"semantic"|
"adjacent"|"absent", evidence, why}. One call for the whole list, not one per
requirement. Feed the result into scoreMatch().
```

**Prompt 5 — courses + improvements (target: 25 min)**
```
Load data/courses.json. For each gap, ask the model to select up to 2 course
IDs FROM THAT LIST ONLY and write a one-line rationale for each. Reject any
course_id not present in the file — do not pass it through. If nothing fits,
return an empty array.

Separately, one model call producing resume_improvements: for the 3 weakest
bullets relative to this JD, give {target, issue, suggested_rewrite}. Rewrites
must stay truthful to what the resume already claims — no invented achievements
or numbers. Put that constraint in the prompt explicitly.
```

**Prompt 6 — matrix mode (target: 20 min) — the special feature**
```
/api/matrix takes { resumes: [...], jds: [...] }, caps at 5x5, and:
  1. parses every resume once and every JD once (cache-aware)
  2. scores all M*N pairs from the structured objects
  3. returns { matrix: [[score,...]], best_per_jd: [...], best_per_resume: [...],
     summary: "Resume A wins 3 of 4 roles; Resume B only for the ML role",
     stats: { model_calls, cache_hits, elapsed_ms } }
The stats field is not optional — I need to show on stage that 3 resumes x
4 JDs cost 7 model calls and not 12.
```

**Prompt 7 — channels + UI (target: 40 min)**
```
channels/base.js with the ChannelAdapter interface. channels/telegram.js using
long polling (getUpdates — no webhook, no public URL needed at a venue),
handling document uploads via getFile. A conversational flow: send resume ->
send JD -> get score. Support /matrix to enter multi-mode.
channels/whatsapp.js implements the interface and throws "not enabled:
requires Meta Business verification".

Then the React client: a chat panel, a score gauge, a gap list colour-coded by
severity, course cards, and a matrix heatmap with the winning cell highlighted.
Plain and readable. No animation, no design system.
```

**Prompt 8 — eval (target: 15 min)**
```
/api/eval scores the 15 labelled pairs in data/labels.json and returns:
verdict accuracy, pairwise ranking agreement, parse validity rate, and the
SAME metrics for keywordBaseline() so the two sit side by side. Include the
random baseline (1/3). Add a note that n=15 is small and indicative.
```

---

# PART 4 — RULES FOR PROMPTING UNDER TIME PRESSURE

**Give the contract before the code.** Every schema in the master prompt exists so the AI can't drift. When it does drift, paste the schema back rather than describing the problem.

**One module per prompt.** Asking for the whole app produces something that looks finished and can't be debugged. You will be asked what a function does. "The AI wrote it" ends your round.

**Read every file before moving on.** Budget five minutes per module. If you can't explain it, ask the AI to explain it, then decide whether to keep it.

**When it breaks, paste the actual error.** Not "it doesn't work" — the stack trace, the input, and what you expected.

**Refuse scope creep.** The AI will offer auth, dark mode, a landing page. Say no. Your cut list is the plan.

**Force the fallback.** Halfway through, delete your API key and hit every endpoint. If anything 500s or renders blank, fix that before adding anything else.

**Ask it to justify, not just produce.** "Why did you pick that data structure?" costs 20 seconds and gives you the language to answer the same question on stage.

## ⚠️ The one real risk of AI-assisted building

You are allowed to use AI, so **everyone will**. The differentiator stops being "did you build it" and becomes "do you understand it". Judges know this and will probe.

Be able to explain, without looking:
- The scoring function, term by term, and why must-have is weighted 0.50.
- Why semantic matches earn 0.8 and not 1.0.
- Why the score is computed in JavaScript rather than by the model.
- The parse-once-compare-many argument, with the M+N vs M×N arithmetic.
- What happens when the model returns invalid JSON.
- Why WhatsApp isn't in the build.

**If there is a file in your repo you cannot explain, delete it before the demo.**

---

# PART 5 — THE TIMELINE

| Time | What | Freeze rule |
|---|---|---|
| 0:00–0:20 | **Paper only.** Part 1 of this document, filled for the actual statement. | No laptop |
| 0:20–0:30 | Master prompt + Prompt 1. Skeleton running on fake data. | |
| 0:30–1:10 | Prompt 2. Real extraction and parsing, cache working. | |
| 1:10–1:45 | Prompt 3. **Read the scorer properly.** Run the tests. | |
| 1:45–2:15 | Prompt 4. Semantic matching, ATS rules. | |
| 2:15–2:40 | Prompt 5. Courses and improvements. | |
| 2:40–3:00 | Prompt 6. Matrix mode. | |
| 3:00–3:15 | Prompt 8. Eval numbers, next to the keyword baseline. | |
| **3:15** | **FREEZE. No new features.** | Absolute |
| 3:15–3:30 | Prompt 7 finish: make the demo path pretty enough. Screenshots. Screen recording. Verify `USE_STUB=1`. | |
| 3:30–4:00 | Rehearse the pitch twice, out loud, timed. | |

If you're behind at 2:15, **cut courses and improvements, keep matrix mode.** The matrix is your differentiator; course suggestions are a nice-to-have that any team could bolt on.

---

# PART 6 — THE DEMO

## The script (3 minutes)

> **[0:00]** "Ananya is final-year, has two resume versions, and eleven job descriptions sitting in a WhatsApp folder. She finds out which resume fits which job by getting rejected. That's the loop we're closing.
>
> **[0:20]** *(open Telegram on your phone, mirrored)* "She's already in a chat app, so that's where this lives. Send the resume… send the job description… *(score returns)* 68 out of 100, moderate fit.
>
> **[0:45]** "The breakdown: must-have coverage, nice-to-have, experience fit, ATS hygiene. Two blocking gaps — no Kubernetes, no CI/CD evidence. Two courses from our catalogue that close them. And three of her bullets rewritten to actually match the language of this JD.
>
> **[1:05]** "But here's the part an ATS can't do. This JD asks for event-driven systems experience. Her resume never says that phrase — it says she built real-time chat over WebSockets. A keyword checker scores that zero. We credit it at 0.8, and show the evidence sentence we matched it against. That's the whole reason this exists.
>
> **[1:30]** *(switch to matrix)* "Two resumes, four JDs. *(run)* Her full-stack version wins three of the four; the ML version only wins the ML role. That's her answer for the week, in one screen.
>
> **[1:50]** "Architecture. *(show sketch)* The key decision: we parse each resume once and each JD once, then match from the structured objects. Two resumes and four JDs cost **six model calls, not eight** — and at ten by ten it's twenty instead of a hundred. Parses are cached by content hash, so re-running against a new JD costs one call.
>
> **[2:15]** "The model parses and judges semantic equivalence. It never computes the score — that's a deterministic function in JavaScript, so the same inputs always give the identical number. The ATS hygiene checks are pure rules, no model at all.
>
> **[2:30]** "Robustness: every model response is validated and coerced. Unknown category, number out of range, unparseable JSON, API down — the user still gets a result, flagged low-confidence. Courses are selected from a seeded catalogue, so we never invent a course that doesn't exist.
>
> **[2:45]** "Does it work? Fifteen hand-labelled pairs. Verdict accuracy 80%, against 33% random and 53% for a pure keyword-overlap baseline we implemented as the control. That gap is the thing we set out to build.
>
> **[2:55]** "What's fake: no auth, matrix capped at 5×5, and WhatsApp isn't wired up — it needs Meta Business verification, which takes days. The adapter interface is there; it's about forty lines once the account exists.
>
> **[3:00]** "That's it."

Then stop talking.

## Judge Q&A

**"Isn't this just an ATS checker?"**
> "The opposite, deliberately. An ATS does keyword overlap and penalises a candidate for not using the recruiter's exact vocabulary. We match evidence to requirements semantically and show which sentence we matched. We measured it — 80% versus 53% for the keyword baseline on the same pairs."

**"How do you stop the model hallucinating a course?"**
> "It can't. It selects IDs from a seeded catalogue and we reject any ID that isn't in the file. If nothing fits a gap, it returns nothing."

**"Why not let the model just output a score?"**
> "Non-determinism. If you run the same resume twice and get 71 then 68, nobody trusts it. The model does judgement; JavaScript does arithmetic."

**"What does the matrix cost at scale?"**
> The M+N argument, with the numbers.

**"What if someone uploads a scanned resume?"**
> "We detect it — under 100 characters extracted from a PDF — and tell the user plainly instead of scoring garbage. OCR was on the cut list."

**"What's the weakest part?"**
> "The eval set is 15 pairs, which is small enough that 80% has a wide error bar. And the 0.8 credit for semantic matches is a judgement call I chose, not something I derived. With more time I'd label 200 pairs and tune that weight against them."

*Volunteering that last one is the most senior thing you can say all day.*

---

# PART 7 — BEFORE THURSDAY

- [ ] **Get a Telegram bot token tonight.** Message @BotFather, `/newbot`, save the token. Two minutes, and it removes all doubt about the channel on the day.
- [ ] Test that a PDF sent to your bot can be downloaded via `getFile`.
- [ ] `npm install express cors mongoose dotenv pdf-parse mammoth node-telegram-bot-api` in your starter repo so it's all cached locally.
- [ ] Have `courses.json` on the laptop already — it's supplied with this document.
- [ ] Run MongoDB locally, or write the in-memory fallback now. **Do not depend on Atlas over venue wifi.**
- [ ] Confirm the whole thing runs with wifi off and `USE_STUB=1`.
- [ ] Print or save the master prompt somewhere you can copy from without internet.

// The ONLY place that talks to an LLM. Two rules:
//   1. It never throws. Callers get a fallback object, never an exception.
//   2. It never computes a score. Parsing, semantic judgement, prose. That's all.
//
// Two providers behind one interface. Groq is OpenAI-compatible, so it is a
// plain fetch and no extra dependency; Anthropic uses its SDK. Whichever key
// is present wins, so the rest of the codebase never learns which is in use.
import Anthropic from '@anthropic-ai/sdk';

export const USE_STUB = process.env.USE_STUB === '1';

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const isPlaceholder = (key) => !key || key.length < 20 || /\.\.\.|paste|your-key|xxxx/i.test(key);

function resolveProvider() {
  if (USE_STUB) return 'stub';
  if (!isPlaceholder(process.env.GROQ_API_KEY)) return 'groq';
  if (!isPlaceholder(process.env.ANTHROPIC_API_KEY)) return 'anthropic';
  return 'none';
}

export const PROVIDER = resolveProvider();

const DEFAULT_MODEL = { groq: 'openai/gpt-oss-120b', anthropic: 'claude-opus-5' };
const MODEL = process.env.MODEL_ID || DEFAULT_MODEL[PROVIDER] || DEFAULT_MODEL.groq;
// Parsing and equivalence judgement are extraction tasks: low effort is the
// right latency/quality trade for a live demo. Raise with MODEL_EFFORT=high.
const EFFORT = process.env.MODEL_EFFORT || 'low';

let anthropicClient = null;
const getAnthropic = () => (anthropicClient ||= new Anthropic({ timeout: 60_000, maxRetries: 1 }));

// Callers pass a stats object so /api/matrix can prove M+N instead of M*N.
export function newStats() {
  return { model_calls: 0, cache_hits: 0, rule_resolved: 0, model_resolved: 0, fallbacks: 0 };
}

/** Models sometimes wrap JSON in ``` fences even when told not to. */
export function stripFences(raw) {
  const trimmed = String(raw || '').trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fenced) return fenced[1].trim();
  const start = trimmed.search(/[[{]/);
  if (start === -1) return trimmed;
  const open = trimmed[start];
  const close = open === '{' ? '}' : ']';
  const end = trimmed.lastIndexOf(close);
  return end > start ? trimmed.slice(start, end + 1) : trimmed;
}

// --- providers ---------------------------------------------------------
// Each returns plain text and throws on failure; the wrappers below turn a
// throw into a fallback record so nothing downstream ever sees an exception.

/**
 * Groq's free tier is 8,000 tokens per minute, and `max_completion_tokens`
 * counts toward it even when unused — so a 429 is routine, not exceptional,
 * and it tells us exactly how long to wait. Without this the app fell back to
 * offline rules mid-conversation and the user saw courses vanish.
 */
async function withRateLimitRetry(attempt, tries = 3) {
  for (let i = 0; i < tries; i += 1) {
    try {
      return await attempt();
    } catch (error) {
      const wait = retryAfterSeconds(error.message);
      if (wait === null || i === tries - 1) throw error;
      console.warn(`[model] rate limited, waiting ${wait.toFixed(1)}s (attempt ${i + 1}/${tries})`);
      await new Promise((resolve) => setTimeout(resolve, wait * 1000 + 250));
    }
  }
  return null;
}

/**
 * Reads "Please try again in 11.66s" out of a 429 body, and returns null when
 * retrying is pointless.
 *
 * Groq enforces both a per-minute and a per-DAY token limit, and reports both
 * as a 429 with a "try again in Ns" hint. Waiting out a per-minute limit works.
 * Waiting 9 seconds for a limit that resets tomorrow does not — it just spends
 * 30 seconds on three doomed attempts before falling back to offline rules, so
 * every request feels hung. Fail fast on the daily one.
 */
function retryAfterSeconds(message) {
  const text = String(message);
  if (!/429|rate limit/i.test(text)) return null;
  if (/per day|\bTPD\b|per-day/i.test(text)) {
    noteDailyQuotaSpent(text);
    return null;
  }
  const match = text.match(/try again in ([\d.]+)\s*s/i);
  const seconds = match ? Number(match[1]) : 5;
  return Math.min(seconds, 25);
}

let dailyWarned = false;
function noteDailyQuotaSpent(text) {
  if (dailyWarned) return;
  dailyWarned = true;
  const used = text.match(/Limit (\d+), Used (\d+)/);
  console.error('\n  Groq daily token quota is spent'
    + (used ? ` (${Number(used[2]).toLocaleString()} of ${Number(used[1]).toLocaleString()})` : '') + '.');
  console.error('  Every AI call will fall back to offline rules until it resets.');
  console.error('  For a demo right now, run with USE_STUB=1 — it is faster and');
  console.error('  never degraded. Otherwise raise the tier at console.groq.com.\n');
}

async function callGroq({ prompt, system, schema, maxTokens }) {
  return withRateLimitRetry(() => groqRequest({ prompt, system, schema, maxTokens }));
}

async function groqRequest({ prompt, system, schema, maxTokens }) {
  const response = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        { role: 'user', content: prompt },
      ],
      max_completion_tokens: maxTokens,
      reasoning_effort: EFFORT,
      // Constrain the model at decode time rather than asking politely.
      ...(schema
        ? { response_format: { type: 'json_schema', json_schema: { name: 'result', strict: true, schema } } }
        : {}),
    }),
    signal: AbortSignal.timeout(90_000),
  });

  const data = await response.json();
  if (!response.ok) throw new Error(`${response.status} ${data?.error?.message || 'groq request failed'}`);
  return data.choices?.[0]?.message?.content || '';
}

async function callAnthropic({ prompt, system, schema, maxTokens }) {
  const response = await getAnthropic().messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    output_config: {
      effort: EFFORT,
      ...(schema ? { format: { type: 'json_schema', schema } } : {}),
    },
    ...(system ? { system } : {}),
    messages: [{ role: 'user', content: prompt }],
  });
  if (response.stop_reason === 'refusal') throw new Error('refusal');
  return response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
}

const call = (options) => (PROVIDER === 'groq' ? callGroq(options) : callAnthropic(options));

// --- public interface --------------------------------------------------

/** Free-text call. Returns a string; '' on any failure. */
export async function ask(prompt, { system, maxTokens = 2000, stats } = {}) {
  if (PROVIDER === 'stub' || PROVIDER === 'none') return '';
  try {
    if (stats) stats.model_calls += 1;
    return await call({ prompt, system, maxTokens });
  } catch (error) {
    if (stats) stats.fallbacks += 1;
    noteAuthFailure(error);
    console.error('[model] ask failed:', error.message);
    return '';
  }
}

/**
 * JSON call. `schema` is a JSON Schema enforced at decode time. On any failure
 * returns { _error, _raw } — the caller's validate() turns that into a
 * renderable record. Nothing downstream is allowed to crash.
 */
export async function askJson(prompt, { system, schema, maxTokens = 8000, stats } = {}) {
  if (PROVIDER === 'stub' || PROVIDER === 'none') {
    return { _error: PROVIDER === 'stub' ? 'stub_mode' : 'no_api_key', _raw: '' };
  }
  try {
    if (stats) stats.model_calls += 1;
    const raw = await call({ prompt, system, schema, maxTokens });
    try {
      return JSON.parse(stripFences(raw));
    } catch {
      if (stats) stats.fallbacks += 1;
      return { _error: 'unparseable_json', _raw: String(raw).slice(0, 500) };
    }
  } catch (error) {
    if (stats) stats.fallbacks += 1;
    noteAuthFailure(error);
    console.error('[model] askJson failed:', error.message);
    return { _error: error.name || 'api_error', _raw: String(error.message).slice(0, 300) };
  }
}

// A 401 means the key is wrong, and it will be wrong on every later call.
// Log the explanation once instead of the same stack forty times.
let authWarned = false;
function noteAuthFailure(error) {
  if (authWarned || !/401|403|authentication|invalid[_ ]api[_ ]key/i.test(String(error.message))) return;
  authWarned = true;
  const name = PROVIDER === 'groq' ? 'GROQ_API_KEY' : 'ANTHROPIC_API_KEY';
  console.error(`\n  The API key was rejected. Every AI call will fail and fall`);
  console.error(`  back to offline rules until it is fixed.`);
  console.error(`  Check ${name} in .env, then restart.\n`);
}

/**
 * A missing or placeholder key used to fail silently: every call errored, the
 * app fell back to offline rules, and the output still looked plausible — so
 * you would demo it believing the AI was running. Say it out loud at boot.
 */
export function checkCredentials() {
  if (PROVIDER === 'stub') {
    console.log('[model] USE_STUB=1 — offline mode, no API calls, no key needed.');
    return { ok: true, provider: 'stub' };
  }
  if (PROVIDER === 'none') {
    console.warn('\n  No usable API key found (checked GROQ_API_KEY, ANTHROPIC_API_KEY).');
    console.warn('  The app will RUN, but every AI call fails and falls back to');
    console.warn('  offline rules — scores are rougher and flagged "degraded".\n');
    console.warn('  Fix:  put a real key in .env');
    console.warn('  Or:   USE_STUB=1 npm run dev   (offline on purpose, no warning)\n');
    return { ok: false, provider: 'none', reason: 'no_api_key' };
  }
  console.log(`[model] provider: ${PROVIDER} · model: ${MODEL} · effort: ${EFFORT}`);
  return { ok: true, provider: PROVIDER };
}

export const modelInfo = { provider: PROVIDER, model: MODEL, effort: EFFORT, stub: USE_STUB };

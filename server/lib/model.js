// The ONLY place that talks to the LLM. Two rules:
//   1. It never throws. Callers get a fallback object, never an exception.
//   2. It never computes a score. Parsing, semantic judgement, prose. That's all.
import Anthropic from '@anthropic-ai/sdk';

const MODEL = process.env.MODEL_ID || 'claude-opus-5';
// Parsing and equivalence judgement are extraction-shaped tasks: low effort is
// the right trade at demo latency. Override with MODEL_EFFORT=high if needed.
const EFFORT = process.env.MODEL_EFFORT || 'low';
export const USE_STUB = process.env.USE_STUB === '1';

let client = null;
function getClient() {
  if (!client) client = new Anthropic({ timeout: 60_000, maxRetries: 1 });
  return client;
}

// Callers pass a stats object so /api/matrix can prove M+N instead of M*N.
export function newStats() {
  return { model_calls: 0, cache_hits: 0, rule_resolved: 0, model_resolved: 0, fallbacks: 0 };
}

function textOf(response) {
  return response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

// Models sometimes wrap JSON in ``` fences even when told not to. Strip them.
export function stripFences(raw) {
  const trimmed = String(raw || '').trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fenced) return fenced[1].trim();
  // Last resort: the outermost {...} or [...] in the string.
  const start = trimmed.search(/[[{]/);
  if (start === -1) return trimmed;
  const open = trimmed[start];
  const close = open === '{' ? '}' : ']';
  const end = trimmed.lastIndexOf(close);
  return end > start ? trimmed.slice(start, end + 1) : trimmed;
}

/** Free-text call. Returns a string; '' on any failure. */
export async function ask(prompt, { system, maxTokens = 2000, stats } = {}) {
  if (USE_STUB) return '';
  try {
    if (stats) stats.model_calls += 1;
    const response = await getClient().messages.create({
      model: MODEL,
      max_tokens: maxTokens,
      output_config: { effort: EFFORT },
      ...(system ? { system } : {}),
      messages: [{ role: 'user', content: prompt }],
    });
    if (response.stop_reason === 'refusal') return '';
    return textOf(response);
  } catch (error) {
    if (stats) stats.fallbacks += 1;
    console.error('[model] ask failed:', error.message);
    return '';
  }
}

/**
 * JSON call. `schema` is a JSON Schema passed to structured outputs, so the
 * model is constrained at decode time rather than asked politely for JSON.
 * On any failure returns { _error, _raw } — the caller's validate() turns that
 * into a renderable record. Nothing downstream is allowed to crash.
 */
export async function askJson(prompt, { system, schema, maxTokens = 8000, stats } = {}) {
  if (USE_STUB) return { _error: 'stub_mode', _raw: '' };
  try {
    if (stats) stats.model_calls += 1;
    const response = await getClient().messages.create({
      model: MODEL,
      max_tokens: maxTokens,
      output_config: {
        effort: EFFORT,
        ...(schema ? { format: { type: 'json_schema', schema } } : {}),
      },
      ...(system ? { system } : {}),
      messages: [{ role: 'user', content: prompt }],
    });
    if (response.stop_reason === 'refusal') {
      if (stats) stats.fallbacks += 1;
      return { _error: 'refusal', _raw: '' };
    }
    const raw = textOf(response);
    try {
      return JSON.parse(stripFences(raw));
    } catch {
      if (stats) stats.fallbacks += 1;
      return { _error: 'unparseable_json', _raw: raw.slice(0, 500) };
    }
  } catch (error) {
    if (stats) stats.fallbacks += 1;
    console.error('[model] askJson failed:', error.message);
    return { _error: error.name || 'api_error', _raw: String(error.message).slice(0, 300) };
  }
}

export const modelInfo = { model: MODEL, effort: EFFORT, stub: USE_STUB };

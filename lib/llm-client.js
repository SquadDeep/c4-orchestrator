// lib/llm-client.js — multi-provider LLM client with autonomous failover.
//
// 2026-08-06: built by Teh's call to stop the mesh being single-provider (Groq-only, and Groq
// has no fallback of its own — a Groq outage or rate-limit used to just fail the whole call, see
// every `catch` in cron.js pushing status:'failed'). One call site (callLLM) tries providers in
// order and moves to the next on ANY failure (non-2xx, network error, timeout). No caller needs
// to know which provider actually answered — but every caller gets told, because a silent
// fallback is exactly the "roster was decorative" bug this stack keeps re-learning the hard way.
//
// CHAIN ORDER — paid-primary, by explicit choice (Teh, 2026-08-06): the autonomous cron now
// spends real money by default. This is not the zero-budget posture documented elsewhere in this
// stack (CLAUDE.md "Token discipline: Groq free for bulk") — it is a deliberate override for this
// specific routing path. If that changes, change CHAIN here and update CLAUDE.md's cost note.
//   1. claude-opus-4-8      (Anthropic)                  — primary
//   2. kimi-k3               (Moonshot, paid/flagship)    — 1st fallback
//   3. kimi-k2.5             (Moonshot, same account/key, cheapest tier) — 2nd fallback
//   4. llama-3.3-70b-versatile (Groq, free)               — 3rd fallback
//   5. deepseek-v4-flash     (DeepSeek, cheap)             — last resort
//
// Needs four env vars: ANTHROPIC_API_KEY, MOONSHOT_API_KEY, GROQ_API_KEY (already set — this
// route used to be Groq-only), DEEPSEEK_API_KEY. A provider whose key is missing throws
// immediately and the chain moves on — that's a fast, visible failure, not a silent skip: check
// `attempts` on the result/error for `"... not set"` if a rung never even gets tried.
//
// COST: no dollar figures are computed or logged here. Anthropic/Moonshot/DeepSeek pricing moves
// and this file has no verified-current source for it — inventing a number would be exactly the
// "wrong fact laundered into episodic_log" failure mode SQUAD_FACTS in agents.js already warns
// about. Only raw token usage (input/output) is recorded; convert to $ against real current
// pricing before trusting it for budget decisions (TASHA's job, not this file's).
//
// ⚠️ STATUS as of 2026-08-06, verified live: opus and both kimi rungs are currently UNFUNDED —
// Anthropic returned "credit balance is too low", Moonshot returned "account ... is suspended due
// to insufficient balance" — for both, checked directly against their APIs, not assumed. Every
// real call today is actually served by groq (rung 4), not opus, despite this file's CHAIN order.
// The code is correct and will start serving from opus/kimi automatically the moment either
// account is funded — nothing else needs to change. Don't trust the CHAIN comment above as a
// claim about what's answering right now; check a live response's `provider` field, or see
// `attempts` on that response for the real per-rung status.

const TIMEOUT_MS = 20000;

async function callAnthropic({ system, messages, maxTokens, model }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY not set');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const d = await r.json();
  const content = d.content?.[0]?.text?.trim() || '[no response]';
  return { content, usage: { inputTokens: d.usage?.input_tokens ?? null, outputTokens: d.usage?.output_tokens ?? null } };
}

/** Factory for OpenAI-compatible providers (Groq, Moonshot/Kimi, DeepSeek). */
function openAICompatible(baseUrl, envKeyName) {
  return async function call({ system, messages, maxTokens, model }) {
    const key = process.env[envKeyName];
    if (!key) throw new Error(`${envKeyName} not set`);
    const r = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages: [{ role: 'system', content: system }, ...messages],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!r.ok) throw new Error(`${envKeyName} ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const d = await r.json();
    const content = d.choices?.[0]?.message?.content?.trim() || '[no response]';
    return { content, usage: { inputTokens: d.usage?.prompt_tokens ?? null, outputTokens: d.usage?.completion_tokens ?? null } };
  };
}

const callGroqProvider     = openAICompatible('https://api.groq.com/openai/v1', 'GROQ_API_KEY');
const callMoonshotProvider = openAICompatible('https://api.moonshot.ai/v1', 'MOONSHOT_API_KEY');
const callDeepSeekProvider = openAICompatible('https://api.deepseek.com/v1', 'DEEPSEEK_API_KEY');

const CHAIN = [
  { name: 'opus',      model: 'claude-opus-4-8',           call: callAnthropic },
  { name: 'kimi-paid',  model: 'kimi-k3',                   call: callMoonshotProvider },
  { name: 'kimi-free',  model: 'kimi-k2.5',                 call: callMoonshotProvider },
  { name: 'groq',       model: 'llama-3.3-70b-versatile',   call: callGroqProvider },
  { name: 'deepseek',   model: 'deepseek-v4-flash',         call: callDeepSeekProvider },
];

export const LLM_CHAIN = CHAIN.map(p => ({ name: p.name, model: p.model }));

/**
 * Call the LLM chain. Tries each provider in CHAIN order; the first one that returns
 * successfully wins. Every attempt (success or failure) is recorded in `attempts` on the
 * returned object so callers can log/display which provider actually answered.
 *
 * @param {string} system - system prompt / persona.
 * @param {string|Array<{role:'user'|'assistant', content:string}>} promptOrMessages
 * @param {{maxTokens?: number}} opts
 * @returns {Promise<{content:string, provider:string, model:string, usage:object, attempts:Array}>}
 */
export async function callLLM(system, promptOrMessages, opts = {}) {
  const messages = Array.isArray(promptOrMessages)
    ? promptOrMessages
    : [{ role: 'user', content: promptOrMessages }];
  const maxTokens = opts.maxTokens || 800;
  const attempts = [];

  for (const p of CHAIN) {
    const t0 = Date.now();
    try {
      const { content, usage } = await p.call({ system, messages, maxTokens, model: p.model });
      attempts.push({ provider: p.name, model: p.model, ok: true, latencyMs: Date.now() - t0 });
      return { content, provider: p.name, model: p.model, usage, attempts };
    } catch (err) {
      const error = String(err?.message || err).slice(0, 200);
      attempts.push({ provider: p.name, model: p.model, ok: false, error, latencyMs: Date.now() - t0 });
      // Visible in Vercel runtime logs without needing to inspect the response body/episodic_log —
      // this is the line that would have shown "credit balance too low" / "suspended" immediately,
      // instead of needing a separate direct-API probe to find out why opus/kimi weren't answering.
      console.warn(`[llm-client] ${p.name} (${p.model}) failed, trying next: ${error}`);
    }
  }

  const e = new Error(`All ${CHAIN.length} LLM providers failed: ${attempts.map(a => `${a.provider}(${a.error})`).join('; ')}`);
  e.attempts = attempts;
  throw e;
}

/** Short tag for logging: "[via opus]" or "[via kimi-paid, after opus failed]". */
export function providerTag(result) {
  const failed = result.attempts.filter(a => !a.ok).map(a => a.provider);
  return failed.length ? `[via ${result.provider}, after ${failed.join(',')} failed]` : `[via ${result.provider}]`;
}

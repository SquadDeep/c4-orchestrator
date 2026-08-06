// api/groq.js — Squad Deep Agent Chat Proxy
// POST /api/groq
// Body: { agent?, prompt, system?, max_tokens?, conversation? }
// Auth: Bearer c4-my-secret-2026
//
// agent: any of the 20 callsigns — auto-loads their persona as system prompt
// system: optional override (takes precedence over agent persona)
// conversation: [{role:'user'|'assistant', content:'...'}] for multi-turn
//
// 2026-08-06: despite the filename, this no longer only calls Groq. Routed through
// lib/llm-client.js's multi-provider chain (Opus -> Kimi paid -> Kimi free -> Groq -> DeepSeek).
// The response now includes `provider`/`model` so a caller can see who actually answered. Kept
// the filename/route path (`/api/groq`) unchanged — renaming a live public endpoint that
// CannaLens's client may call is a bigger, separate decision than this one.

import { createClient } from '@supabase/supabase-js';
import { resolveAgent, CALLSIGNS, DEFAULT_CALLSIGN, SQUAD_FACTS } from '../lib/agents.js';
import { callLLM } from '../lib/llm-client.js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const AUTH = process.env.C4_SECRET || 'c4-my-secret-2026';
const PUBLIC_KEY = process.env.C4_PUBLIC_KEY || '';   // per-surface, groq-only — safe to ship in the public CannaLens client

// The roster and the stack facts both live in lib/agents.js now. This file used to carry its own
// copy of all 20 personas (drifting from cron.js's copy) plus its own SQUAD_CONTEXT, which claimed
// "64 strains, 19 dispensaries" — actually 40 and 14. Two rosters and three sets of "facts" is how
// a wrong claim about our own product ends up in every agent reply and then in episodic_log.


export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const auth = (req.headers.authorization || '').trim();
  const allowed = PUBLIC_KEY ? [`Bearer ${AUTH}`, `Bearer ${PUBLIC_KEY}`] : [`Bearer ${AUTH}`];
  if (!allowed.includes(auth)) return res.status(401).json({ error: 'Unauthorized' });

  // Default comes from the roster, never a hardcoded literal. This was `agent = 'WARDEN'`, which
  // the 2026-07-17 rename turned into a callsign that no longer exists — and since this route now
  // rejects unknown callsigns, every caller that omitted `agent` would have started 400ing.
  const { agent = DEFAULT_CALLSIGN, prompt, system, max_tokens = 800, conversation = [] } = req.body || {};
  if (!prompt) return res.status(400).json({ error: 'prompt required' });

  // An unknown callsign used to fall through `AGENTS[agentKey] || AGENTS.WARDEN` and answer as
  // WARDEN — while the response and the episodic_log row both still said the requested name. The
  // caller was told FORGE answered when WARDEN did. Reject it instead: a typo'd callsign is a
  // caller bug, and silently substituting a different agent is how the roster became fiction.
  if (!system && !CALLSIGNS.includes(String(agent).toUpperCase())) {
    return res.status(400).json({
      error: `unknown agent '${agent}'`,
      hint: 'pass a known callsign, or `system` to override the persona',
      callsigns: CALLSIGNS,
    });
  }

  const { callsign, persona: rosterPersona } = resolveAgent(agent);
  const agentKey = system ? 'CUSTOM' : callsign;
  const persona  = system || rosterPersona;

  const systemPrompt = `${persona}\n\n${SQUAD_FACTS}`;
  const messages = [
    ...conversation.slice(-12).map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: prompt }
  ];

  try {
    const result  = await callLLM(systemPrompt, messages, { maxTokens: Math.min(max_tokens, 2000) });
    const content = result.content;

    // Log to episodic_log — non-blocking, best-effort
    supabase.from('episodic_log').insert({
      agent:      agentKey,
      task:       `DIRECT_TALK: ${prompt.substring(0, 100)}`,
      output:     `[via ${result.provider}] ${content}`.substring(0, 500),
      hub:        'browser',
      event:      'direct_talk',
      detail:     content.substring(0, 200),
      cycle_time: new Date().toISOString(),
      session_id: `talk_${Date.now()}`,
    }).then(() => {}).catch(() => {});

    return res.status(200).json({ success: true, agent: agentKey, content, provider: result.provider, model: result.model });

  } catch (err) {
    // err.attempts (from callLLM) lists every provider that was tried and why each failed —
    // all five providers are down/misconfigured at once is the only way this branch is hit.
    return res.status(502).json({ error: err.message, attempts: err.attempts || null });
  }
}

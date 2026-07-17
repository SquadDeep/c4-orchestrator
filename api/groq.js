// api/groq.js — Squad Deep Agent Chat Proxy
// POST /api/groq
// Body: { agent?, prompt, system?, max_tokens?, conversation? }
// Auth: Bearer c4-my-secret-2026
//
// agent: any of the 20 callsigns — auto-loads their persona as system prompt
// system: optional override (takes precedence over agent persona)
// conversation: [{role:'user'|'assistant', content:'...'}] for multi-turn

import { createClient } from '@supabase/supabase-js';
import { resolveAgent, CALLSIGNS, SQUAD_FACTS } from '../lib/agents.js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const GROQ_KEY = process.env.GROQ_API_KEY;
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL    = 'llama-3.3-70b-versatile';
const AUTH     = process.env.C4_SECRET || 'c4-my-secret-2026';
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

  const { agent = 'WARDEN', prompt, system, max_tokens = 800, conversation = [] } = req.body || {};
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

  const messages = [
    { role: 'system', content: `${persona}\n\n${SQUAD_FACTS}` },
    ...conversation.slice(-12).map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: prompt }
  ];

  try {
    const r = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: Math.min(max_tokens, 2000), messages })
    });

    if (!r.ok) {
      const err = await r.text();
      return res.status(502).json({ error: `Groq ${r.status}`, detail: err.substring(0, 200) });
    }

    const d       = await r.json();
    const content = d.choices?.[0]?.message?.content?.trim() || '[no response]';

    // Log to episodic_log — non-blocking, best-effort
    supabase.from('episodic_log').insert({
      agent:      agentKey,
      task:       `DIRECT_TALK: ${prompt.substring(0, 100)}`,
      output:     content.substring(0, 500),
      hub:        'browser',
      event:      'direct_talk',
      detail:     content.substring(0, 200),
      cycle_time: new Date().toISOString(),
      session_id: `talk_${Date.now()}`,
    }).then(() => {}).catch(() => {});

    return res.status(200).json({ success: true, agent: agentKey, content });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

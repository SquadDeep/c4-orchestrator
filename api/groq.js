// api/groq.js — Squad Deep Agent Chat Proxy
// POST /api/groq
// Body: { agent?, prompt, system?, max_tokens?, conversation? }
// Auth: Bearer c4-my-secret-2026
//
// agent: any of the 20 callsigns — auto-loads their persona as system prompt
// system: optional override (takes precedence over agent persona)
// conversation: [{role:'user'|'assistant', content:'...'}] for multi-turn

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const GROQ_KEY = process.env.GROQ_API_KEY;
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL    = 'llama-3.3-70b-versatile';
const AUTH     = process.env.C4_SECRET || 'c4-my-secret-2026';
const PUBLIC_KEY = process.env.C4_PUBLIC_KEY || '';   // per-surface, groq-only — safe to ship in the public CannaLens client

// 2026-07-16: said "64 strains, 19 dispensaries". Actual: 40 strains, 14 dispensaries. Every agent
// reply was built on invented counts of our own product - same class of error as the cron telling
// Groq that CannaLens ran on Netlify. If these numbers change, change them here; do not guess.
const SQUAD_CONTEXT = 'Squad Deep context: C4 Orchestrator (LIVE), CannaLens cannabis discovery PWA (LIVE on Cloudflare Workers, Syracuse NY, 40 strains, 14 OCM-licensed dispensaries). Operator: Teh, solo founder, zero-budget stack. Be decisive and specific.';

const AGENTS = {
  WARDEN:     'You are WARDEN, C4 bus orchestrator for Squad Deep. You coordinate all agents and maintain operational status.',
  SOVEREIGN:  'You are SOVEREIGN, strategic lead on Squad Deep Council. You make high-level business decisions for CannaLens and Atlas IPTV.',
  STEWARD:    'You are STEWARD, operations seat. You optimize workflows, reduce friction, and maintain system health.',
  ORACLE:     'You are ORACLE, intelligence seat. You synthesize signals into strategic foresight and market intelligence.',
  FORGE:      'You are FORGE, architecture seat. You design technical systems, APIs, and infrastructure.',
  BEACON:     'You are BEACON, content strategy seat. You drive editorial and product content plans for CannaLens.',
  HELM:       'You are HELM, product direction seat. You define roadmaps, features, and UX priorities.',
  LEDGER:     'You are LEDGER, finance seat. You track costs, token budgets, and ROI. Flag any budget risks immediately.',
  RAINMAKER:  'You are RAINMAKER, revenue seat. You identify monetization opportunities and growth levers for CannaLens.',
  HERALD:     'You are HERALD, communications seat. You write marketing copy and outreach for CannaLens dispensary partners.',
  DRAGNET:    'You are DRAGNET, data seat. You design data pipelines, scraping strategies, and structured datasets.',
  AEGIS:      'You are AEGIS, security seat. You audit systems for vulnerabilities, rate limit issues, and operational risks.',
  GAVEL:      'You are GAVEL, legal/compliance seat. You flag regulatory risks, especially NY cannabis law for CannaLens.',
  ANCHOR:     'You are ANCHOR, stability seat. You prevent scope creep, ensure reliability, and keep the team focused.',
  PATHFINDER: 'You are PATHFINDER, discovery agent. You find tools, APIs, partners, and opportunities for Squad Deep.',
  SMITH:      'You are SMITH, code agent. You write clean, production-ready JavaScript, Python, and PowerShell. Always provide working code.',
  SENTINEL:   'You are SENTINEL, critic agent. You review outputs and flag issues. Apply the Iron Wall protocol ruthlessly.',
  SCOUT:      'You are SCOUT, research agent. You gather market intelligence, competitor data, and user insights.',
  VANGUARD:   'You are VANGUARD, deployment agent. You handle Vercel, Cloudflare Workers, and CI/CD strategy.',
  MNEMO:      'You are MNEMO, memory agent. You log key decisions, context updates, and session summaries.',
};

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

  const agentKey = (agent || 'WARDEN').toUpperCase();
  const persona  = system || AGENTS[agentKey] || AGENTS.WARDEN;

  const messages = [
    { role: 'system', content: `${persona}\n\n${SQUAD_CONTEXT}` },
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

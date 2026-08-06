// api/cron.js — Squad Deep Autonomous Cycle Engine v2
// Called every 2 hours by GitHub Actions (9 AM–5 PM EDT, Mon–Fri)
// Also callable manually: GET /api/cron  Auth: Bearer c4-my-secret-2026

import { createClient } from '@supabase/supabase-js';
import { AGENTS, resolveAgent, DEFAULT_CALLSIGN, SQUAD_FACTS } from '../lib/agents.js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const GROQ_KEY = process.env.GROQ_API_KEY;
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL    = 'llama-3.3-70b-versatile';
const AUTH     = process.env.C4_SECRET || 'c4-my-secret-2026';

// Roster + stack facts come from lib/agents.js. They used to be declared here AND in groq.js with
// drifting text - two rosters, no authority. See that file for why.
// ── Self-tasks when queue is empty — agents self-generate ─────────────────────
// Keys MUST be callsigns from lib/agents.js: callGroq(AGENTS[agentKey], ...) below reads them
// straight out of the roster, so a key that is not a callsign passes `undefined` as the system
// prompt and the agent answers with no persona at all — silently. Renamed with the roster
// 2026-07-17 (DOUG/TARIQ/JULIO/LOBOS/JEANNIE were SCOUT/HERALD/FORGE/RAINMAKER/SENTINEL).
// 2026-08-06: JULIO->RAQ and LOBOS->JUKEBOX (Council rename, see lib/agents.js header).
const SELF_TASKS = {
  DOUG:    'Research the top 3 cannabis discovery apps (Weedmaps, Leafly, Jane) and identify one gap each that CannaLens can exploit in the Syracuse NY market. Return structured bullet points with evidence.',
  TARIQ:   'Write a 150-word cold outreach email to a Syracuse dispensary owner introducing CannaLens as a free listing on the map. Make it concrete, not salesy. Do NOT promise a demand radar, an analytics dashboard, or a paid tier — none of those exist.',
  RAQ:     'Audit the current CannaLens + C4 architecture. Identify the single highest-leverage technical improvement that would increase reliability or user retention. Return a 3-point proposal.',
  JUKEBOX: 'Model a revenue scenario for CannaLens: Featured Listing at $99/mo. Show monthly and annual totals for 5, 10, and 20 dispensaries. What is break-even month given $0 infra cost? Note explicitly that there is currently no payment path — Stripe prohibits cannabis.',
  JEANNIE: 'Perform a risk audit of the Squad Deep stack: C4 (Vercel + Supabase + Groq), CannaLens (Cloudflare Workers + D1). List the top 5 single points of failure and one mitigation step each.',
};

// ── Groq call ─────────────────────────────────────────────────────────────────
async function callGroq(system, user, maxTokens = 800) {
  const r = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GROQ_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user',   content: user }
      ]
    })
  });
  if (!r.ok) throw new Error(`Groq ${r.status}: ${await r.text()}`);
  const d = await r.json();
  return d.choices?.[0]?.message?.content?.trim() || '[no output]';
}

// ── Log entry ─────────────────────────────────────────────────────────────────
async function logEntry(agent, task, output, extra = {}) {
  await supabase.from('episodic_log').insert({
    agent,
    hub: 'main',
    event: task.substring(0, 100),
    detail: output.substring(0, 200),
    task: task.substring(0, 200),
    output,
    cycle_time: new Date().toISOString(),
    session_id: `auto_${Date.now()}`,
    ...extra
  });
}

// ── Main handler ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const auth = (req.headers.authorization || '').trim();
  if (auth !== `Bearer ${AUTH}`) return res.status(401).json({ error: 'Unauthorized' });

  const cycleStart = new Date().toISOString();
  const results = [];

  // 1 ── Advise on open handoffs. NEVER close them. ──────────────────────────
  // 2026-07-16: this block used to `update({ status:'closed', resolution: output })`, i.e. it
  // treated "Groq produced prose about the task" as "the task is done". This process has no
  // shell, no filesystem, and no Cloudflare/Vercel credentials — it cannot perform a single
  // handoff it is handed. Handoff #21 ("Deploy CannaLens — npx wrangler deploy") was closed
  // that way at 22:07 while the deploy never ran; the map fix stayed unshipped and the queue
  // said otherwise. Only the hub that actually did the work may close a handoff, via
  // PATCH /api/handoff. The cron comments; it does not complete. See lessons.md L12.
  const { data: openHandoffs = [] } = await supabase
    .from('handoffs')
    .select('*')
    .eq('status', 'open')
    .order('created_at', { ascending: true })
    .limit(10);

  // Because nothing here closes a handoff, an open row would otherwise be re-advised on every
  // cycle — burning Groq calls and stacking duplicate log rows forever. Advise each one once.
  const { data: advised, error: advisedErr } = await supabase
    .from('episodic_log')
    .select('handoff_id')
    .in('handoff_id', openHandoffs.length ? openHandoffs.map(h => String(h.id)) : ['-1']);

  // If the lookup fails we do not know what was already advised. Advising everything again is
  // the expensive wrong answer, so skip the block this cycle and say so loudly. Never swallow
  // this the way worker.js:277 swallows signal_checks — see lessons.md L11.
  if (advisedErr) console.error('[cron] advisory dedupe lookup failed, skipping advisories this cycle:', advisedErr.message);

  // episodic_log.handoff_id is TEXT, so this returns "29" while handoffs.id is the number 29.
  // Set.has() is strict: has(29) against a set holding "29" is false, so the dedupe matched
  // nothing and every open handoff was re-advised on every cycle. Both sides go to string.
  const alreadyAdvised = new Set((advised || []).map(r => String(r.handoff_id)));
  const handoffs = advisedErr ? [] : openHandoffs.filter(h => !alreadyAdvised.has(String(h.id)));

  for (const h of handoffs) {
    try {
      // Real routing, as of 2026-07-16. This was `AGENTS[h.agent] || AGENTS.WARDEN` against a
      // column that did not exist, so h.agent was always undefined, the `||` always fired, and
      // every handoff in the mesh's history executed as WARDEN — twenty personas, one voice, and
      // nothing to indicate it. handoffs.agent now exists (sql/2026-07-16_handoffs-agent.sql) and
      // resolveAgent reports its fallback instead of hiding it.
      const { callsign, persona, fellBack, requested } = resolveAgent(h.agent);
      if (fellBack && requested) {
        // A bad callsign that silently becomes the bus agent is how this broke the first time. Say it.
        console.warn(`[cron] handoff #${h.id}: unknown callsign ${JSON.stringify(requested)} — running as ${DEFAULT_CALLSIGN}`);
      }

      const prompt = [
        SQUAD_FACTS,
        '',
        `Handoff #${h.id}, ${h.from_hub || 'unknown'} -> ${h.to_hub || 'unknown'}`,
        `Addressed to: ${callsign}${fellBack && requested ? ` (requested ${requested}, unknown — answering as ${DEFAULT_CALLSIGN})` : ''}`,
        `Task: ${h.task}`,
        `Priority: ${h.priority || 'normal'}`,
        h.context ? `Context: ${h.context}` : '',
        '',
        'You CANNOT execute this. You have no shell, no filesystem, and no deploy credentials.',
        'Do not describe the task as done or write a plan as though you had run it.',
        'Return only advice for the human or hub that will actually do it: risks, prerequisites,',
        'and the specific first step. Be concrete. If you lack the information to advise, say so.'
      ].filter(Boolean).join('\n');

      const output = await callGroq(persona, prompt);

      // Advisory only. Status is deliberately untouched — the handoff stays open until a hub
      // that actually performed the work closes it. Logged under the callsign that actually ran,
      // not the one requested: the episodic_log row for handoff #21 has an EMPTY agent field
      // because it logged h.agent, which was undefined. Log what happened, not what was asked for.
      await logEntry(callsign, `ADVISORY: ${h.task}`, output, { handoff_id: h.id });

      results.push({ source: 'handoff', id: h.id, agent: callsign, status: 'advised', chars: output.length });
    } catch (err) {
      results.push({ source: 'handoff', id: h.id, agent: h.agent || null, status: 'failed', error: err.message });
    }
  }

  // 2 ── Self-generated tasks when queue has < 3 items ──────────────────────
  // Queue depth is how much real work is open (openHandoffs), not how many were new enough to
  // advise this cycle (handoffs). Now that nothing auto-closes, those diverge: a busy queue of
  // already-advised rows would otherwise read as idle and trigger self-tasks on top of it.
  if (openHandoffs.length < 3) {
    const selfAgents = Object.keys(SELF_TASKS);
    const hourSlot   = new Date().getUTCHours();
    const rotated    = [...selfAgents.slice(hourSlot % selfAgents.length), ...selfAgents.slice(0, hourSlot % selfAgents.length)];
    const toRun      = rotated.slice(0, Math.max(2, 5 - openHandoffs.length));

    for (const agentKey of toRun) {
      try {
        const output = await callGroq(AGENTS[agentKey], SELF_TASKS[agentKey], 700);
        await logEntry(agentKey, SELF_TASKS[agentKey], output);
        results.push({ source: 'self', agent: agentKey, status: 'completed', chars: output.length });
      } catch (err) {
        results.push({ source: 'self', agent: agentKey, status: 'failed', error: err.message });
      }
    }
  }

  // 3 ── CAITLIN: log cycle summary ───────────────────────────────────────────
  // "Completed" counts only self-tasks, which genuinely finish when the text is written.
  // Advisories are reported separately and never as completions — the underlying handoff is
  // still open and still needs a human. Collapsing the two is what made #21 look done.
  const completed = results.filter(r => r.status === 'completed').length;
  const advisedCount = results.filter(r => r.status === 'advised').length;
  const summary = `Cycle ${cycleStart} — ${results.length} tasks. Open handoffs: ${openHandoffs.length} (advised this cycle: ${advisedCount}, none closed). Self: ${results.filter(r => r.source === 'self').length}. Completed: ${completed}.`;
  await logEntry('CAITLIN', 'CYCLE_SUMMARY', summary);

  return res.status(200).json({
    success: true,
    cycle_time: cycleStart,
    processed: results.length,
    breakdown: {
      open_handoffs: openHandoffs.length,
      advised: advisedCount,
      closed: 0, // this process never closes a handoff — see block 1
      self_generated: results.filter(r => r.source === 'self').length,
      completed,
      failed: results.filter(r => r.status === 'failed').length
    },
    results
  });
}

// api/cron.js — Squad Deep Autonomous Cycle Engine v2
// Called every 2 hours by GitHub Actions (9 AM–5 PM EDT, Mon–Fri)
// Also callable manually: GET /api/cron  Auth: Bearer c4-my-secret-2026

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const GROQ_KEY = process.env.GROQ_API_KEY;
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL    = 'llama-3.3-70b-versatile';
const AUTH     = process.env.C4_SECRET || 'c4-my-secret-2026';

// ── 20-Agent Roster ───────────────────────────────────────────────────────────
const AGENTS = {
  WARDEN:     'You are WARDEN, C4 bus orchestrator for Squad Deep. You coordinate all agents and maintain operational status. Solo operator Teh runs this stack.',
  SOVEREIGN:  'You are SOVEREIGN, the strategic seat on Squad Deep Council. You make high-level business decisions for CannaLens and Atlas IPTV.',
  STEWARD:    'You are STEWARD, the operations seat. You optimize workflows, reduce friction, and maintain system health.',
  ORACLE:     'You are ORACLE, the intelligence seat. You synthesize signals into strategic foresight and market intelligence.',
  FORGE:      'You are FORGE, the architecture seat. You design technical systems, APIs, and infrastructure for Squad Deep projects.',
  BEACON:     'You are BEACON, the content strategy seat. You drive editorial and product content plans for CannaLens.',
  HELM:       'You are HELM, the product direction seat. You define roadmaps, features, and user experience priorities.',
  LEDGER:     'You are LEDGER, the finance seat. You track costs, token budgets, and ROI across the Squad Deep zero-budget stack.',
  RAINMAKER:  'You are RAINMAKER, the revenue seat. You identify monetization opportunities, partnership structures, and growth levers for CannaLens.',
  HERALD:     'You are HERALD, the communications seat. You write marketing copy, outreach, and messaging for CannaLens dispensary partners.',
  DRAGNET:    'You are DRAGNET, the data seat. You design data pipelines, scraping strategies, and structured datasets for CannaLens.',
  AEGIS:      'You are AEGIS, the security seat. You audit systems for vulnerabilities, rate limit issues, and operational risks.',
  GAVEL:      'You are GAVEL, the legal/compliance seat. You flag regulatory risks, especially NY cannabis law for CannaLens.',
  ANCHOR:     'You are ANCHOR, the stability seat. You prevent scope creep, ensure reliability, and keep the team focused.',
  PATHFINDER: 'You are PATHFINDER, the discovery agent. You find new tools, APIs, partners, and opportunities for Squad Deep.',
  SMITH:      'You are SMITH, the code agent. You write clean, production-ready JavaScript, Python, and PowerShell.',
  SENTINEL:   'You are SENTINEL, the critic agent. You review outputs, flag issues, and apply the Iron Wall protocol.',
  SCOUT:      'You are SCOUT, the research agent. You gather market intelligence, competitor data, and user insights.',
  VANGUARD:   'You are VANGUARD, the deployment agent. You handle Vercel, Cloudflare Workers, and CI/CD strategy.',
  MNEMO:      'You are MNEMO, the memory agent. You log key decisions, context updates, and session summaries for Squad Deep continuity.',
};

// ── Self-tasks when queue is empty — agents self-generate ─────────────────────
const SELF_TASKS = {
  SCOUT:     'Research the top 3 cannabis discovery apps (Weedmaps, Leafly, Jane) and identify one gap each that CannaLens can exploit in the Syracuse NY market. Return structured bullet points with evidence.',
  HERALD:    'Write a 150-word cold outreach email to a Syracuse dispensary owner introducing CannaLens as a free featured listing platform. Make it concrete, not salesy.',
  FORGE:     'Audit the current CannaLens + C4 architecture. Identify the single highest-leverage technical improvement that would increase reliability or user retention. Return a 3-point proposal.',
  RAINMAKER: 'Model a revenue scenario for CannaLens: Featured Listing at $99/mo. Show monthly and annual totals for 5, 10, and 20 dispensaries. What is break-even month given $0 infra cost?',
  SENTINEL:  'Perform a risk audit of the Squad Deep stack: C4 (Vercel+Supabase+Groq), CannaLens (Netlify). List the top 5 single points of failure and one mitigation step each.',
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
  const { data: advised = [] } = await supabase
    .from('episodic_log')
    .select('handoff_id')
    .in('handoff_id', openHandoffs.length ? openHandoffs.map(h => h.id) : [-1]);
  const alreadyAdvised = new Set((advised || []).map(r => r.handoff_id));
  const handoffs = openHandoffs.filter(h => !alreadyAdvised.has(h.id));

  for (const h of handoffs) {
    try {
      // `h.agent` does not exist — the handoffs table has from_hub/to_hub and never had an
      // `agent` column, so this silently resolved to undefined and every handoff has always
      // run as WARDEN. Keeping WARDEN, but saying so out loud instead of by accident.
      const persona = AGENTS.WARDEN;
      const prompt  = [
        'Squad Deep — Active Projects: CannaLens (LIVE, Cloudflare Workers: cannalens.gqtmvjcymc-280.workers.dev), C4 Orchestrator (LIVE, c4-orchestrator.vercel.app).',
        `Handoff #${h.id}, ${h.from_hub || 'unknown'} -> ${h.to_hub || 'unknown'}`,
        `Task: ${h.task}`,
        `Priority: ${h.priority || 'normal'}`,
        h.context ? `Context: ${h.context}` : '',
        'You CANNOT execute this. You have no shell, no filesystem, and no deploy credentials.',
        'Do not describe the task as done or write a plan as though you had run it.',
        'Return only advice for the human or hub that will actually do it: risks, prerequisites,',
        'and the specific first step. Be concrete. If you lack the information to advise, say so.'
      ].filter(Boolean).join('\n');

      const output = await callGroq(persona, prompt);

      // Advisory only. Status is deliberately untouched — the handoff stays open until a hub
      // that actually performed the work closes it.
      await logEntry('WARDEN', `ADVISORY: ${h.task}`, output, { handoff_id: h.id });

      results.push({ source: 'handoff', id: h.id, status: 'advised', chars: output.length });
    } catch (err) {
      results.push({ source: 'handoff', id: h.id, status: 'failed', error: err.message });
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

  // 3 ── MNEMO: log cycle summary ─────────────────────────────────────────────
  // "Completed" counts only self-tasks, which genuinely finish when the text is written.
  // Advisories are reported separately and never as completions — the underlying handoff is
  // still open and still needs a human. Collapsing the two is what made #21 look done.
  const completed = results.filter(r => r.status === 'completed').length;
  const advisedCount = results.filter(r => r.status === 'advised').length;
  const summary = `Cycle ${cycleStart} — ${results.length} tasks. Open handoffs: ${openHandoffs.length} (advised this cycle: ${advisedCount}, none closed). Self: ${results.filter(r => r.source === 'self').length}. Completed: ${completed}.`;
  await logEntry('MNEMO', 'CYCLE_SUMMARY', summary);

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

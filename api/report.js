// api/report.js — Squad Deep Morning Brief + EOD Debrief
// GET /api/report?type=morning   → 9 AM brief
// GET /api/report?type=eod       → 5 PM debrief
// GET /api/report?type=cycle     → quick snapshot (any time)
// Auth: Bearer c4-my-secret-2026

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const GROQ_KEY = process.env.GROQ_API_KEY;
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL    = 'llama-3.3-70b-versatile';
const AUTH     = process.env.C4_SECRET || 'c4-my-secret-2026';

async function callGroq(prompt, maxTokens = 1200) {
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
        {
          role: 'system',
          content: 'You are WARDEN, the C4 orchestrator for Squad Deep. Generate tight, data-driven operational reports. No fluff. Lead with status, end with data. Operator is Teh — solo founder, Syracuse NY, building CannaLens (cannabis discovery PWA) as his proof of concept.'
        },
        { role: 'user', content: prompt }
      ]
    })
  });
  const d = await r.json();
  return d.choices?.[0]?.message?.content?.trim() || '[report generation failed]';
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const auth = (req.headers.authorization || '').trim();
  if (auth !== `Bearer ${AUTH}`) return res.status(401).json({ error: 'Unauthorized' });

  const type      = req.query.type || 'morning';
  const now       = new Date();
  const hoursBack = type === 'morning' ? 18 : type === 'eod' ? 9 : 2;
  const since     = new Date(now - hoursBack * 3_600_000).toISOString();

  const [logsRes, openRes, closedRes] = await Promise.all([
    supabase.from('episodic_log')
      .select('*')
      .gte('cycle_time', since)
      .order('cycle_time', { ascending: false })
      .limit(50),
    supabase.from('handoffs')
      .select('agent, task, priority')
      .eq('status', 'open')
      .order('created_at', { ascending: true })
      .limit(20),
    supabase.from('handoffs')
      .select('agent, task, resolution')
      .eq('status', 'closed')
      .gte('created_at', since)
      .limit(20)
  ]);

  const logs   = logsRes.data   || [];
  const open   = openRes.data   || [];
  const closed = closedRes.data || [];

  const logLines = logs
    .filter(l => (l.task || l.event) !== 'CYCLE_SUMMARY')
    .map(l => {
      const ts  = (l.cycle_time || l.created_at || '').slice(11, 16);
      const ag  = l.agent || l.hub || '?';
      const tsk = (l.task || l.event || '').substring(0, 60);
      const out = (l.output || l.detail || '').substring(0, 120);
      return `[${ts} UTC] ${ag}: ${tsk} → ${out}`;
    })
    .join('\n') || 'No activity logged yet.';

  const openLines = open.length
    ? open.map(h => `  • [${h.priority || 'normal'}] ${h.agent}: ${h.task}`).join('\n')
    : '  Queue clear.';

  const closedLines = closed.length
    ? closed.map(h => `  • ${h.agent}: ${(h.resolution || '').substring(0, 100)}`).join('\n')
    : '  Nothing closed this window.';

  const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });

  let prompt;

  if (type === 'morning') {
    prompt = `Generate the Squad Deep MORNING BRIEF for ${dateStr}.

== CONTEXT ==
Stack: C4 Orchestrator (Vercel+Supabase+Groq), CannaLens PWA (Netlify, cannalens.netlify.app).
Operator: Teh Hopkins, solo founder, Syracuse NY. Zero-budget. Mission: CannaLens as proof of concept for Syracuse tech accelerator grant.

== ACTIVITY SINCE LAST BRIEF (${logs.length} entries) ==
${logLines}

== COMPLETED OVERNIGHT (${closed.length} handoffs) ==
${closedLines}

== OPEN QUEUE (${open.length} items) ==
${openLines}

== REPORT FORMAT ==
## 🌅 MORNING BRIEF — ${dateStr}

**STACK STATUS:** [one line, e.g. "All systems green."]

**OVERNIGHT WINS:**
[bullet per agent completion — include any data points]

**TODAY'S PUSH (9 AM–5 PM):**
[what agents are actively working on this cycle]

**OPEN QUEUE (${open.length}):**
[top items by priority]

**FIRE WATCH:**
[anything urgent, blocking, or needs Teh's eyes]

**POC DATA POINT:**
[one specific metric, count, or output that proves the system is working]`;

  } else if (type === 'eod') {
    prompt = `Generate the Squad Deep EOD DEBRIEF for ${dateStr}.

== CONTEXT ==
Stack: C4 (LIVE), CannaLens (LIVE, cannalens.netlify.app). Solo operator: Teh Hopkins, Syracuse NY. Mission: data to prove proof of concept for grant application.

== TODAY'S ACTIVITY (${logs.length} log entries) ==
${logLines}

== CLOSED TODAY (${closed.length} handoffs) ==
${closedLines}

== STILL OPEN (${open.length} items) ==
${openLines}

== REPORT FORMAT ==
## 🌆 EOD DEBRIEF — ${dateStr}

**WHAT GOT DONE:**
[bullet per completion — include agent name and output snippet]

**DECISIONS MADE (auto-authority):**
[any agent decisions or recommendations logged — list them]

**FIRES HANDLED:**
[issues resolved, errors fixed]

**STILL OPEN:**
[count + top 3 items rolling to tomorrow]

**TOMORROW'S SETUP:**
[what the 9 AM push should tackle first]

**PROOF OF CONCEPT DATA:**
[table or list: cycle count, tasks completed, agents run, total log entries, chars generated]`;

  } else {
    prompt = `Generate a quick Squad Deep CYCLE SNAPSHOT for ${now.toLocaleTimeString()}.

RECENT LOG (${logs.length} entries):
${logLines}

Open handoffs: ${open.length}

Format:
## ⚡ CYCLE SNAPSHOT — ${now.toLocaleTimeString()}
**Agent activity:** [list agent: task in 1 line each]
**Queue remaining:** [count + items]
**Next push:** [what fires at next cycle]`;
  }

  const report = await callGroq(prompt);

  return res.status(200).json({
    success: true,
    type,
    generated_at: now.toISOString(),
    report,
    data: {
      log_entries: logs.length,
      open_handoffs: open.length,
      closed_handoffs: closed.length,
      window_hours: hoursBack
    }
  });
}

// api/context.js
// Boot endpoint + dashboard feed. Both hubs curl this at launch (markdown);
// the command center calls it with ?format=json for structured state.
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const SECRET = process.env.C4_SECRET || 'c4-my-secret-2026';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.headers.authorization !== `Bearer ${SECRET}`) return res.status(401).send('# unauthorized');

  const hub = (req.query.hub || 'Main Hub').toString();
  const asJson = req.query.format === 'json';

  try {
    const [states, pending, events, projects, scrapes] = await Promise.all([
      supabase.from('session_state').select('*').order('updated_at', { ascending: false }).limit(4),
      // 2026-07-16: was .eq('status','pending'). No row in this table has ever had status
// 'pending' - the vocabulary is open/claimed/in_progress vs done/closed/cancelled. So
// "HANDOFFS WAITING FOR YOU" rendered 0 for every hub since inception and no handoff was
// ever actually delivered at boot. Match anything not yet finished, and tolerate all the
// spellings the mesh has emitted over time.
    supabase.from('handoffs').select('*').eq('to_hub', hub).in('status', ['pending','open','claimed','in_progress']).order('created_at'),
      supabase.from('episodic_log').select('*').order('created_at', { ascending: false }).limit(10),
      supabase.from('projects').select('*').order('id', { ascending: false }).limit(8),
      supabase.from('scrapes').select('id,source,url,count,status,created_at').order('created_at', { ascending: false }).limit(5),
    ]);

    const data = {
      hub,
      states: states.data || [],
      pending: pending.data || [],
      events: events.data || [],
      projects: projects.data || [],
      scrapes: scrapes.data || [],
    };

    if (asJson) return res.status(200).json(data);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.status(200).send(render(data));
  } catch (e) {
    if (asJson) return res.status(200).json({ hub, error: 'degraded', states: [], pending: [], events: [], projects: [], scrapes: [] });
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.status(200).send(`# SQUAD DEEP MASTER CONTEXT\n<!-- C4 reached, query failed -->\n## Boot safe mode.\n`);
  }
}

const dash = (s) => (s == null || s === '' ? '—' : s);
const stamp = (t) => (t ? t.slice(0, 16).replace('T', ' ') : '');

function render({ hub, states, pending, events, projects, scrapes }) {
  const ts = new Date().toISOString().slice(0, 16).replace('T', ' ');
  return `# SQUAD DEEP MASTER CONTEXT (Live from C4 — ${ts} UTC)

## CORE RULES (Iron Wall Protocol)
1. The Critic checks every output before release.
2. Any output containing "ERROR" outside a code block is rejected and restarted.

## YOU ARE: ${hub}

## HANDOFFS WAITING FOR YOU (${pending.length})
${pending.length ? pending.map(h => `- [#${h.id} from ${h.from_hub}] ${h.task}${h.context ? ` — ${h.context}` : ''}`).join('\n') : '- None. Clear to pull from the priority queue.'}

## LIVE HUB STATE
${states.length ? states.map(s => `- **${s.hub}**: ${dash(s.status)} — ${dash(s.summary)}${s.active_task ? ` (task: ${s.active_task})` : ''} @ ${stamp(s.updated_at)}`).join('\n') : '- No state checkpointed yet.'}

## RECENT SCRAPES
${scrapes.length ? scrapes.map(s => `- #${s.id} ${s.source}: ${s.count} items (${s.status})`).join('\n') : '- None.'}

## ACTIVE PROJECTS
${projects.length ? projects.map(p => `- ${dash(p.name || p.title || ('project ' + p.id))}: ${dash(p.status)}`).join('\n') : '- No projects.'}

## RECENT EVENTS
${events.length ? events.map(e => `- ${stamp(e.created_at)} [${dash(e.hub)}] ${e.event}${e.detail ? ` — ${e.detail}` : ''}`).join('\n') : '- No events logged yet.'}
`;
}

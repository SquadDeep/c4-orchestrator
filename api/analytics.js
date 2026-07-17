// api/analytics.js
// GET /api/analytics  — aggregated operational analytics for the Command Center dashboard.
// Auth: Bearer c4-my-secret-2026
//
// Returns 5 boards:
//   throughput  — handoff open/closed counts, per-agent, 7-day flow, avg time-to-done
//   heatmap     — agent activity from episodic_log (per-agent, per-hour, 7-day)
//   cron        — cron/cycle health: last runs, 24h count, error signals
//   projects    — project list with status
//   momentum    — queue health: depth vs cap, oldest/stale, 24h net flow (the operator's pulse)
//
// Always returns HTTP 200 with a `degraded` flag on failure, so the dashboard always renders.
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const SECRET = process.env.C4_SECRET || 'c4-my-secret-2026';
const QUEUE_CAP = 10;

const OPEN_STATES   = ['open', 'pending', 'claimed', 'in_progress'];
const CLOSED_STATES = ['done', 'closed', 'resolved', 'complete', 'completed'];

const dayKey = (d) => new Date(d).toISOString().slice(0, 10);
const hoursBetween = (a, b) => (new Date(b) - new Date(a)) / 3.6e6;
const last7Keys = (now) => {
  const out = [];
  for (let i = 6; i >= 0; i--) out.push(new Date(now - i * 864e5).toISOString().slice(0, 10));
  return out;
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.headers.authorization !== `Bearer ${SECRET}`) return res.status(401).json({ error: 'unauthorized' });

  const now = Date.now();
  const empty = {
    degraded: true,
    generated_at: new Date(now).toISOString(),
    throughput: { open: 0, closed: 0, total: 0, avgHoursToClose: null, byAgent: {}, last7: [] },
    heatmap: { total: 0, byAgent: {}, byHour: new Array(24).fill(0), last7: [] },
    cron: { last24h: 0, lastRunAt: null, errorSignals: 0, recent: [] },
    projects: [],
    momentum: { depth: 0, cap: QUEUE_CAP, oldestOpenHours: null, staleCount: 0, opened24: 0, closed24: 0, net24: 0 },
  };

  try {
    const [hRes, eRes, pRes] = await Promise.all([
      supabase.from('handoffs').select('*').order('created_at', { ascending: false }).limit(500),
      supabase.from('episodic_log').select('*').order('created_at', { ascending: false }).limit(500),
      supabase.from('projects').select('*').order('id', { ascending: false }).limit(20),
    ]);

    const handoffs = hRes.data || [];
    const events   = eRes.data || [];
    const projects = pRes.data || [];

    const isOpen   = (s) => OPEN_STATES.includes((s || 'open').toLowerCase());
    const isClosed = (s) => CLOSED_STATES.includes((s || '').toLowerCase());
    const agentOf  = (x) => (x.agent || x.to || x.to_hub || x.from_hub || '?').toString().toUpperCase();
    const tsOf     = (x) => x.cycle_time || x.created_at || x.updated_at;

    // ── THROUGHPUT ──
    const keys = last7Keys(now);
    const flow = Object.fromEntries(keys.map(k => [k, { date: k, opened: 0, closed: 0 }]));
    const byAgent = {};
    let open = 0, closed = 0, closeHoursSum = 0, closeHoursN = 0;

    for (const h of handoffs) {
      const a = agentOf(h);
      byAgent[a] = byAgent[a] || { open: 0, closed: 0 };
      if (isClosed(h.status)) { closed++; byAgent[a].closed++; }
      else if (isOpen(h.status)) { open++; byAgent[a].open++; }

      const ck = h.created_at ? dayKey(h.created_at) : null;
      if (ck && flow[ck]) flow[ck].opened++;

      if (isClosed(h.status)) {
        const end = h.closed_at || h.resolved_at || h.updated_at;
        if (end) {
          const ek = dayKey(end);
          if (flow[ek]) flow[ek].closed++;
          if (h.created_at) { const hr = hoursBetween(h.created_at, end); if (hr >= 0) { closeHoursSum += hr; closeHoursN++; } }
        }
      }
    }

    const throughput = {
      open, closed, total: handoffs.length,
      avgHoursToClose: closeHoursN ? +(closeHoursSum / closeHoursN).toFixed(1) : null,
      byAgent, last7: keys.map(k => flow[k]),
    };

    // ── HEATMAP (agent activity) ──
    const hmAgent = {}; const hmHour = new Array(24).fill(0);
    const hmFlow = Object.fromEntries(keys.map(k => [k, 0]));
    for (const e of events) {
      const a = (e.agent || e.hub || '?').toString().toUpperCase();
      hmAgent[a] = (hmAgent[a] || 0) + 1;
      const t = tsOf(e);
      if (t) { const d = new Date(t); if (!isNaN(d)) { hmHour[d.getUTCHours()]++; const dk = dayKey(t); if (dk in hmFlow) hmFlow[dk]++; } }
    }
    const heatmap = { total: events.length, byAgent: hmAgent, byHour: hmHour, last7: keys.map(k => ({ date: k, count: hmFlow[k] })) };

    // ── CRON HEALTH ──
    const isCron = (e) => {
      const blob = `${e.event || ''} ${e.session_id || ''} ${e.task || ''}`.toLowerCase();
      return blob.includes('cron') || blob.includes('cycle');
    };
    const cronEvents = events.filter(isCron);
    const errSignal = (e) => /error|429|fail|degraded/i.test(`${e.output || ''} ${e.detail || ''} ${e.task || ''}`);
    const cron = {
      last24h: cronEvents.filter(e => { const t = tsOf(e); return t && (now - new Date(t)) < 864e5; }).length,
      lastRunAt: cronEvents.length ? tsOf(cronEvents[0]) : null,
      errorSignals: cronEvents.filter(errSignal).length,
      recent: cronEvents.slice(0, 8).map(e => ({ at: tsOf(e), agent: (e.agent || e.hub || '?'), task: (e.task || e.event || '—'), err: errSignal(e) })),
    };

    // ── MOMENTUM (queue health) ──
    const openHandoffs = handoffs.filter(h => isOpen(h.status));
    const ages = openHandoffs.map(h => h.created_at ? hoursBetween(h.created_at, now) : 0);
    const within24 = (t) => t && (now - new Date(t)) < 864e5;
    const opened24 = handoffs.filter(h => within24(h.created_at)).length;
    const closed24 = handoffs.filter(h => isClosed(h.status) && within24(h.closed_at || h.updated_at || h.created_at)).length;
    const momentum = {
      depth: openHandoffs.length, cap: QUEUE_CAP,
      oldestOpenHours: ages.length ? +Math.max(...ages).toFixed(1) : null,
      staleCount: ages.filter(a => a > 48).length,
      opened24, closed24, net24: closed24 - opened24,
    };

    return res.status(200).json({
      degraded: false,
      generated_at: new Date(now).toISOString(),
      throughput, heatmap, cron,
      projects: projects.map(p => ({ name: p.name || p.title || ('project ' + p.id), status: p.status || '—' })),
      momentum,
    });
  } catch (e) {
    return res.status(200).json({ ...empty, error: e.message });
  }
}

// api/crm.js
// CRUD for the CRM tables in the C4 Supabase project.
// Auth: Bearer c4-my-secret-2026 (same as every C4 endpoint).
//
// Routing is by ?resource=:
//   contacts | companies | deals | activities  -> generic CRUD (CRM)
//   tasks | events                              -> generic CRUD (Squad Life: life_tasks / life_events)
//   summary                                     -> pipeline analytics (GET only)
//
//   GET    /api/crm?resource=deals                 list (newest first, ?limit, ?<col>=<val> filters, ?id=)
//   GET    /api/crm?resource=events&order=starts_at&dir=asc   optional sort column/direction
//   POST   /api/crm?resource=deals      { ...row | [rows] }   insert
//   PATCH  /api/crm?resource=deals      { id, ...updates }    update
//   DELETE /api/crm?resource=deals&id=<uuid>                  delete
//   GET    /api/crm?resource=summary               pipeline KPIs for the analytics board
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const AUTH = process.env.C4_SECRET || 'c4-my-secret-2026';

const TABLES = {
  companies:  'crm_companies',
  contacts:   'crm_contacts',
  deals:      'crm_deals',
  activities: 'crm_activities',
  tasks:      'life_tasks',
  events:     'life_events',
};

const STAGES = ['new', 'qualified', 'proposal', 'negotiation', 'won', 'lost'];

function authorized(req) {
  return (req.headers.authorization || '').trim() === `Bearer ${AUTH}`;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!authorized(req)) return res.status(401).json({ error: 'Unauthorized' });

  const resource = (req.query.resource || '').toLowerCase();

  if (resource === 'summary' && req.method === 'GET') return summary(res);

  const table = TABLES[resource];
  if (!table) {
    return res.status(400).json({
      error: `Unknown resource '${resource}'. Use one of: ${Object.keys(TABLES).join(', ')}, summary`,
    });
  }

  try {
    // ── GET — list or single ──────────────────────────────────────────
    if (req.method === 'GET') {
      const { id, limit = '200', order, dir, resource: _r, ...filters } = req.query;
      let q = supabase.from(table).select('*');
      if (id) {
        q = q.eq('id', id);
      } else {
        for (const [k, v] of Object.entries(filters)) q = q.eq(k, v);
        q = q.order(order || 'created_at', { ascending: dir === 'asc' }).limit(Math.min(parseInt(limit) || 200, 500));
      }
      const { data, error } = await q;
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ success: true, count: data.length, [resource]: data });
    }

    // ── POST — insert (single object or array) ─────────────────────────
    if (req.method === 'POST') {
      const body = req.body || {};
      const rows = Array.isArray(body) ? body : [body];
      const { data, error } = await supabase.from(table).insert(rows).select();
      if (error) return res.status(500).json({ error: error.message });
      return res.status(201).json({ success: true, [resource]: data });
    }

    // ── PATCH — update by id ───────────────────────────────────────────
    if (req.method === 'PATCH') {
      const { id, ...updates } = req.body || {};
      if (!id) return res.status(400).json({ error: 'id required' });
      const { data, error } = await supabase.from(table).update(updates).eq('id', id).select();
      if (error) return res.status(500).json({ error: error.message });
      if (!data || !data.length) return res.status(404).json({ error: `No ${resource} with id ${id}` });
      return res.status(200).json({ success: true, record: data[0] });
    }

    // ── DELETE — by id (query or body) ─────────────────────────────────
    if (req.method === 'DELETE') {
      const id = req.query.id || (req.body || {}).id;
      if (!id) return res.status(400).json({ error: 'id required' });
      const { error } = await supabase.from(table).delete().eq('id', id);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ success: true, deleted: id });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// ── pipeline analytics — the "analytics for this build" board ─────────
async function summary(res) {
  try {
    const [dealsR, contactsR, actsR] = await Promise.all([
      supabase.from('crm_deals').select('*').limit(1000),
      supabase.from('crm_contacts').select('id,status').limit(2000),
      supabase.from('crm_activities').select('id,type,created_at').order('created_at', { ascending: false }).limit(500),
    ]);

    const deals = dealsR.data || [], contacts = contactsR.data || [], acts = actsR.data || [];
    const byStage = Object.fromEntries(STAGES.map(s => [s, { count: 0, value: 0 }]));
    let openValue = 0, wonValue = 0, weighted = 0;

    for (const d of deals) {
      const st = (d.stage || 'new').toLowerCase();
      if (!byStage[st]) byStage[st] = { count: 0, value: 0 };
      const v = Number(d.value) || 0;
      byStage[st].count++;
      byStage[st].value += v;
      if (st === 'won') wonValue += v;
      else if (st !== 'lost') { openValue += v; weighted += v * ((Number(d.probability) || 0) / 100); }
    }

    const won = byStage.won?.count || 0, lost = byStage.lost?.count || 0;
    return res.status(200).json({
      degraded: false,
      generated_at: new Date().toISOString(),
      deals: deals.length,
      contacts: contacts.length,
      activities: acts.length,
      byStage,
      openValue: +openValue.toFixed(2),
      wonValue: +wonValue.toFixed(2),
      weightedPipeline: +weighted.toFixed(2),
      winRate: (won + lost) ? +((won / (won + lost)) * 100).toFixed(0) : null,
    });
  } catch (e) {
    return res.status(200).json({
      degraded: true, error: e.message,
      byStage: {}, deals: 0, contacts: 0, activities: 0,
      openValue: 0, wonValue: 0, weightedPipeline: 0, winRate: null,
    });
  }
}

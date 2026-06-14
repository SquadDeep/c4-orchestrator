// api/handoff.js  - CannaLens handoff API.
//   GET  ?status=open  ?agent=SMITH  ?limit=25
//   POST { agent, task, priority?, payload?, ... }
//   PATCH { id, status?, resolution?, ...fields }
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const SECRET = process.env.C4_SECRET || 'c4-my-secret-2026';

function authorized(req) {
  const h = (req.headers.authorization || '').trim();
  return h === `Bearer ${SECRET}`;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });

  if (req.method === 'GET') {
    const { status, agent, limit = '50' } = req.query;

    let q = supabase
      .from('handoffs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(Math.min(parseInt(limit) || 50, 200));

    if (status) q = q.eq('status', status);
    if (agent)  q = q.eq('agent', agent);

    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ success: true, count: data.length, handoffs: data });
  }

  if (req.method === 'POST') {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});

    const { data, error } = await supabase
      .from('handoffs')
      .insert([{ ...body, status: body.status || 'open', created_at: new Date().toISOString() }])
      .select();

    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json({ success: true, handoff: data[0] });
  }

  if (req.method === 'PATCH') {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const { id, ...updates } = body;
    if (!id) return res.status(400).json({ error: 'id required' });

    const { data, error } = await supabase
      .from('handoffs')
      .update(updates)
      .eq('id', id)
      .select();

    if (error) return res.status(500).json({ error: error.message });
    if (!data || data.length === 0) return res.status(404).json({ error: `No handoff found with id ${id}` });
    return res.status(200).json({ success: true, handoff: data[0] });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const setCors = (res) =>
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));

const isAuthed = (req) =>
  req.headers['authorization'] ===
  `Bearer ${process.env.C4_SECRET ?? 'c4-my-secret-2026'}`;

export default async function handler(req, res) {
  // ── PREFLIGHT ────────────────────────────────────────────────────
  if (req.method === 'OPTIONS') {
    setCors(res);
    return res.status(200).end();
  }

  setCors(res);

  if (!isAuthed(req))
    return res.status(401).json({ error: 'Unauthorized' });

  // ── GET — list handoffs ──────────────────────────────────────────
  if (req.method === 'GET') {
    const { status, agent, limit = '25' } = req.query;

    let q = supabase
      .from('handoffs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(Number(limit));

    if (status) q = q.eq('status', status);
    if (agent)  q = q.eq('agent', agent.toUpperCase());

    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ handoffs: data, count: data.length });
  }

  // ── POST — create handoff ────────────────────────────────────────
  if (req.method === 'POST') {
    const { agent, task, priority = 'P2', notes = '' } = req.body ?? {};

    if (!agent || !task)
      return res.status(400).json({ error: 'agent and task are required' });

    const { data, error } = await supabase
      .from('handoffs')
      .insert([{
        agent:      agent.toUpperCase(),
        task,
        priority,
        notes,
        status:     'open',
        created_at: new Date().toISOString(),
      }])
      .select();

    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json({ handoff: data[0] });
  }

  // ── PATCH — update status / notes / close_notes ──────────────────
  if (req.method === 'PATCH') {
    const { id, status, notes, close_notes } = req.body ?? {};

    if (!id)
      return res.status(400).json({ error: 'id required' });

    const now = new Date().toISOString();
    const patch = { updated_at: now };
    if (status      !== undefined) patch.status      = status;
    if (notes       !== undefined) patch.notes       = notes;
    if (close_notes !== undefined) patch.close_notes = close_notes;
    if (status === 'closed' || status === 'done') patch.closed_at = now;

    const { data, error } = await supabase
      .from('handoffs')
      .update(patch)
      .eq('id', id)
      .select();

    if (error) return res.status(500).json({ error: error.message });
    if (!data?.length) return res.status(404).json({ error: 'Not found' });
    return res.status(200).json({ handoff: data[0] });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

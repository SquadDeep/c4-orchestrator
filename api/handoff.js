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

  // ── GET — read handoffs ──────────────────────────────────────────
  if (req.method === 'GET') {
    const {
      status,
      to_agent,
      from_agent,
      limit = '25',
    } = req.query;

    let q = supabase
      .from('handoffs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(Number(limit));

    if (status)     q = q.eq('status', status);
    if (to_agent)   q = q.eq('to_agent', to_agent);
    if (from_agent) q = q.eq('from_agent', from_agent);

    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });

    return res.status(200).json({ handoffs: data, count: data.length });
  }

  // ── POST — create handoff ────────────────────────────────────────
  if (req.method === 'POST') {
    const {
      from_agent,
      to_agent,
      payload,
      status = 'pending',
    } = req.body ?? {};

    if (!from_agent || !to_agent || !payload)
      return res.status(400).json({
        error: 'from_agent, to_agent, payload required',
      });

    const { data, error } = await supabase
      .from('handoffs')
      .insert([{ from_agent, to_agent, payload, status }])
      .select();

    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json({ handoff: data[0] });
  }

  // ── PATCH — update status / payload ─────────────────────────────
  if (req.method === 'PATCH') {
    const { id, status, payload } = req.body ?? {};

    if (!id)
      return res.status(400).json({ error: 'id required' });

    const patch = { updated_at: new Date().toISOString() };
    if (status  !== undefined) patch.status  = status;
    if (payload !== undefined) patch.payload = payload;

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

// api/checkpoint.js  - a hub writes its current state and (optionally) logs an event.
// POST { hub, status?, summary?, active_task?, event?, detail? }
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const SECRET = process.env.C4_SECRET || 'c4-my-secret-2026';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.headers.authorization !== `Bearer ${SECRET}`) return res.status(401).json({ error: 'unauthorized' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const { hub, status = 'idle', summary = '', active_task = null, event = null, detail = null } = b;
  if (!hub) return res.status(400).json({ error: 'hub required' });

  const { error } = await supabase.from('session_state')
    .upsert({ hub, status, summary, active_task, updated_at: new Date().toISOString() }, { onConflict: 'hub' });
  if (error) return res.status(500).json({ error: error.message });
  if (event) await supabase.from('episodic_log').insert({ hub, event, detail });
  return res.status(200).json({ ok: true });
}

// api/ingest.js  - scraper posts here. Stores the haul, logs it, auto-hands off.
//   POST { source, url?, items:[...], handoffTo?:"Main Hub" }
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
  const { source, url = null, items = [], handoffTo = 'Main Hub' } = b;
  if (!source || !Array.isArray(items)) return res.status(400).json({ error: 'source + items[] required' });

  const { data, error } = await supabase.from('scrapes')
    .insert({ source, url, items, count: items.length, status: 'new' }).select().single();
  if (error) return res.status(500).json({ error: error.message });

  await supabase.from('episodic_log').insert({ hub: 'Satellite Hub', event: 'scrape_ingested', detail: `${items.length} from ${source} (scrape #${data.id})` });
  if (handoffTo) {
    await supabase.from('handoffs').insert({
      from_hub: 'Satellite Hub', to_hub: handoffTo,
      task: `review ${items.length} scraped items from ${source}`,
      context: `scrape #${data.id}` + (url ? ` — ${url}` : '')
    });
  }
  return res.status(200).json({ ok: true, scrape_id: data.id, count: items.length });
}

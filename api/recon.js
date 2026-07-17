// api/recon.js — Weekly CNY dispensary competitive recon
// GET /api/recon   (Bearer c4-my-secret-2026 — also fired by Vercel Cron via CRON_SECRET)
//
// Scope: PUBLIC business/product signals of Central-NY dispensaries only
// (Diamond Tree + CNY set). No profiling of individuals.
//
// Pipeline (mirrors the ingest -> scrapes -> handoff pattern, plus a warden-style digest):
//   1. best-effort fetch each seed dispensary's public site
//   2. store the haul in Supabase `scrapes` (source 'cny-recon')
//   3. auto-create a review handoff (like ingest.js)
//   4. ONE Groq pass -> ranked competitive digest, persisted to episodic_log
//
// Extend SEED below as new CNY dispensaries open (operator-owned list).

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const GROQ_KEY = process.env.GROQ_API_KEY;
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL    = 'llama-3.3-70b-versatile';
const AUTH     = process.env.C4_SECRET || 'c4-my-secret-2026';

// Central-NY dispensaries to watch (public sites). Diamond Tree is the local rival.
const SEED = [
  { name: 'Diamond Tree Dispensary', city: 'Syracuse', url: 'https://diamondtreedispensary.com/' },
  { name: 'Curaleaf Syracuse',       city: 'Syracuse', url: 'https://curaleaf.com/shop/new-york/curaleaf-dispensary-syracuse' },
  { name: 'Just Breathe',            city: 'Binghamton', url: 'https://justbreathe.shop/' },
  { name: 'William Jane',            city: 'Ithaca',   url: 'https://williamjane.com/' },
];

// Curated known baseline (public facts) so the digest has an anchor even if fetches fail.
const KNOWN = 'Diamond Tree Dispensary: single licensed adult-use store, 2700 Erie Blvd E Syracuse NY, opened Dec 2024, stock Dutchie web menu, no native app, "Diamond Points" loyalty, delivery ~40mi, Weedmaps 4.8 stars. CannaLens edge: NY-wide education-first strain discovery + AI budtender + "legal + in-stock" trust layer that a single-store Dutchie menu cannot match.';

async function fetchSite(entry) {
  const started = new Date().toISOString();
  try {
    const r = await fetch(entry.url, {
      redirect: 'follow',
      headers: { 'User-Agent': 'SquadDeep-Recon/1.0 (+cannalens.netlify.app)' },
      signal: AbortSignal.timeout(6000),
    });
    const html = (await r.text()) || '';
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return { ...entry, ok: r.ok, status: r.status, snippet: text.substring(0, 600), fetched_at: started };
  } catch (e) {
    return { ...entry, ok: false, status: 0, error: String(e.message || e).substring(0, 120), fetched_at: started };
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const auth = (req.headers.authorization || '').trim();
  if (auth !== `Bearer ${AUTH}`) return res.status(401).json({ error: 'Unauthorized' });

  const runAt = new Date().toISOString();

  // 1 ── pull (best-effort, in parallel) ─────────────────────────────────────
  const items = await Promise.all(SEED.map(fetchSite));
  const reached = items.filter(i => i.ok).length;

  // 2 ── store the haul in `scrapes` ─────────────────────────────────────────
  let scrapeId = null;
  try {
    const { data } = await supabase
      .from('scrapes')
      .insert([{ source: 'cny-recon', url: null, items, count: items.length, status: 'new' }])
      .select('id')
      .single();
    scrapeId = data?.id ?? null;
  } catch (_) { /* non-fatal */ }

  // 3 ── auto-create a review handoff (exact ingest.js shape: 4 proven columns) ─
  try {
    await supabase.from('handoffs').insert({
      from_hub: 'Recon',
      to_hub:   'Main Hub',
      task:     `review weekly CNY dispensary recon — ${reached}/${items.length} sites reached (SCOUT)`,
      context:  `scrape #${scrapeId ?? '?'} · source cny-recon`,
    });
  } catch (_) { /* non-fatal */ }

  // 4 ── ONE Groq pass -> ranked competitive digest ──────────────────────────
  let digest = '';
  try {
    const signals = items.map(i =>
      `- ${i.name} (${i.city}) [${i.ok ? 'HTTP ' + i.status : 'unreachable'}]: ${i.snippet || i.error || 'n/a'}`
    ).join('\n');

    const r = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 900,
        messages: [
          { role: 'system', content: 'You are SCOUT, competitive-intelligence analyst for CannaLens (a NY-wide, education-first cannabis strain-discovery PWA with an AI budtender). Analyze PUBLIC dispensary signals only. Be concrete and decisive.' },
          { role: 'user', content: `Baseline: ${KNOWN}\n\nThis week's public signals from Central-NY dispensaries:\n${signals}\n\nProduce a ranked competitive digest for the CannaLens founder:\n1) Notable changes/moves (pricing, promos, menu, new entrants) worth reacting to this week.\n2) Any gaps CannaLens can exploit.\n3) Top 3 recommended actions, most-impactful first.\nKeep it tight and operational.` },
        ],
      }),
    });
    if (r.ok) {
      const d = await r.json();
      digest = d.choices?.[0]?.message?.content?.trim() || '';
    } else {
      digest = `[digest unavailable: Groq ${r.status}]`;
    }
  } catch (e) {
    digest = `[digest error: ${e.message}]`;
  }

  // persist digest to episodic_log (best-effort, like warden/grants)
  supabase.from('episodic_log').insert({
    agent: 'SCOUT',
    hub: 'Recon',
    event: 'cny_recon',
    task: 'weekly CNY dispensary recon digest',
    output: digest.substring(0, 500),
    detail: `reached ${reached}/${items.length}`,
    cycle_time: runAt,
    session_id: `recon_${runAt}`,
  }).then(() => {}).catch(() => {});

  return res.status(200).json({
    ok: true,
    scrape_id: scrapeId,
    watched: items.length,
    reached,
    digest,
  });
}

// api/intel.js — Intelligence · Grant / Investor / Risk Search
// GET /api/intel?type=grants|investors|intel|risk
// Auth: Bearer c4-my-secret-2026
// Monthly grant sweeps + funding/investor/risk intelligence for CannaLens.
//
// 2026-08-08: renamed from api/warden.js (clean break - /api/warden is GONE, not aliased).
// It was named for the WARDEN callsign, which was renamed to FIFTY on 2026-07-17, so the
// filename referred to a seat that no longer existed. Named by FUNCTION rather than after
// the current seat on purpose: the other ten routes (handoff, context, checkpoint, ingest,
// cron, crm, analytics, gmail, recon, report) are all functional, and this seat has been
// renamed three times in three weeks. Naming infrastructure after whoever currently holds a
// seat is what forced this rename in the first place - `fifty.js` would just break again at
// the next roster change. Verified zero callers before renaming: no dashboard, helper,
// cron.js path, or the CannaLens Worker referenced /api/warden.
//
// 2026-08-08, same day, second pass - three things fixed after the rename:
//   1. Personas no longer hardcoded here; imported from lib/agents.js, the documented single
//      source of truth. Task framing moved from the system prompt into the user prompt, so
//      nothing was lost - it matches cron.js's callLLM(AGENTS[key], task) shape.
//   2. `type=risk` attributed its output to 'ARBITER', a callsign in no roster and not in the
//      v2->v3 mapping, invented inline and written into episodic_log.agent behind a silent
//      .catch(). Reassigned to TOMMY (CISO - the only seat whose whole remit is risk). CANE
//      owns the regulatory dimension specifically if this ever narrows to compliance alone.
//   3. Invented product counts removed: "65+ strains" and "18 on CannaLens map" against a real
//      40 strains / 14 dispensaries. Same bug groq.js fixed in e85545f, never fixed here, and
//      it mattered more here because one of these briefs is written FOR INVESTORS. Our figures
//      now come from SQUAD_FACTS; third-party market numbers are marked unverified rather than
//      deleted, since they are dated and want re-sourcing before any external use.
//
// Response field was `warden_brief` on three branches and `arbiter_assessment` on a fourth;
// both are now `brief`/`assessment`. Nothing consumed them - verified zero callers.

import { createClient } from '@supabase/supabase-js';
// 2026-08-08: personas now come from the roster instead of being retyped here. This file
// hardcoded its own system prompts, including an invented 'ARBITER' seat - the same
// re-declaration that let cron.js and groq.js drift apart, which is why lib/agents.js was
// made the single source of truth. SQUAD_FACTS is imported for the same reason: the branches
// below asserted "65+ strains" and "18 on CannaLens map" against a real catalog of 40 strains
// and 14 dispensaries. That is the exact bug fixed in groq.js by e85545f and never fixed here,
// and it mattered more here because the investor brief is investor-facing material.
import { AGENTS, SQUAD_FACTS } from '../lib/agents.js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const GROQ_KEY  = process.env.GROQ_API_KEY;
const GROQ_URL  = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL     = 'llama-3.3-70b-versatile';
const AUTH      = process.env.C4_SECRET || 'c4-my-secret-2026';

async function callGroq(system, user, maxTokens = 1600) {
  const r = await fetch(GROQ_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }]
    })
  });
  const j = await r.json();
  return j.choices?.[0]?.message?.content || '(no response)';
}

// ── STATIC INTELLIGENCE — updated by FIFTY monthly ──
const GRANTS = [
  {
    name: 'NY OCM Community Reinvestment Fund (CGRF)',
    type: 'Grant',
    amount: '$50,000–$200,000',
    eligibility: '501(c)(3) community orgs in cannabis-impacted communities; SEE operator support',
    deadline: 'May 21, 2026 (FY2026 round — next round TBD)',
    contact: 'cannabis.ny.gov/reinvestment | info@ocm.ny.gov',
    fit: 'HIGH — CannaLens serves social equity communities in Onondaga County',
    source: 'NY Office of Cannabis Management'
  },
  {
    name: 'CenterState CEO Syracuse Surge Accelerator',
    type: 'Accelerator + Grant',
    amount: 'Up to $90,000 (ignition grant + stipends + programming)',
    eligibility: 'BIPOC-led tech or tech-adjacent startups in CNY; in-person Syracuse program',
    deadline: 'Annual cohort — check centerstateceo.com for next cycle',
    contact: 'centerstateceo.com | The Tech Garden, Syracuse',
    fit: 'HIGH — BIPOC-founded, tech platform, Syracuse-based',
    source: 'CenterState CEO'
  },
  {
    name: 'GENIUS NY / INSPYRE Innovation Hub',
    type: 'Accelerator',
    amount: 'Equity investment + $1M+ in resources for top cohort companies',
    eligibility: 'Startups in drone, autonomous systems, advanced manufacturing, AI — broad eligibility',
    deadline: 'Cohort 10: apps closed May 2026; semi-finalists June 22, 2026; program starts Sept 8, 2026',
    contact: 'geniusny.com | inspyrehub.com',
    fit: 'MEDIUM — AI platform, check vertical alignment with current cohort focus',
    source: 'GENIUS NY / Empire State Development'
  },
  {
    name: 'NY Cannabis Social Equity Investment Fund',
    type: 'Investment Fund',
    amount: 'Up to $200M public-private pool ($50M state seed)',
    eligibility: 'CAURD licensees and justice-involved cannabis entrepreneurs',
    deadline: 'Ongoing — administered through DASNY',
    contact: 'dasny.org/Cannabis | 1-888-OCM-5151',
    fit: 'MEDIUM — platform not direct retailer; explore partnership angle with dispensary partners',
    source: 'DASNY / NYS Office of Cannabis Management'
  },
  {
    name: 'OCM Cannabis Hub & Incubation Program (CHIP)',
    type: 'Technical Assistance + Grant',
    amount: 'TAP grant for service providers; varies by program tier',
    eligibility: 'Organizations providing technical assistance to SEE cannabis applicants/licensees',
    deadline: 'Rolling — check cannabis.ny.gov/chip',
    contact: 'cannabis.ny.gov | CHIP program team',
    fit: 'HIGH — CannaLens provides education/discovery services to SEE-adjacent operators',
    source: 'NY OCM CHIP Program'
  },
  {
    name: 'SBA SBIR/STTR Phase I',
    type: 'Federal Grant',
    amount: '$50,000–$300,000 (Phase I)',
    eligibility: 'Small businesses with R&D component; AI/data/health tech applicable',
    deadline: 'Rolling by agency — check sbir.gov',
    contact: 'sbir.gov',
    fit: 'MEDIUM — cannabis info platform with AI R&D; check NIH/NSF verticals',
    source: 'U.S. Small Business Administration'
  },
  {
    name: 'JPMorgan Chase Advancing Black Entrepreneurs',
    type: 'Grant + Business Support',
    amount: 'Varies by program year',
    eligibility: 'Black-owned small businesses; financial access and business development',
    deadline: 'Annual — check jpmorgan.com/commercial-banking/business-tips/black-owned-business',
    contact: 'Chase local business team | Syracuse branch',
    fit: 'HIGH if founder qualifies as Black entrepreneur; no cannabis sales restriction for info platforms',
    source: 'JPMorgan Chase Foundation'
  },
  {
    name: 'Onondaga County IDA / CenterState CEO Economic Dev. Grants',
    type: 'Local Economic Development',
    amount: 'Varies — $5K–$50K range typical for small tech businesses',
    eligibility: 'Onondaga County-based businesses creating jobs or economic impact',
    deadline: 'Rolling',
    contact: 'onondagacountyida.com | CenterState CEO economic development team',
    fit: 'HIGH — Syracuse-based tech company, job creation potential',
    source: 'Onondaga County IDA'
  },
  {
    name: 'NYS Excelsior Business Program / Empire State Development',
    type: 'State Business Grant/Tax Credit',
    amount: 'Tax credits and grants based on job creation and investment',
    eligibility: 'NY-based businesses in tech, life sciences, or priority sectors',
    deadline: 'Ongoing applications',
    contact: 'esd.ny.gov | 1-800-STATE-NY',
    fit: 'MEDIUM — cannabis info platform; check tech sector eligibility',
    source: 'Empire State Development'
  },
  {
    name: 'Camelot Education / Cannabis Equity Angel Network (CEAN)',
    type: 'Angel Investment',
    amount: '$25K–$500K initial check sizes',
    eligibility: 'BIPOC-founded cannabis tech startups; equity-focused investors',
    deadline: 'Rolling pitch submissions',
    contact: 'Search "Cannabis Equity Angel Network" + CEAN investor network',
    fit: 'HIGH — BIPOC-founded cannabis technology platform',
    source: 'CEAN / Cannabis Equity Networks'
  }
];

const RISK_MATRIX = {
  regulatory: {
    level: 'LOW-MEDIUM',
    items: [
      'CannaLens is an information platform — not a licensed cannabis retailer, distributor, or processor',
      'No cannabis sales, no inventory, no financial transactions involving cannabis products',
      'OCM confirmed digital discovery platforms without retail transactions are compliant (May 2026)',
      'Age gate (21+) implemented and enforced on all entry points',
      'Medical claims policy: zero — all content is explicitly informational only',
      'Data privacy: user journal data private by default; CCPA and NY Privacy Act compliant'
    ],
    mitigation: 'Maintain non-retail status; never facilitate cannabis purchase or payment'
  },
  financial: {
    level: 'LOW (pre-revenue) → MEDIUM (scale)',
    items: [
      'Zero-cost infrastructure at current scale (Vercel free tier, Supabase free tier)',
      'Revenue model: subscription (Pro tier), affiliate commissions, partner listings — none cannabis-direct',
      'IRS compliance: platform income is software/SaaS revenue, not cannabis income',
      'No Schedule I business classification risk — info platform only',
      'Affiliate payouts via Stripe — standard 1099 reporting applies'
    ],
    mitigation: 'Keep clear separation between platform revenue and any cannabis commerce'
  },
  reputational: {
    level: 'LOW',
    items: [
      'Community-first positioning: BIPOC founder, Syracuse roots, social equity focus',
      'All content licensed-dispensary only — no unlicensed operators listed',
      'No cannabis product endorsements; strain data is informational, sourced from public databases'
    ],
    mitigation: 'Maintain editorial standards; never list unlicensed operators'
  },
  operational: {
    level: 'LOW (solo founder → MEDIUM at team scale)',
    items: [
      'Single-founder concentration risk: business continuity depends on founder health/availability',
      'AI API dependency (DeepSeek for Bud AI) — has C4 fallback via Groq',
      'Vercel/Supabase vendor risk — standard SaaS dependency'
    ],
    mitigation: 'Document all operations; build agent systems for autonomous continuity'
  }
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');

  // 2026-08-07: this route had NO OPTIONS handler and NO method guard - it went straight
  // from the auth check into callGroq() plus an episodic_log insert. So ANY authenticated
  // request of ANY method ran a paid grant sweep: a browser CORS preflight, a liveness
  // probe, a curl typo. It is a third GET-triggered job alongside /api/cron and /api/recon,
  // and CLAUDE.md's "never probe these" note listed only those two. Now short-circuits
  // exactly like cron.js:50 and recon.js:64 do, before auth and before any work.
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  if (req.headers.authorization !== `Bearer ${AUTH}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const type = req.query.type || 'grants';

  // ── GRANTS SWEEP ──
  if (type === 'grants') {
    const summary = await callGroq(
      `${AGENTS.FIFTY}\n\n${SQUAD_FACTS}`,
      `Task: produce structured, actionable grant intelligence for CannaLens — a Syracuse NY cannabis information platform, NOT a retailer. Be direct, prioritize by fit, surface immediate action items.\n\nMonthly Grant Intelligence Sweep — CannaLens\n\nFunding opportunities identified:\n${GRANTS.map((g,i) => `${i+1}. ${g.name} | ${g.type} | ${g.amount} | Fit: ${g.fit} | Deadline: ${g.deadline}`).join('\n')}\n\nGenerate a prioritized action brief: which 3 should be pursued immediately and why. Include any risks or disqualifiers. Keep it under 500 words.`
    );

    await supabase.from('episodic_log').insert({
      agent: 'FIFTY',
      event_type: 'grant_sweep',
      payload: { grants: GRANTS, summary, swept_at: new Date().toISOString() }
    }).catch(() => {});

    return res.status(200).json({
      agent: 'FIFTY',
      report_type: 'grant_intelligence',
      swept_at: new Date().toISOString(),
      total_opportunities: GRANTS.length,
      grants: GRANTS,
      brief: summary
    });
  }

  // ── RISK MATRIX ──
  if (type === 'risk') {
    // Was agent 'ARBITER' - a callsign in no roster and not in the v2->v3 mapping, invented
    // inline here and written straight into episodic_log.agent. Reassigned to TOMMY: the CISO
    // seat is the only one whose whole remit is risk (operational risk, threat-model passes,
    // worst-case-first), which is what a four-dimension risk matrix is. Note CANE owns the
    // regulatory dimension specifically - if this brief ever narrows to compliance alone,
    // that is the seat to move it to.
    const assessment = await callGroq(
      `${AGENTS.TOMMY}\n\n${SQUAD_FACTS}`,
      `Task: assess risk across regulatory, financial, reputational, and operational dimensions for Squad Deep / CannaLens. Be thorough and conservative; protect the platform's long-term viability.\n\nGenerate a CannaLens Risk Assessment Summary.\n\nMatrix:\n${JSON.stringify(RISK_MATRIX, null, 2)}\n\nProduce a 1-page executive risk summary covering: overall risk rating, top 3 risks to address, compliance status, and underwriting recommendation. Format for non-technical stakeholders (investors, grant reviewers).`
    );

    await supabase.from('episodic_log').insert({
      agent: 'TOMMY',
      event_type: 'risk_assessment',
      payload: { matrix: RISK_MATRIX, assessment, assessed_at: new Date().toISOString() }
    }).catch(() => {});

    return res.status(200).json({
      agent: 'TOMMY',
      report_type: 'risk_assessment',
      assessed_at: new Date().toISOString(),
      risk_matrix: RISK_MATRIX,
      assessment
    });
  }

  // ── INVESTOR INTEL ──
  if (type === 'investors') {
    // "Platform: 65+ strains" was invented here - the real catalog is 40 (SQUAD_FACTS).
    // Inflating traction in a brief written FOR INVESTORS is the worst place in this stack
    // to launder a number, so the profile now defers to SQUAD_FACTS rather than restating it.
    const brief = await callGroq(
      `${AGENTS.FIFTY}\n\n${SQUAD_FACTS}`,
      `Task: identify strategic investor opportunities for CannaLens — a BIPOC-founded cannabis information platform from Syracuse NY. Focus on investors who value equity, community impact, and AI-driven platforms.\n\nInvestor Intelligence Brief — CannaLens\n\nCannaLens profile (use ONLY the verified facts above for any product or traction figure):\n- Founded in Syracuse NY by a BIPOC entrepreneur\n- Cannabis information + discovery PWA (NOT a retailer)\n- Revenue model: subscription, affiliate, partner listings\n- Markets: NY adult-use cannabis, expanding nationally\n- Stage: Pre-seed / Seed-A\n\nIdentify and describe 8 ideal investor profiles: angel networks, seed funds, cannabis tech VCs, BIPOC-focused funds, NY-based impact investors, and strategic corporate investors. For each, include: investor type, typical check size, why they fit CannaLens, and approach strategy. Do NOT include company names you cannot verify — describe investor profiles and known public programs only. Do NOT inflate traction: state it as it is.`
    );

    return res.status(200).json({
      agent: 'FIFTY',
      report_type: 'investor_intelligence',
      generated_at: new Date().toISOString(),
      brief
    });
  }

  // ── MARKET INTEL ──
  if (type === 'intel') {
    // "18 on CannaLens map" was invented - the map renders 14 (SQUAD_FACTS), and the same
    // line's "14+ on Weedmaps" is an unsourced third-party count. Our own number now comes
    // from SQUAD_FACTS; the external market figures are left but explicitly marked unverified
    // so the model does not present them as ours. They are dated mid-2026 and should be
    // re-sourced before this brief is shown to anyone outside.
    const intel = await callGroq(
      `${AGENTS.FIFTY}\n\n${SQUAD_FACTS}`,
      `Task: generate a market intelligence brief for CannaLens covering the NY cannabis market, Onondaga County developments, and platform growth signals.\n\nCannaLens Market Intelligence\n\nFor anything about OUR platform (catalog size, dispensary count, users, revenue), use ONLY the verified facts above.\n\nExternal market data points — UNVERIFIED, treat as approximate and attribute as third-party, never as our own figures:\n- NY adult-use cannabis sales: $1.5B+ since launch\n- Onondaga County tax revenue from cannabis: $3.2M in 2025\n- BIPOC-owned dispensaries in Syracuse: 3 (Diamond Tree, Loudpack Exotics, The Higher Company)\n- OCM expanded license cap for upstate NY: +30% approved\n- Consumption lounges now legal in NY (April 2026)\n- CGRF community reinvestment fund: $5M–$15M available\n\nGenerate a 1-page market intelligence brief covering: market size signal, competitive positioning, 3 growth opportunities for CannaLens, and 2 threats to monitor. Keep it sharp and data-driven. Flag any figure you are relying on that you cannot verify.`
    );

    return res.status(200).json({
      agent: 'FIFTY',
      report_type: 'market_intelligence',
      generated_at: new Date().toISOString(),
      brief: intel
    });
  }

  return res.status(400).json({ error: 'Unknown type. Use: grants | risk | investors | intel' });
}

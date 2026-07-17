// lib/agents.js — the Squad Deep roster. ONE definition, imported everywhere.
//
// Until 2026-07-16 this list existed twice: once in api/cron.js and once in api/groq.js, with
// drifting text (cron's WARDEN said "Solo operator Teh runs this stack", groq's did not; groq's
// SMITH said "Always provide working code", cron's did not). Two rosters means two answers to
// "who is FORGE", and neither is authoritative. Same failure mode as the two SquadDeep.ps1 copies
// and the two c4-orchestrator codebases: a fork nobody chose, that quietly wins by being the one
// that ran. Import from here; do not re-declare.
//
// STACK FACTS live here too, for the same reason. They were hardcoded into three prompts and were
// wrong in all of them: cron.js told Groq "CannaLens (LIVE, cannalens.netlify.app)" (it is a
// Cloudflare Worker), report.js primed both daily briefs with the same dead host, and groq.js
// asserted "64 strains, 19 dispensaries" (actually 40 and 14). Those outputs are written straight
// back into episodic_log as agent analysis, so a wrong fact about our own stack laundered itself
// into the record every cycle. If a number here changes, change it HERE and nowhere else — and
// only after checking it against the live thing. See lessons.md L10 and L12.

export const AGENTS = {
  // ── Bus ───────────────────────────────────────────────────────────────────
  WARDEN:     'You are WARDEN, C4 bus orchestrator for Squad Deep. You coordinate agents and maintain operational status. Solo operator Teh runs this stack.',

  // ── Council (13 seats) ────────────────────────────────────────────────────
  SOVEREIGN:  'You are SOVEREIGN, the strategic seat and CEO on the Squad Deep Council. You make high-level business decisions for CannaLens and Atlas IPTV, and you issue council rulings.',
  STEWARD:    'You are STEWARD, the chief-of-staff seat. You optimize workflows, reduce friction, and maintain system health.',
  ORACLE:     'You are ORACLE, the strategy seat. You synthesize signals into strategic foresight and market intelligence.',
  FORGE:      'You are FORGE, the CTO seat. You design technical systems, APIs, and infrastructure for Squad Deep projects.',
  BEACON:     'You are BEACON, the product/content seat. You drive editorial and product content plans for CannaLens.',
  HELM:       'You are HELM, the COO seat. You define roadmaps, features, and user experience priorities.',
  LEDGER:     'You are LEDGER, the finance seat. You track costs, token budgets, and ROI across the Squad Deep zero-budget stack. Flag any budget risk immediately.',
  RAINMAKER:  'You are RAINMAKER, the revenue seat. You identify monetization opportunities, partnership structures, and growth levers for CannaLens.',
  HERALD:     'You are HERALD, the communications seat. You write marketing copy, outreach, and messaging for CannaLens dispensary prospects.',
  DRAGNET:    'You are DRAGNET, the data seat. You design data pipelines, scraping strategies, and structured datasets for CannaLens.',
  AEGIS:      'You are AEGIS, the security seat. You audit systems for vulnerabilities, rate-limit issues, and operational risks.',
  GAVEL:      'You are GAVEL, the legal/compliance seat. You flag regulatory risks, especially NY cannabis law for CannaLens.',
  ANCHOR:     'You are ANCHOR, the customer-success seat. You prevent scope creep, ensure reliability, and keep the team focused.',

  // ── Tactical ──────────────────────────────────────────────────────────────
  PATHFINDER: 'You are PATHFINDER, the planning and discovery lead. You find tools, APIs, partners, and opportunities for Squad Deep.',
  SMITH:      'You are SMITH, the code agent. You write clean, production-ready JavaScript, Python, and PowerShell. Always provide working code.',
  SENTINEL:   'You are SENTINEL, the critic agent. You review outputs and flag issues. Apply the Iron Wall protocol ruthlessly.',
  SCOUT:      'You are SCOUT, the research agent. You gather market intelligence, competitor data, and user insights.',
  VANGUARD:   'You are VANGUARD, the deployment agent. You handle Vercel, Cloudflare Workers, and CI/CD strategy.',
  MNEMO:      'You are MNEMO, the memory agent. You log key decisions, context updates, and session summaries for Squad Deep continuity.',
};

export const CALLSIGNS = Object.keys(AGENTS);

export const DEFAULT_CALLSIGN = 'WARDEN';

/** True only for a real callsign. Case-insensitive. */
export function isCallsign(x) {
  return typeof x === 'string' && Object.prototype.hasOwnProperty.call(AGENTS, x.toUpperCase());
}

/**
 * Resolve a callsign to { callsign, persona, fellBack }.
 *
 * `fellBack` is deliberately returned rather than swallowed. The old code was
 * `AGENTS[h.agent] || AGENTS.WARDEN` — an unknown or missing agent silently became WARDEN, which is
 * exactly how every handoff ran as WARDEN for months without anyone noticing. A fallback you cannot
 * see is a bug you cannot find (lessons.md L11). Callers should log when fellBack is true.
 */
export function resolveAgent(x) {
  const key = typeof x === 'string' ? x.toUpperCase() : '';
  if (Object.prototype.hasOwnProperty.call(AGENTS, key)) {
    return { callsign: key, persona: AGENTS[key], fellBack: false };
  }
  return {
    callsign: DEFAULT_CALLSIGN,
    persona: AGENTS[DEFAULT_CALLSIGN],
    fellBack: true,
    requested: x ?? null,
  };
}

/**
 * Single source of truth for what is true about this stack. Verified 2026-07-16 against the live
 * Worker (/api/dispensaries returned 14; the catalog holds 40 strains) and the live D1.
 * Do not restate these facts in a prompt string anywhere else.
 */
export const SQUAD_FACTS = [
  'Squad Deep stack, verified 2026-07-16:',
  '- C4 Orchestrator: LIVE on Vercel (c4-orchestrator.vercel.app), Supabase + Groq behind it.',
  '- CannaLens: LIVE on Cloudflare Workers (cannalens.gqtmvjcymc-280.workers.dev), backed by D1.',
  '  Marketing is served at /, the app at /app. It has NEVER run on Netlify or Vercel.',
  '- Catalog: 40 strains. Map: 14 real OCM-licensed Onondaga County dispensaries.',
  '- Traction, honestly: 2 registered users, 0 budtender chats, 0 demand signals, 0 revenue.',
  '  One IG DM to The Higher Company on 2026-07-12, no reply. No partners. No paying customers.',
  '- Operator: Teh, solo founder, Syracuse NY, zero-budget stack.',
  'Do not invent traction, partners, ratings, or user counts. If you do not know, say so.',
].join('\n');

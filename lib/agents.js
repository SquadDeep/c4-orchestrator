// lib/agents.js — the Squad Deep roster. ONE definition, imported everywhere.
//
// 2026-07-17: callsigns reverted to the character names by Teh's call.
//   Tactical squad -> House of Lies.  Council -> Power.  Bus: WARDEN -> FIFTY.
//   PATHFINDER->MARTY, SMITH->CLYDE, SENTINEL->JEANNIE, SCOUT->DOUG, VANGUARD->MONICA,
//   MNEMO->CAITLIN, SOVEREIGN->GHOST, STEWARD->RAYRAY, ORACLE->KANAN, FORGE->JULIO,
//   BEACON->SIMON, HELM->DRE, LEDGER->TASHA, RAINMAKER->LOBOS, HERALD->TARIQ,
//   DRAGNET->SAXE, AEGIS->TOMMY, GAVEL->DAVIS, ANCHOR->MONET, WARDEN->FIFTY.
//   This reverses AGENT_PROTOCOL v2 (2026-07-16). 06_Archive/ and dated logs keep whatever
//   they had — rewriting a log rewrites history.
//
//   Note for whoever renames these next: the functional names were ordinary English words and
//   the character names are not. That is a feature here. "LEDGER" collided with the budget
//   ledger, the ledger-routing dashboard, ledgerTick() and a <button data-tab="ledger">LEDGER
//   </button> tab — 103 of its 154 occurrences were not the callsign at all. "ANCHOR" collided
//   with HTML anchors, "SCOUT"/"FORGE"/"BEACON" with plain prose. TASHA collides with nothing.
//   If you ever go back to functional names, rename by meaning, not with find/replace.
//
// Until 2026-07-16 this list existed twice: once in api/cron.js and once in api/groq.js, with
// drifting text (cron's bus persona said "Solo operator Teh runs this stack", groq's did not;
// groq's coder said "Always provide working code", cron's did not). Two rosters means two answers
// to "who is JULIO", and neither is authoritative. Same failure mode as the two SquadDeep.ps1
// copies and the two c4-orchestrator codebases: a fork nobody chose, that quietly wins by being
// the one that ran. Import from here; do not re-declare.
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
  FIFTY:      'You are FIFTY, C4 bus orchestrator for Squad Deep. You coordinate agents and maintain operational status. Solo operator Teh runs this stack.',

  // ── Council (13 seats) — Power ────────────────────────────────────────────
  GHOST:      'You are GHOST, the strategic seat and CEO on the Squad Deep Council. You make high-level business decisions for CannaLens and Atlas IPTV, and you issue council rulings.',
  RAYRAY:     'You are RAYRAY, the chief-of-staff seat. You optimize workflows, reduce friction, and maintain system health.',
  KANAN:      'You are KANAN, the strategy seat. You synthesize signals into strategic foresight and market intelligence.',
  JULIO:      'You are JULIO, the CTO seat. You design technical systems, APIs, and infrastructure for Squad Deep projects.',
  SIMON:      'You are SIMON, the product/content seat. You drive editorial and product content plans for CannaLens.',
  DRE:        'You are DRE, the COO seat. You define roadmaps, features, and user experience priorities.',
  TASHA:      'You are TASHA, the finance seat. You track costs, token budgets, and ROI across the Squad Deep zero-budget stack. Flag any budget risk immediately.',
  LOBOS:      'You are LOBOS, the revenue seat. You identify monetization opportunities, partnership structures, and growth levers for CannaLens.',
  TARIQ:      'You are TARIQ, the communications seat. You write marketing copy, outreach, and messaging for CannaLens dispensary prospects.',
  SAXE:       'You are SAXE, the data seat. You design data pipelines, scraping strategies, and structured datasets for CannaLens.',
  TOMMY:      'You are TOMMY, the security seat. You audit systems for vulnerabilities, rate-limit issues, and operational risks.',
  DAVIS:      'You are DAVIS, the legal/compliance seat. You flag regulatory risks, especially NY cannabis law for CannaLens.',
  MONET:      'You are MONET, the customer-success seat. You prevent scope creep, ensure reliability, and keep the team focused.',

  // ── Tactical squad (6) — House of Lies ────────────────────────────────────
  MARTY:      'You are MARTY, the planning and discovery lead. You find tools, APIs, partners, and opportunities for Squad Deep.',
  CLYDE:      'You are CLYDE, the code agent. You write clean, production-ready JavaScript, Python, and PowerShell. Always provide working code.',
  JEANNIE:    'You are JEANNIE, the critic agent. You review outputs and flag issues. Apply the Iron Wall protocol ruthlessly.',
  DOUG:       'You are DOUG, the research agent. You gather market intelligence, competitor data, and user insights.',
  MONICA:     'You are MONICA, the deployment agent. You handle Vercel, Cloudflare Workers, and CI/CD strategy.',
  CAITLIN:    'You are CAITLIN, the memory agent. You log key decisions, context updates, and session summaries for Squad Deep continuity.',
};

export const CALLSIGNS = Object.keys(AGENTS);

export const DEFAULT_CALLSIGN = 'FIFTY';

/** True only for a real callsign. Case-insensitive. */
export function isCallsign(x) {
  return typeof x === 'string' && Object.prototype.hasOwnProperty.call(AGENTS, x.toUpperCase());
}

/**
 * Resolve a callsign to { callsign, persona, fellBack }.
 *
 * `fellBack` is deliberately returned rather than swallowed. The old code was
 * `AGENTS[h.agent] || AGENTS.WARDEN` — an unknown or missing agent silently became the bus agent,
 * which is exactly how every handoff ran as WARDEN for months without anyone noticing. A fallback
 * you cannot see is a bug you cannot find (lessons.md L11). Callers should log when fellBack is true.
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

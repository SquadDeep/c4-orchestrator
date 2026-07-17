-- ============================================================================
--  Migration: handoffs.agent
--  Run in the Supabase SQL editor for project cvwhbveqpfarqmfuqska.
--  Safe: additive, nullable, no data rewritten, no rows touched. Re-runnable.
-- ============================================================================
--
--  WHY
--  cron.js has always read `h.agent` to pick which of the 20 personas executes a
--  handoff (`AGENTS[h.agent] || AGENTS.WARDEN`). The column has never existed, so
--  h.agent was permanently undefined and EVERY handoff has executed as WARDEN
--  since inception. The 20-agent roster is decorative: one agent wearing twenty
--  name tags. The `agent` field on episodic_log rows written by the cron is empty
--  for the same reason - see the row for handoff_id=21.
--
--  This adds the column the code always assumed it had. It is the same missing
--  column that made /api/handoff POST 500 for three days ("Could not find the
--  'agent' column of 'handoffs' in the schema cache") - the route was reverted to
--  match the DB then. This migration closes the gap from the other side, so the
--  roster can be real rather than removed.
--
--  ORDER OF OPERATIONS - IMPORTANT
--  Run this BEFORE deploying the route/cron changes that write `agent`. Deploying
--  code that inserts a column the DB lacks is precisely the failure this session
--  started with (lessons.md L13). Verify with the SELECT at the bottom first.
-- ============================================================================

alter table public.handoffs
  add column if not exists agent text;

comment on column public.handoffs.agent is
  'Squad Deep callsign that should execute this handoff (WARDEN, FORGE, SCOUT, SENTINEL, ...). NULL means WARDEN. Added 2026-07-16: cron.js read this since inception but the column never existed, so every handoff ran as WARDEN.';

-- Only these callsigns route to a real persona. Anything else would silently fall
-- back to WARDEN, which is how the roster became decorative in the first place -
-- so make a bad value a loud failure at write time instead.
alter table public.handoffs
  drop constraint if exists handoffs_agent_valid;

alter table public.handoffs
  add constraint handoffs_agent_valid check (
    agent is null or agent in (
      'WARDEN','SOVEREIGN','STEWARD','ORACLE','FORGE','BEACON','HELM','LEDGER',
      'RAINMAKER','HERALD','DRAGNET','AEGIS','GAVEL','ANCHOR','PATHFINDER',
      'SMITH','SENTINEL','SCOUT','VANGUARD','MNEMO'
    )
  );

-- The cron only ever selects status='open'. Rows created by ingest.js / recon.js
-- omit status entirely and therefore inherit the column default. If that default
-- is 'pending', those handoffs are invisible to the cron forever. Check it:
--   select column_default from information_schema.columns
--    where table_name='handoffs' and column_name='status';
-- Left alone here deliberately - changing a default is a behaviour change, not a
-- migration, and /api/context already matches pending+open+claimed+in_progress.

create index if not exists idx_handoffs_agent_status
  on public.handoffs (agent, status);

-- ── verify ──────────────────────────────────────────────────────────────────
-- Expect: agent | text | YES
select column_name, data_type, is_nullable
from information_schema.columns
where table_name = 'handoffs' and column_name = 'agent';

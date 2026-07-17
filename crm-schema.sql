-- ════════════════════════════════════════════════════════════════════
-- CRM schema for the C4 Orchestrator
-- Supabase project: cvwhbveqpfarqmfuqska  (C4)
-- Paste into Supabase -> SQL Editor -> Run.  Idempotent: safe to re-run.
-- RLS is intentionally left OFF; access is gated by the /api/crm Bearer
-- token (the service_role key bypasses RLS anyway).
-- ════════════════════════════════════════════════════════════════════

-- ── companies ───────────────────────────────────────────────────────
create table if not exists crm_companies (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  domain      text,
  industry    text,
  website     text,
  notes       text,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

-- ── contacts ────────────────────────────────────────────────────────
create table if not exists crm_contacts (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  email             text,
  phone             text,
  title             text,
  company_id        uuid references crm_companies(id) on delete set null,
  company           text,                       -- denormalized for quick display
  tags              text[] default '{}',
  status            text default 'lead',         -- lead | active | customer | cold
  notes             text,
  last_contacted_at timestamptz,
  created_at        timestamptz default now(),
  updated_at        timestamptz default now()
);

-- ── deals (the pipeline) ─────────────────────────────────────────────
create table if not exists crm_deals (
  id             uuid primary key default gen_random_uuid(),
  title          text not null,
  contact_id     uuid references crm_contacts(id) on delete set null,
  company_id     uuid references crm_companies(id) on delete set null,
  contact        text,                            -- denormalized
  stage          text default 'new',              -- new | qualified | proposal | negotiation | won | lost
  value          numeric default 0,
  currency       text default 'USD',
  probability    int default 10,                  -- 0..100
  owner          text,                            -- agent callsign or 'Teh'
  expected_close date,
  notes          text,
  created_at     timestamptz default now(),
  updated_at     timestamptz default now()
);

-- ── activities (calls / emails / notes / tasks) ─────────────────────
create table if not exists crm_activities (
  id          uuid primary key default gen_random_uuid(),
  type        text default 'note',                -- note | call | email | meeting | task
  subject     text,
  body        text,
  contact_id  uuid references crm_contacts(id) on delete cascade,
  deal_id     uuid references crm_deals(id) on delete cascade,
  contact     text,                               -- denormalized
  direction   text,                               -- in | out
  agent       text,
  done        boolean default false,
  due_at      timestamptz,
  created_at  timestamptz default now()
);

-- ── updated_at touch trigger ─────────────────────────────────────────
create or replace function crm_touch() returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

drop trigger if exists t_crm_companies on crm_companies;
create trigger t_crm_companies before update on crm_companies
  for each row execute function crm_touch();

drop trigger if exists t_crm_contacts on crm_contacts;
create trigger t_crm_contacts before update on crm_contacts
  for each row execute function crm_touch();

drop trigger if exists t_crm_deals on crm_deals;
create trigger t_crm_deals before update on crm_deals
  for each row execute function crm_touch();

-- ── indexes ──────────────────────────────────────────────────────────
create index if not exists idx_crm_contacts_email   on crm_contacts(email);
create index if not exists idx_crm_contacts_status   on crm_contacts(status);
create index if not exists idx_crm_deals_stage       on crm_deals(stage);
create index if not exists idx_crm_activities_contact on crm_activities(contact_id);
create index if not exists idx_crm_activities_deal    on crm_activities(deal_id);

-- ── seed: a couple of rows so the board isn't empty on first load ────
insert into crm_companies (name, industry, website)
  select 'Squad Deep', 'AI / Ops', 'https://cannalens.netlify.app'
  where not exists (select 1 from crm_companies);

insert into crm_deals (title, stage, value, probability, owner)
  select 'CannaLens — first dispensary partner', 'qualified', 5000, 40, 'RAINMAKER'
  where not exists (select 1 from crm_deals);

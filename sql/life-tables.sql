-- Squad Life tables (Mobile Command Center: tasks + calendar)
-- Run once in Supabase SQL Editor -> C4 project (cvwhbveqpfarqmfuqska).
-- Served by /api/crm?resource=tasks and /api/crm?resource=events.

create table if not exists life_tasks (
  id           uuid primary key default gen_random_uuid(),
  title        text not null,
  notes        text,
  due_date     date,
  priority     text default 'normal',   -- low | normal | high
  status       text default 'open',     -- open | done
  completed_at timestamptz,
  created_at   timestamptz default now()
);

create table if not exists life_events (
  id         uuid primary key default gen_random_uuid(),
  title      text not null,
  notes      text,
  starts_at  timestamptz not null,
  ends_at    timestamptz,
  all_day    boolean default false,
  location   text,
  created_at timestamptz default now()
);

create index if not exists life_tasks_status_idx  on life_tasks (status, due_date);
create index if not exists life_events_starts_idx on life_events (starts_at);

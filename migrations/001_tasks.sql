-- Deferred tasks: one row per "ping me when X" the agent is tracking.
-- The dispatcher in tasks.py polls this table on a tick.
--
--   psql "$DATABASE_URL" -f migrations/001_tasks.sql
--
-- (Or use docker-compose, which mounts this file into the postgres
-- init dir so it runs on first container boot.)

create extension if not exists "pgcrypto";

create table if not exists tasks (
    id                  uuid primary key default gen_random_uuid(),
    tenant_id           text not null,
    user_id             text not null,
    channel             text not null,
    title               text not null,
    check_prompt        text not null,
    next_run_at         timestamptz not null,
    expires_at          timestamptz not null,
    status              text not null default 'pending'
        check (status in ('pending', 'fired', 'expired', 'cancelled', 'failed')),
    consecutive_errors  int not null default 0,
    last_checked_at     timestamptz,
    last_reason         text,
    fired_at            timestamptz,
    created_at          timestamptz not null default now()
);

create index if not exists tasks_due_idx
    on tasks (status, next_run_at) where status = 'pending';

create index if not exists tasks_user_idx
    on tasks (tenant_id, user_id, status);

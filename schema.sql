-- Run once in Supabase: SQL Editor > New query > paste > Run.
-- The app uses the service key on the server only. Row Level Security is switched on
-- with no policies, so the public (anon) key cannot read or write anything.
create table if not exists public.users    (id text primary key, data jsonb not null, created_at timestamptz default now());
create table if not exists public.orders   (id text primary key, data jsonb not null, created_at timestamptz default now());
create table if not exists public.payments (id text primary key, data jsonb not null, created_at timestamptz default now());
create table if not exists public.audit    (id text primary key, data jsonb not null, created_at timestamptz default now());
create table if not exists public.settings (id text primary key, data jsonb not null, created_at timestamptz default now());
create table if not exists public.images   (id text primary key, data jsonb not null, created_at timestamptz default now());
alter table public.users    enable row level security;
alter table public.orders   enable row level security;
alter table public.payments enable row level security;
alter table public.audit    enable row level security;
alter table public.settings enable row level security;
alter table public.images   enable row level security;

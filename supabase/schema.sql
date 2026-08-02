create table if not exists public.trello_connections (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  organization_id text not null,
  encrypted_api_key text not null,
  encrypted_token text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, organization_id)
);

-- Migration for installations created with the former Supabase-auth schema.
alter table public.trello_connections drop constraint if exists trello_connections_user_id_fkey;
alter table public.trello_connections alter column user_id type text using user_id::text;

-- Firebase authenticates requests; the Edge Function uses the service role and
-- always scopes reads/writes by the verified Firebase user_id.
alter table public.trello_connections disable row level security;

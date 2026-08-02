create table if not exists public.trello_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  organization_id text not null,
  encrypted_api_key text not null,
  encrypted_token text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, organization_id)
);

alter table public.trello_connections enable row level security;

create policy "Users can read their own Trello connections"
  on public.trello_connections for select using (auth.uid() = user_id);
create policy "Users can delete their own Trello connections"
  on public.trello_connections for delete using (auth.uid() = user_id);

revoke all on public.trello_connections from anon, authenticated;
grant select, delete on public.trello_connections to authenticated;

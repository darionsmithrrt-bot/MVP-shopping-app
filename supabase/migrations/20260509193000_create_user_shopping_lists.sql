create table if not exists public.user_shopping_lists (
  id uuid primary key default gen_random_uuid(),
  user_profile_id uuid not null references public.profiles(id) on delete cascade,
  list_name text not null default 'My Shopping List',
  list_items jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_profile_id, list_name)
);

alter table public.user_shopping_lists enable row level security;

drop policy if exists "Users can read own shopping lists" on public.user_shopping_lists;
create policy "Users can read own shopping lists"
on public.user_shopping_lists
for select
to authenticated
using (auth.uid() = user_profile_id);

drop policy if exists "Users can insert own shopping lists" on public.user_shopping_lists;
create policy "Users can insert own shopping lists"
on public.user_shopping_lists
for insert
to authenticated
with check (auth.uid() = user_profile_id);

drop policy if exists "Users can update own shopping lists" on public.user_shopping_lists;
create policy "Users can update own shopping lists"
on public.user_shopping_lists
for update
to authenticated
using (auth.uid() = user_profile_id)
with check (auth.uid() = user_profile_id);

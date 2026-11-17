-- MINATOHOST BOT - complete schema for a fresh Supabase project.
-- Run in Supabase SQL Editor. For a database created with the earlier
-- MINATOHOST setup, run supabase/migrate_from_previous.sql instead.

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now()
);

create table if not exists public.bot_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  bot_name text not null default 'MINATOHOST',
  bot_enabled boolean not null default false,
  anti_link boolean not null default false,
  welcome boolean not null default false,
  goodbye boolean not null default false,
  command_prefix text not null default '.',
  updated_at timestamptz not null default now(),
  constraint bot_settings_prefix_length check (char_length(command_prefix) between 1 and 3)
);

create table if not exists public.bot_sessions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  phone text,
  status text not null default 'disconnected'
    check (status in ('disconnected','connecting','waiting_qr','connected','error')),
  updated_at timestamptz not null default now()
);

create table if not exists public.group_settings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  group_jid text not null,
  anti_link_enabled boolean not null default false,
  welcome_enabled boolean not null default false,
  goodbye_enabled boolean not null default false,
  updated_at timestamptz not null default now(),
  unique (user_id, group_jid)
);

create table if not exists public.bot_logs (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  event text not null default 'activity',
  level text not null default 'info' check (level in ('info','warning','error')),
  message text not null,
  created_at timestamptz not null default now()
);

create index if not exists bot_logs_user_created_idx
  on public.bot_logs(user_id, created_at desc);
create index if not exists group_settings_user_idx
  on public.group_settings(user_id);

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists bot_settings_set_updated_at on public.bot_settings;
create trigger bot_settings_set_updated_at before update on public.bot_settings
for each row execute function public.set_updated_at();

drop trigger if exists bot_sessions_set_updated_at on public.bot_sessions;
create trigger bot_sessions_set_updated_at before update on public.bot_sessions
for each row execute function public.set_updated_at();

drop trigger if exists group_settings_set_updated_at on public.group_settings;
create trigger group_settings_set_updated_at before update on public.group_settings
for each row execute function public.set_updated_at();

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.profiles(user_id, display_name)
  values(new.id, coalesce(new.raw_user_meta_data ->> 'display_name',''));
  insert into public.bot_settings(user_id) values(new.id);
  insert into public.bot_sessions(user_id) values(new.id);
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
for each row execute procedure public.handle_new_user();

alter table public.profiles enable row level security;
alter table public.bot_settings enable row level security;
alter table public.bot_sessions enable row level security;
alter table public.group_settings enable row level security;
alter table public.bot_logs enable row level security;

drop policy if exists "profile_select_own" on public.profiles;
create policy "profile_select_own" on public.profiles
for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists "profile_update_own" on public.profiles;
create policy "profile_update_own" on public.profiles
for update to authenticated using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

drop policy if exists "settings_select_own" on public.bot_settings;
create policy "settings_select_own" on public.bot_settings
for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists "settings_update_own" on public.bot_settings;
create policy "settings_update_own" on public.bot_settings
for update to authenticated using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

drop policy if exists "sessions_select_own" on public.bot_sessions;
create policy "sessions_select_own" on public.bot_sessions
for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists "groups_select_own" on public.group_settings;
create policy "groups_select_own" on public.group_settings
for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists "groups_insert_own" on public.group_settings;
create policy "groups_insert_own" on public.group_settings
for insert to authenticated with check (user_id = (select auth.uid()));
drop policy if exists "groups_update_own" on public.group_settings;
create policy "groups_update_own" on public.group_settings
for update to authenticated using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));
drop policy if exists "groups_delete_own" on public.group_settings;
create policy "groups_delete_own" on public.group_settings
for delete to authenticated using (user_id = (select auth.uid()));

drop policy if exists "logs_select_own" on public.bot_logs;
create policy "logs_select_own" on public.bot_logs
for select to authenticated using (user_id = (select auth.uid()));

-- Only the trusted worker uses the service-role key to write sessions/logs.
-- Never expose that key in config.js or browser code.

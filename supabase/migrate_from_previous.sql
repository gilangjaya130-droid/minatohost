-- MINATOHOST BOT: migrate the database created by the earlier SQL script.
-- Run once in Supabase SQL Editor. Safe to re-run.

alter table public.bot_settings
  add column if not exists bot_enabled boolean not null default false,
  add column if not exists anti_link boolean not null default false,
  add column if not exists welcome boolean not null default false,
  add column if not exists goodbye boolean not null default false;

alter table public.bot_sessions
  add column if not exists phone text;

-- Worker uses waiting_qr while a QR is waiting to be scanned.
do $$
declare c record;
begin
  for c in
    select conname
    from pg_constraint
    where conrelid = 'public.bot_sessions'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%status%'
  loop
    execute format('alter table public.bot_sessions drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.bot_sessions
  add constraint bot_sessions_status_check
  check (status in ('disconnected','connecting','waiting_qr','connected','error'));

-- Worker writes an event label with each log row.
alter table public.bot_logs
  add column if not exists event text not null default 'activity';

-- Ensure the default settings rows and profile are created for new signups.
create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.profiles(user_id, display_name)
  values(new.id, coalesce(new.raw_user_meta_data ->> 'display_name',''));
  insert into public.bot_settings(user_id) values(new.id)
  on conflict (user_id) do nothing;
  insert into public.bot_sessions(user_id) values(new.id)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
for each row execute procedure public.handle_new_user();

alter table public.profiles enable row level security;
drop policy if exists "profile_select_own" on public.profiles;
create policy "profile_select_own" on public.profiles
for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists "profile_update_own" on public.profiles;
create policy "profile_update_own" on public.profiles
for update to authenticated using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

-- Keep logs and sessions private to each account. The worker's service-role
-- key bypasses RLS, but it must remain only in the worker's private environment.

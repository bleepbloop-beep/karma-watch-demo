-- Karma Watch schema. Every table is owner-scoped with row level security.

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  plan text not null default 'free',
  created_at timestamptz not null default now()
);

create table public.monitors (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  name text not null,
  type text not null default 'keyword' check (type in ('keyword', 'industry', 'competitor')),
  industry text not null default 'energy',
  keywords text[] not null default '{}',
  subreddits text[] not null default '{}',
  search_mode boolean not null default false,
  active boolean not null default true,
  email_alerts boolean not null default false,
  last_scanned_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.threads (
  id uuid primary key default gen_random_uuid(),
  monitor_id uuid not null references public.monitors (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  reddit_id text not null,
  subreddit text not null,
  title text not null,
  body text,
  url text not null,
  author text,
  upvotes integer not null default 0,
  num_comments integer not null default 0,
  matched_keyword text,
  intent text not null default 'unclassified' check (intent in
    ('question', 'pain_point', 'buying_signal', 'comparison', 'informational', 'other', 'unclassified')),
  customer_intent text,
  recommended_action text,
  brand_tolerance text,
  geo_location text,
  us_state text,
  country text,
  energy_market text,
  commodity text,
  status text not null default 'new' check (status in ('new', 'read', 'actioned', 'dismissed')),
  alerted boolean not null default false,
  created_utc timestamptz,
  detected_at timestamptz not null default now(),
  unique (monitor_id, reddit_id) -- re-scans never create duplicates
);

create table public.alert_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  thread_id uuid not null references public.threads (id) on delete cascade,
  channel text not null default 'email',
  status text not null default 'pending',
  created_at timestamptz not null default now()
);

create index monitors_user_idx on public.monitors (user_id);
create index monitors_active_idx on public.monitors (active) where active;
create index threads_user_idx on public.threads (user_id, detected_at desc);
create index threads_monitor_idx on public.threads (monitor_id);
create index threads_action_idx on public.threads (user_id, recommended_action);
create index threads_state_idx on public.threads (user_id, us_state);
create index threads_commodity_idx on public.threads (user_id, commodity);
create index threads_country_idx on public.threads (user_id, country);

alter table public.profiles enable row level security;
alter table public.monitors enable row level security;
alter table public.threads enable row level security;
alter table public.alert_log enable row level security;

-- Signed-out visitors get nothing. Signed-in users get only what the UI needs.
revoke all on public.profiles, public.monitors, public.threads, public.alert_log from anon, authenticated;
grant select on public.profiles, public.threads, public.alert_log to authenticated;
grant select, delete on public.monitors to authenticated;
grant insert (user_id, name, type, industry, keywords, subreddits, email_alerts) on public.monitors to authenticated;
grant update (name, type, industry, keywords, subreddits, active, email_alerts) on public.monitors to authenticated;
grant update (status) on public.threads to authenticated;

create policy "own profile" on public.profiles for select to authenticated using (auth.uid() = id);
create policy "own monitors" on public.monitors for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "select own threads" on public.threads for select to authenticated using (auth.uid() = user_id);
create policy "update own threads" on public.threads for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own alerts" on public.alert_log for select to authenticated using (auth.uid() = user_id);

-- Creates a profile for each new account.
create function public.handle_new_user() returns trigger
  language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email);
  return new;
end;
$$;
revoke execute on function public.handle_new_user() from public, anon, authenticated;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

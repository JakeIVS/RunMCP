-- RunMCP canonical storage. Configure Supabase third-party auth to validate the
-- Clerk JWT issuer/JWKS, and issue a role=authenticated claim before applying.
create table if not exists public.profiles (
  user_id text primary key,
  display_name text,
  training_intensity text not null default 'balanced' check (training_intensity in ('conservative','balanced','ambitious')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists public.goals (
  id text primary key, user_id text not null references public.profiles(user_id) on delete cascade,
  name text not null, distance text not null, custom_distance numeric, unit text not null,
  target_date date not null, target_pace text, active boolean not null default true, created_at timestamptz not null default now()
);
create table if not exists public.training_plans (
  user_id text primary key references public.profiles(user_id) on delete cascade,
  id text not null default 'current', generated_at timestamptz not null default now(), version integer not null default 0,
  revision_reason text, revision_rationale text
);
create table if not exists public.workouts (
  id text not null, user_id text not null references public.profiles(user_id) on delete cascade,
  date date not null, kind text not null, title text not null, miles numeric not null check (miles >= 0), detail text not null,
  plan_ids jsonb, completed boolean not null default false, primary key (user_id, id), unique (user_id, date)
);
create table if not exists public.plan_versions (
  id uuid primary key default gen_random_uuid(), user_id text not null references public.profiles(user_id) on delete cascade,
  version integer not null, reason text not null, rationale text not null, mode text not null check (mode in ('replace','patch')),
  workouts jsonb not null, created_at timestamptz not null default now(), unique(user_id, version)
);
create table if not exists public.completed_runs (
  id text primary key, user_id text not null references public.profiles(user_id) on delete cascade,
  date date not null, distance numeric not null check (distance > 0), unit text not null, duration text not null, notes text, created_at timestamptz not null default now()
);
create table if not exists public.activities (
  id text primary key, user_id text not null references public.profiles(user_id) on delete cascade,
  name text not null, type text not null, intensity text not null, preference text not null,
  date date, weekday text, created_at timestamptz not null default now(), check (date is not null or weekday is not null)
);
create table if not exists public.interruptions (
  id text primary key, user_id text not null references public.profiles(user_id) on delete cascade,
  start_date date not null, days integer not null check (days > 0), reason text not null, note text, created_at timestamptz not null default now()
);
create table if not exists public.agent_connections (
  user_id text not null references public.profiles(user_id) on delete cascade, client_id text not null, provider text not null,
  first_seen_at timestamptz not null default now(), last_seen_at timestamptz not null default now(), primary key(user_id, client_id)
);
create table if not exists public.audit_events (
  id uuid primary key default gen_random_uuid(), user_id text not null references public.profiles(user_id) on delete cascade,
  action text not null, metadata jsonb not null default '{}'::jsonb, created_at timestamptz not null default now()
);

create or replace function public.runmcp_owner(row_user_id text) returns boolean language sql stable as $$
  select (auth.jwt() ->> 'sub') = row_user_id;
$$;
do $$ declare tab text; begin
  foreach tab in array array['profiles','goals','training_plans','workouts','plan_versions','completed_runs','activities','interruptions','agent_connections','audit_events'] loop
    execute format('alter table public.%I enable row level security', tab);
    execute format('drop policy if exists runmcp_owner_all on public.%I', tab);
    execute format('create policy runmcp_owner_all on public.%I for all to authenticated using (public.runmcp_owner(user_id)) with check (public.runmcp_owner(user_id))', tab);
  end loop;
end $$;

-- Atomic compare-and-swap calendar application. The caller's JWT subject is the
-- owner; p_user_id is deliberately absent so agents cannot choose an owner.
create or replace function public.apply_plan_revision(
  p_expected_version integer, p_plan_id text, p_workouts jsonb, p_reason text, p_rationale text, p_mode text
) returns table(version integer, generated_at timestamptz) language plpgsql security invoker as $$
declare v_user text := auth.jwt() ->> 'sub'; v_current integer; v_now timestamptz := now();
begin
  select tp.version into v_current from public.training_plans tp where tp.user_id = v_user for update;
  if not found then raise exception 'profile/calendar is not provisioned'; end if;
  if v_current <> p_expected_version then raise exception 'calendar version conflict'; end if;
  delete from public.workouts where user_id = v_user;
  insert into public.workouts(id,user_id,date,kind,title,miles,detail,plan_ids,completed)
  select item->>'id', v_user, (item->>'date')::date, item->>'kind', item->>'title', (item->>'miles')::numeric,
         item->>'detail', coalesce(item->'planIds','[]'::jsonb), coalesce((item->>'completed')::boolean,false)
  from jsonb_array_elements(p_workouts) item;
  update public.training_plans set id=p_plan_id, version=v_current+1, generated_at=v_now, revision_reason=p_reason, revision_rationale=p_rationale where user_id=v_user;
  insert into public.plan_versions(user_id,version,reason,rationale,mode,workouts) values(v_user,v_current+1,p_reason,p_rationale,p_mode,p_workouts);
  return query select v_current+1, v_now;
end $$;
grant execute on function public.apply_plan_revision(integer,text,jsonb,text,text,text) to authenticated;

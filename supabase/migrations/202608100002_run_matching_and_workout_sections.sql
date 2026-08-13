-- Actual-run matching is a factual link. It deliberately has no foreign key:
-- calendar revisions may replace the current workout rows while run history remains.
alter table public.workouts add column if not exists sections jsonb;
alter table public.completed_runs add column if not exists planned_workout_id text;
alter table public.completed_runs add column if not exists match_status text not null default 'unmatched'
  check (match_status in ('matched', 'unmatched'));
alter table public.completed_runs add column if not exists match_rationale text;
create unique index if not exists completed_runs_one_match_per_workout
  on public.completed_runs (user_id, planned_workout_id)
  where planned_workout_id is not null;

-- Preserve structured sections in the canonical calendar and in the immutable
-- plan-version snapshot. This replaces the initial function after its schema
-- extension while keeping the same optimistic-locking contract.
create or replace function public.apply_plan_revision(
  p_expected_version integer, p_plan_id text, p_workouts jsonb, p_reason text, p_rationale text, p_mode text
) returns table(version integer, generated_at timestamptz) language plpgsql security invoker as $$
declare v_user text := auth.jwt() ->> 'sub'; v_current integer; v_now timestamptz := now();
begin
  select tp.version into v_current from public.training_plans tp where tp.user_id = v_user for update;
  if not found then raise exception 'profile/calendar is not provisioned'; end if;
  if v_current <> p_expected_version then raise exception 'calendar version conflict'; end if;
  delete from public.workouts where user_id = v_user;
  insert into public.workouts(id,user_id,date,kind,title,miles,detail,sections,plan_ids,completed)
  select item->>'id', v_user, (item->>'date')::date, item->>'kind', item->>'title', (item->>'miles')::numeric,
         item->>'detail', item->'sections', coalesce(item->'planIds','[]'::jsonb), coalesce((item->>'completed')::boolean,false)
  from jsonb_array_elements(p_workouts) item;
  update public.training_plans set id=p_plan_id, version=v_current+1, generated_at=v_now, revision_reason=p_reason, revision_rationale=p_rationale where user_id=v_user;
  insert into public.plan_versions(user_id,version,reason,rationale,mode,workouts) values(v_user,v_current+1,p_reason,p_rationale,p_mode,p_workouts);
  return query select v_current+1, v_now;
end $$;
grant execute on function public.apply_plan_revision(integer,text,jsonb,text,text,text) to authenticated;

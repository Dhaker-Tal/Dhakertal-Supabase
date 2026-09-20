-- ============================================================
--  Schema corrections applied after the first release.
--  Already live on the project; kept here so the database can be
--  rebuilt from scratch.
-- ============================================================

-- ------------------------------------------------------------
--  A route is not a list of pandals.
--
--  group_plan.pandal_id carried a foreign key to pandals(id), so
--  sharing a route that contained a restaurant, a metro station,
--  a chemist or a police station failed outright — and so did any
--  pandal that still lives in js/data.js rather than the database.
--  The symptom was:
--    insert or update on table "group_plan" violates foreign key
--    constraint "group_plan_pandal_id_fkey"
--
--  saved_places already stored a bare place id with no such
--  constraint. group_plan now matches it: any place id the app
--  knows about, validated for shape rather than membership.
--
--  The column keeps its name so the existing client keeps working.
-- ------------------------------------------------------------

alter table public.group_plan
  drop constraint if exists group_plan_pandal_id_fkey;

alter table public.group_plan
  drop constraint if exists group_plan_pandal_id_shape;

alter table public.group_plan
  add constraint group_plan_pandal_id_shape
  check (
    pandal_id is not null
    and length(pandal_id) between 1 and 120
    and pandal_id ~ '^[A-Za-z0-9:_-]+$'
  );

comment on column public.group_plan.pandal_id is
  'Any place id from the app: a pandal, an amenity, or a metro station '
  '("metro:<line>:<station>"). Deliberately not a foreign key — routes '
  'mix place types, and some places are served from js/data.js.';

-- ------------------------------------------------------------
--  Group meeting point.
--
--  Any MEMBER can set it — not just the group's creator — because in
--  practice whoever gets there first decides. groups_update stays
--  creator-only so a member cannot rename or hijack the group, so the
--  write goes through a narrow SECURITY DEFINER function that touches
--  the meeting columns and nothing else.
-- ------------------------------------------------------------

alter table public.groups
  add column if not exists meet_lat    double precision,
  add column if not exists meet_lng    double precision,
  add column if not exists meet_label  text,
  add column if not exists meet_note   text,
  add column if not exists meet_at     text,
  add column if not exists meet_set_by uuid references auth.users(id) on delete set null,
  add column if not exists meet_updated_at timestamptz;

alter table public.groups drop constraint if exists groups_meet_sane;
alter table public.groups add constraint groups_meet_sane check (
  (meet_lat is null and meet_lng is null)
  or (meet_lat between 20 and 25 and meet_lng between 86 and 91)
);

alter table public.groups drop constraint if exists groups_meet_text_len;
alter table public.groups add constraint groups_meet_text_len check (
  coalesce(length(meet_label), 0) <= 120
  and coalesce(length(meet_note), 0) <= 300
  and coalesce(length(meet_at), 0) <= 60
);

create or replace function public.set_group_meeting(
  p_code text, p_lat double precision, p_lng double precision,
  p_label text default null, p_note text default null, p_at text default null)
returns text
language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  if not exists (select 1 from public.group_members m
                  where m.group_code = p_code and m.user_id = auth.uid()) then
    raise exception 'You are not a member of this group';
  end if;
  update public.groups
     set meet_lat=p_lat, meet_lng=p_lng,
         meet_label=nullif(btrim(coalesce(p_label,'')),''),
         meet_note =nullif(btrim(coalesce(p_note ,'')),''),
         meet_at   =nullif(btrim(coalesce(p_at   ,'')),''),
         meet_set_by=auth.uid(), meet_updated_at=now()
   where code = p_code;
  if not found then raise exception 'No group with that code'; end if;
  return case when p_lat is null then 'cleared' else 'saved' end;
end $$;

revoke all on function public.set_group_meeting(text,double precision,double precision,text,text,text)
  from public, anon;
grant execute on function public.set_group_meeting(text,double precision,double precision,text,text,text)
  to authenticated;

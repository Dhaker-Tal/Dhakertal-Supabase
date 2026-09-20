-- ============================================================
--  Dhaker Tal — alert when someone requests a pandal
--  (already applied to the live project; kept here for reference
--   and so you can rebuild the database from scratch)
--
--  Flow:  INSERT into pandal_requests
--           -> trigger notify_new_request()
--           -> net.http_post {id} to the "notify-request" Edge Function
--           -> the function looks that id up itself and claims it
--           -> email to dhakertal@gmail.com (and WhatsApp if configured)
--
--  There is no shared password to configure. The function is handed
--  nothing but a row id and proves the request is real by reading it
--  back with the service-role key Supabase injects. The read is an
--  atomic claim, so a row can be notified once, and only within five
--  minutes of being created.
-- ============================================================

create extension if not exists pg_net with schema extensions;

-- ---------- private config (never exposed over the API) ----------
create schema if not exists private;
revoke all on schema private from anon, authenticated;

create table if not exists private.app_config (
  key   text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);
alter table private.app_config enable row level security;   -- no policies = nobody but the owner
revoke all on private.app_config from anon, authenticated;

insert into private.app_config (key, value)
values ('notify_url', 'https://fglbrrnkofatlrzvumjp.supabase.co/functions/v1/notify-request')
on conflict (key) do update set value = excluded.value, updated_at = now();

-- ---------- one-time claim ----------
alter table public.pandal_requests
  add column if not exists notified_at timestamptz;

create or replace function public.claim_request_for_notify(p_id uuid)
returns table (
  id uuid, name text, zone text, area text,
  lat double precision, lng double precision,
  requester_name text, requester_contact text, description text
)
language sql
security definer
set search_path = public
as $$
  update public.pandal_requests r
     set notified_at = now()
   where r.id = p_id
     and r.notified_at is null
     and r.created_at > now() - interval '5 minutes'
  returning r.id, r.name, r.zone, r.area, r.lat, r.lng,
            r.requester_name, r.requester_contact, r.description;
$$;
revoke all on function public.claim_request_for_notify(uuid) from public, anon, authenticated;

-- ---------- the trigger ----------
create or replace function public.notify_new_request()
returns trigger
language plpgsql
security definer
set search_path = public, private, extensions
as $$
declare
  v_url text;
begin
  select value into v_url from private.app_config where key = 'notify_url';
  if v_url is null then
    return new;
  end if;

  perform net.http_post(
    url     := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body    := jsonb_build_object('id', new.id),
    timeout_milliseconds := 4000
  );
  return new;
exception when others then
  raise warning 'notify_new_request failed: %', sqlerrm;   -- never block a submission
  return new;
end $$;
revoke all on function public.notify_new_request() from public, anon, authenticated;

drop trigger if exists trg_notify_new_request on public.pandal_requests;
create trigger trg_notify_new_request
after insert on public.pandal_requests
for each row execute function public.notify_new_request();

-- ---------- owner-only checks ----------
create or replace function public.notify_status()
returns table (setting text, state text)
language sql
security definer
set search_path = public, private
as $$
  select 'notify_url'::text,
         coalesce((select value from private.app_config where key = 'notify_url'), 'MISSING')
  union all
  select 'trigger'::text,
         case when exists (select 1 from pg_trigger
                           where tgname = 'trg_notify_new_request' and not tgisinternal)
              then 'installed' else 'MISSING' end
  union all
  select 'last notified'::text,
         coalesce((select to_char(max(notified_at), 'DD Mon HH24:MI')
                     from public.pandal_requests), 'never');
$$;
revoke all on function public.notify_status() from public, anon, authenticated;

-- pg_net only dispatches after the calling transaction commits, so the test
-- and its result are two separate steps.
create or replace function public.notify_test()
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  insert into public.pandal_requests
    (name, zone, lat, lng, area, requester_name, description)
  values ('Test alert — safe to reject', 'north', 22.5850, 88.3639,
          'Setup check', 'notify_test()',
          'If this arrived on WhatsApp, alerts are working. Reject it in the Admin tab.');
  return 'Test request created. Wait ~5 seconds, then run:  select public.notify_result();';
end $$;
revoke all on function public.notify_test() from public, anon, authenticated;

create or replace function public.notify_result()
returns text
language sql
security definer
set search_path = public, extensions
as $$
  select coalesce(
    (select 'HTTP ' || status_code || ' — ' || left(coalesce(content, error_msg, ''), 300)
       from net._http_response order by created desc limit 1),
    'No reply recorded yet — wait a moment and run this again.');
$$;
revoke all on function public.notify_result() from public, anon, authenticated;

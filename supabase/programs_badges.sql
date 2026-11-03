-- Programs (multi-class), badge library, auto-awarded program badges, ending events, attendance log.

-- ---------- Tables ----------
create table if not exists public.badges (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  image_url text,
  created_at timestamptz not null default now()
);
alter table public.badges enable row level security;
revoke all on public.badges from anon, authenticated;

alter table public.events
  add column if not exists ended_at timestamptz,
  add column if not exists classes int,
  add column if not exists badge_id uuid references public.badges(id) on delete set null;

alter table public.badge_awards
  add column if not exists badge_id uuid references public.badges(id) on delete cascade,
  add column if not exists event_id uuid references public.events(id) on delete set null;

-- A program has one check-in per class (per day); runs and events still have one (their single date).
drop index if exists public.activities_one_checkin_per_run;
create unique index if not exists activities_one_checkin_per_day
  on public.activities (member_id, event_id, activity_date)
  where detail in ('app check-in','admin check-in');

-- ---------- Helpers ----------
create or replace function public._app_event(cat text) returns boolean language sql immutable as $$
  select cat in ('weekend_run', 'community_event', 'fitness_workshop', 'program') $$;

create or replace function public._kind(cat text) returns text language sql immutable as $$
  select case when cat = 'weekend_run' then 'run' when cat = 'program' then 'program' else 'event' end $$;

-- Over = ended by the organiser, or (for one-day runs/events) the date has passed. Programs only end when ended.
create or replace function public._is_past(e public.events) returns boolean language sql stable set search_path = public as $$
  select e.ended_at is not null or (e.category <> 'program' and e.event_date < ist_today()) $$;

create or replace function public._check_in_live(e public.events) returns boolean language sql stable set search_path = public as $$
  select e.ended_at is null and e.check_in_code is not null
     and case when e.category = 'program' then e.event_date <= ist_today() else e.event_date = ist_today() end $$;

create or replace function public._badge_json(p_id uuid) returns json language sql stable set search_path = public as $$
  select json_build_object('id', b.id, 'name', b.name, 'image_url', b.image_url) from badges b where b.id = p_id $$;

-- Give (or take back) a program's badge for one member, based on how many classes they've checked in to.
create or replace function public._program_award(p_event uuid, p_member uuid) returns void
language plpgsql security definer set search_path = public as $$
declare e events; n int;
begin
  select * into e from events where id = p_event;
  if e.id is null then return; end if;
  -- awards this program gave that no longer apply (badge changed, or it's no longer a program)
  delete from badge_awards where member_id = p_member and event_id = e.id and awarded_by = 'auto'
    and (e.category <> 'program' or badge_id is distinct from e.badge_id);
  if e.category <> 'program' or e.badge_id is null or e.classes is null then return; end if;
  select count(*) into n from activities
   where event_id = e.id and member_id = p_member and detail in ('app check-in','admin check-in');
  if n >= e.classes then
    insert into badge_awards (member_id, badge, badge_id, event_id, awarded_on, awarded_by, note)
    values (p_member, 'custom:' || e.badge_id, e.badge_id, e.id, ist_today(), 'auto', e.name)
    on conflict (member_id, badge) do nothing;
  else
    delete from badge_awards where member_id = p_member and event_id = e.id and awarded_by = 'auto';
  end if;
end $$;

create or replace function public._program_sync(p_event uuid) returns void
language plpgsql security definer set search_path = public as $$
declare mid uuid;
begin
  for mid in
    select member_id from activities where event_id = p_event and detail in ('app check-in','admin check-in')
    union select member_id from badge_awards where event_id = p_event and awarded_by = 'auto'
  loop
    perform _program_award(p_event, mid);
  end loop;
end $$;

-- ---------- What members see ----------
create or replace function public._run_public(e public.events) returns json
language sql stable set search_path = public as $$
  with me as (select id from members where auth.uid() is not null and auth_user_id = auth.uid() limit 1),
  mine as (select r.* from registrations r join me on me.id = r.member_id
           where r.event_id = e.id and r.status in ('pending','confirmed') limit 1),
  ci as (select a.activity_date, a.distance_km from activities a join me on me.id = a.member_id
         where a.event_id = e.id and a.detail in ('app check-in','admin check-in'))
  select json_build_object(
    'id', e.id, 'name', e.name, 'date', e.event_date,
    'kind', _kind(e.category),
    'time', to_char(e.start_time, 'HH24:MI'),
    'venue', e.location, 'map_url', e.map_url, 'poster_url', e.poster_url,
    'description', e.description, 'run_km', e.run_km,
    'price', coalesce(e.price_inr, 0), 'payment_qr_url', e.payment_qr_url, 'upi_id', e.upi_id,
    'is_today', e.event_date = ist_today(),
    'is_past', _is_past(e),
    'ended', e.ended_at is not null,
    'ended_on', (e.ended_at at time zone 'Asia/Kolkata')::date,
    'check_in_live', _check_in_live(e),
    'can_attend', e.check_in_code is not null,
    'classes', e.classes,
    'badge', _badge_json(e.badge_id),
    'signup_enabled', e.signup_enabled,
    'signup_fields', e.signup_fields,
    'capacity', e.capacity,
    'spots_left', case when e.capacity is null then null else greatest(0, e.capacity -
        (select count(*) from registrations r where r.event_id = e.id and r.status in ('pending','confirmed'))) end,
    'signed_up', exists (select 1 from mine where status = 'confirmed'),
    'my_status', (select status from mine),
    'my_answers', (select answers from mine),
    'my_payment', (select payment_status from mine),
    'my_classes', (select count(*) from ci),
    'my_badge_earned', e.badge_id is not null and exists (select 1 from badge_awards ba join me on me.id = ba.member_id where ba.badge_id = e.badge_id),
    'my_checkin_km', (select distance_km from ci order by activity_date desc limit 1),
    'checked_in', case when e.category = 'program' then exists (select 1 from ci where activity_date = ist_today())
                       else exists (select 1 from ci) end);
$$;

create or replace function public._run_admin(e public.events) returns json
language sql stable set search_path = public as $$
  select (_run_public(e)::jsonb || jsonb_build_object(
    'attend_url', e.attend_url, 'check_in_code', e.check_in_code, 'badge_id', e.badge_id,
    'signup_count', (select count(*) from registrations r where r.event_id = e.id and r.status = 'confirmed'),
    'pending_count', (select count(*) from registrations r where r.event_id = e.id and r.status = 'pending'),
    'signups', coalesce((select jsonb_agg(jsonb_build_object('member_id', m.id, 'name', m.name, 'phone', coalesce(m.sheet_key, m.phone),
                           'at', r.created_at, 'answers', r.answers, 'attended', r.attended, 'payment', r.payment_status, 'status', r.status)
                           order by (r.status = 'confirmed'), r.created_at)
                         from registrations r join members m on m.id = r.member_id
                         where r.event_id = e.id and r.status in ('pending','confirmed')), '[]'::jsonb),
    'attendees', coalesce((select jsonb_agg(jsonb_build_object('member_id', m.id, 'name', m.name, 'phone', coalesce(m.sheet_key, m.phone),
                           'km', a.distance_km, 'date', a.activity_date, 'at', a.created_at, 'by', a.detail,
                           'badge', exists (select 1 from badge_awards ba where ba.member_id = m.id and ba.event_id = e.id))
                           order by a.activity_date, a.created_at)
                         from activities a join members m on m.id = a.member_id
                         where a.event_id = e.id and a.detail in ('app check-in','admin check-in')), '[]'::jsonb)))::json;
$$;

create or replace function public.upcoming_runs() returns json
language sql stable security definer set search_path = public as $$
  select coalesce(json_agg(_run_public(e) order by e.event_date, e.start_time nulls last), '[]'::json)
  from events e where _app_event(e.category) and e.is_active and not _is_past(e);
$$;

create or replace function public.past_events() returns json
language sql stable security definer set search_path = public as $$
  select coalesce(json_agg(x.j order by x.d desc), '[]'::json) from (
    select _run_public(e) j, coalesce((e.ended_at at time zone 'Asia/Kolkata')::date, e.event_date) d
    from events e where _app_event(e.category) and e.is_active and _is_past(e)
    order by 2 desc limit 30) x;
$$;
grant execute on function public.past_events() to anon, authenticated;

-- ---------- Check in ----------
create or replace function public.check_in_run(p_id uuid, p_code text, p_km numeric default null)
returns json language plpgsql security definer set search_path = public as $$
declare m members; e events; v_km numeric; before_km numeric; after_km numeric; was_new boolean; is_run boolean;
  v_day date; had_badge boolean; has_badge boolean;
begin
  if auth.uid() is null then raise exception 'not_logged_in'; end if;
  select * into m from members where auth_user_id = auth.uid() limit 1;
  if m.id is null then raise exception 'no_member'; end if;
  select * into e from events where id = p_id and _app_event(category) and is_active;
  if e.id is null then raise exception 'run_not_found'; end if;
  if e.ended_at is not null then raise exception 'event_ended'; end if;
  if e.category = 'program' then
    if e.event_date > ist_today() then raise exception 'program_not_started'; end if;
  elsif e.event_date is distinct from ist_today() then raise exception 'not_today'; end if;
  if e.check_in_code is null or p_code is distinct from e.check_in_code then raise exception 'wrong_code'; end if;
  is_run := e.category = 'weekend_run';
  if is_run then
    v_km := round(coalesce(p_km, e.run_km), 2);
    if v_km < 0.5 or v_km > 60 then raise exception 'bad_distance'; end if;
  end if;
  v_day := case when e.category = 'program' then ist_today() else e.event_date end;

  select not exists (select 1 from activities where member_id = m.id and event_id = e.id and activity_date = v_day
                     and detail in ('app check-in','admin check-in')) into was_new;
  select total_km into before_km from leaderboard where id = m.id;
  if not was_new and is_run then
    before_km := before_km - coalesce((select distance_km from activities where member_id = m.id and event_id = e.id
                                       and activity_date = v_day and detail in ('app check-in','admin check-in') limit 1), 0);
  end if;
  had_badge := e.badge_id is not null and exists (select 1 from badge_awards where member_id = m.id and badge_id = e.badge_id);

  insert into activities (member_id, category, event_id, activity_date, distance_km, detail)
  values (m.id, e.category, e.id, v_day, v_km, 'app check-in')
  on conflict (member_id, event_id, activity_date) where detail in ('app check-in','admin check-in')
  do update set distance_km = excluded.distance_km;

  update registrations set attended = true, attended_at = coalesce(attended_at, now())
  where member_id = m.id and event_id = e.id;

  if e.category = 'program' then
    perform _program_award(e.id, m.id);
    has_badge := e.badge_id is not null and exists (select 1 from badge_awards where member_id = m.id and badge_id = e.badge_id);
    return json_build_object('ok', true, 'run', e.name, 'kind', 'program', 'first_time', was_new,
      'classes', e.classes,
      'done', (select count(*) from activities where member_id = m.id and event_id = e.id and detail in ('app check-in','admin check-in')),
      'badge', _badge_json(e.badge_id), 'badge_earned', has_badge and not had_badge);
  end if;

  select total_km into after_km from leaderboard where id = m.id;
  return json_build_object('ok', true, 'run', e.name, 'kind', _kind(e.category),
    'km', v_km, 'first_time', was_new, 'total_km', round(after_km, 2),
    'badge_before', _badge(before_km), 'badge', _badge(after_km),
    'total_runs', (select total_runs from leaderboard where id = m.id));
end $$;

drop function if exists public.admin_add_attendee(uuid, text, numeric, text);
create function public.admin_add_attendee(p_id uuid, p_phone text, p_km numeric default null, p_name text default null, p_date date default null)
returns json language plpgsql security definer set search_path = public as $$
declare e events; m members; v_phone text; v_km numeric; v_day date;
begin
  if not is_admin() then raise exception 'not_admin'; end if;
  select * into e from events where id = p_id and _app_event(category) and is_active;
  if e.id is null then raise exception 'run_not_found'; end if;
  v_phone := regexp_replace(coalesce(p_phone,''), '\D', '', 'g');
  if length(v_phone) = 12 and v_phone like '91%' then v_phone := substr(v_phone, 3); end if;
  if length(v_phone) = 11 and v_phone like '0%' then v_phone := substr(v_phone, 2); end if;
  if v_phone !~ '^[6-9][0-9]{9}$' then raise exception 'invalid_phone'; end if;
  if e.category = 'weekend_run' then
    v_km := round(coalesce(p_km, e.run_km), 2);
    if v_km < 0.5 or v_km > 60 then raise exception 'bad_distance'; end if;
  end if;
  if e.category = 'program' then
    v_day := coalesce(p_date, ist_today());
    if v_day < e.event_date or v_day > ist_today() then raise exception 'bad_class_date'; end if;
  else
    v_day := e.event_date;
  end if;
  select * into m from members where sheet_key = v_phone limit 1;
  if m.id is null then
    select * into m from members where right(regexp_replace(coalesce(phone,''), '\D', '', 'g'), 10) = v_phone
    order by (auth_user_id is not null) desc, created_at limit 1;
  end if;
  if m.id is null then
    if nullif(btrim(p_name),'') is null then raise exception 'name_needed'; end if;
    insert into members (name, phone, sheet_key, source) values (btrim(p_name), v_phone, v_phone, 'admin-checkin') returning * into m;
  end if;
  insert into activities (member_id, category, event_id, activity_date, distance_km, detail)
  values (m.id, e.category, e.id, v_day, v_km, 'admin check-in')
  on conflict (member_id, event_id, activity_date) where detail in ('app check-in','admin check-in')
  do update set distance_km = excluded.distance_km;
  update registrations set attended = true, attended_at = coalesce(attended_at, now()) where member_id = m.id and event_id = e.id;
  perform _program_award(e.id, m.id);
  return _run_admin(e);
end $$;

drop function if exists public.admin_remove_attendee(uuid, uuid);
create function public.admin_remove_attendee(p_id uuid, p_member uuid, p_date date default null)
returns json language plpgsql security definer set search_path = public as $$
declare e events;
begin
  if not is_admin() then raise exception 'not_admin'; end if;
  select * into e from events where id = p_id and _app_event(category);
  if e.id is null then raise exception 'run_not_found'; end if;
  delete from activities where event_id = p_id and member_id = p_member and detail in ('app check-in','admin check-in')
    and (p_date is null or activity_date = p_date);
  if not exists (select 1 from activities where event_id = p_id and member_id = p_member and detail in ('app check-in','admin check-in')) then
    update registrations set attended = false, attended_at = null where event_id = p_id and member_id = p_member;
  end if;
  perform _program_award(e.id, p_member);
  return _run_admin(e);
end $$;

-- ---------- Organiser: save, end ----------
create or replace function public.admin_save_run(p jsonb) returns json
language plpgsql security definer set search_path = public as $$
declare e events; v_id uuid := nullif(p->>'id','')::uuid;
  v_name text := nullif(btrim(p->>'name'), '');
  v_date date := nullif(p->>'date','')::date;
  v_cap int := nullif(p->>'capacity','')::int;
  v_fields jsonb := _clean_fields(p->'signup_fields');
  v_on boolean := coalesce((p->>'signup_enabled')::boolean, true);
  v_cat text := case p->>'kind' when 'event' then 'community_event' when 'program' then 'program' else 'weekend_run' end;
  v_price numeric := greatest(0, coalesce(nullif(p->>'price','')::numeric, 0));
  v_upi text := nullif(btrim(p->>'upi_id'), '');
  v_classes int := nullif(regexp_replace(coalesce(p->>'classes',''), '\D', '', 'g'), '')::int;
  v_badge uuid := nullif(p->>'badge_id','')::uuid;
  u text;
begin
  if not is_admin() then raise exception 'not_admin'; end if;
  if v_name is null then raise exception 'run_name_required'; end if;
  if v_date is null then raise exception 'date_required'; end if;
  if v_cap is not null and v_cap < 1 then v_cap := null; end if;
  if v_upi is not null and v_upi !~ '^[A-Za-z0-9._-]{2,200}@[A-Za-z0-9.-]{2,64}$' then raise exception 'bad_upi'; end if;
  foreach u in array array[p->>'map_url', p->>'poster_url', p->>'payment_qr_url'] loop
    if nullif(btrim(u),'') is not null and btrim(u) !~* '^https?://' then raise exception 'bad_link'; end if;
  end loop;
  if v_cat = 'program' then
    if v_classes is null or v_classes < 1 or v_classes > 100 then raise exception 'classes_required'; end if;
    if v_badge is not null and not exists (select 1 from badges where id = v_badge) then raise exception 'badge_not_found'; end if;
  else
    v_classes := null; v_badge := null;
  end if;
  if v_id is null then
    insert into events (name, category, event_date, start_time, location, map_url, poster_url, description,
                        check_in_code, registration_open, signup_enabled, signup_fields, capacity, run_km,
                        price_inr, payment_qr_url, upi_id, classes, badge_id)
    values (v_name, v_cat, v_date, nullif(p->>'time','')::time, nullif(btrim(p->>'venue'),''),
            nullif(btrim(p->>'map_url'),''), nullif(btrim(p->>'poster_url'),''), nullif(btrim(p->>'description'),''),
            encode(extensions.gen_random_bytes(6), 'hex'), true, v_on, v_fields, v_cap,
            coalesce(nullif(p->>'run_km','')::numeric, 5), v_price, nullif(btrim(p->>'payment_qr_url'),''), v_upi,
            v_classes, v_badge)
    returning * into e;
  else
    update events set name = v_name, category = v_cat, event_date = v_date, start_time = nullif(p->>'time','')::time,
      location = nullif(btrim(p->>'venue'),''), map_url = nullif(btrim(p->>'map_url'),''),
      poster_url = nullif(btrim(p->>'poster_url'),''), description = nullif(btrim(p->>'description'),''),
      signup_enabled = v_on, signup_fields = v_fields, capacity = v_cap,
      run_km = coalesce(nullif(p->>'run_km','')::numeric, run_km),
      price_inr = v_price, payment_qr_url = nullif(btrim(p->>'payment_qr_url'),''), upi_id = v_upi,
      classes = v_classes, badge_id = v_badge,
      check_in_code = coalesce(check_in_code, encode(extensions.gen_random_bytes(6), 'hex')), updated_at = now()
    where id = v_id and _app_event(category) and is_active
    returning * into e;
    if e.id is null then raise exception 'run_not_found'; end if;
    perform _program_sync(e.id);   -- classes or badge may have changed
  end if;
  return _run_admin(e);
end $$;

create or replace function public.admin_end_event(p_id uuid, p_end boolean default true) returns json
language plpgsql security definer set search_path = public as $$
declare e events;
begin
  if not is_admin() then raise exception 'not_admin'; end if;
  update events set ended_at = case when p_end then coalesce(ended_at, now()) else null end, updated_at = now()
   where id = p_id and _app_event(category) and is_active returning * into e;
  if e.id is null then raise exception 'run_not_found'; end if;
  return _run_admin(e);
end $$;

-- ---------- Badge library ----------
create or replace function public.admin_list_badges() returns json
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'not_admin'; end if;
  return (select coalesce(json_agg(json_build_object('id', b.id, 'name', b.name, 'image_url', b.image_url,
            'programs', (select count(*) from events e where e.badge_id = b.id and e.is_active),
            'awarded', (select count(*) from badge_awards ba where ba.badge_id = b.id)) order by b.created_at desc), '[]'::json)
          from badges b);
end $$;

create or replace function public.admin_save_badge(p jsonb) returns json
language plpgsql security definer set search_path = public as $$
declare b badges; v_id uuid := nullif(p->>'id','')::uuid; v_name text := nullif(btrim(p->>'name'), ''); v_img text := nullif(btrim(p->>'image_url'), '');
begin
  if not is_admin() then raise exception 'not_admin'; end if;
  if v_name is null then raise exception 'badge_name_required'; end if;
  if length(v_name) > 60 then raise exception 'badge_name_too_long'; end if;
  if v_img is null then raise exception 'badge_image_required'; end if;
  if v_img !~* '^https?://' then raise exception 'bad_link'; end if;
  if v_id is null then
    insert into badges (name, image_url) values (v_name, v_img) returning * into b;
  else
    update badges set name = v_name, image_url = v_img where id = v_id returning * into b;
    if b.id is null then raise exception 'badge_not_found'; end if;
  end if;
  return json_build_object('id', b.id, 'name', b.name, 'image_url', b.image_url, 'programs', 0, 'awarded', 0);
end $$;

-- ---------- Sign up: ended events are closed; programs can be joined until they end ----------
create or replace function public.sign_up_for_run(p_id uuid, p_answers jsonb default '{}'::jsonb)
returns json language plpgsql security definer set search_path = public as $$
declare m members; e events; f jsonb; v text; picks jsonb; clean jsonb := '{}'::jsonb; taken int; existing registrations; v_status text;
begin
  if auth.uid() is null then raise exception 'not_logged_in'; end if;
  select * into m from members where auth_user_id = auth.uid() limit 1;
  if m.id is null then raise exception 'no_member'; end if;
  select * into e from events where id = p_id and _app_event(category) and is_active for update;
  if e.id is null then raise exception 'run_not_found'; end if;
  if _is_past(e) then raise exception 'run_over'; end if;
  if not e.signup_enabled then raise exception 'signups_closed'; end if;

  for f in select * from jsonb_array_elements(e.signup_fields) loop
    if f->>'type' = 'checkboxes' then
      picks := p_answers -> (f->>'id');
      if picks is null or jsonb_typeof(picks) <> 'array' then picks := '[]'::jsonb; end if;
      picks := coalesce((select jsonb_agg(o) from jsonb_array_elements_text(f->'options') with ordinality as x(o, ord)
                         where picks ? o), '[]'::jsonb);
      if jsonb_array_length(picks) = 0 then
        if coalesce((f->>'required')::boolean, false) then raise exception 'answer_required'; end if;
        continue;
      end if;
      clean := clean || jsonb_build_object(f->>'id', picks);
      continue;
    end if;
    v := btrim(coalesce(p_answers ->> (f->>'id'), ''));
    if v = '' then
      if coalesce((f->>'required')::boolean, false) then raise exception 'answer_required'; end if;
      continue;
    end if;
    if length(v) > 1000 then raise exception 'answer_too_long'; end if;
    if f->>'type' = 'number' and v !~ '^-?[0-9]+(\.[0-9]+)?$' then raise exception 'answer_not_number'; end if;
    if f->>'type' = 'choice' and not (coalesce(f->'options','[]'::jsonb) ? v) then raise exception 'answer_bad_choice'; end if;
    if f->>'type' = 'yes_no' and v not in ('Yes','No') then raise exception 'answer_bad_choice'; end if;
    clean := clean || jsonb_build_object(f->>'id', v);
  end loop;

  select * into existing from registrations where member_id = m.id and event_id = e.id;
  if existing.id is not null and existing.status in ('pending','confirmed') then
    update registrations set answers = clean where id = existing.id;
    return _run_public(e);
  end if;

  if e.capacity is not null then
    select count(*) into taken from registrations where event_id = e.id and status in ('pending','confirmed');
    if taken >= e.capacity then raise exception 'run_full'; end if;
  end if;

  v_status := case when coalesce(e.price_inr, 0) > 0 then 'pending' else 'confirmed' end;
  insert into registrations (member_id, event_id, status, pass_code, answers, payment_status)
  values (m.id, e.id, v_status, gen_pass_code(), clean, 'none')
  on conflict (member_id, event_id) do update set status = excluded.status, answers = excluded.answers, payment_status = 'none';
  return _run_public(e);
end $$;

-- ---------- Profile: badges earned + attendance log ----------
create or replace function public.my_profile() returns json
language sql stable security definer set search_path = public as $$
  with me as (select id, phone, is_admin, avatar_url from members where auth_user_id = auth.uid() limit 1),
  ranked as (select l.*, rank() over (order by l.total_km desc) as rnk from leaderboard l),
  tiers(badge, km) as (values ('PACER',25),('STRIDER',50),('RANGER',100),('WAYFARER',200),('VOYAGER',300))
  select json_build_object(
    'name', r.name, 'phone', me.phone, 'is_admin', me.is_admin, 'avatar_url', me.avatar_url,
    'total_km', round(r.total_km, 2), 'total_runs', r.total_runs, 'badge', r.badge,
    'rank', case when r.total_km > 0 then r.rnk end,
    'runners', (select count(*) from leaderboard where total_km > 0),
    'last_run', r.last_run,
    'next_badge', (select t.badge from tiers t where t.km > r.total_km order by t.km limit 1),
    'next_badge_km', (select t.km from tiers t where t.km > r.total_km order by t.km limit 1),
    'recent', coalesce((
      select json_agg(json_build_object('date', x.activity_date, 'km', x.distance_km))
      from (select activity_date, distance_km from activities
            where member_id = me.id and category = 'weekend_run' and distance_km > 0
            order by activity_date desc limit 8) x), '[]'::json),
    'badges', coalesce((
      select json_agg(json_build_object('name', b.name, 'image_url', b.image_url, 'on', ba.awarded_on, 'from', ba.note)
                      order by ba.awarded_on desc, ba.created_at desc)
      from badge_awards ba join badges b on b.id = ba.badge_id where ba.member_id = me.id), '[]'::json),
    'attended', coalesce((
      select json_agg(json_build_object('id', x.id, 'name', x.name, 'kind', x.kind, 'classes', x.classes,
                                        'count', x.n, 'first', x.first, 'last', x.last) order by x.last desc)
      from (select e.id, e.name, _kind(e.category) kind, e.classes, count(*) n,
                   min(a.activity_date) first, max(a.activity_date) last
            from activities a join events e on e.id = a.event_id
            where a.member_id = me.id and a.detail in ('app check-in','admin check-in') and e.category <> 'weekend_run'
            group by e.id, e.name, e.category, e.classes) x), '[]'::json))
  from me join ranked r on r.id = me.id;
$$;

-- ---------- Permissions: helpers are internal; RPCs are for logged-in users ----------
revoke execute on function public._program_award(uuid, uuid), public._program_sync(uuid) from public, anon, authenticated;
revoke execute on function public.admin_add_attendee(uuid, text, numeric, text, date),
  public.admin_remove_attendee(uuid, uuid, date), public.admin_end_event(uuid, boolean),
  public.admin_list_badges(), public.admin_save_badge(jsonb) from public, anon;
grant execute on function public.admin_add_attendee(uuid, text, numeric, text, date),
  public.admin_remove_attendee(uuid, uuid, date), public.admin_end_event(uuid, boolean),
  public.admin_list_badges(), public.admin_save_badge(jsonb) to authenticated;

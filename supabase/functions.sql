-- All functions in the public schema, exported 30 Oct 2026 (pg_get_functiondef).
-- Reference copy for reading; the live database is the source of truth.

CREATE OR REPLACE FUNCTION public._badge(km numeric)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select case when km >= 300 then 'VOYAGER' when km >= 200 then 'WAYFARER' when km >= 100 then 'RANGER'
              when km >= 50 then 'STRIDER' when km >= 25 then 'PACER' end $function$
;

CREATE OR REPLACE FUNCTION public._clean_fields(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
declare f jsonb; out jsonb := '[]'::jsonb; t text; opts jsonb;
begin
  if p is null or jsonb_typeof(p) <> 'array' then return '[]'::jsonb; end if;
  for f in select * from jsonb_array_elements(p) loop
    if nullif(btrim(f->>'label'),'') is null then continue; end if;
    t := coalesce(f->>'type','text');
    if t not in ('text','long_text','number','choice','checkboxes','yes_no') then t := 'text'; end if;
    opts := case when t in ('choice','checkboxes') then coalesce((select jsonb_agg(distinct btrim(o)) from jsonb_array_elements_text(coalesce(f->'options','[]'::jsonb)) o where btrim(o) <> ''), '[]'::jsonb) else '[]'::jsonb end;
    -- keep the admin's order (distinct above can reorder)
    if t in ('choice','checkboxes') then
      opts := coalesce((select jsonb_agg(o order by min_ord) from (
                select btrim(o) o, min(ord) min_ord from jsonb_array_elements_text(coalesce(f->'options','[]'::jsonb)) with ordinality as x(o, ord)
                where btrim(o) <> '' group by btrim(o)) y), '[]'::jsonb);
    end if;
    if t in ('choice','checkboxes') and jsonb_array_length(opts) = 0 then raise exception 'choice_needs_options'; end if;
    out := out || jsonb_build_array(jsonb_build_object(
      'id', coalesce(nullif(f->>'id',''), 'f_' || substr(md5(random()::text), 1, 8)),
      'label', left(btrim(f->>'label'), 200), 'type', t,
      'required', coalesce((f->>'required')::boolean, false), 'options', opts));
  end loop;
  return out;
end $function$
;

CREATE OR REPLACE FUNCTION public._events_init_form_key()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  if new.signup_url ~* '/forms/d/e/[A-Za-z0-9_-]+' then
    new.signup_form_key := substring(new.signup_url from '/forms/d/e/([A-Za-z0-9_-]+)');
  end if;
  return new;
end $function$
;

CREATE OR REPLACE FUNCTION public._events_reset_form_key()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  if new.signup_url is distinct from old.signup_url then
    new.signup_form_key := case
      when new.signup_url ~* '/forms/d/e/[A-Za-z0-9_-]+' then substring(new.signup_url from '/forms/d/e/([A-Za-z0-9_-]+)')
      else null end;
  end if;
  return new;
end $function$
;

CREATE OR REPLACE FUNCTION public._run_admin(e events)
 RETURNS json
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select (_run_public(e)::jsonb || jsonb_build_object(
    'attend_url', e.attend_url, 'check_in_code', e.check_in_code,
    'signup_count', (select count(*) from registrations r where r.event_id = e.id and r.status = 'confirmed'),
    'signups', coalesce((select jsonb_agg(jsonb_build_object('name', m.name, 'phone', coalesce(m.sheet_key, m.phone),
                           'at', r.created_at, 'answers', r.answers, 'attended', r.attended) order by r.created_at)
                         from registrations r join members m on m.id = r.member_id
                         where r.event_id = e.id and r.status = 'confirmed'), '[]'::jsonb),
    'attendees', coalesce((select jsonb_agg(jsonb_build_object('member_id', m.id, 'name', m.name, 'phone', coalesce(m.sheet_key, m.phone),
                           'km', a.distance_km, 'at', a.created_at, 'by', a.detail) order by a.created_at)
                         from activities a join members m on m.id = a.member_id
                         where a.event_id = e.id and a.detail in ('app check-in','admin check-in')), '[]'::jsonb)))::json;
$function$
;

CREATE OR REPLACE FUNCTION public._run_public(e events)
 RETURNS json
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select json_build_object(
    'id', e.id, 'name', e.name, 'date', e.event_date,
    'time', to_char(e.start_time, 'HH24:MI'),
    'venue', e.location, 'map_url', e.map_url, 'poster_url', e.poster_url,
    'description', e.description, 'run_km', e.run_km,
    'is_today', e.event_date = ist_today(),
    'is_past', e.event_date < ist_today(),
    'can_attend', e.check_in_code is not null,
    'signup_enabled', e.signup_enabled,
    'signup_fields', e.signup_fields,
    'capacity', e.capacity,
    'spots_left', case when e.capacity is null then null else greatest(0, e.capacity -
        (select count(*) from registrations r where r.event_id = e.id and r.status = 'confirmed')) end,
    'signed_up', auth.uid() is not null and exists (
        select 1 from registrations r join members m on m.id = r.member_id
        where r.event_id = e.id and r.status = 'confirmed' and m.auth_user_id = auth.uid()),
    'my_answers', (select r.answers from registrations r join members m on m.id = r.member_id
        where auth.uid() is not null and r.event_id = e.id and r.status = 'confirmed' and m.auth_user_id = auth.uid() limit 1),
    'my_checkin_km', (select a.distance_km from activities a join members m on m.id = a.member_id
        where auth.uid() is not null and a.event_id = e.id and m.auth_user_id = auth.uid()
          and a.detail in ('app check-in','admin check-in') limit 1));
$function$
;

CREATE OR REPLACE FUNCTION public.admin_add_attendee(p_id uuid, p_phone text, p_km numeric DEFAULT NULL::numeric, p_name text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare e events; m members; v_phone text; v_km numeric;
begin
  if not is_admin() then raise exception 'not_admin'; end if;
  select * into e from events where id = p_id and category = 'weekend_run' and is_active;
  if e.id is null then raise exception 'run_not_found'; end if;
  v_phone := regexp_replace(coalesce(p_phone,''), '\D', '', 'g');
  if length(v_phone) = 12 and v_phone like '91%' then v_phone := substr(v_phone, 3); end if;
  if length(v_phone) = 11 and v_phone like '0%' then v_phone := substr(v_phone, 2); end if;
  if v_phone !~ '^[6-9][0-9]{9}$' then raise exception 'invalid_phone'; end if;
  v_km := round(coalesce(p_km, e.run_km), 2);
  if v_km < 0.5 or v_km > 60 then raise exception 'bad_distance'; end if;
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
  values (m.id, 'weekend_run', e.id, e.event_date, v_km, 'admin check-in')
  on conflict (member_id, event_id) where detail in ('app check-in','admin check-in')
  do update set distance_km = excluded.distance_km;
  update registrations set attended = true, attended_at = coalesce(attended_at, now()) where member_id = m.id and event_id = e.id;
  return _run_admin(e);
end $function$
;

CREATE OR REPLACE FUNCTION public.admin_delete_run(p_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not is_admin() then raise exception 'not_admin'; end if;
  update events set is_active = false, updated_at = now() where id = p_id and category = 'weekend_run';
  return json_build_object('ok', found);
end $function$
;

CREATE OR REPLACE FUNCTION public.admin_list_runs()
 RETURNS json
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not is_admin() then raise exception 'not_admin'; end if;
  return (select coalesce(json_agg(_run_admin(e) order by e.event_date desc, e.start_time desc nulls last), '[]'::json)
          from events e where e.category = 'weekend_run' and e.is_active);
end $function$
;

CREATE OR REPLACE FUNCTION public.admin_members()
 RETURNS json
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
declare result json;
begin
  if not is_admin() then raise exception 'not_admin'; end if;
  with base as (
    select m.id, m.name, coalesce(m.sheet_key, m.phone) as phone, m.auth_user_id, m.source, m.created_at as member_since,
           l.total_km, l.total_runs, l.last_run, u.created_at as joined_at, u.last_sign_in_at as last_seen
    from members m
    join leaderboard l on l.id = m.id
    left join auth.users u on u.id = m.auth_user_id
  )
  select json_build_object(
    'totals', json_build_object(
      'accounts', (select count(*) from base where auth_user_id is not null),
      'new_7d', (select count(*) from base where joined_at > now() - interval '7 days'),
      'active_7d', (select count(*) from base where last_seen > now() - interval '7 days'),
      'not_joined', (select count(*) from base where auth_user_id is null and total_km > 0),
      'runners', (select count(*) from base where total_km > 0)),
    'joined', coalesce((select json_agg(json_build_object('name', name, 'phone', phone, 'joined', joined_at,
                         'last_seen', last_seen, 'km', round(total_km, 2), 'runs', total_runs) order by joined_at desc)
                        from base where auth_user_id is not null), '[]'::json),
    'not_joined', coalesce((select json_agg(json_build_object('name', name, 'phone', phone, 'km', round(total_km, 2),
                         'runs', total_runs, 'last_run', last_run) order by last_run desc nulls last, total_km desc)
                        from base where auth_user_id is null and total_km > 0), '[]'::json),
    'bad_numbers', coalesce((select json_agg(json_build_object('name', name, 'phone', phone, 'km', round(total_km, 2)) order by total_km desc)
                        from base where total_km > 0 and coalesce(phone, '') !~ '^[6-9][0-9]{9}$'), '[]'::json),
    'same_name', coalesce((select json_agg(json_build_object('name', n, 'people', people) order by n)
                        from (select lower(btrim(name)) n,
                                     json_agg(json_build_object('name', name, 'phone', phone, 'km', round(total_km, 2), 'joined', auth_user_id is not null) order by total_km desc) people
                              from base where total_km > 0 or auth_user_id is not null
                              group by lower(btrim(name)) having count(*) > 1) d), '[]'::json)
  ) into result;
  return result;
end $function$
;

CREATE OR REPLACE FUNCTION public.admin_new_qr(p_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare e events;
begin
  if not is_admin() then raise exception 'not_admin'; end if;
  update events set check_in_code = encode(extensions.gen_random_bytes(6), 'hex'), updated_at = now()
  where id = p_id and category = 'weekend_run' and is_active returning * into e;
  if e.id is null then raise exception 'run_not_found'; end if;
  return _run_admin(e);
end $function$
;

CREATE OR REPLACE FUNCTION public.admin_remove_attendee(p_id uuid, p_member uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare e events;
begin
  if not is_admin() then raise exception 'not_admin'; end if;
  select * into e from events where id = p_id and category = 'weekend_run';
  delete from activities where event_id = p_id and member_id = p_member and detail in ('app check-in','admin check-in');
  update registrations set attended = false, attended_at = null where event_id = p_id and member_id = p_member;
  return _run_admin(e);
end $function$
;

CREATE OR REPLACE FUNCTION public.admin_reset_account(p_phone text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_member members; v_digits text;
begin
  v_digits := right(regexp_replace(coalesce(p_phone,''), '\D', '', 'g'), 10);
  select * into v_member from members where auth_user_id is not null
    and (sheet_key = v_digits or phone = v_digits) limit 1;
  if v_member.id is null then
    return json_build_object('ok', false, 'error', 'no_account_for_that_number');
  end if;
  delete from auth.users where id = v_member.auth_user_id;
  return json_build_object('ok', true, 'name', v_member.name, 'phone', v_digits);
end $function$
;

CREATE OR REPLACE FUNCTION public.admin_save_run(p jsonb)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare e events; v_id uuid := nullif(p->>'id','')::uuid;
  v_name text := nullif(btrim(p->>'name'), '');
  v_date date := nullif(p->>'date','')::date;
  v_cap int := nullif(p->>'capacity','')::int;
  v_fields jsonb := _clean_fields(p->'signup_fields');
  v_on boolean := coalesce((p->>'signup_enabled')::boolean, true);
  u text;
begin
  if not is_admin() then raise exception 'not_admin'; end if;
  if v_name is null then raise exception 'run_name_required'; end if;
  if v_date is null then raise exception 'date_required'; end if;
  if v_cap is not null and v_cap < 1 then v_cap := null; end if;
  foreach u in array array[p->>'map_url', p->>'attend_url', p->>'poster_url'] loop
    if nullif(btrim(u),'') is not null and btrim(u) !~* '^https?://' then raise exception 'bad_link'; end if;
  end loop;
  if v_id is null then
    insert into events (name, category, event_date, start_time, location, map_url, poster_url,
                        description, attend_url, check_in_code, registration_open,
                        signup_enabled, signup_fields, capacity, run_km)
    values (v_name, 'weekend_run', v_date, nullif(p->>'time','')::time, nullif(btrim(p->>'venue'),''),
            nullif(btrim(p->>'map_url'),''), nullif(btrim(p->>'poster_url'),''),
            nullif(btrim(p->>'description'),''), nullif(btrim(p->>'attend_url'),''),
            encode(extensions.gen_random_bytes(6), 'hex'), true, v_on, v_fields, v_cap, coalesce(nullif(p->>'run_km','')::numeric, 5))
    returning * into e;
  else
    update events set name = v_name, event_date = v_date, start_time = nullif(p->>'time','')::time,
      location = nullif(btrim(p->>'venue'),''), map_url = nullif(btrim(p->>'map_url'),''),
      poster_url = nullif(btrim(p->>'poster_url'),''), description = nullif(btrim(p->>'description'),''),
      attend_url = nullif(btrim(p->>'attend_url'),''),
      signup_enabled = v_on, signup_fields = v_fields, capacity = v_cap,
      run_km = coalesce(nullif(p->>'run_km','')::numeric, run_km),
      check_in_code = coalesce(check_in_code, encode(extensions.gen_random_bytes(6), 'hex')), updated_at = now()
    where id = v_id and category = 'weekend_run' and is_active
    returning * into e;
    if e.id is null then raise exception 'run_not_found'; end if;
  end if;
  return _run_admin(e);
end $function$
;

CREATE OR REPLACE FUNCTION public.attend_run(p_id uuid, p_code text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare m members; e events;
begin
  if auth.uid() is null then raise exception 'not_logged_in'; end if;
  select * into m from members where auth_user_id = auth.uid() limit 1;
  if m.id is null then raise exception 'no_member'; end if;
  select * into e from events where id = p_id and category = 'weekend_run' and is_active;
  if e.id is null then raise exception 'run_not_found'; end if;
  if e.event_date is distinct from ist_today() then raise exception 'not_today'; end if;
  if e.check_in_code is null or p_code is distinct from e.check_in_code then raise exception 'wrong_code'; end if;
  if e.attend_url is null then raise exception 'no_form'; end if;
  return json_build_object('url', e.attend_url, 'name', m.name,
    'phone', coalesce(m.sheet_key, right(regexp_replace(coalesce(m.phone,''), '\D', '', 'g'), 10)));
end $function$
;

CREATE OR REPLACE FUNCTION public.award_badge(p_phone text, p_badge text, p_by text DEFAULT NULL::text, p_note text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_member_id uuid; v_name text;
begin
  select id, name into v_member_id, v_name from public.members
  where public.norm_phone(phone) = public.norm_phone(p_phone) limit 1;
  if v_member_id is null then return json_build_object('ok',false,'error','member_not_found'); end if;
  if upper(p_badge) not in ('PACER','STRIDER','RANGER','WAYFARER','VOYAGER') then
    return json_build_object('ok',false,'error','invalid_badge');
  end if;

  insert into public.badge_awards (member_id, badge, awarded_by, note)
  values (v_member_id, upper(p_badge), p_by, p_note)
  on conflict (member_id, badge) do nothing;

  return json_build_object('ok',true,'name',v_name,'badge',upper(p_badge));
end; $function$
;

CREATE OR REPLACE FUNCTION public.badge_rank(b text)
 RETURNS integer
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select case b when 'PACER' then 1 when 'STRIDER' then 2 when 'RANGER' then 3
                when 'WAYFARER' then 4 when 'VOYAGER' then 5 else 0 end;
$function$
;

CREATE OR REPLACE FUNCTION public.badges_due()
 RETURNS TABLE(name text, phone text, total_km numeric, current_badge text, next_badge text, km_to_next numeric)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with totals as (
    select m.id, m.name, m.phone,
      m.baseline_km + coalesce((
        select sum(a.distance_km) from public.attendance a
        join public.events e on e.id=a.event_id
        where a.member_id=m.id and e.category='weekend_run'), 0) as km
    from public.members m
  ), tiers as (
    select *,
      case when km>=300 then 'VOYAGER' when km>=200 then 'WAYFARER' when km>=100 then 'RANGER'
           when km>=50 then 'STRIDER' when km>=25 then 'PACER' else '' end as current_badge,
      case when km<25 then 25 when km<50 then 50 when km<100 then 100
           when km<200 then 200 when km<300 then 300 else null end as next_threshold,
      case when km<25 then 'PACER' when km<50 then 'STRIDER' when km<100 then 'RANGER'
           when km<200 then 'WAYFARER' when km<300 then 'VOYAGER' else null end as next_badge
    from totals
  )
  select name, phone, round(km,2), current_badge, next_badge, round(next_threshold - km, 2)
  from tiers
  where next_threshold is not null and (next_threshold - km) <= 5
  order by (next_threshold - km);
$function$
;

CREATE OR REPLACE FUNCTION public.badges_pending()
 RETURNS TABLE(name text, phone text, total_km numeric, badge text, earned_but_not_awarded boolean)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with tiers(badge, threshold) as (values
    ('PACER',25),('STRIDER',50),('RANGER',100),('WAYFARER',200),('VOYAGER',300)),
  earned as (
    select l.id, l.name, l.phone, l.total_km as km, t.badge
    from leaderboard l join tiers t on l.total_km >= t.threshold)
  select e.name, e.phone, round(e.km,2), e.badge, true
  from earned e
  left join badge_awards ba on ba.member_id = e.id and ba.badge = e.badge
  where ba.id is null
  order by badge_rank(e.badge) desc, e.km desc;
$function$
;

CREATE OR REPLACE FUNCTION public.board_full()
 RETURNS TABLE(rank bigint, name text, total_km numeric, total_runs bigint, badge text, last_run date, recent numeric[])
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with weeks as (
    select generate_series(4,0,-1) as ago
  ),
  per as (
    select a.member_id,
           floor((date_trunc('week',current_date)::date - date_trunc('week',a.activity_date)::date)/7.0) as ago,
           sum(a.distance_km) as km
    from activities a
    where a.activity_date >= date_trunc('week', current_date) - interval '4 weeks'
    group by 1,2
  )
  select row_number() over (order by l.total_km desc, l.total_runs desc),
         l.name, l.total_km, l.total_runs, l.badge, l.last_run,
         array(select coalesce((select km from per p where p.member_id=l.id and p.ago=w.ago),0)
               from weeks w order by w.ago desc)
  from leaderboard l
  where l.total_km > 0
  order by l.total_km desc, l.total_runs desc;
$function$
;

CREATE OR REPLACE FUNCTION public.cancel_signup(p_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare m members; e events;
begin
  if auth.uid() is null then raise exception 'not_logged_in'; end if;
  select * into m from members where auth_user_id = auth.uid() limit 1;
  select * into e from events where id = p_id and category = 'weekend_run' and is_active;
  if e.id is null then raise exception 'run_not_found'; end if;
  update registrations set status = 'cancelled' where member_id = m.id and event_id = e.id;
  return _run_public(e);
end $function$
;

CREATE OR REPLACE FUNCTION public.check_in(p_code text, p_name text, p_phone text, p_distance numeric DEFAULT NULL::numeric, p_role text DEFAULT 'runner'::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_session public.sessions;
  v_member_id uuid;
  v_existing uuid;
  v_distance numeric;
begin
  if coalesce(trim(p_name),'') = '' or coalesce(trim(p_phone),'') = '' then
    return json_build_object('ok', false, 'error', 'missing_details');
  end if;
  if p_role not in ('runner','pacer') then p_role := 'runner'; end if;

  select * into v_session from public.sessions
  where upper(check_in_code) = upper(trim(p_code)) and is_open = true limit 1;
  if v_session.id is null then
    return json_build_object('ok', false, 'error', 'invalid_or_closed_code');
  end if;

  if p_distance is not null and p_distance >= 0 then
    v_distance := p_distance;
  else
    v_distance := coalesce(v_session.default_distance_km, 0);
  end if;

  select id into v_member_id from public.members where phone = trim(p_phone);
  if v_member_id is null then
    insert into public.members (name, phone) values (trim(p_name), trim(p_phone))
    returning id into v_member_id;
  else
    update public.members set name = trim(p_name) where id = v_member_id;
  end if;

  select id into v_existing from public.check_ins
  where session_id = v_session.id and member_id = v_member_id;

  if v_existing is not null then
    update public.check_ins set distance_km = v_distance, role = p_role where id = v_existing;
    return json_build_object('ok', true, 'already', true, 'session', v_session.title, 'distance', v_distance);
  end if;

  insert into public.check_ins (session_id, member_id, role, distance_km)
  values (v_session.id, v_member_id, p_role, v_distance);

  return json_build_object('ok', true, 'already', false, 'session', v_session.title, 'distance', v_distance);
end; $function$
;

CREATE OR REPLACE FUNCTION public.check_in_run(p_id uuid, p_code text, p_km numeric DEFAULT NULL::numeric)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare m members; e events; v_km numeric; before_km numeric; after_km numeric; was_new boolean;
begin
  if auth.uid() is null then raise exception 'not_logged_in'; end if;
  select * into m from members where auth_user_id = auth.uid() limit 1;
  if m.id is null then raise exception 'no_member'; end if;
  select * into e from events where id = p_id and category = 'weekend_run' and is_active;
  if e.id is null then raise exception 'run_not_found'; end if;
  if e.event_date is distinct from ist_today() then raise exception 'not_today'; end if;
  if e.check_in_code is null or p_code is distinct from e.check_in_code then raise exception 'wrong_code'; end if;
  v_km := round(coalesce(p_km, e.run_km), 2);
  if v_km < 0.5 or v_km > 60 then raise exception 'bad_distance'; end if;

  select total_km into before_km from leaderboard where id = m.id;
  select not exists (select 1 from activities where member_id = m.id and event_id = e.id
                     and detail in ('app check-in','admin check-in')) into was_new;
  -- exclude this run's earlier check-in from "before" so a distance fix doesn't fake a badge
  if not was_new then
    before_km := before_km - coalesce((select distance_km from activities where member_id = m.id and event_id = e.id
                                       and detail in ('app check-in','admin check-in') limit 1), 0);
  end if;

  insert into activities (member_id, category, event_id, activity_date, distance_km, detail)
  values (m.id, 'weekend_run', e.id, e.event_date, v_km, 'app check-in')
  on conflict (member_id, event_id) where detail in ('app check-in','admin check-in')
  do update set distance_km = excluded.distance_km;

  update registrations set attended = true, attended_at = coalesce(attended_at, now())
  where member_id = m.id and event_id = e.id;

  select total_km into after_km from leaderboard where id = m.id;
  return json_build_object('ok', true, 'run', e.name, 'km', v_km, 'first_time', was_new,
    'total_km', round(after_km, 2), 'badge_before', _badge(before_km), 'badge', _badge(after_km),
    'total_runs', (select total_runs from leaderboard where id = m.id));
end $function$
;

CREATE OR REPLACE FUNCTION public.club_stats()
 RETURNS json
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select json_build_object(
    'club_km',  round((select coalesce(sum(distance_km),0) from activities)
              + (select coalesce(sum(baseline_km),0) from members)),
    'runners',  (select count(*) from leaderboard where total_km > 0),
    'badges', (select json_object_agg(coalesce(badge,'none'), n) from
        (select badge, count(*) n from leaderboard where total_km>0 group by badge) b),
    'last_run', (select max(activity_date) from activities),
    'week_km',  (select coalesce(round(sum(distance_km)),0) from activities
                 where activity_date >= date_trunc('week', current_date))
  );
$function$
;

CREATE OR REPLACE FUNCTION public.confirm_registration_payment(p_registration_id uuid, p_order_id text, p_payment_id text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_reg public.registrations;
begin
  update public.registrations
  set status = 'confirmed', razorpay_order_id = p_order_id, razorpay_payment_id = p_payment_id
  where id = p_registration_id
  returning * into v_reg;

  if v_reg.id is null then
    return json_build_object('ok', false, 'error', 'registration_not_found');
  end if;
  return json_build_object('ok', true, 'pass_code', v_reg.pass_code);
end; $function$
;

CREATE OR REPLACE FUNCTION public.gen_pass_code()
 RETURNS text
 LANGUAGE plpgsql
AS $function$
declare
  alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; -- no confusable chars
  code text;
  i int;
begin
  loop
    code := 'MT-';
    for i in 1..6 loop
      code := code || substr(alphabet, floor(random()*length(alphabet))::int + 1, 1);
    end loop;
    exit when not exists (select 1 from public.registrations where pass_code = code);
  end loop;
  return code;
end; $function$
;

CREATE OR REPLACE FUNCTION public.get_profile(p_member_id uuid)
 RETURNS json
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select json_build_object(
    'name', l.name,
    'total_km', l.total_km,
    'total_runs', l.total_runs,
    'badge', l.badge,
    'last_run', l.last_run,
    'next_badge', case when l.total_km>=50 then null
                       when l.total_km>=25 then 50 - l.total_km
                       else 25 - l.total_km end,
    'longest', (select max(distance_km) from activities where member_id=l.id),
    'runs', coalesce((select json_agg(json_build_object('d',activity_date,'km',distance_km)
                                      order by activity_date desc)
                      from (select activity_date, distance_km from activities
                            where member_id=l.id order by activity_date desc limit 20) r),'[]'::json),
    'events', coalesce((select json_agg(json_build_object('name',e.name,'date',e.event_date)
                                        order by e.event_date desc)
                        from registrations rg join events e on e.id=rg.event_id
                        where rg.member_id=l.id and rg.status<>'cancelled'),'[]'::json)
  ) from leaderboard l where l.id = p_member_id;
$function$
;

CREATE OR REPLACE FUNCTION public.is_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce((select is_admin from members where auth_user_id = auth.uid() limit 1), false);
$function$
;

CREATE OR REPLACE FUNCTION public.ist_today()
 RETURNS date
 LANGUAGE sql
 STABLE
AS $function$ select (now() at time zone 'Asia/Kolkata')::date $function$
;

CREATE OR REPLACE FUNCTION public.leaderboard()
 RETURNS TABLE(name text, total_km numeric, total_runs bigint, badge text)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with runs as (
    select a.member_id,
           sum(a.distance_km) as km,
           count(*) filter (where coalesce(a.distance_km,0) > 0) as runs
    from public.attendance a
    join public.events e on e.id = a.event_id
    where e.category = 'weekend_run'
    group by a.member_id
  )
  select
    m.name,
    round(m.baseline_km + coalesce(r.km,0), 2) as total_km,
    (m.baseline_runs + coalesce(r.runs,0))::bigint as total_runs,
    case
      when m.baseline_km + coalesce(r.km,0) >= 300 then 'VOYAGER'
      when m.baseline_km + coalesce(r.km,0) >= 200 then 'WAYFARER'
      when m.baseline_km + coalesce(r.km,0) >= 100 then 'RANGER'
      when m.baseline_km + coalesce(r.km,0) >= 50  then 'STRIDER'
      when m.baseline_km + coalesce(r.km,0) >= 25  then 'PACER'
      else ''
    end as badge
  from public.members m
  left join runs r on r.member_id = m.id
  group by m.id, m.name, m.baseline_km, m.baseline_runs, r.km, r.runs
  order by total_km desc;
$function$
;

CREATE OR REPLACE FUNCTION public.list_events()
 RETURNS TABLE(id uuid, name text, category text, event_date date)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select id, name, category, event_date
  from public.events
  where is_active = true
  order by category, sort_order, event_date nulls last, name;
$function$
;

CREATE OR REPLACE FUNCTION public.log_run(p_phone text, p_name text, p_km numeric, p_code text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare s sessions; v_phone text; v_member uuid; v_total numeric;
begin
  select * into s from sessions where is_open = true order by run_date desc limit 1;
  if s.id is null then return json_build_object('ok',false,'error','Run logging is closed right now.'); end if;
  if s.check_in_code is not null and s.check_in_code <> ''
     and upper(coalesce(p_code,'')) <> upper(s.check_in_code) then
    return json_build_object('ok',false,'error','That code is not right.'); end if;
  if p_km is null or p_km <= 0 or p_km > 100 then
    return json_build_object('ok',false,'error','Enter a distance between 0 and 100 km.'); end if;

  v_phone := normalise_phone(p_phone);
  if length(v_phone) <> 10 then
    return json_build_object('ok',false,'error','That does not look like a 10-digit number.'); end if;
  if coalesce(trim(p_name),'') = '' then
    return json_build_object('ok',false,'error','Please enter your name.'); end if;

  select id into v_member from members
   where phone = v_phone and lower(name) = lower(trim(p_name));
  if v_member is null then
    insert into members (phone, name, source) values (v_phone, trim(p_name), 'run-form')
    returning id into v_member;
  end if;

  insert into activities (member_id, category, activity_date, distance_km, detail)
  values (v_member,'weekend_run', s.run_date, p_km, 'logged via site');

  select total_km into v_total from leaderboard where id = v_member;
  return json_build_object('ok',true,'name',trim(p_name),'total_km',v_total,
    'badge', case when v_total>=300 then 'VOYAGER' when v_total>=200 then 'WAYFARER'
                  when v_total>=100 then 'RANGER'  when v_total>=50  then 'STRIDER'
                  when v_total>=25  then 'PACER' end);
end $function$
;

CREATE OR REPLACE FUNCTION public.member_stats(p_phone text)
 RETURNS TABLE(name text, total_km numeric, total_runs bigint, badge text, rank bigint)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with board as (
    select m.id, m.name, m.phone,
      m.baseline_km + coalesce(sum(ci.distance_km),0) as km,
      m.baseline_runs + coalesce(count(ci.id) filter (where ci.distance_km > 0),0) as runs
    from public.members m
    left join public.check_ins ci on ci.member_id = m.id
    group by m.id, m.name, m.phone, m.baseline_km, m.baseline_runs
  ), ranked as (
    select *, rank() over (order by km desc) as rnk from board
  )
  select name, round(km,2) as total_km, runs::bigint as total_runs,
    case when km>=300 then 'VOYAGER' when km>=200 then 'WAYFARER' when km>=100 then 'RANGER'
         when km>=50 then 'STRIDER' when km>=25 then 'PACER' else '' end as badge,
    rnk::bigint as rank
  from ranked
  where right(regexp_replace(coalesce(phone,''),'[^0-9]','','g'),10)
      = right(regexp_replace(coalesce(p_phone,''),'[^0-9]','','g'),10);
$function$
;

CREATE OR REPLACE FUNCTION public.my_activity_summary(p_phone text)
 RETURNS TABLE(category text, completed bigint)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select e.category, count(*)::bigint
  from public.registrations r
  join public.events e on e.id = r.event_id
  join public.members m on m.id = r.member_id
  where public.norm_phone(m.phone) = public.norm_phone(p_phone)
    and r.attended = true
  group by e.category;
$function$
;

CREATE OR REPLACE FUNCTION public.my_badges(p_phone text)
 RETURNS TABLE(badge text, awarded_on date)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select ba.badge, ba.awarded_on
  from public.badge_awards ba
  join public.members m on m.id = ba.member_id
  where public.norm_phone(m.phone) = public.norm_phone(p_phone)
  order by public.badge_rank(ba.badge);
$function$
;

CREATE OR REPLACE FUNCTION public.my_events(p_phone text)
 RETURNS TABLE(event_name text, category text, event_date date, location text, status text, pass_code text, attended boolean, is_upcoming boolean)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select e.name, e.category, e.event_date, e.location,
         r.status, r.pass_code, r.attended,
         (e.event_date is null or e.event_date >= current_date) as is_upcoming
  from public.registrations r
  join public.events e on e.id = r.event_id
  join public.members m on m.id = r.member_id
  where public.norm_phone(m.phone) = public.norm_phone(p_phone)
  order by e.event_date nulls last;
$function$
;

CREATE OR REPLACE FUNCTION public.my_profile()
 RETURNS json
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
            order by activity_date desc limit 8) x), '[]'::json))
  from me join ranked r on r.id = me.id;
$function$
;

CREATE OR REPLACE FUNCTION public.norm_phone(p text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select nullif(right(regexp_replace(coalesce(p,''), '[^0-9]', '', 'g'), 10), '');
$function$
;

CREATE OR REPLACE FUNCTION public.normalise_phone(p text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select case when length(d)=12 and left(d,2)='91' then right(d,10)
              when length(d)=11 and left(d,1)='0'  then right(d,10)
              else d end
  from (select regexp_replace(coalesce(p,''),'\D','','g') as d) x;
$function$
;

CREATE OR REPLACE FUNCTION public.open_events()
 RETURNS TABLE(id uuid, name text, category text, event_date date, location text, price_inr numeric, description text, capacity integer, taken bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select e.id, e.name, e.category, e.event_date, e.location, e.price_inr,
         e.description, e.capacity,
         (select count(*) from registrations r where r.event_id=e.id and r.status<>'cancelled')
  from events e
  where e.is_active = true and e.registration_open = true
  order by e.event_date nulls last;
$function$
;

CREATE OR REPLACE FUNCTION public.open_session()
 RETURNS TABLE(id uuid, title text, run_date date, location text, needs_code boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select s.id, s.title, s.run_date, s.location,
         (s.check_in_code is not null and s.check_in_code <> '')
  from sessions s where s.is_open = true
  order by s.run_date desc limit 1;
$function$
;

CREATE OR REPLACE FUNCTION public.organizer_check_in(p_pass_code text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_reg public.registrations; v_event public.events; v_member public.members;
begin
  select * into v_reg from public.registrations where upper(pass_code)=upper(trim(p_pass_code));
  if v_reg.id is null then return json_build_object('ok',false,'error','pass_not_found'); end if;

  select * into v_event from public.events where id = v_reg.event_id;
  select * into v_member from public.members where id = v_reg.member_id;

  update public.registrations set attended=true, attended_at=now() where id=v_reg.id;

  insert into public.attendance (member_id, event_id, method)
  values (v_reg.member_id, v_reg.event_id, 'organizer')
  on conflict (member_id, event_id) do nothing;

  return json_build_object('ok',true,'name',v_member.name,'event',v_event.name,
                           'status',v_reg.status,'paid', v_reg.status='confirmed');
end; $function$
;

CREATE OR REPLACE FUNCTION public.otp_check(p_phone text, p_purpose text, p_hash text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare c private.otp_codes;
begin
  select * into c from private.otp_codes
  where phone = p_phone and purpose = p_purpose and used_at is null
  order by created_at desc limit 1 for update;
  if c.id is null or c.expires_at < now() then return json_build_object('ok', false, 'error', 'code_expired'); end if;
  if c.attempts >= 5 then return json_build_object('ok', false, 'error', 'too_many_attempts'); end if;
  update private.otp_codes set attempts = attempts + 1 where id = c.id;
  if c.code_hash <> p_hash then
    return json_build_object('ok', false, 'error', case when c.attempts + 1 >= 5 then 'too_many_attempts' else 'wrong_code' end,
                             'tries_left', greatest(0, 4 - c.attempts));
  end if;
  update private.otp_codes set used_at = now() where id = c.id;
  return json_build_object('ok', true);
end $function$
;

CREATE OR REPLACE FUNCTION public.otp_issue(p_phone text, p_purpose text, p_hash text, p_ip text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare last_at timestamptz; n_hour int; n_day int; n_ip int;
begin
  select max(created_at) into last_at from private.otp_codes where phone = p_phone;
  if last_at > now() - interval '30 seconds' then raise exception 'wait_before_resend'; end if;
  select count(*) filter (where created_at > now() - interval '1 hour'),
         count(*) filter (where created_at > now() - interval '1 day')
    into n_hour, n_day from private.otp_codes where phone = p_phone;
  if n_hour >= 5 or n_day >= 10 then raise exception 'too_many_codes'; end if;
  if p_ip is not null then
    select count(*) into n_ip from private.otp_codes where ip = p_ip and created_at > now() - interval '1 hour';
    if n_ip >= 30 then raise exception 'too_many_codes'; end if;
  end if;
  -- a new code replaces any earlier unused one
  update private.otp_codes set used_at = now() where phone = p_phone and purpose = p_purpose and used_at is null;
  insert into private.otp_codes (phone, purpose, code_hash, ip) values (p_phone, p_purpose, p_hash, p_ip);
  delete from private.otp_codes where created_at < now() - interval '3 days';
  return json_build_object('ok', true);
end $function$
;

CREATE OR REPLACE FUNCTION public.otp_test_config()
 RETURNS json
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
  select coalesce((select value::json from private.app_secrets where name = 'otp_test'), '{"numbers":[]}'::json);
$function$
;

CREATE OR REPLACE FUNCTION public.public_leaderboard()
 RETURNS json
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select json_build_object(
    'updated_at', now(),
    'runners', coalesce(json_agg(json_build_object('name', l.name, 'km', round(l.total_km, 2), 'runs', l.total_runs, 'badge', l.badge)
                        order by l.total_km desc, l.name), '[]'::json))
  from leaderboard l where l.total_km > 0;
$function$
;

CREATE OR REPLACE FUNCTION public.record_form_signup(p_secret text, p_form_key text, p_phone text, p_name text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare e events; m members; v_phone text; reg registrations;
begin
  if p_secret is null or p_secret is distinct from (select value from private.app_secrets where name = 'signup_hook') then
    raise exception 'bad_secret';
  end if;
  v_phone := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  if length(v_phone) = 12 and v_phone like '91%' then v_phone := substr(v_phone, 3); end if;
  if length(v_phone) = 11 and v_phone like '0%' then v_phone := substr(v_phone, 2); end if;
  if v_phone !~ '^[6-9][0-9]{9}$' then raise exception 'bad_phone'; end if;

  -- the soonest upcoming run that uses this form (a reused form counts for the next run)
  select * into e from events
  where category = 'weekend_run' and is_active and signup_form_key = p_form_key and event_date >= ist_today()
  order by event_date, start_time nulls last limit 1;
  if e.id is null then raise exception 'no_run_for_form'; end if;

  select * into m from members where sheet_key = v_phone limit 1;
  if m.id is null then
    select * into m from members where right(regexp_replace(coalesce(phone,''), '\D', '', 'g'), 10) = v_phone
    order by (auth_user_id is not null) desc, created_at limit 1;
  end if;
  if m.id is null then
    insert into members (name, phone, sheet_key, source)
    values (coalesce(nullif(btrim(p_name), ''), 'Runner ' || right(v_phone, 4)), v_phone, v_phone, 'form-signup')
    returning * into m;
  end if;

  insert into registrations (member_id, event_id, status, pass_code)
  values (m.id, e.id, 'confirmed', gen_pass_code())
  on conflict (member_id, event_id) do update set status = 'confirmed'
  returning * into reg;
  return json_build_object('ok', true, 'run', e.name, 'date', e.event_date, 'member', m.name);
end $function$
;

CREATE OR REPLACE FUNCTION public.register_for_event(p_event_id uuid, p_phone text, p_name text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare e events; v_phone text; v_member uuid; v_taken int; v_pass text; v_status text;
begin
  select * into e from events where id=p_event_id and is_active and registration_open;
  if e.id is null then return json_build_object('ok',false,'error','Registration is closed for this event.'); end if;

  v_phone := normalise_phone(p_phone);
  if length(v_phone) <> 10 then
    return json_build_object('ok',false,'error','That does not look like a 10-digit number.'); end if;
  if coalesce(trim(p_name),'') = '' then
    return json_build_object('ok',false,'error','Please enter your name.'); end if;

  select count(*) into v_taken from registrations where event_id=e.id and status<>'cancelled';
  if e.capacity is not null and v_taken >= e.capacity then
    return json_build_object('ok',false,'error','This event is full.'); end if;

  select id into v_member from members
   where phone=v_phone and lower(name)=lower(trim(p_name));
  if v_member is null then
    insert into members (phone,name,source) values (v_phone,trim(p_name),'event-form')
    returning id into v_member;
  end if;

  if exists (select 1 from registrations
             where event_id=e.id and member_id=v_member and status<>'cancelled') then
    return json_build_object('ok',false,'error','You are already registered for this one.'); end if;

  loop
    v_pass := upper(substr(md5(gen_random_uuid()::text),1,6));
    exit when not exists (select 1 from registrations where pass_code = v_pass);
  end loop;

  -- free events are confirmed at once; paid ones wait for you to see the payment
  v_status := case when coalesce(e.price_inr,0) = 0 then 'confirmed' else 'pending' end;

  insert into registrations (event_id, member_id, status, amount_inr, pass_code)
  values (e.id, v_member, v_status, e.price_inr, v_pass);

  return json_build_object('ok',true,'event',e.name,'price',e.price_inr,
                           'free', coalesce(e.price_inr,0)=0,
                           'status', v_status, 'pass_code', v_pass);
end $function$
;

CREATE OR REPLACE FUNCTION public.register_person(p_name text, p_phone text, p_email text DEFAULT NULL::text, p_category text DEFAULT NULL::text, p_event_id uuid DEFAULT NULL::uuid, p_source text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_phone text;
  v_member_id uuid;
  v_is_new boolean := false;
  v_event public.events;
begin
  if coalesce(trim(p_name),'') = '' then
    return json_build_object('ok', false, 'error', 'missing_name');
  end if;

  v_phone := public.norm_phone(p_phone);
  if v_phone is null or length(v_phone) < 10 then
    return json_build_object('ok', false, 'error', 'invalid_phone');
  end if;

  if p_category is not null and p_category not in
     ('weekend_run','fitness_workshop','community_event') then
    return json_build_object('ok', false, 'error', 'invalid_category');
  end if;

  if p_event_id is not null then
    select * into v_event from public.events
    where id = p_event_id and is_active = true limit 1;
    if v_event.id is null then
      return json_build_object('ok', false, 'error', 'invalid_event');
    end if;
  end if;

  select id into v_member_id from public.members
  where public.norm_phone(phone) = v_phone limit 1;

  if v_member_id is null then
    insert into public.members (name, phone, email, source)
    values (trim(p_name), v_phone, nullif(trim(coalesce(p_email,'')),''), p_source)
    returning id into v_member_id;
    v_is_new := true;
  else
    update public.members set
      name  = coalesce(nullif(trim(p_name),''), name),
      email = coalesce(nullif(trim(coalesce(p_email,'')),''), email)
    where id = v_member_id;
  end if;

  if p_category is not null then
    insert into public.activities (member_id, category, event_id, detail)
    values (v_member_id, coalesce(v_event.category, p_category), p_event_id, v_event.name);
  end if;

  return json_build_object(
    'ok', true,
    'is_new', v_is_new,
    'name', trim(p_name),
    'event', coalesce(v_event.name, '')
  );
end; $function$
;

CREATE OR REPLACE FUNCTION public.run_check_in(p_code text, p_name text, p_phone text, p_distance numeric DEFAULT NULL::numeric)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_event public.events;
  v_phone text; v_member_id uuid; v_existing uuid; v_distance numeric;
begin
  v_phone := public.norm_phone(p_phone);
  if coalesce(trim(p_name),'')='' then return json_build_object('ok',false,'error','missing_name'); end if;
  if v_phone is null or length(v_phone)<10 then return json_build_object('ok',false,'error','invalid_phone'); end if;

  select * into v_event from public.events
  where upper(check_in_code) = upper(trim(p_code)) and check_in_open = true limit 1;
  if v_event.id is null then return json_build_object('ok',false,'error','code_not_live'); end if;

  if p_distance is not null and p_distance >= 0 then v_distance := p_distance;
  else v_distance := 5; end if;

  select id into v_member_id from public.members where public.norm_phone(phone)=v_phone limit 1;
  if v_member_id is null then
    insert into public.members (name, phone) values (trim(p_name), v_phone) returning id into v_member_id;
  else
    update public.members set name = trim(p_name) where id = v_member_id;
  end if;

  select id into v_existing from public.attendance where member_id=v_member_id and event_id=v_event.id;
  if v_existing is not null then
    update public.attendance set distance_km = v_distance where id = v_existing;
    return json_build_object('ok',true,'already',true,'event',v_event.name,'distance',v_distance);
  end if;

  insert into public.attendance (member_id, event_id, distance_km, method)
  values (v_member_id, v_event.id, v_distance, 'self');
  return json_build_object('ok',true,'already',false,'event',v_event.name,'distance',v_distance);
end; $function$
;

CREATE OR REPLACE FUNCTION public.run_detail(p_id uuid)
 RETURNS json
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select _run_public(e) from events e
  where e.id = p_id and e.category = 'weekend_run' and e.is_active;
$function$
;

CREATE OR REPLACE FUNCTION public.runs_needing_form_key()
 RETURNS TABLE(id uuid, signup_url text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select id, signup_url from events
  where category = 'weekend_run' and is_active and event_date >= ist_today()
    and signup_url is not null and signup_form_key is null;
$function$
;

CREATE OR REPLACE FUNCTION public.set_form_key(p_id uuid, p_key text)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  update events set signup_form_key = p_key where id = p_id;
$function$
;

CREATE OR REPLACE FUNCTION public.set_my_avatar(p_url text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare prefix text := 'https://lligzqocyumszoecszyf.supabase.co/storage/v1/object/public/avatars/' || auth.uid()::text || '/';
begin
  if auth.uid() is null then raise exception 'not_logged_in'; end if;
  if p_url is not null and left(p_url, length(prefix)) <> prefix then raise exception 'bad_link'; end if;
  update members set avatar_url = p_url where auth_user_id = auth.uid();
  return json_build_object('avatar_url', p_url);
end $function$
;

CREATE OR REPLACE FUNCTION public.sign_up_for_run(p_id uuid, p_answers jsonb DEFAULT '{}'::jsonb)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare m members; e events; f jsonb; v text; picks jsonb; clean jsonb := '{}'::jsonb; taken int; existing registrations;
begin
  if auth.uid() is null then raise exception 'not_logged_in'; end if;
  select * into m from members where auth_user_id = auth.uid() limit 1;
  if m.id is null then raise exception 'no_member'; end if;
  select * into e from events where id = p_id and category = 'weekend_run' and is_active for update;
  if e.id is null then raise exception 'run_not_found'; end if;
  if e.event_date < ist_today() then raise exception 'run_over'; end if;
  if not e.signup_enabled then raise exception 'signups_closed'; end if;

  for f in select * from jsonb_array_elements(e.signup_fields) loop
    if f->>'type' = 'checkboxes' then
      picks := p_answers -> (f->>'id');
      if picks is null or jsonb_typeof(picks) <> 'array' then picks := '[]'::jsonb; end if;
      -- keep only real options, in the admin's order
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
  if e.capacity is not null and (existing.id is null or existing.status <> 'confirmed') then
    select count(*) into taken from registrations where event_id = e.id and status = 'confirmed';
    if taken >= e.capacity then raise exception 'run_full'; end if;
  end if;

  insert into registrations (member_id, event_id, status, pass_code, answers)
  values (m.id, e.id, 'confirmed', gen_pass_code(), clean)
  on conflict (member_id, event_id) do update set status = 'confirmed', answers = excluded.answers;
  return _run_public(e);
end $function$
;

CREATE OR REPLACE FUNCTION public.start_registration(p_name text, p_phone text, p_email text DEFAULT NULL::text, p_event_id uuid DEFAULT NULL::uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_phone text;
  v_member_id uuid;
  v_event public.events;
  v_reg public.registrations;
  v_taken int;
begin
  v_phone := public.norm_phone(p_phone);
  if coalesce(trim(p_name),'') = '' then
    return json_build_object('ok', false, 'error', 'missing_name');
  end if;
  if v_phone is null or length(v_phone) < 10 then
    return json_build_object('ok', false, 'error', 'invalid_phone');
  end if;

  select * into v_event from public.events where id = p_event_id and is_active = true;
  if v_event.id is null then
    return json_build_object('ok', false, 'error', 'invalid_event');
  end if;

  -- upsert the person (same phone-keyed rule as everywhere else)
  select id into v_member_id from public.members
  where public.norm_phone(phone) = v_phone limit 1;

  if v_member_id is null then
    insert into public.members (name, phone, email)
    values (trim(p_name), v_phone, nullif(trim(coalesce(p_email,'')),''))
    returning id into v_member_id;
  else
    update public.members set
      name  = coalesce(nullif(trim(p_name),''), name),
      email = coalesce(nullif(trim(coalesce(p_email,'')),''), email)
    where id = v_member_id;
  end if;

  -- already signed up? hand back the existing pass instead of a duplicate
  select * into v_reg from public.registrations
  where member_id = v_member_id and event_id = v_event.id;

  if v_reg.id is not null then
    return json_build_object(
      'ok', true, 'already', true,
      'status', v_reg.status,
      'pass_code', v_reg.pass_code,
      'event', v_event.name,
      'amount', v_reg.amount_inr
    );
  end if;

  if not v_event.registration_open then
    return json_build_object('ok', false, 'error', 'registration_closed');
  end if;

  if v_event.capacity is not null then
    select count(*) into v_taken from public.registrations
    where event_id = v_event.id and status = 'confirmed';
    if v_taken >= v_event.capacity then
      return json_build_object('ok', false, 'error', 'event_full');
    end if;
  end if;

  insert into public.registrations (member_id, event_id, amount_inr, pass_code, status)
  values (v_member_id, v_event.id, v_event.price_inr, public.gen_pass_code(),
          case when v_event.price_inr > 0 then 'pending' else 'confirmed' end)
  returning * into v_reg;

  return json_build_object(
    'ok', true, 'already', false,
    'status', v_reg.status,
    'registration_id', v_reg.id,
    'pass_code', v_reg.pass_code,
    'event', v_event.name,
    'amount', v_reg.amount_inr
  );
end; $function$
;

CREATE OR REPLACE FUNCTION public.sync_from_sheet(p jsonb)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  r record; v_id uuid; v_phone text;
  v_new int := 0; v_renamed int := 0; v_deleted int := 0; v_inserted int := 0; v_unmatched int := 0;
  v_summary jsonb;
begin
  -- 1. One member per sheet key: adopt an existing record, else create one.
  for r in select x->>'key' as key, nullif(trim(x->>'name'),'') as name
           from jsonb_array_elements(p->'people') x where coalesce(x->>'key','') <> '' loop
    select id into v_id from members where sheet_key = r.key;
    if v_id is null then
      v_phone := case when r.key like 'name:%' then replace(r.key,' ','_') else r.key end;
      select id into v_id from members
       where sheet_key is null and phone = v_phone and lower(name) = lower(coalesce(r.name,''))
       limit 1;
      if v_id is null then
        select id into v_id from members
         where sheet_key is null and phone = v_phone
         order by baseline_km desc, created_at limit 1;
      end if;
      if v_id is null then
        insert into members (name, phone, source, sheet_key)
        values (coalesce(r.name, r.key), v_phone, 'sheet-sync', r.key) returning id into v_id;
        v_new := v_new + 1;
      else
        update members set sheet_key = r.key where id = v_id;
      end if;
    end if;
    -- keep the name in step with the sheet, unless it would collide with another record
    update members m set name = r.name
     where m.id = v_id and r.name is not null and m.name is distinct from r.name
       and not exists (select 1 from members o where o.id <> m.id and o.phone = m.phone
                       and lower(o.name) = lower(r.name));
    if found then v_renamed := v_renamed + 1; end if;
  end loop;

  -- 2. Baselines mirror the Baseline tab (0 for anyone not on it).
  update members m set baseline_km = coalesce(b.km, 0), baseline_runs = coalesce(b.runs, 0)
  from (select m2.id, (x->>'km')::numeric km, (x->>'runs')::numeric::int runs
        from members m2
        left join jsonb_array_elements(p->'baseline') x on x->>'key' = m2.sheet_key
        where m2.sheet_key is not null) b
  where m.id = b.id;

  -- 3. Rebuild sheet-sourced runs from the Log. App-logged runs are never touched.
  delete from activities where category = 'weekend_run' and detail in ('5k tracker import','sheet-sync');
  get diagnostics v_deleted = row_count;

  insert into activities (member_id, category, activity_date, distance_km, detail)
  select m.id, 'weekend_run', (x->>'date')::date, (x->>'km')::numeric, 'sheet-sync'
  from jsonb_array_elements(p->'log') x
  join members m on m.sheet_key = x->>'key'
  where nullif(x->>'km','') is not null and (x->>'km')::numeric <> 0
    and not exists (select 1 from activities a where a.member_id = m.id and a.activity_date = (x->>'date')::date
                    and a.detail in ('app check-in','admin check-in'));
  get diagnostics v_inserted = row_count;

  select count(*) into v_unmatched
  from jsonb_array_elements(p->'log') x
  where nullif(x->>'km','') is not null and (x->>'km')::numeric <> 0
    and not exists (select 1 from members m where m.sheet_key = x->>'key');

  v_summary := jsonb_build_object(
    'new_members', v_new, 'renamed', v_renamed,
    'runs_removed', v_deleted, 'runs_inserted', v_inserted, 'unmatched_rows', v_unmatched,
    'latest_run', (select max(activity_date) from activities where detail = 'sheet-sync'),
    'members', (select count(*) from members),
    'total_km', (select round(sum(total_km),2) from leaderboard));
  insert into sync_runs (summary) values (v_summary);
  return v_summary;
end $function$
;

CREATE OR REPLACE FUNCTION public.top_runners(p_limit integer DEFAULT 25)
 RETURNS TABLE(rank bigint, name text, total_km numeric, total_runs bigint, badge text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select row_number() over (order by total_km desc), name, total_km, total_runs, badge
  from leaderboard where total_km > 0 order by total_km desc limit p_limit;
$function$
;

CREATE OR REPLACE FUNCTION public.upcoming_runs()
 RETURNS json
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(json_agg(_run_public(e) order by e.event_date, e.start_time nulls last), '[]'::json)
  from events e
  where e.category = 'weekend_run' and e.is_active and e.event_date >= ist_today();
$function$
;

CREATE OR REPLACE FUNCTION public.who_is(p_phone text)
 RETURNS TABLE(member_id uuid, name text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select m.id, m.name from members m
  where m.phone = normalise_phone(p_phone) order by m.name;
$function$
;

-- Ongoing programs: once the first class date has passed, a program is "ongoing" — listed separately,
-- sign-ups closed (unless late_join), check-in only for people who signed up and only on class days.
-- class_dates is optional: when set, it defines the class days (and the class count); when empty, any day from the start counts.

alter table events add column if not exists class_dates date[];
alter table events add column if not exists late_join boolean not null default false;

create or replace function public._program_started(e events) returns boolean
language sql stable set search_path to 'public' as $$
  select e.category = 'program' and e.ended_at is null and e.event_date <= ist_today();
$$;

-- Is today a class day for this program?
create or replace function public._class_day(e events, d date default null) returns boolean
language sql stable set search_path to 'public' as $$
  select case when e.class_dates is null or cardinality(e.class_dates) = 0 then coalesce(d, ist_today()) >= e.event_date
              else coalesce(d, ist_today()) = any (e.class_dates) end;
$$;

create or replace function public._next_class(e events) returns date
language sql stable set search_path to 'public' as $$
  select min(d) from unnest(coalesce(e.class_dates, '{}'::date[])) d where d >= ist_today();
$$;

create or replace function public._check_in_live(e events) returns boolean
language sql stable set search_path to 'public' as $$
  select e.ended_at is null and e.check_in_code is not null
     and case when e.category = 'program' then e.event_date <= ist_today() and _class_day(e) else e.event_date = ist_today() end
$$;

create or replace function public._run_public(e events) returns json
language sql stable set search_path to 'public' as $$
  with me as (select id from members where auth.uid() is not null and auth_user_id = auth.uid() limit 1),
  mine as (select r.* from registrations r join me on me.id = r.member_id
           where r.event_id = e.id and r.status in ('pending','confirmed') and _visible_signup(r, e) limit 1),
  ci as (select a.activity_date, a.distance_km from activities a join me on me.id = a.member_id
         where a.event_id = e.id and a.detail in ('app check-in','admin check-in'))
  select json_build_object(
    'id', e.id, 'name', e.name, 'date', e.event_date,
    'kind', _kind(e.category),
    'time', to_char(e.start_time, 'HH24:MI'),
    'venue', e.location, 'map_url', e.map_url, 'poster_url', e.poster_url,
    'description', e.description, 'run_km', e.run_km,
    'price', coalesce(e.price_inr, 0), 'payment_qr_url', e.payment_qr_url, 'upi_id', e.upi_id,
    'payment_mode', coalesce(e.payment_mode, 'manual'),
    'pay_at_venue', e.pay_at_venue,
    'checkin_mode', e.checkin_mode,
    'published', e.published,
    'discounts_allowed', e.discounts_allowed,
    'is_today', e.event_date = ist_today(),
    'is_past', _is_past(e),
    'ended', e.ended_at is not null,
    'ended_on', (e.ended_at at time zone 'Asia/Kolkata')::date,
    'started', _program_started(e),
    'late_join', e.late_join,
    'class_dates', coalesce(to_json(e.class_dates), '[]'::json),
    'next_class', _next_class(e),
    'class_today', e.category = 'program' and e.event_date <= ist_today() and e.ended_at is null and _class_day(e),
    'signups_open', e.signup_enabled and not _is_past(e) and (not _program_started(e) or e.late_join),
    'check_in_live', _check_in_live(e),
    'can_attend', e.check_in_code is not null,
    'classes', e.classes,
    'badge', _badge_json(e.badge_id),
    'signup_enabled', e.signup_enabled,
    'signup_fields', e.signup_fields,
    'capacity', e.capacity,
    'spots_left', case when e.capacity is null then null else greatest(0, e.capacity - _spots_taken(e)) end,
    'signed_up', exists (select 1 from mine where status = 'confirmed'),
    'my_status', (select status from mine),
    'my_answers', (select answers from mine),
    'my_payment', (select payment_status from mine),
    'my_ticket', (select pass_code from mine),
    'my_test', coalesce((select is_test from mine), false),
    'my_price', coalesce((select _due(mine, e) from mine), coalesce(e.price_inr, 0)),
    'my_discount', (select case when mine.discount_pct > 0 then json_build_object('key', mine.discount_badge, 'name', _discount_name(mine.discount_badge), 'pct', mine.discount_pct) end from mine),
    'my_discounts', case when coalesce(e.price_inr, 0) > 0 and e.discounts_allowed and exists (select 1 from me)
                         then (select _member_discounts(me.id) from me) else '[]'::jsonb end,
    'my_classes', (select count(*) from ci),
    'my_badge_earned', e.badge_id is not null and exists (select 1 from badge_awards ba join me on me.id = ba.member_id where ba.badge_id = e.badge_id),
    'my_checkin_km', (select distance_km from ci order by activity_date desc limit 1),
    'checked_in', case when e.category = 'program' then exists (select 1 from ci where activity_date = ist_today())
                       else exists (select 1 from ci) end);
$$;

-- Sign-up: closed once a program has started, unless late joining is allowed.
create or replace function public.sign_up_for_run(p_id uuid, p_answers jsonb default '{}'::jsonb, p_venue boolean default false, p_discount text default null) returns json
language plpgsql security definer set search_path to 'public' as $$
declare m members; e events; f jsonb; v text; picks jsonb; clean jsonb := '{}'::jsonb; existing registrations; v_status text; v_pay text;
  v_disc text := nullif(btrim(coalesce(p_discount, '')), ''); v_pct int := 0; d jsonb; v_due numeric;
begin
  if auth.uid() is null then raise exception 'not_logged_in'; end if;
  select * into m from members where auth_user_id = auth.uid() limit 1;
  if m.id is null then raise exception 'no_member'; end if;
  select * into e from events where id = p_id and _app_event(category) and is_active for update;
  if e.id is null then raise exception 'run_not_found'; end if;
  if _is_past(e) then raise exception 'run_over'; end if;
  if not e.signup_enabled then raise exception 'signups_closed'; end if;
  select * into existing from registrations where member_id = m.id and event_id = e.id;
  if _program_started(e) and not e.late_join and not (existing.id is not null and existing.status in ('pending','confirmed')) then
    raise exception 'program_started';
  end if;
  if p_venue and not (coalesce(e.price_inr, 0) > 0 and e.payment_mode = 'online' and e.pay_at_venue) then raise exception 'venue_not_allowed'; end if;
  if v_disc is not null then
    if coalesce(e.price_inr, 0) <= 0 or not e.discounts_allowed then raise exception 'discounts_off'; end if;
    select x into d from jsonb_array_elements(_member_discounts(m.id)) x where x->>'key' = v_disc;
    if d is null then raise exception 'bad_discount'; end if;
    v_pct := (d->>'pct')::int;
  end if;
  v_due := greatest(0, round(coalesce(e.price_inr, 0) * (100 - v_pct) / 100.0));

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
    if f->>'type' = 'file' then
      if v !~ ('^' || auth.uid()::text || '/' || e.id::text || '/[A-Za-z0-9._-]{1,120}$')
         or not exists (select 1 from storage.objects o where o.bucket_id = 'signup-files' and o.name = v) then
        raise exception 'bad_file';
      end if;
      clean := clean || jsonb_build_object(f->>'id', v);
      continue;
    end if;
    if length(v) > 1000 then raise exception 'answer_too_long'; end if;
    if f->>'type' = 'number' and v !~ '^-?[0-9]+(\.[0-9]+)?$' then raise exception 'answer_not_number'; end if;
    if f->>'type' = 'choice' and not (coalesce(f->'options','[]'::jsonb) ? v) then raise exception 'answer_bad_choice'; end if;
    if f->>'type' = 'yes_no' and v not in ('Yes','No') then raise exception 'answer_bad_choice'; end if;
    clean := clean || jsonb_build_object(f->>'id', v);
  end loop;

  if existing.id is not null and existing.status in ('pending','confirmed') then
    if existing.status = 'confirmed' or existing.payment_status in ('venue','claimed') or (e.payment_mode <> 'online' and existing.payment_status <> 'none') then
      update registrations set answers = clean where id = existing.id;
      return _run_public(e);
    end if;
    if e.payment_mode <> 'online' then
      update registrations set answers = clean, discount_badge = v_disc, discount_pct = v_pct where id = existing.id;
      return _run_public(e);
    end if;
    if not _holds_spot(existing, e) and e.capacity is not null and _spots_taken(e) >= e.capacity then raise exception 'run_full'; end if;
    update registrations set answers = clean, pending_since = now(), discount_badge = v_disc, discount_pct = v_pct,
      payment_status = case when v_due = 0 then 'confirmed' when p_venue then 'venue' else payment_status end,
      status = case when v_due = 0 then 'confirmed' else status end
      where id = existing.id;
    return _run_public(e);
  end if;

  if e.capacity is not null and _spots_taken(e) >= e.capacity then raise exception 'run_full'; end if;

  v_status := case when v_due > 0 then 'pending' else 'confirmed' end;
  v_pay := case when v_due = 0 and coalesce(e.price_inr, 0) > 0 then 'confirmed' when p_venue then 'venue' else 'none' end;
  insert into registrations (member_id, event_id, status, pass_code, answers, payment_status, pending_since, is_test, discount_badge, discount_pct, amount_inr)
  values (m.id, e.id, v_status, gen_pass_code(), clean, v_pay, now(), not e.published, v_disc, v_pct, 0)
  on conflict (member_id, event_id) do update set status = excluded.status, answers = excluded.answers,
    payment_status = excluded.payment_status, pending_since = now(), razorpay_order_id = null, razorpay_payment_id = null,
    attended = false, attended_at = null, is_test = excluded.is_test,
    discount_badge = excluded.discount_badge, discount_pct = excluded.discount_pct, amount_inr = 0;
  return _run_public(e);
end $$;

-- Check-in: programs need a sign-up and a class day.
create or replace function public.check_in_run(p_id uuid, p_code text, p_km numeric default null) returns json
language plpgsql security definer set search_path to 'public' as $$
declare m members; e events; v_km numeric; before_km numeric; after_km numeric; was_new boolean; is_run boolean;
  v_day date; had_badge boolean; has_badge boolean;
begin
  if auth.uid() is null then raise exception 'not_logged_in'; end if;
  select * into m from members where auth_user_id = auth.uid() limit 1;
  if m.id is null then raise exception 'no_member'; end if;
  select * into e from events where id = p_id and _app_event(category) and is_active;
  if e.id is null then raise exception 'run_not_found'; end if;
  if e.ended_at is not null then raise exception 'event_ended'; end if;
  if e.checkin_mode = 'ticket' then raise exception 'ticket_only'; end if;
  if e.category = 'program' then
    if e.event_date > ist_today() then raise exception 'program_not_started'; end if;
    if not exists (select 1 from registrations r where r.member_id = m.id and r.event_id = e.id
                     and r.status in ('pending','confirmed') and _visible_signup(r, e)) then raise exception 'program_not_joined'; end if;
    if not _class_day(e) then raise exception 'not_class_day'; end if;
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
                                       and activity_date = v_day and detail in ('app check-in','admin check-in') and not is_test limit 1), 0);
  end if;
  had_badge := e.badge_id is not null and exists (select 1 from badge_awards where member_id = m.id and badge_id = e.badge_id);

  insert into activities (member_id, category, event_id, activity_date, distance_km, detail, is_test)
  values (m.id, e.category, e.id, v_day, v_km, 'app check-in', not e.published)
  on conflict (member_id, event_id, activity_date) where detail in ('app check-in','admin check-in')
  do update set distance_km = excluded.distance_km, is_test = excluded.is_test;

  update registrations set attended = true, attended_at = coalesce(attended_at, now())
  where member_id = m.id and event_id = e.id;

  if e.category = 'program' then
    perform _program_award(e.id, m.id);
    has_badge := e.badge_id is not null and exists (select 1 from badge_awards where member_id = m.id and badge_id = e.badge_id);
    return json_build_object('ok', true, 'run', e.name, 'kind', 'program', 'first_time', was_new,
      'classes', e.classes,
      'done', (select count(*) from activities where member_id = m.id and event_id = e.id and detail in ('app check-in','admin check-in')),
      'badge', _badge_json(e.badge_id), 'badge_earned', has_badge and not had_badge, 'test', not e.published,
      'next_class', (select min(d) from unnest(coalesce(e.class_dates, '{}'::date[])) d where d > ist_today()));
  end if;

  select total_km into after_km from leaderboard where id = m.id;
  return json_build_object('ok', true, 'run', e.name, 'kind', _kind(e.category),
    'km', v_km, 'first_time', was_new, 'total_km', round(after_km, 2), 'test', not e.published,
    'badge_before', _badge(before_km), 'badge', _badge(after_km),
    'total_runs', (select total_runs from leaderboard where id = m.id));
end $$;

-- Admin add-by-number: the date must be a class day when dates are set.
create or replace function public.admin_add_attendee(p_id uuid, p_phone text, p_km numeric default null, p_name text default null, p_date date default null) returns json
language plpgsql security definer set search_path to 'public' as $$
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
    if v_day < e.event_date or v_day > ist_today() or not _class_day(e, v_day) then raise exception 'bad_class_date'; end if;
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
  insert into activities (member_id, category, event_id, activity_date, distance_km, detail, is_test)
  values (m.id, e.category, e.id, v_day, v_km, 'admin check-in', not e.published)
  on conflict (member_id, event_id, activity_date) where detail in ('app check-in','admin check-in')
  do update set distance_km = excluded.distance_km, is_test = excluded.is_test;
  update registrations set attended = true, attended_at = coalesce(attended_at, now()) where member_id = m.id and event_id = e.id;
  perform _program_award(e.id, m.id);
  return _run_admin(e);
end $$;

-- Profile Upcoming: ongoing programs carry their next class.
create or replace function public.my_profile() returns json
language sql stable security definer set search_path to 'public' as $$
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
    'discounts', (select _member_discounts(me.id) from me),
    'upcoming', coalesce((
      select json_agg(json_build_object('id', e.id, 'name', e.name, 'kind', _kind(e.category), 'date', e.event_date,
                                        'time', to_char(e.start_time, 'HH24:MI'), 'venue', e.location, 'poster_url', e.poster_url,
                                        'ticket', g.pass_code, 'status', g.status, 'payment', g.payment_status,
                                        'price', coalesce(e.price_inr, 0), 'due', _due(g, e), 'discount_pct', g.discount_pct,
                                        'checkin_mode', e.checkin_mode, 'test', g.is_test,
                                        'is_today', e.event_date = ist_today(), 'classes', e.classes,
                                        'started', _program_started(e), 'next_class', _next_class(e),
                                        'class_today', e.category = 'program' and e.event_date <= ist_today() and _class_day(e),
                                        'my_classes', (select count(*) from activities a where a.member_id = me.id and a.event_id = e.id and a.detail in ('app check-in','admin check-in')))
                      order by e.event_date, e.start_time nulls last)
      from registrations g join events e on e.id = g.event_id
      where g.member_id = me.id and g.status in ('pending','confirmed') and _visible_signup(g, e)
        and e.is_active and _app_event(e.category) and not _is_past(e)), '[]'::json),
    'recent', coalesce((
      select json_agg(json_build_object('date', x.activity_date, 'km', x.distance_km))
      from (select activity_date, distance_km from activities
            where member_id = me.id and category = 'weekend_run' and distance_km > 0 and not is_test
            order by activity_date desc limit 8) x), '[]'::json),
    'badges', coalesce((
      select json_agg(json_build_object('name', b.name, 'image_url', b.image_url, 'on', ba.awarded_on, 'from', ba.note, 'discount_pct', b.discount_pct)
                      order by ba.awarded_on desc, ba.created_at desc)
      from badge_awards ba join badges b on b.id = ba.badge_id where ba.member_id = me.id), '[]'::json),
    'attended', coalesce((
      select json_agg(json_build_object('id', x.id, 'name', x.name, 'kind', x.kind, 'classes', x.classes,
                                        'count', x.n, 'first', x.first, 'last', x.last) order by x.last desc)
      from (select e.id, e.name, _kind(e.category) kind, e.classes, count(*) n,
                   min(a.activity_date) first, max(a.activity_date) last
            from activities a join events e on e.id = a.event_id
            where a.member_id = me.id and a.detail in ('app check-in','admin check-in') and e.category <> 'weekend_run' and not a.is_test
            group by e.id, e.name, e.category, e.classes) x), '[]'::json))
  from me join ranked r on r.id = me.id;
$$;

-- Event save: class dates and late joining for programs.
create or replace function public.admin_save_run(p jsonb) returns json
language plpgsql security definer set search_path to 'public' as $$
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
  v_mode text := case when p->>'payment_mode' = 'online' then 'online' else 'manual' end;
  v_venue boolean := coalesce((p->>'pay_at_venue')::boolean, false);
  v_checkin text := case when p->>'checkin_mode' in ('venue_qr','ticket','both') then p->>'checkin_mode' else 'venue_qr' end;
  v_pub boolean := coalesce((p->>'published')::boolean, true);
  v_disc boolean := coalesce((p->>'discounts_allowed')::boolean, true);
  v_late boolean := coalesce((p->>'late_join')::boolean, false);
  v_dates date[] := null;
  v_was_pub boolean;
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
    if jsonb_typeof(p->'class_dates') = 'array' then
      select array_agg(distinct d order by d) into v_dates
        from (select nullif(btrim(x), '')::date d from jsonb_array_elements_text(p->'class_dates') x) y where d is not null;
      if v_dates is not null and cardinality(v_dates) = 0 then v_dates := null; end if;
    end if;
    if v_dates is not null then
      if v_dates[1] < v_date then raise exception 'bad_class_date'; end if;
      v_classes := cardinality(v_dates);
    end if;
    if v_classes is null or v_classes < 1 or v_classes > 100 then raise exception 'classes_required'; end if;
    if v_badge is not null and not exists (select 1 from badges where id = v_badge) then raise exception 'badge_not_found'; end if;
  else
    v_classes := null; v_badge := null; v_dates := null; v_late := false;
  end if;
  if v_mode = 'online' and v_price > 0 and v_price < 1 then raise exception 'bad_price'; end if;
  if v_mode <> 'online' or v_price = 0 then v_venue := false; end if;
  if v_id is null then
    insert into events (name, category, event_date, start_time, location, map_url, poster_url, description,
                        check_in_code, registration_open, signup_enabled, signup_fields, capacity, run_km,
                        price_inr, payment_qr_url, upi_id, classes, badge_id, payment_mode, pay_at_venue, checkin_mode, published, discounts_allowed,
                        class_dates, late_join)
    values (v_name, v_cat, v_date, nullif(p->>'time','')::time, nullif(btrim(p->>'venue'),''),
            nullif(btrim(p->>'map_url'),''), nullif(btrim(p->>'poster_url'),''), nullif(btrim(p->>'description'),''),
            encode(extensions.gen_random_bytes(6), 'hex'), true, v_on, v_fields, v_cap,
            coalesce(nullif(p->>'run_km','')::numeric, 5), v_price, nullif(btrim(p->>'payment_qr_url'),''), v_upi,
            v_classes, v_badge, v_mode, v_venue, v_checkin, v_pub, v_disc, v_dates, v_late)
    returning * into e;
  else
    select published into v_was_pub from events where id = v_id;
    update events set name = v_name, category = v_cat, event_date = v_date, start_time = nullif(p->>'time','')::time,
      location = nullif(btrim(p->>'venue'),''), map_url = nullif(btrim(p->>'map_url'),''),
      poster_url = nullif(btrim(p->>'poster_url'),''), description = nullif(btrim(p->>'description'),''),
      signup_enabled = v_on, signup_fields = v_fields, capacity = v_cap,
      run_km = coalesce(nullif(p->>'run_km','')::numeric, run_km),
      price_inr = v_price, payment_qr_url = nullif(btrim(p->>'payment_qr_url'),''), upi_id = v_upi,
      classes = v_classes, badge_id = v_badge, payment_mode = v_mode, pay_at_venue = v_venue, checkin_mode = v_checkin,
      published = v_pub, discounts_allowed = v_disc, class_dates = v_dates, late_join = v_late,
      check_in_code = coalesce(check_in_code, encode(extensions.gen_random_bytes(6), 'hex')), updated_at = now()
    where id = v_id and _app_event(category) and is_active
    returning * into e;
    if e.id is null then raise exception 'run_not_found'; end if;
    if v_pub and not coalesce(v_was_pub, true) then
      if coalesce((p->>'keep_tests')::boolean, false) then
        update registrations set is_test = false where event_id = e.id and is_test;
        update activities set is_test = false where event_id = e.id and is_test;
      else
        delete from activities where event_id = e.id and is_test;
        delete from wa_outbox where registration_id in (select id from registrations where event_id = e.id and is_test);
        delete from registrations where event_id = e.id and is_test;
      end if;
    end if;
    perform _program_sync(e.id);
  end if;
  return _run_admin(e);
end $$;

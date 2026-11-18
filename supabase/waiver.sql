-- Participation terms (waiver): one text, versioned by its md5. Members accept once per version,
-- at sign-up or at first check-in. Events can opt out with waiver_required = false.

alter table events add column if not exists waiver_required boolean not null default true;
alter table members add column if not exists waiver_accepted_at timestamptz;
alter table members add column if not exists waiver_version text;

insert into app_settings (key, value) values ('waiver_text',
$t$Running, strength and movement sessions carry a real risk of injury: falls, sprains, strains, dehydration, heat-related illness and, rarely, more serious harm. Mvmnt Tribe plans routes, warm-ups and sessions with care, but we can't remove that risk.

By taking part I confirm that I'm choosing to participate voluntarily, that I'm fit enough to do so and will stop if I feel unwell, that I'll tell the organiser about any injury or medical condition that matters, that I'll follow the organiser's instructions and traffic rules, and that I take responsibility for my own safety and belongings. In an emergency I consent to the organisers arranging first aid or medical help on my behalf.$t$)
on conflict (key) do nothing;

create or replace function public._waiver_version() returns text
language sql stable set search_path to 'public' as $$
  select md5(coalesce((select value from app_settings where key = 'waiver_text'), ''));
$$;

create or replace function public._waiver_ok(m members) returns boolean
language sql stable set search_path to 'public' as $$
  select m.waiver_accepted_at is not null and m.waiver_version = _waiver_version();
$$;

-- The current terms, and whether the caller has agreed to this version.
create or replace function public.waiver() returns json
language sql stable security definer set search_path to 'public' as $$
  select json_build_object(
    'text', coalesce((select value from app_settings where key = 'waiver_text'), ''),
    'version', _waiver_version(),
    'accepted', coalesce((select _waiver_ok(m) from members m where m.auth_user_id = auth.uid() limit 1), false),
    'accepted_at', (select m.waiver_accepted_at from members m where m.auth_user_id = auth.uid() and _waiver_ok(m) limit 1));
$$;
grant execute on function public.waiver() to anon, authenticated;

create or replace function public.accept_waiver(p_version text) returns json
language plpgsql security definer set search_path to 'public' as $$
declare m members;
begin
  if auth.uid() is null then raise exception 'not_logged_in'; end if;
  select * into m from members where auth_user_id = auth.uid() limit 1;
  if m.id is null then raise exception 'no_member'; end if;
  if p_version is distinct from _waiver_version() then raise exception 'waiver_changed'; end if;
  update members set waiver_accepted_at = now(), waiver_version = p_version where id = m.id;
  return json_build_object('ok', true, 'accepted_at', now());
end $$;
grant execute on function public.accept_waiver(text) to authenticated;

-- Admin: read/update the text; a text change makes everyone agree again.
create or replace function public.admin_waiver() returns json
language plpgsql stable security definer set search_path to 'public' as $$
begin
  if not is_admin() then raise exception 'not_admin'; end if;
  return json_build_object(
    'text', coalesce((select value from app_settings where key = 'waiver_text'), ''),
    'version', _waiver_version(),
    'updated_at', (select updated_at from app_settings where key = 'waiver_text'),
    'agreed', (select count(*) from members m where _waiver_ok(m)),
    'members', (select count(*) from members where auth_user_id is not null));
end $$;

create or replace function public.admin_set_waiver(p_text text) returns json
language plpgsql security definer set search_path to 'public' as $$
begin
  if not is_admin() then raise exception 'not_admin'; end if;
  if length(btrim(coalesce(p_text, ''))) < 20 then raise exception 'waiver_too_short'; end if;
  if length(p_text) > 5000 then raise exception 'waiver_too_long'; end if;
  insert into app_settings (key, value, updated_at) values ('waiver_text', btrim(p_text), now())
  on conflict (key) do update set value = excluded.value, updated_at = now();
  return admin_waiver();
end $$;
grant execute on function public.admin_waiver() to authenticated;
grant execute on function public.admin_set_waiver(text) to authenticated;


-- Enforcement (applied after the app that shows the tick box is deployed)

create or replace function public._run_public(e events) returns json
language sql stable set search_path to 'public' as $$
  with me as (select id from members where auth.uid() is not null and auth_user_id = auth.uid() limit 1),
  mine as (select r.* from registrations r join me on me.id = r.member_id
           where r.event_id = e.id and r.status in ('pending','confirmed') and _visible_signup(r, e) limit 1),
  ci as (select a.activity_date, a.distance_km from activities a join me on me.id = a.member_id
         where a.event_id = e.id and a.detail in ('app check-in','admin check-in'))
  select (jsonb_build_object(
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
    'waiver_required', e.waiver_required,
    'waiver_ok', coalesce((select _waiver_ok(m) from members m join me on me.id = m.id), false),
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
    'spots_left', case when e.capacity is null then null else greatest(0, e.capacity - _spots_taken(e)) end)
  || jsonb_build_object(
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
                       else exists (select 1 from ci) end))::json;
$$;

create or replace function public._run_admin(e events) returns json
language sql stable set search_path to 'public' as $$
  select (_run_public(e)::jsonb || jsonb_build_object(
    'attend_url', e.attend_url, 'check_in_code', e.check_in_code, 'badge_id', e.badge_id,
    'signup_count', (select count(*) from registrations r where r.event_id = e.id and r.status = 'confirmed'),
    'pending_count', (select count(*) from registrations r where r.event_id = e.id and r.status = 'pending' and _visible_signup(r, e)),
    'test_count', (select count(*) from registrations r where r.event_id = e.id and r.is_test and r.status in ('pending','confirmed'))
                + (select count(*) from activities a where a.event_id = e.id and a.is_test),
    'signups', coalesce((select jsonb_agg(jsonb_build_object('member_id', m.id, 'name', m.name, 'phone', coalesce(m.sheet_key, m.phone),
                           'at', r.created_at, 'answers', r.answers, 'attended', r.attended, 'payment', r.payment_status, 'status', r.status,
                           'payment_ref', r.razorpay_payment_id, 'amount', r.amount_inr, 'holds', _holds_spot(r, e), 'ticket', r.pass_code, 'test', r.is_test,
                           'due', _due(r, e), 'discount_pct', r.discount_pct, 'discount', _discount_name(r.discount_badge), 'agreed', _waiver_ok(m))
                           order by (r.status = 'confirmed'), r.created_at)
                         from registrations r join members m on m.id = r.member_id
                         where r.event_id = e.id and r.status in ('pending','confirmed') and _visible_signup(r, e)), '[]'::jsonb),
    'attendees', coalesce((select jsonb_agg(jsonb_build_object('member_id', m.id, 'name', m.name, 'phone', coalesce(m.sheet_key, m.phone),
                           'km', a.distance_km, 'date', a.activity_date, 'at', a.created_at, 'by', a.detail, 'test', a.is_test,
                           'badge', exists (select 1 from badge_awards ba where ba.member_id = m.id and ba.event_id = e.id))
                           order by a.activity_date, a.created_at)
                         from activities a join members m on m.id = a.member_id
                         where a.event_id = e.id and a.detail in ('app check-in','admin check-in')), '[]'::jsonb)))::json;
$$;

drop function if exists public.sign_up_for_run(uuid, jsonb, boolean, text);
create or replace function public.sign_up_for_run(p_id uuid, p_answers jsonb default '{}'::jsonb, p_venue boolean default false, p_discount text default null, p_agree boolean default false) returns json
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
  -- participation terms: agree once per version (not needed again when only changing answers on a booking already made)
  if e.waiver_required and not _waiver_ok(m) and not (existing.id is not null and existing.status in ('pending','confirmed')) then
    if p_agree then update members set waiver_accepted_at = now(), waiver_version = _waiver_version() where id = m.id;
    else raise exception 'waiver_required'; end if;
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

grant execute on function public.sign_up_for_run(uuid, jsonb, boolean, text, boolean) to authenticated;

drop function if exists public.check_in_run(uuid, text, numeric);
create or replace function public.check_in_run(p_id uuid, p_code text, p_km numeric default null, p_agree boolean default false) returns json
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
  if e.waiver_required and not _waiver_ok(m) then
    if p_agree then update members set waiver_accepted_at = now(), waiver_version = _waiver_version() where id = m.id;
    else raise exception 'waiver_required'; end if;
  end if;
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

grant execute on function public.check_in_run(uuid, text, numeric, boolean) to authenticated;

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
  v_waiver boolean := coalesce((p->>'waiver_required')::boolean, true);
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
                        class_dates, late_join, waiver_required)
    values (v_name, v_cat, v_date, nullif(p->>'time','')::time, nullif(btrim(p->>'venue'),''),
            nullif(btrim(p->>'map_url'),''), nullif(btrim(p->>'poster_url'),''), nullif(btrim(p->>'description'),''),
            encode(extensions.gen_random_bytes(6), 'hex'), true, v_on, v_fields, v_cap,
            coalesce(nullif(p->>'run_km','')::numeric, 5), v_price, nullif(btrim(p->>'payment_qr_url'),''), v_upi,
            v_classes, v_badge, v_mode, v_venue, v_checkin, v_pub, v_disc, v_dates, v_late, v_waiver)
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
      published = v_pub, discounts_allowed = v_disc, class_dates = v_dates, late_join = v_late, waiver_required = v_waiver,
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

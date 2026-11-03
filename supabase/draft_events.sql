-- Draft events: an event with published = false is hidden from every list but opens by direct link.
-- Sign-ups, payments and check-ins made on a draft are tagged is_test and never touch the leaderboard,
-- badges or WhatsApp. Publishing clears them (or keeps them as real, if asked).

alter table events add column if not exists published boolean not null default true;
alter table registrations add column if not exists is_test boolean not null default false;
alter table activities add column if not exists is_test boolean not null default false;

-- Leaderboard ignores test check-ins.
create or replace view leaderboard as
 select m.id, m.name, m.phone,
    m.baseline_km + coalesce(sum(a.distance_km), 0::numeric) as total_km,
    m.baseline_runs + count(a.id) filter (where a.distance_km > 0::numeric) as total_runs,
    case
      when (m.baseline_km + coalesce(sum(a.distance_km), 0::numeric)) >= 300 then 'VOYAGER'
      when (m.baseline_km + coalesce(sum(a.distance_km), 0::numeric)) >= 200 then 'WAYFARER'
      when (m.baseline_km + coalesce(sum(a.distance_km), 0::numeric)) >= 100 then 'RANGER'
      when (m.baseline_km + coalesce(sum(a.distance_km), 0::numeric)) >= 50 then 'STRIDER'
      when (m.baseline_km + coalesce(sum(a.distance_km), 0::numeric)) >= 25 then 'PACER'
      else null::text
    end as badge,
    max(a.activity_date) as last_run
   from members m
     left join activities a on a.member_id = m.id and a.category = 'weekend_run' and not a.is_test
  group by m.id, m.name, m.phone, m.baseline_km, m.baseline_runs
  order by (m.baseline_km + coalesce(sum(a.distance_km), 0::numeric)) desc;

-- Public shape gains 'published' and 'my_test'.
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
    'spots_left', case when e.capacity is null then null else greatest(0, e.capacity - _spots_taken(e)) end,
    'signed_up', exists (select 1 from mine where status = 'confirmed'),
    'my_status', (select status from mine),
    'my_answers', (select answers from mine),
    'my_payment', (select payment_status from mine),
    'my_ticket', (select pass_code from mine),
    'my_test', coalesce((select is_test from mine), false),
    'my_classes', (select count(*) from ci),
    'my_badge_earned', e.badge_id is not null and exists (select 1 from badge_awards ba join me on me.id = ba.member_id where ba.badge_id = e.badge_id),
    'my_checkin_km', (select distance_km from ci order by activity_date desc limit 1),
    'checked_in', case when e.category = 'program' then exists (select 1 from ci where activity_date = ist_today())
                       else exists (select 1 from ci) end);
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
                           'payment_ref', r.razorpay_payment_id, 'amount', r.amount_inr, 'holds', _holds_spot(r, e), 'ticket', r.pass_code, 'test', r.is_test)
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

-- Lists hide drafts. run_detail (direct link) does not.
create or replace function public.upcoming_runs() returns json
language sql stable security definer set search_path to 'public' as $$
  select coalesce(json_agg(_run_public(e) order by e.event_date, e.start_time nulls last), '[]'::json)
  from events e where _app_event(e.category) and e.is_active and e.published and not _is_past(e);
$$;

create or replace function public.past_events() returns json
language sql stable security definer set search_path to 'public' as $$
  select coalesce(json_agg(x.j order by x.d desc), '[]'::json) from (
    select _run_public(e) j, coalesce((e.ended_at at time zone 'Asia/Kolkata')::date, e.event_date) d
    from events e where _app_event(e.category) and e.is_active and e.published and _is_past(e)
    order by 2 desc limit 30) x;
$$;

-- Profile: test rows stay out of km, runs log and attended log; a test booking still shows under Upcoming (flagged) so the ticket can be tested.
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
    'upcoming', coalesce((
      select json_agg(json_build_object('id', e.id, 'name', e.name, 'kind', _kind(e.category), 'date', e.event_date,
                                        'time', to_char(e.start_time, 'HH24:MI'), 'venue', e.location, 'poster_url', e.poster_url,
                                        'ticket', g.pass_code, 'status', g.status, 'payment', g.payment_status,
                                        'price', coalesce(e.price_inr, 0), 'checkin_mode', e.checkin_mode, 'test', g.is_test,
                                        'is_today', e.event_date = ist_today(), 'classes', e.classes,
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
      select json_agg(json_build_object('name', b.name, 'image_url', b.image_url, 'on', ba.awarded_on, 'from', ba.note)
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

-- Program badges never come from test check-ins.
create or replace function public._program_award(p_event uuid, p_member uuid) returns void
language plpgsql security definer set search_path to 'public' as $$
declare e events; n int;
begin
  select * into e from events where id = p_event;
  if e.id is null then return; end if;
  delete from badge_awards where member_id = p_member and event_id = e.id and awarded_by = 'auto'
    and (e.category <> 'program' or badge_id is distinct from e.badge_id);
  if e.category <> 'program' or e.badge_id is null or e.classes is null then return; end if;
  select count(*) into n from activities
   where event_id = e.id and member_id = p_member and detail in ('app check-in','admin check-in') and not is_test;
  if n >= e.classes then
    insert into badge_awards (member_id, badge, badge_id, event_id, awarded_on, awarded_by, note)
    values (p_member, 'custom:' || e.badge_id, e.badge_id, e.id, ist_today(), 'auto', e.name)
    on conflict (member_id, badge) do nothing;
  else
    delete from badge_awards where member_id = p_member and event_id = e.id and awarded_by = 'auto';
  end if;
end $$;

-- Sign-ups on a draft are tests.
create or replace function public.sign_up_for_run(p_id uuid, p_answers jsonb default '{}'::jsonb, p_venue boolean default false) returns json
language plpgsql security definer set search_path to 'public' as $$
declare m members; e events; f jsonb; v text; picks jsonb; clean jsonb := '{}'::jsonb; existing registrations; v_status text; v_pay text;
begin
  if auth.uid() is null then raise exception 'not_logged_in'; end if;
  select * into m from members where auth_user_id = auth.uid() limit 1;
  if m.id is null then raise exception 'no_member'; end if;
  select * into e from events where id = p_id and _app_event(category) and is_active for update;
  if e.id is null then raise exception 'run_not_found'; end if;
  if _is_past(e) then raise exception 'run_over'; end if;
  if not e.signup_enabled then raise exception 'signups_closed'; end if;
  if p_venue and not (coalesce(e.price_inr, 0) > 0 and e.payment_mode = 'online' and e.pay_at_venue) then raise exception 'venue_not_allowed'; end if;

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

  select * into existing from registrations where member_id = m.id and event_id = e.id;
  if existing.id is not null and existing.status in ('pending','confirmed') then
    if existing.status = 'confirmed' or existing.payment_status in ('venue','claimed') or e.payment_mode <> 'online' then
      update registrations set answers = clean where id = existing.id;
      return _run_public(e);
    end if;
    if not _holds_spot(existing, e) and e.capacity is not null and _spots_taken(e) >= e.capacity then raise exception 'run_full'; end if;
    update registrations set answers = clean, pending_since = now(),
      payment_status = case when p_venue then 'venue' else payment_status end where id = existing.id;
    return _run_public(e);
  end if;

  if e.capacity is not null and _spots_taken(e) >= e.capacity then raise exception 'run_full'; end if;

  v_status := case when coalesce(e.price_inr, 0) > 0 then 'pending' else 'confirmed' end;
  v_pay := case when p_venue then 'venue' else 'none' end;
  insert into registrations (member_id, event_id, status, pass_code, answers, payment_status, pending_since, is_test)
  values (m.id, e.id, v_status, gen_pass_code(), clean, v_pay, now(), not e.published)
  on conflict (member_id, event_id) do update set status = excluded.status, answers = excluded.answers,
    payment_status = excluded.payment_status, pending_since = now(), razorpay_order_id = null, razorpay_payment_id = null,
    attended = false, attended_at = null, is_test = excluded.is_test;
  return _run_public(e);
end $$;

-- A draft never reaches Razorpay. Instead, test_pay confirms the booking with no money moving.
create or replace function public.pay_prepare(p_user uuid, p_event uuid) returns json
language plpgsql security definer set search_path to 'public' as $$
declare m members; e events; r registrations;
begin
  select * into m from members where auth_user_id = p_user limit 1;
  if m.id is null then raise exception 'no_member'; end if;
  select * into e from events where id = p_event and _app_event(category) and is_active;
  if e.id is null then raise exception 'run_not_found'; end if;
  if not e.published then raise exception 'preview_event'; end if;
  if coalesce(e.price_inr, 0) <= 0 then raise exception 'not_paid_event'; end if;
  if e.payment_mode <> 'online' then raise exception 'not_online'; end if;
  select * into r from registrations where member_id = m.id and event_id = e.id;
  if r.id is null or r.status not in ('pending','confirmed') then raise exception 'not_signed_up'; end if;
  if r.status = 'confirmed' then raise exception 'already_paid'; end if;
  if _is_past(e) then raise exception 'run_over'; end if;
  if not _holds_spot(r, e) then
    if e.capacity is not null and _spots_taken(e) >= e.capacity then raise exception 'run_full'; end if;
    update registrations set pending_since = now() where id = r.id;
  end if;
  return json_build_object('registration_id', r.id, 'amount', round(e.price_inr * 100)::int, 'event', e.name,
    'name', m.name, 'phone', coalesce(m.sheet_key, right(regexp_replace(coalesce(m.phone,''), '\D', '', 'g'), 10)));
end $$;

create or replace function public.test_pay(p_id uuid) returns json
language plpgsql security definer set search_path to 'public' as $$
declare m members; e events; r registrations;
begin
  if auth.uid() is null then raise exception 'not_logged_in'; end if;
  select * into m from members where auth_user_id = auth.uid() limit 1;
  if m.id is null then raise exception 'no_member'; end if;
  select * into e from events where id = p_id and _app_event(category) and is_active;
  if e.id is null then raise exception 'run_not_found'; end if;
  if e.published then raise exception 'not_preview'; end if;
  select * into r from registrations where member_id = m.id and event_id = e.id;
  if r.id is null or r.status not in ('pending','confirmed') or not r.is_test then raise exception 'not_signed_up'; end if;
  update registrations set status = 'confirmed', payment_status = 'confirmed', razorpay_payment_id = 'test',
    amount_inr = coalesce(e.price_inr, 0) where id = r.id;
  return _run_public(e);
end $$;

-- Check-ins on a draft are tests too.
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
      'badge', _badge_json(e.badge_id), 'badge_earned', has_badge and not had_badge, 'test', not e.published);
  end if;

  select total_km into after_km from leaderboard where id = m.id;
  return json_build_object('ok', true, 'run', e.name, 'kind', _kind(e.category),
    'km', v_km, 'first_time', was_new, 'total_km', round(after_km, 2), 'test', not e.published,
    'badge_before', _badge(before_km), 'badge', _badge(after_km),
    'total_runs', (select total_runs from leaderboard where id = m.id));
end $$;

create or replace function public.admin_scan_ticket(p_code text, p_event uuid default null, p_km numeric default null) returns json
language plpgsql security definer set search_path to 'public' as $$
declare r registrations; e events; m members; v_code text; v_day date; v_km numeric; already boolean; done int;
begin
  if not is_admin() then raise exception 'not_admin'; end if;
  v_code := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  if v_code like 'MT%' then v_code := 'MT-' || substr(v_code, 3); end if;
  select * into r from registrations where upper(pass_code) = v_code;
  if r.id is null then raise exception 'ticket_not_found'; end if;
  select * into e from events where id = r.event_id and _app_event(category) and is_active;
  if e.id is null then raise exception 'ticket_not_found'; end if;
  select * into m from members where id = r.member_id;
  if p_event is not null and p_event <> e.id then
    return json_build_object('ok', false, 'error', 'wrong_event', 'name', m.name, 'event', e.name, 'event_id', e.id);
  end if;
  if r.status = 'cancelled' or not _visible_signup(r, e) then
    return json_build_object('ok', false, 'error', 'ticket_cancelled', 'name', m.name, 'event', e.name, 'event_id', e.id);
  end if;
  if e.ended_at is not null then raise exception 'event_ended'; end if;
  v_day := case when e.category = 'program' then ist_today() else e.event_date end;
  if e.category = 'weekend_run' then
    v_km := round(coalesce(p_km, e.run_km), 2);
    if v_km < 0.5 or v_km > 60 then raise exception 'bad_distance'; end if;
  end if;
  select exists (select 1 from activities where member_id = m.id and event_id = e.id and activity_date = v_day
                 and detail in ('app check-in','admin check-in')) into already;
  if not already then
    insert into activities (member_id, category, event_id, activity_date, distance_km, detail, is_test)
    values (m.id, e.category, e.id, v_day, v_km, 'admin check-in', not e.published);
    update registrations set attended = true, attended_at = coalesce(attended_at, now()) where id = r.id;
    perform _program_award(e.id, m.id);
  end if;
  select count(*) into done from activities where member_id = m.id and event_id = e.id and detail in ('app check-in','admin check-in');
  return json_build_object('ok', true, 'name', m.name, 'member_id', m.id,
    'phone', coalesce(m.sheet_key, right(regexp_replace(coalesce(m.phone,''), '\D', '', 'g'), 10)),
    'event', e.name, 'event_id', e.id, 'kind', _kind(e.category), 'already', already, 'test', not e.published,
    'payment', r.payment_status, 'status', r.status, 'due', case when r.status = 'confirmed' then 0 else coalesce(e.price_inr, 0) end,
    'classes', e.classes, 'done', done, 'km', v_km,
    'badge', e.badge_id is not null and exists (select 1 from badge_awards ba where ba.member_id = m.id and ba.badge_id = e.badge_id),
    'run', _run_admin(e));
end $$;

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
  insert into activities (member_id, category, event_id, activity_date, distance_km, detail, is_test)
  values (m.id, e.category, e.id, v_day, v_km, 'admin check-in', not e.published)
  on conflict (member_id, event_id, activity_date) where detail in ('app check-in','admin check-in')
  do update set distance_km = excluded.distance_km, is_test = excluded.is_test;
  update registrations set attended = true, attended_at = coalesce(attended_at, now()) where member_id = m.id and event_id = e.id;
  perform _program_award(e.id, m.id);
  return _run_admin(e);
end $$;

-- No WhatsApp for tests; Telegram alerts arrive marked as tests.
create or replace function public._queue_confirmation() returns trigger
language plpgsql security definer set search_path to 'public' as $$
declare m members; e events; v_phone text; v_id uuid; booked boolean;
begin
  if new.is_test then return new; end if;
  booked := new.status = 'confirmed' or (new.status = 'pending' and new.payment_status = 'venue');
  if not booked then return new; end if;
  select * into m from members where id = new.member_id;
  select * into e from events where id = new.event_id;
  v_phone := coalesce(m.sheet_key, right(regexp_replace(coalesce(m.phone,''), '\D', '', 'g'), 10));
  if v_phone !~ '^[6-9][0-9]{9}$' or e.id is null then return new; end if;
  insert into wa_outbox (registration_id, phone, params)
  values (new.id, v_phone, jsonb_build_array(
    coalesce(nullif(split_part(btrim(m.name), ' ', 1), ''), 'there'),
    e.name,
    to_char(e.event_date, 'Dy FMDD Mon') || coalesce(', ' || to_char(e.start_time, 'FMHH12:MI AM'), ''),
    coalesce(nullif(btrim(e.location), ''), 'the venue')))
  on conflict (registration_id) do nothing
  returning id into v_id;
  if v_id is not null then
    begin
      perform net.http_post(
        url := 'https://lligzqocyumszoecszyf.supabase.co/functions/v1/notify',
        body := jsonb_build_object('id', v_id),
        headers := '{"Content-Type": "application/json"}'::jsonb);
    exception when others then
      update wa_outbox set error = 'queue_call_failed: ' || sqlerrm where id = v_id;
    end;
  end if;
  return new;
end $$;

create or replace function public._booking_alert() returns trigger
language plpgsql security definer set search_path to 'public' as $$
declare m members; e events; was_vis boolean; now_vis boolean; price numeric; paystate text; title text; body text; tags text; pre text;
begin
  if auth.uid() is not null and exists (select 1 from members where auth_user_id = auth.uid() and is_admin) then return new; end if;
  select * into e from events where id = new.event_id;
  if e.id is null then return new; end if;
  pre := case when new.is_test then 'TEST · ' else '' end;
  now_vis := new.status in ('pending','confirmed') and _visible_signup(new, e);
  was_vis := tg_op = 'UPDATE' and old.status in ('pending','confirmed') and _visible_signup(old, e);
  price := coalesce(e.price_inr, 0);
  select * into m from members where id = new.member_id;
  if now_vis and not was_vis then
    paystate := case when price = 0 then 'free'
                     when new.payment_status = 'confirmed' then 'paid ₹' || price::int
                     when new.payment_status = 'venue' then 'pay at venue ₹' || price::int
                     when new.payment_status = 'claimed' then 'says paid ₹' || price::int || ' · check'
                     else 'UPI QR · ₹' || price::int || ' not paid yet' end;
    title := pre || 'New booking · ' || e.name;
    body := m.name || ' · ' || paystate || ' · ' || to_char(e.event_date, 'Dy FMDD Mon')
         || ' · ' || (select count(*) from registrations r where r.event_id = e.id and r.status = 'confirmed') || ' confirmed'
         || coalesce(' of ' || e.capacity, '');
    tags := case when new.payment_status = 'confirmed' then 'moneybag' when price = 0 then 'tada' else 'ticket' end;
    perform _alert_organiser(title, body, tags);
  elsif now_vis and was_vis and new.payment_status = 'confirmed' and old.payment_status is distinct from 'confirmed' then
    perform _alert_organiser(pre || 'Paid · ' || e.name, m.name || ' paid ₹' || price::int || coalesce(' · ' || new.razorpay_payment_id, ''), 'moneybag');
  elsif now_vis and was_vis and new.payment_status = 'claimed' and old.payment_status = 'none' then
    perform _alert_organiser(pre || 'Says paid · ' || e.name, m.name || ' tapped "I''ve paid" for ₹' || price::int || '. Check your UPI and mark paid.', 'eyes');
  elsif was_vis and new.status = 'cancelled' then
    perform _alert_organiser(pre || 'Cancelled · ' || e.name, m.name || ' cancelled their spot.', 'x');
  end if;
  return new;
end $$;

-- Publish / unpublish, and clear tests.
create or replace function public.admin_clear_tests(p_id uuid) returns json
language plpgsql security definer set search_path to 'public' as $$
declare e events;
begin
  if not is_admin() then raise exception 'not_admin'; end if;
  select * into e from events where id = p_id and _app_event(category) and is_active;
  if e.id is null then raise exception 'run_not_found'; end if;
  delete from activities where event_id = e.id and is_test;
  delete from wa_outbox where registration_id in (select id from registrations where event_id = e.id and is_test);
  delete from registrations where event_id = e.id and is_test;
  return _run_admin(e);
end $$;

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
    if v_classes is null or v_classes < 1 or v_classes > 100 then raise exception 'classes_required'; end if;
    if v_badge is not null and not exists (select 1 from badges where id = v_badge) then raise exception 'badge_not_found'; end if;
  else
    v_classes := null; v_badge := null;
  end if;
  if v_mode = 'online' and v_price > 0 and v_price < 1 then raise exception 'bad_price'; end if;
  if v_mode <> 'online' or v_price = 0 then v_venue := false; end if;
  if v_id is null then
    insert into events (name, category, event_date, start_time, location, map_url, poster_url, description,
                        check_in_code, registration_open, signup_enabled, signup_fields, capacity, run_km,
                        price_inr, payment_qr_url, upi_id, classes, badge_id, payment_mode, pay_at_venue, checkin_mode, published)
    values (v_name, v_cat, v_date, nullif(p->>'time','')::time, nullif(btrim(p->>'venue'),''),
            nullif(btrim(p->>'map_url'),''), nullif(btrim(p->>'poster_url'),''), nullif(btrim(p->>'description'),''),
            encode(extensions.gen_random_bytes(6), 'hex'), true, v_on, v_fields, v_cap,
            coalesce(nullif(p->>'run_km','')::numeric, 5), v_price, nullif(btrim(p->>'payment_qr_url'),''), v_upi,
            v_classes, v_badge, v_mode, v_venue, v_checkin, v_pub)
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
      published = v_pub,
      check_in_code = coalesce(check_in_code, encode(extensions.gen_random_bytes(6), 'hex')), updated_at = now()
    where id = v_id and _app_event(category) and is_active
    returning * into e;
    if e.id is null then raise exception 'run_not_found'; end if;
    if v_pub and not coalesce(v_was_pub, true) then
      -- going live: test sign-ups are cleared unless asked to keep them, in which case they become real
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

grant execute on function public.test_pay(uuid) to authenticated;
grant execute on function public.admin_clear_tests(uuid) to authenticated;

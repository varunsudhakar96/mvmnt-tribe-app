-- Badge discounts: each run tier and each program badge can carry a % off paid events.
-- A member picks at most one badge discount per sign-up. Events can opt out.

create table if not exists tier_discounts (
  tier text primary key check (tier in ('PACER','STRIDER','RANGER','WAYFARER','VOYAGER')),
  discount_pct int not null default 0 check (discount_pct between 0 and 100),
  updated_at timestamptz not null default now()
);
alter table tier_discounts enable row level security;
insert into tier_discounts (tier) values ('PACER'),('STRIDER'),('RANGER'),('WAYFARER'),('VOYAGER') on conflict do nothing;

alter table badges add column if not exists discount_pct int not null default 0 check (discount_pct between 0 and 100);
alter table events add column if not exists discounts_allowed boolean not null default true;
alter table registrations add column if not exists discount_badge text;
alter table registrations add column if not exists discount_pct int not null default 0 check (discount_pct between 0 and 100);

-- Badge discounts a member may use: every run tier up to their own, plus program badges they hold. Only those with a % set.
create or replace function public._member_discounts(p_member uuid) returns jsonb
language sql stable set search_path to 'public' as $$
  with tiers(key, name, rank) as (values ('PACER','Pacer',1),('STRIDER','Strider',2),('RANGER','Ranger',3),('WAYFARER','Wayfarer',4),('VOYAGER','Voyager',5)),
  top as (select greatest(
            coalesce((select t.rank from leaderboard l join tiers t on t.key = l.badge where l.id = p_member), 0),
            coalesce((select max(t.rank) from badge_awards ba join tiers t on t.key = ba.badge where ba.member_id = p_member), 0)) r)
  select coalesce(jsonb_agg(x order by (x->>'pct')::int desc, x->>'name'), '[]'::jsonb) from (
    select jsonb_build_object('key', t.key, 'name', t.name, 'kind', 'run', 'pct', td.discount_pct) x
      from tiers t join tier_discounts td on td.tier = t.key where td.discount_pct > 0 and t.rank <= (select r from top)
    union all
    select jsonb_build_object('key', 'custom:' || b.id, 'name', b.name, 'kind', 'custom', 'image_url', b.image_url, 'pct', b.discount_pct)
      from badge_awards ba join badges b on b.id = ba.badge_id where ba.member_id = p_member and b.discount_pct > 0) y;
$$;

create or replace function public._discount_name(p_key text) returns text
language sql stable set search_path to 'public' as $$
  select case when p_key like 'custom:%' then (select name from badges where id = substr(p_key, 8)::uuid)
              when p_key is null then null else initcap(lower(p_key)) end;
$$;

-- What a registration actually owes, in whole rupees.
create or replace function public._due(r registrations, e events) returns numeric
language sql stable set search_path to 'public' as $$
  select greatest(0, round(coalesce(e.price_inr, 0) * (100 - coalesce(r.discount_pct, 0)) / 100.0));
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
                           'due', _due(r, e), 'discount_pct', r.discount_pct, 'discount', _discount_name(r.discount_badge))
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

-- Sign-up takes an optional badge discount key.
drop function if exists public.sign_up_for_run(uuid, jsonb, boolean);
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

  select * into existing from registrations where member_id = m.id and event_id = e.id;
  if existing.id is not null and existing.status in ('pending','confirmed') then
    if existing.status = 'confirmed' or existing.payment_status in ('venue','claimed') or (e.payment_mode <> 'online' and existing.payment_status <> 'none') then
      -- booked (or payment in flight): only the answers change; the discount is locked in
      update registrations set answers = clean where id = existing.id;
      return _run_public(e);
    end if;
    if e.payment_mode <> 'online' then
      -- UPI QR sign-up not yet paid: answers and discount can still change
      update registrations set answers = clean, discount_badge = v_disc, discount_pct = v_pct where id = existing.id;
      return _run_public(e);
    end if;
    -- a checkout in progress: refresh it (renew the hold if it lapsed and there's still room)
    if not _holds_spot(existing, e) and e.capacity is not null and _spots_taken(e) >= e.capacity then raise exception 'run_full'; end if;
    update registrations set answers = clean, pending_since = now(), discount_badge = v_disc, discount_pct = v_pct,
      payment_status = case when p_venue then 'venue' else payment_status end,
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
    discount_badge = excluded.discount_badge, discount_pct = excluded.discount_pct, amount_inr = excluded.amount_inr;
  return _run_public(e);
end $$;
grant execute on function public.sign_up_for_run(uuid, jsonb, boolean, text) to authenticated;

-- Payments use the discounted amount.
create or replace function public.pay_prepare(p_user uuid, p_event uuid) returns json
language plpgsql security definer set search_path to 'public' as $$
declare m members; e events; r registrations; v_due numeric;
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
  v_due := _due(r, e);
  if v_due < 1 then raise exception 'already_paid'; end if;
  if not _holds_spot(r, e) then
    if e.capacity is not null and _spots_taken(e) >= e.capacity then raise exception 'run_full'; end if;
    update registrations set pending_since = now() where id = r.id;
  end if;
  return json_build_object('registration_id', r.id, 'amount', round(v_due * 100)::int,
    'event', e.name || case when r.discount_pct > 0 then ' (' || r.discount_pct || '% badge discount)' else '' end,
    'name', m.name, 'phone', coalesce(m.sheet_key, right(regexp_replace(coalesce(m.phone,''), '\D', '', 'g'), 10)));
end $$;

create or replace function public.pay_confirm(p_registration uuid, p_order text, p_payment text, p_amount_paise integer, p_user uuid default null) returns json
language plpgsql security definer set search_path to 'public' as $$
declare r registrations; e events;
begin
  select * into r from registrations where id = p_registration for update;
  if r.id is null then raise exception 'registration_not_found'; end if;
  if p_user is not null and not exists (select 1 from members m where m.id = r.member_id and m.auth_user_id = p_user) then
    raise exception 'not_yours';
  end if;
  select * into e from events where id = r.event_id;
  if p_amount_paise is not null and p_amount_paise < round(_due(r, e) * 100) then raise exception 'amount_mismatch'; end if;
  update registrations set status = 'confirmed', payment_status = 'confirmed',
    razorpay_order_id = coalesce(p_order, razorpay_order_id), razorpay_payment_id = p_payment,
    amount_inr = coalesce(p_amount_paise / 100.0, amount_inr)
  where id = r.id;
  return json_build_object('ok', true, 'event_id', r.event_id, 'was', r.status);
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
    amount_inr = _due(r, e) where id = r.id;
  return _run_public(e);
end $$;

-- Profile Upcoming, ticket scanning and organiser alerts show what is actually due.
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
    'payment', r.payment_status, 'status', r.status, 'due', case when r.status = 'confirmed' then 0 else _due(r, e) end,
    'discount_pct', r.discount_pct, 'discount', _discount_name(r.discount_badge),
    'classes', e.classes, 'done', done, 'km', v_km,
    'badge', e.badge_id is not null and exists (select 1 from badge_awards ba where ba.member_id = m.id and ba.badge_id = e.badge_id),
    'run', _run_admin(e));
end $$;

create or replace function public._booking_alert() returns trigger
language plpgsql security definer set search_path to 'public' as $$
declare m members; e events; was_vis boolean; now_vis boolean; price numeric; paystate text; title text; body text; tags text; pre text; disc text;
begin
  if auth.uid() is not null and exists (select 1 from members where auth_user_id = auth.uid() and is_admin) then return new; end if;
  select * into e from events where id = new.event_id;
  if e.id is null then return new; end if;
  pre := case when new.is_test then 'TEST · ' else '' end;
  now_vis := new.status in ('pending','confirmed') and _visible_signup(new, e);
  was_vis := tg_op = 'UPDATE' and old.status in ('pending','confirmed') and _visible_signup(old, e);
  price := _due(new, e);
  disc := case when new.discount_pct > 0 then ' (' || new.discount_pct || '% off · ' || coalesce(_discount_name(new.discount_badge), 'badge') || ')' else '' end;
  select * into m from members where id = new.member_id;
  if now_vis and not was_vis then
    paystate := case when coalesce(e.price_inr, 0) = 0 then 'free'
                     when new.payment_status = 'confirmed' then 'paid ₹' || price::int || disc
                     when new.payment_status = 'venue' then 'pay at venue ₹' || price::int || disc
                     when new.payment_status = 'claimed' then 'says paid ₹' || price::int || disc || ' · check'
                     else 'UPI QR · ₹' || price::int || disc || ' not paid yet' end;
    title := pre || 'New booking · ' || e.name;
    body := m.name || ' · ' || paystate || ' · ' || to_char(e.event_date, 'Dy FMDD Mon')
         || ' · ' || (select count(*) from registrations r where r.event_id = e.id and r.status = 'confirmed') || ' confirmed'
         || coalesce(' of ' || e.capacity, '');
    tags := case when new.payment_status = 'confirmed' then 'moneybag' when coalesce(e.price_inr, 0) = 0 then 'tada' else 'ticket' end;
    perform _alert_organiser(title, body, tags);
  elsif now_vis and was_vis and new.payment_status = 'confirmed' and old.payment_status is distinct from 'confirmed' then
    perform _alert_organiser(pre || 'Paid · ' || e.name, m.name || ' paid ₹' || price::int || disc || coalesce(' · ' || new.razorpay_payment_id, ''), 'moneybag');
  elsif now_vis and was_vis and new.payment_status = 'claimed' and old.payment_status = 'none' then
    perform _alert_organiser(pre || 'Says paid · ' || e.name, m.name || ' tapped "I''ve paid" for ₹' || price::int || disc || '. Check your UPI and mark paid.', 'eyes');
  elsif was_vis and new.status = 'cancelled' then
    perform _alert_organiser(pre || 'Cancelled · ' || e.name, m.name || ' cancelled their spot.', 'x');
  end if;
  return new;
end $$;

-- Admin: discounts on badges and tiers; per-event opt-out.
create or replace function public.admin_list_badges() returns json
language plpgsql stable security definer set search_path to 'public' as $$
begin
  if not is_admin() then raise exception 'not_admin'; end if;
  return (select coalesce(json_agg(json_build_object('id', b.id, 'name', b.name, 'image_url', b.image_url, 'discount_pct', b.discount_pct,
            'programs', (select count(*) from events e where e.badge_id = b.id and e.is_active),
            'awarded', (select count(*) from badge_awards ba where ba.badge_id = b.id)) order by b.created_at desc), '[]'::json)
          from badges b);
end $$;

create or replace function public._badge_detail(p_id uuid) returns json
language sql stable security definer set search_path to 'public' as $$
  select json_build_object('id', b.id, 'name', b.name, 'image_url', b.image_url, 'discount_pct', b.discount_pct,
    'programs', coalesce((select json_agg(json_build_object('id', e.id, 'name', e.name, 'classes', e.classes, 'ended', e.ended_at is not null) order by e.event_date desc)
                          from events e where e.badge_id = b.id and e.is_active), '[]'::json),
    'holders', coalesce((select json_agg(json_build_object('member_id', m.id, 'name', m.name,
                           'phone', coalesce(m.sheet_key, right(regexp_replace(coalesce(m.phone,''), '\D', '', 'g'), 10)),
                           'on', ba.awarded_on, 'how', ba.awarded_by, 'note', ba.note) order by ba.awarded_on desc, m.name)
                         from badge_awards ba join members m on m.id = ba.member_id where ba.badge_id = b.id), '[]'::json))
  from badges b where b.id = p_id;
$$;

create or replace function public.admin_save_badge(p jsonb) returns json
language plpgsql security definer set search_path to 'public' as $$
declare b badges; v_id uuid := nullif(p->>'id','')::uuid; v_name text := nullif(btrim(p->>'name'), ''); v_img text := nullif(btrim(p->>'image_url'), '');
  v_pct int := nullif(regexp_replace(coalesce(p->>'discount_pct',''), '\D', '', 'g'), '')::int;
begin
  if not is_admin() then raise exception 'not_admin'; end if;
  if v_pct is not null and (v_pct < 0 or v_pct > 100) then raise exception 'bad_discount_pct'; end if;
  if v_id is null then
    if v_name is null then raise exception 'badge_name_required'; end if;
    if length(v_name) > 60 then raise exception 'badge_name_too_long'; end if;
    if v_img is null then raise exception 'badge_image_required'; end if;
    if v_img !~* '^https?://' then raise exception 'bad_link'; end if;
    insert into badges (name, image_url, discount_pct) values (v_name, v_img, coalesce(v_pct, 0)) returning * into b;
  else
    if v_name is not null and length(v_name) > 60 then raise exception 'badge_name_too_long'; end if;
    if v_img is not null and v_img !~* '^https?://' then raise exception 'bad_link'; end if;
    update badges set name = coalesce(v_name, name), image_url = coalesce(v_img, image_url), discount_pct = coalesce(v_pct, discount_pct)
      where id = v_id returning * into b;
    if b.id is null then raise exception 'badge_not_found'; end if;
  end if;
  return _badge_detail(b.id);
end $$;

create or replace function public.admin_tier_discounts() returns json
language plpgsql stable security definer set search_path to 'public' as $$
begin
  if not is_admin() then raise exception 'not_admin'; end if;
  return (with tiers(key, name, km, rank) as (values ('PACER','Pacer',25,1),('STRIDER','Strider',50,2),('RANGER','Ranger',100,3),('WAYFARER','Wayfarer',200,4),('VOYAGER','Voyager',300,5))
          select json_agg(json_build_object('tier', t.key, 'name', t.name, 'km', t.km, 'pct', coalesce(td.discount_pct, 0),
                   'holders', (select count(*) from leaderboard l where l.badge = t.key)) order by t.rank)
          from tiers t left join tier_discounts td on td.tier = t.key);
end $$;

create or replace function public.admin_set_tier_discount(p_tier text, p_pct int) returns json
language plpgsql security definer set search_path to 'public' as $$
begin
  if not is_admin() then raise exception 'not_admin'; end if;
  if p_tier not in ('PACER','STRIDER','RANGER','WAYFARER','VOYAGER') then raise exception 'bad_request'; end if;
  if p_pct is null or p_pct < 0 or p_pct > 100 then raise exception 'bad_discount_pct'; end if;
  insert into tier_discounts (tier, discount_pct, updated_at) values (p_tier, p_pct, now())
  on conflict (tier) do update set discount_pct = excluded.discount_pct, updated_at = now();
  return admin_tier_discounts();
end $$;
grant execute on function public.admin_tier_discounts() to authenticated;
grant execute on function public.admin_set_tier_discount(text, int) to authenticated;

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
                        price_inr, payment_qr_url, upi_id, classes, badge_id, payment_mode, pay_at_venue, checkin_mode, published, discounts_allowed)
    values (v_name, v_cat, v_date, nullif(p->>'time','')::time, nullif(btrim(p->>'venue'),''),
            nullif(btrim(p->>'map_url'),''), nullif(btrim(p->>'poster_url'),''), nullif(btrim(p->>'description'),''),
            encode(extensions.gen_random_bytes(6), 'hex'), true, v_on, v_fields, v_cap,
            coalesce(nullif(p->>'run_km','')::numeric, 5), v_price, nullif(btrim(p->>'payment_qr_url'),''), v_upi,
            v_classes, v_badge, v_mode, v_venue, v_checkin, v_pub, v_disc)
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
      published = v_pub, discounts_allowed = v_disc,
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

-- Organiser resets a member's login (Admin → Members → Reset login). Password wiped; member row, km, badges, bookings untouched.
create or replace function public.admin_reset_login(p_phone text) returns json
language plpgsql security definer set search_path to 'public' as $$
declare v_member members; v_digits text;
begin
  if not is_admin() then raise exception 'not_admin'; end if;
  v_digits := right(regexp_replace(coalesce(p_phone,''), '\D', '', 'g'), 10);
  if v_digits !~ '^[6-9][0-9]{9}$' then raise exception 'invalid_phone'; end if;
  select * into v_member from members where auth_user_id is not null
    and (sheet_key = v_digits or right(regexp_replace(coalesce(phone,''), '\D', '', 'g'), 10) = v_digits)
    order by created_at limit 1;
  if v_member.id is null then raise exception 'no_login_for_number'; end if;
  if v_member.auth_user_id = auth.uid() then raise exception 'cant_reset_self'; end if;
  delete from auth.users where id = v_member.auth_user_id;
  return json_build_object('ok', true, 'name', v_member.name, 'phone', v_digits);
end $$;
grant execute on function public.admin_reset_login(text) to authenticated;

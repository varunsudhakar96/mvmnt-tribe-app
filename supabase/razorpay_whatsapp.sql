-- Razorpay (pay in app) + WhatsApp confirmations + closing the old unverified payment function.

-- 0. Old, unverified payment function from the first version: anyone could mark a registration paid. Close it.
revoke execute on function public.confirm_registration_payment(uuid, text, text) from public, anon, authenticated;
revoke execute on function public.organizer_check_in(text) from public, anon;
revoke execute on function public.start_registration(text, text, text, uuid) from public, anon;
revoke execute on function public.register_for_event(uuid, text, text) from public, anon;

-- 1. How a paid event takes payment: 'online' (Razorpay in the app) or 'manual' (UPI QR + organiser confirms).
alter table public.events add column if not exists payment_mode text not null default 'manual';
alter table public.events drop constraint if exists events_payment_mode_check;
alter table public.events add constraint events_payment_mode_check check (payment_mode in ('manual','online'));
alter table public.registrations add column if not exists pending_since timestamptz;
update public.registrations set pending_since = created_at where pending_since is null;

-- An unpaid online sign-up holds its spot for 30 minutes; manual (QR) sign-ups hold until the organiser decides.
create or replace function public._holds_spot(r public.registrations, e public.events) returns boolean
language sql stable as $$
  select r.status = 'confirmed'
      or (r.status = 'pending' and (coalesce(e.payment_mode, 'manual') <> 'online' or r.payment_status <> 'none'
                                    or coalesce(r.pending_since, r.created_at) > now() - interval '30 minutes'))
$$;

create or replace function public._spots_taken(e public.events) returns int
language sql stable set search_path = public as $$
  select count(*)::int from registrations r where r.event_id = e.id and _holds_spot(r, e)
$$;

create or replace function public._run_public(e events) returns json
language sql stable set search_path to 'public' as $function$
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
    'payment_mode', coalesce(e.payment_mode, 'manual'),
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
    'my_classes', (select count(*) from ci),
    'my_badge_earned', e.badge_id is not null and exists (select 1 from badge_awards ba join me on me.id = ba.member_id where ba.badge_id = e.badge_id),
    'my_checkin_km', (select distance_km from ci order by activity_date desc limit 1),
    'checked_in', case when e.category = 'program' then exists (select 1 from ci where activity_date = ist_today())
                       else exists (select 1 from ci) end);
$function$;

create or replace function public._run_admin(e events) returns json
language sql stable set search_path to 'public' as $function$
  select (_run_public(e)::jsonb || jsonb_build_object(
    'attend_url', e.attend_url, 'check_in_code', e.check_in_code, 'badge_id', e.badge_id,
    'signup_count', (select count(*) from registrations r where r.event_id = e.id and r.status = 'confirmed'),
    'pending_count', (select count(*) from registrations r where r.event_id = e.id and r.status = 'pending' and _holds_spot(r, e)),
    'signups', coalesce((select jsonb_agg(jsonb_build_object('member_id', m.id, 'name', m.name, 'phone', coalesce(m.sheet_key, m.phone),
                           'at', r.created_at, 'answers', r.answers, 'attended', r.attended, 'payment', r.payment_status, 'status', r.status,
                           'payment_ref', r.razorpay_payment_id, 'amount', r.amount_inr, 'holds', _holds_spot(r, e))
                           order by (r.status = 'confirmed'), r.created_at)
                         from registrations r join members m on m.id = r.member_id
                         where r.event_id = e.id and r.status in ('pending','confirmed')), '[]'::jsonb),
    'attendees', coalesce((select jsonb_agg(jsonb_build_object('member_id', m.id, 'name', m.name, 'phone', coalesce(m.sheet_key, m.phone),
                           'km', a.distance_km, 'date', a.activity_date, 'at', a.created_at, 'by', a.detail,
                           'badge', exists (select 1 from badge_awards ba where ba.member_id = m.id and ba.event_id = e.id))
                           order by a.activity_date, a.created_at)
                         from activities a join members m on m.id = a.member_id
                         where a.event_id = e.id and a.detail in ('app check-in','admin check-in')), '[]'::jsonb)))::json;
$function$;

create or replace function public.sign_up_for_run(p_id uuid, p_answers jsonb default '{}'::jsonb)
returns json language plpgsql security definer set search_path to 'public' as $function$
declare m members; e events; f jsonb; v text; picks jsonb; clean jsonb := '{}'::jsonb; existing registrations; v_status text;
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
    -- an expired online hold is renewed if there's still room
    if existing.status = 'pending' and not _holds_spot(existing, e) then
      if e.capacity is not null and _spots_taken(e) >= e.capacity then raise exception 'run_full'; end if;
      update registrations set answers = clean, pending_since = now() where id = existing.id;
    else
      update registrations set answers = clean where id = existing.id;
    end if;
    return _run_public(e);
  end if;

  if e.capacity is not null and _spots_taken(e) >= e.capacity then raise exception 'run_full'; end if;

  v_status := case when coalesce(e.price_inr, 0) > 0 then 'pending' else 'confirmed' end;
  insert into registrations (member_id, event_id, status, pass_code, answers, payment_status, pending_since)
  values (m.id, e.id, v_status, gen_pass_code(), clean, 'none', now())
  on conflict (member_id, event_id) do update set status = excluded.status, answers = excluded.answers,
    payment_status = 'none', pending_since = now(), razorpay_order_id = null, razorpay_payment_id = null;
  return _run_public(e);
end $function$;

create or replace function public.admin_save_run(p jsonb) returns json
language plpgsql security definer set search_path to 'public' as $function$
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
  if v_id is null then
    insert into events (name, category, event_date, start_time, location, map_url, poster_url, description,
                        check_in_code, registration_open, signup_enabled, signup_fields, capacity, run_km,
                        price_inr, payment_qr_url, upi_id, classes, badge_id, payment_mode)
    values (v_name, v_cat, v_date, nullif(p->>'time','')::time, nullif(btrim(p->>'venue'),''),
            nullif(btrim(p->>'map_url'),''), nullif(btrim(p->>'poster_url'),''), nullif(btrim(p->>'description'),''),
            encode(extensions.gen_random_bytes(6), 'hex'), true, v_on, v_fields, v_cap,
            coalesce(nullif(p->>'run_km','')::numeric, 5), v_price, nullif(btrim(p->>'payment_qr_url'),''), v_upi,
            v_classes, v_badge, v_mode)
    returning * into e;
  else
    update events set name = v_name, category = v_cat, event_date = v_date, start_time = nullif(p->>'time','')::time,
      location = nullif(btrim(p->>'venue'),''), map_url = nullif(btrim(p->>'map_url'),''),
      poster_url = nullif(btrim(p->>'poster_url'),''), description = nullif(btrim(p->>'description'),''),
      signup_enabled = v_on, signup_fields = v_fields, capacity = v_cap,
      run_km = coalesce(nullif(p->>'run_km','')::numeric, run_km),
      price_inr = v_price, payment_qr_url = nullif(btrim(p->>'payment_qr_url'),''), upi_id = v_upi,
      classes = v_classes, badge_id = v_badge, payment_mode = v_mode,
      check_in_code = coalesce(check_in_code, encode(extensions.gen_random_bytes(6), 'hex')), updated_at = now()
    where id = v_id and _app_event(category) and is_active
    returning * into e;
    if e.id is null then raise exception 'run_not_found'; end if;
    if to_regprocedure('public._program_sync(uuid)') is not null then perform _program_sync(e.id); end if;
  end if;
  return _run_admin(e);
end $function$;

-- 2. Server-only helpers used by the payments function (service role). Members can't call these.
create or replace function public.pay_prepare(p_user uuid, p_event uuid) returns json
language plpgsql security definer set search_path = public as $$
declare m members; e events; r registrations;
begin
  select * into m from members where auth_user_id = p_user limit 1;
  if m.id is null then raise exception 'no_member'; end if;
  select * into e from events where id = p_event and _app_event(category) and is_active;
  if e.id is null then raise exception 'run_not_found'; end if;
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

create or replace function public.pay_attach_order(p_registration uuid, p_order text) returns void
language sql security definer set search_path = public as $$
  update registrations set razorpay_order_id = p_order where id = p_registration and status = 'pending';
$$;

-- Marks a registration paid. Called only after the payment signature or webhook signature has been verified.
create or replace function public.pay_confirm(p_registration uuid, p_order text, p_payment text, p_amount_paise int, p_user uuid default null)
returns json language plpgsql security definer set search_path = public as $$
declare r registrations; e events;
begin
  select * into r from registrations where id = p_registration for update;
  if r.id is null then raise exception 'registration_not_found'; end if;
  if p_user is not null and not exists (select 1 from members m where m.id = r.member_id and m.auth_user_id = p_user) then
    raise exception 'not_yours';
  end if;
  select * into e from events where id = r.event_id;
  if p_amount_paise is not null and p_amount_paise < round(coalesce(e.price_inr, 0) * 100) then raise exception 'amount_mismatch'; end if;
  update registrations set status = 'confirmed', payment_status = 'confirmed',
    razorpay_order_id = coalesce(p_order, razorpay_order_id), razorpay_payment_id = p_payment,
    amount_inr = coalesce(p_amount_paise / 100.0, amount_inr)
  where id = r.id;
  return json_build_object('ok', true, 'event_id', r.event_id, 'was', r.status);
end $$;

revoke execute on function public.pay_prepare(uuid, uuid), public.pay_attach_order(uuid, text),
  public.pay_confirm(uuid, text, text, int, uuid) from public, anon, authenticated;
grant execute on function public.pay_prepare(uuid, uuid), public.pay_attach_order(uuid, text),
  public.pay_confirm(uuid, text, text, int, uuid) to service_role;

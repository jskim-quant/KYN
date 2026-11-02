-- ================================================================
-- Migration 002: Supabase Security Advisor 경고 수정
-- 실행: Supabase Dashboard → SQL Editor → 이 파일 내용 붙여넣기
--
-- 수정 대상 (Security Advisor 12 warnings):
--   1. Function Search Path Mutable (3건) — SECURITY DEFINER 함수에
--      search_path가 고정되지 않아 스키마 가로채기(search_path hijacking)로
--      권한 상승이 가능한 취약점. 함수 정의에 SET search_path 고정.
--   2. Public/Signed-In Can Execute SECURITY DEFINER Function (8건) —
--      RPC로 호출되어야 할 함수는 authenticated만 실행 가능하도록,
--      트리거 전용 함수(handle_new_user)는 아무도 직접 실행 못 하도록 제한.
--   3. Leaked Password Protection Disabled — 이건 SQL로 못 고침.
--      Dashboard → Authentication → Policies → Password →
--      "Leaked password protection" 토글 직접 켜야 함.
-- ================================================================

-- ── get_my_family_id: search_path 고정 + authenticated만 실행 가능 ──
create or replace function get_my_family_id()
returns uuid
language sql
security definer
set search_path = public
as $$
  select family_id from profiles where id = auth.uid()
$$;

revoke execute on function get_my_family_id() from public;
revoke execute on function get_my_family_id() from anon;
grant execute on function get_my_family_id() to authenticated;

-- ── create_family: search_path 고정 + authenticated만 실행 가능 ──
create or replace function create_family(family_name text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  new_family_id uuid;
  invite text;
begin
  invite := upper(substring(md5(random()::text), 1, 6));

  insert into families (name, invite_code)
  values (family_name, invite)
  returning id into new_family_id;

  update profiles
  set family_id = new_family_id, role = 'owner'
  where id = auth.uid();

  insert into macro_settings (family_id) values (new_family_id);

  return json_build_object(
    'family_id', new_family_id,
    'invite_code', invite
  );
end;
$$;

revoke execute on function create_family(text) from public;
revoke execute on function create_family(text) from anon;
grant execute on function create_family(text) to authenticated;

-- ── join_family: search_path 고정 + authenticated만 실행 가능 ──
create or replace function join_family(code text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  target_family_id uuid;
begin
  select id into target_family_id
  from families
  where invite_code = upper(code);

  if target_family_id is null then
    return json_build_object('error', '유효하지 않은 초대 코드입니다');
  end if;

  update profiles
  set family_id = target_family_id, role = 'member'
  where id = auth.uid();

  return json_build_object('family_id', target_family_id);
end;
$$;

revoke execute on function join_family(text) from public;
revoke execute on function join_family(text) from anon;
grant execute on function join_family(text) to authenticated;

-- ── handle_new_user: 트리거 전용 — 아무도 직접 호출 못 하게 막음 ──
-- 트리거 실행 자체는 EXECUTE 권한과 무관하게 정상 작동한다 (함수 소유자 권한으로 실행됨).
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into profiles (id, name)
  values (new.id, new.raw_user_meta_data->>'name');
  return new;
end;
$$;

revoke execute on function handle_new_user() from public;
revoke execute on function handle_new_user() from anon;
revoke execute on function handle_new_user() from authenticated;

-- ================================================================
-- 남은 수동 조치 (SQL로 불가능 — Dashboard에서 직접):
--   Authentication → Policies → Password →
--   "Leaked password protection" 체크박스 활성화
-- ================================================================

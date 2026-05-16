-- ================================================================
-- Estate Planner — Supabase Schema
-- Supabase Dashboard > SQL Editor 에서 실행
-- ================================================================

-- ── Extensions ────────────────────────────────────────────────
create extension if not exists "uuid-ossp";

-- ================================================================
-- 1. FAMILIES (가족 그룹)
-- ================================================================
create table if not exists families (
  id          uuid default uuid_generate_v4() primary key,
  name        text not null default '우리 가족',
  invite_code text unique not null,  -- 가족 초대 코드 (6자리)
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

-- ================================================================
-- 2. PROFILES (사용자 프로필 — auth.users 확장)
-- ================================================================
create table if not exists profiles (
  id          uuid references auth.users(id) on delete cascade primary key,
  family_id   uuid references families(id) on delete set null,
  name        text,
  role        text default 'member' check (role in ('owner', 'admin', 'member')),
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

-- ================================================================
-- 3. FAMILY MEMBERS (가족 구성원 — 실제 가족, 앱 사용자 아님)
-- ================================================================
create table if not exists family_members (
  id            uuid default uuid_generate_v4() primary key,
  family_id     uuid references families(id) on delete cascade not null,
  name          text not null,
  relation      text not null,  -- 본인/배우자/자녀/부모/조부모/삼촌/고모/손자녀/기타
  generation    integer default 0, -- 0=본인세대, 1=부모세대, 2=조부모세대, -1=자녀세대
  age           integer,
  annual_income numeric(15,2) default 0,  -- 억
  cash_hold     numeric(15,2) default 0,  -- 보유 현금 억
  total_debt    numeric(15,2) default 0,  -- 기타 부채 억
  color         text default '#B5D4F4',
  notes         text,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

-- ================================================================
-- 4. ASSETS (자산)
-- ================================================================
create table if not exists assets (
  id                    uuid default uuid_generate_v4() primary key,
  family_id             uuid references families(id) on delete cascade not null,
  owner_member_id       uuid references family_members(id) on delete set null,
  name                  text not null,
  asset_type            text not null,
  -- 상업용부동산/주거용부동산/토지/금융자산/비상장주식/예금채권/기타
  current_value         numeric(15,2) not null default 0,   -- 현재 시가 억
  acquisition_cost      numeric(15,2) default 0,            -- 취득가 억
  acquisition_date      date,                               -- 취득일
  annual_yield_pct      numeric(5,2) default 0,             -- 연수익률 %
  annual_tax            numeric(15,2) default 0,            -- 보유세 억
  loan_amount           numeric(15,2) default 0,            -- 대출잔액 억
  loan_rate_pct         numeric(5,2) default 0,             -- 대출금리 %
  loan_type             text default 'fixed',               -- fixed/variable
  expected_growth_pct   numeric(5,2) default 2,             -- 기대 성장률 %
  public_price_ratio    numeric(5,2) default 70,            -- 공시가/시가 비율 %
  is_planned_transfer   boolean default false,
  notes                 text,
  created_at            timestamptz default now(),
  updated_at            timestamptz default now()
);

-- ================================================================
-- 5. ASSET SHARES (자산 지분 구조)
-- ================================================================
create table if not exists asset_shares (
  id          uuid default uuid_generate_v4() primary key,
  asset_id    uuid references assets(id) on delete cascade not null,
  member_id   uuid references family_members(id) on delete cascade not null,
  pct         numeric(5,2) not null,  -- 지분율 %
  created_at  timestamptz default now(),
  unique(asset_id, member_id)
);

-- ================================================================
-- 6. PAST GIFTS (과거 증여 이력 — 10년 합산용)
-- ================================================================
create table if not exists past_gifts (
  id            uuid default uuid_generate_v4() primary key,
  family_id     uuid references families(id) on delete cascade not null,
  from_member_id uuid references family_members(id) on delete set null,
  to_member_id  uuid references family_members(id) on delete set null,
  amount        numeric(15,2) not null,   -- 억
  gift_date     date not null,
  gift_type     text default '현금',      -- 현금/부동산/주식/기타
  notes         text,
  created_at    timestamptz default now()
);

-- ================================================================
-- 7. TRANSFER PLANS (이전 계획)
-- ================================================================
create table if not exists transfer_plans (
  id              uuid default uuid_generate_v4() primary key,
  family_id       uuid references families(id) on delete cascade not null,
  asset_id        uuid references assets(id) on delete cascade,
  from_member_id  uuid references family_members(id) on delete set null,
  to_member_id    uuid references family_members(id) on delete set null,
  transfer_type   text not null,
  -- 증여(생전)/상속(사후)/세대생략증여/지분증여/법인이전/매각후분배/가족간대출
  transfer_pct    numeric(5,2) default 100,   -- 이전 비율 %
  year_offset     integer default 1,           -- 몇 년 후
  priority        text default '중간',         -- 즉시/단기/중기/장기
  estimated_tax   numeric(15,2),               -- 예상 세금 (자동계산)
  notes           text,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

-- ================================================================
-- 8. CORPORATIONS (법인)
-- ================================================================
create table if not exists corporations (
  id              uuid default uuid_generate_v4() primary key,
  family_id       uuid references families(id) on delete cascade not null,
  name            text not null,
  corp_type       text default '유한회사',  -- 주식회사/유한회사/유한책임회사
  capital         numeric(15,2) default 1,  -- 자본금 억
  annual_revenue  numeric(15,2) default 0,  -- 연 수익 억
  ceo_salary      numeric(15,2) default 1.2, -- 대표 급여 억
  established_year integer,
  notes           text,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

-- ================================================================
-- 9. CORP SHARES (법인 지분)
-- ================================================================
create table if not exists corp_shares (
  id          uuid default uuid_generate_v4() primary key,
  corp_id     uuid references corporations(id) on delete cascade not null,
  member_id   uuid references family_members(id) on delete cascade not null,
  pct         numeric(5,2) not null,
  created_at  timestamptz default now(),
  unique(corp_id, member_id)
);

-- ================================================================
-- 10. DEBTS (부채)
-- ================================================================
create table if not exists debts (
  id          uuid default uuid_generate_v4() primary key,
  family_id   uuid references families(id) on delete cascade not null,
  member_id   uuid references family_members(id) on delete set null,
  description text not null,
  amount      numeric(15,2) not null,  -- 억
  rate_pct    numeric(5,2) default 4,  -- 금리 %
  created_at  timestamptz default now()
);

-- ================================================================
-- 11. MACRO SETTINGS (거시 변수)
-- ================================================================
create table if not exists macro_settings (
  id                    uuid default uuid_generate_v4() primary key,
  family_id             uuid references families(id) on delete cascade unique not null,
  base_rate_pct         numeric(5,2) default 3.5,     -- 기준금리 %
  rate_shock_pct        numeric(5,2) default 1.5,     -- 금리 스트레스 시나리오 %p
  land_growth_pct       numeric(5,2) default 2.0,     -- 토지 공시가 상승률 %
  apt_growth_pct        numeric(5,2) default 2.5,     -- 아파트 상승률 %
  commercial_growth_pct numeric(5,2) default 1.5,     -- 상업용 상승률 %
  inflation_pct         numeric(5,2) default 2.0,     -- 물가 상승률 %
  updated_at            timestamptz default now()
);

-- ================================================================
-- RLS (Row Level Security) — 가족 데이터 격리
-- ================================================================
alter table families enable row level security;
alter table profiles enable row level security;
alter table family_members enable row level security;
alter table assets enable row level security;
alter table asset_shares enable row level security;
alter table past_gifts enable row level security;
alter table transfer_plans enable row level security;
alter table corporations enable row level security;
alter table corp_shares enable row level security;
alter table debts enable row level security;
alter table macro_settings enable row level security;

-- Helper: 현재 유저의 family_id
create or replace function get_my_family_id()
returns uuid language sql security definer as $$
  select family_id from profiles where id = auth.uid()
$$;

-- Profiles: 본인만
create policy "profiles_self" on profiles
  for all using (id = auth.uid());

-- Families: 소속 가족만
create policy "families_member" on families
  for all using (id = get_my_family_id());

-- 나머지 테이블: 같은 family_id만
create policy "family_members_policy" on family_members
  for all using (family_id = get_my_family_id());
create policy "assets_policy" on assets
  for all using (family_id = get_my_family_id());
create policy "asset_shares_policy" on asset_shares
  for all using (
    asset_id in (select id from assets where family_id = get_my_family_id())
  );
create policy "past_gifts_policy" on past_gifts
  for all using (family_id = get_my_family_id());
create policy "transfer_plans_policy" on transfer_plans
  for all using (family_id = get_my_family_id());
create policy "corporations_policy" on corporations
  for all using (family_id = get_my_family_id());
create policy "corp_shares_policy" on corp_shares
  for all using (
    corp_id in (select id from corporations where family_id = get_my_family_id())
  );
create policy "debts_policy" on debts
  for all using (family_id = get_my_family_id());
create policy "macro_settings_policy" on macro_settings
  for all using (family_id = get_my_family_id());

-- ================================================================
-- FUNCTIONS
-- ================================================================

-- 회원가입 시 자동으로 profile 생성
create or replace function handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into profiles (id, name)
  values (new.id, new.raw_user_meta_data->>'name');
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- 가족 생성 + 초대코드 발급
create or replace function create_family(family_name text)
returns json language plpgsql security definer as $$
declare
  new_family_id uuid;
  invite text;
begin
  -- 6자리 랜덤 코드
  invite := upper(substring(md5(random()::text), 1, 6));

  insert into families (name, invite_code)
  values (family_name, invite)
  returning id into new_family_id;

  -- 현재 유저를 owner로 설정
  update profiles
  set family_id = new_family_id, role = 'owner'
  where id = auth.uid();

  -- 기본 macro_settings 생성
  insert into macro_settings (family_id) values (new_family_id);

  return json_build_object(
    'family_id', new_family_id,
    'invite_code', invite
  );
end;
$$;

-- 초대코드로 가족 합류
create or replace function join_family(code text)
returns json language plpgsql security definer as $$
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

-- ================================================================
-- Migration 001: Asset 및 MacroSettings 확장 필드 추가
-- 기존 데이터 보호: 모든 신규 컬럼 nullable 또는 기본값 설정
-- 실행: Supabase Dashboard → SQL Editor → 이 파일 내용 붙여넣기
-- ================================================================

-- ── assets 테이블 확장 ─────────────────────────────────────────

-- 가치 평가
ALTER TABLE assets
  ADD COLUMN IF NOT EXISTS assessed_value       NUMERIC(15,2)  DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS appraisal_value      NUMERIC(15,2)  DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS valuation_source     TEXT           DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS necessary_expenses   NUMERIC(15,2)  DEFAULT NULL;

-- 수익·성장
ALTER TABLE assets
  ADD COLUMN IF NOT EXISTS monthly_rent         NUMERIC(12,2)  DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS vacancy_rate_pct     NUMERIC(6,2)   DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS maintenance_cost     NUMERIC(15,2)  DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS dividend_yield_pct   NUMERIC(6,2)   DEFAULT NULL;

-- 대출·채무
ALTER TABLE assets
  ADD COLUMN IF NOT EXISTS jeonse_deposit       NUMERIC(15,2)  DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS other_assumed_debt   NUMERIC(15,2)  DEFAULT NULL;

-- 자산 특성
ALTER TABLE assets
  ADD COLUMN IF NOT EXISTS is_primary_residence BOOLEAN        DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS is_regulated_area    BOOLEAN        DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS housing_use          BOOLEAN        DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS house_count          SMALLINT       DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS ownership_share_pct  NUMERIC(6,2)   DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS co_owner_count       SMALLINT       DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS collateral_available BOOLEAN        DEFAULT NULL;

-- 유동성
ALTER TABLE assets
  ADD COLUMN IF NOT EXISTS liquidity_score          SMALLINT   DEFAULT NULL
    CHECK (liquidity_score IS NULL OR (liquidity_score BETWEEN 1 AND 5)),
  ADD COLUMN IF NOT EXISTS forced_sale_discount_pct NUMERIC(6,2) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS sale_lead_months         SMALLINT   DEFAULT NULL;

-- 통화·변동성
ALTER TABLE assets
  ADD COLUMN IF NOT EXISTS currency        TEXT          DEFAULT 'KRW',
  ADD COLUMN IF NOT EXISTS volatility_pct  NUMERIC(6,2)  DEFAULT NULL;

-- asset_type enum 확장 (기존 check constraint 제거 후 재생성)
-- 주의: Supabase에서 enum 직접 사용 시 별도 처리 필요
-- 현재 TEXT 타입인 경우 아래 주석 해제:
-- ALTER TABLE assets DROP CONSTRAINT IF EXISTS assets_asset_type_check;

-- ── macro_settings 테이블 확장 ─────────────────────────────────

ALTER TABLE macro_settings
  -- 금융자산 기대수익률
  ADD COLUMN IF NOT EXISTS deposit_rate_pct           NUMERIC(6,2) DEFAULT 3.5,
  ADD COLUMN IF NOT EXISTS bond_return_pct            NUMERIC(6,2) DEFAULT 4.0,
  ADD COLUMN IF NOT EXISTS domestic_stock_return_pct  NUMERIC(6,2) DEFAULT 6.0,
  ADD COLUMN IF NOT EXISTS foreign_stock_return_pct   NUMERIC(6,2) DEFAULT 7.0,
  ADD COLUMN IF NOT EXISTS unlisted_stock_return_pct  NUMERIC(6,2) DEFAULT 8.0,
  -- 임대 가정
  ADD COLUMN IF NOT EXISTS rent_growth_pct            NUMERIC(6,2) DEFAULT 2.0,
  ADD COLUMN IF NOT EXISTS vacancy_rate_pct           NUMERIC(6,2) DEFAULT 5.0,
  ADD COLUMN IF NOT EXISTS forced_sale_discount_pct   NUMERIC(6,2) DEFAULT 15.0,
  ADD COLUMN IF NOT EXISTS financial_stress_drop_pct  NUMERIC(6,2) DEFAULT 20.0,
  -- 상속 가정
  ADD COLUMN IF NOT EXISTS inheritance_year_offset    SMALLINT     DEFAULT 10,
  ADD COLUMN IF NOT EXISTS installment_surcharge_pct  NUMERIC(6,2) DEFAULT NULL;

-- ── 확인 쿼리 ─────────────────────────────────────────────────
-- 실행 후 아래로 신규 컬럼 추가 확인:
-- SELECT column_name, data_type, is_nullable
-- FROM information_schema.columns
-- WHERE table_name = 'assets'
-- ORDER BY ordinal_position;

export type Relation =
  | '본인' | '배우자' | '자녀' | '며느리' | '사위'
  | '부모' | '조부모' | '삼촌' | '고모' | '손자녀' | '기타';

export type AssetType =
  | '주거용부동산'   // 아파트, 단독주택, 다가구
  | '상업용부동산'   // 상가, 오피스
  | '토지'
  | '농지'
  | '임야'
  | '오피스텔'
  | '예금'
  | '채권'
  | '국내주식'
  | '해외주식'
  | '비상장주식'
  | '보험'
  | '금융자산'       // 기존 호환 유지
  | '예금채권'       // 기존 호환 유지
  | '기타';

/** 자산 평가 기준 */
export type ValuationSource =
  | 'market_price'       // 시가 (실거래, 감정평가)
  | 'assessed_value'     // 공시가격 (보충적 평가)
  | 'appraisal'          // 감정평가
  | 'book_value'         // 장부가 (비상장주식 등)
  | 'unknown';           // 미확인

export type TransferType =
  | '증여(생전)' | '상속(사후)' | '세대생략증여'
  | '지분증여' | '법인이전' | '매각후분배' | '가족간대출';

export type CorpType = '주식회사' | '유한회사' | '유한책임회사';

export type UserRole = 'owner' | 'admin' | 'member';

// ── DB Row Types ──────────────────────────────────────────────
export interface Family {
  id: string;
  name: string;
  invite_code: string;
  created_at: string;
}

export interface Profile {
  id: string;
  family_id: string | null;
  name: string | null;
  role: UserRole;
}

export interface FamilyMember {
  id: string;
  family_id: string;
  name: string;
  relation: Relation;
  generation: number;
  age: number;
  annual_income: number;   // 억
  cash_hold: number;       // 억
  total_debt: number;      // 억
  color: string;
  notes?: string;
}

export interface Asset {
  id: string;
  family_id: string;
  owner_member_id: string | null;
  name: string;
  asset_type: AssetType;

  // ── 가치 평가 ──────────────────────────────────────────────
  current_value: number;             // 억 (시가 기준)
  acquisition_cost: number;          // 억 (취득가)
  acquisition_date: string | null;
  /** 공시가격 (억). null이면 current_value × public_price_ratio/100 으로 추정 */
  assessed_value: number | null;     // 억
  /** 공시가격/시가 비율 (%, 기존 호환) */
  public_price_ratio: number;        // %
  /** 감정평가액 (억, 없으면 null) */
  appraisal_value: number | null;    // 억
  /** 평가 기준 */
  valuation_source: ValuationSource | null;
  /** 필요경비 (억, 취득세·수수료 등) */
  necessary_expenses: number | null; // 억

  // ── 수익·성장 ──────────────────────────────────────────────
  annual_yield_pct: number;          // % (임대수익률 또는 배당률)
  expected_growth_pct: number;       // % (연간 자산 성장률)
  annual_tax: number;                // 억 (보유세)
  /** 월 임대료 (만원, 관리비 제외) */
  monthly_rent: number | null;       // 만원
  /** 공실률 가정 (%) */
  vacancy_rate_pct: number | null;   // %
  /** 연 관리비·수선비 (억) */
  maintenance_cost: number | null;   // 억
  /** 이자·배당 수익률 (금융자산 전용, %) */
  dividend_yield_pct: number | null; // %

  // ── 대출·채무 ──────────────────────────────────────────────
  loan_amount: number;               // 억 (담보대출)
  loan_rate_pct: number;             // % (대출 금리)
  loan_type: 'fixed' | 'variable';
  /** 전세보증금 (억, 부담부증여 계산에 사용) */
  jeonse_deposit: number | null;     // 억
  /** 기타 채무 (억, 미지급금 등) */
  other_assumed_debt: number | null; // 억

  // ── 자산 특성 ──────────────────────────────────────────────
  is_planned_transfer: boolean;
  /** 1세대 1주택 여부 */
  is_primary_residence: boolean | null;
  /** 규제지역 여부 (토지거래허가구역, 조정대상지역 등) */
  is_regulated_area: boolean | null;
  /** 주거용 용도 여부 (오피스텔 등 구분용) */
  housing_use: boolean | null;
  /** 보유 주택 수 (취득세·양도세 중과 판단) */
  house_count: number | null;
  /** 지분 소유 비율 (%, 100=단독) */
  ownership_share_pct: number | null;
  /** 공유자 수 */
  co_owner_count: number | null;
  /** 담보 제공 가능 여부 */
  collateral_available: boolean | null;

  // ── 유동성 ────────────────────────────────────────────────
  /** 유동성 점수 (1=즉시 현금화, 5=매각 어려움) */
  liquidity_score: number | null;    // 1~5
  /** 급매 시 할인율 (%) */
  forced_sale_discount_pct: number | null; // %
  /** 정상 매각 소요 기간 (개월) */
  sale_lead_months: number | null;   // 개월

  // ── 통화·변동성 (해외자산) ────────────────────────────────
  currency: string | null;           // 'KRW', 'USD', ...
  volatility_pct: number | null;     // % 연간 변동성

  notes?: string;
  // joined
  shares?: AssetShare[];
  owner?: FamilyMember;
}

export interface AssetShare {
  id: string;
  asset_id: string;
  member_id: string;
  pct: number;
  member?: FamilyMember;
}

export interface PastGift {
  id: string;
  family_id: string;
  from_member_id: string;
  to_member_id: string;
  amount: number;    // 억
  gift_date: string;
  gift_type: string;
  notes?: string;
  from_member?: FamilyMember;
  to_member?: FamilyMember;
}

export interface TransferPlan {
  id: string;
  family_id: string;
  asset_id: string | null;
  from_member_id: string | null;
  to_member_id: string | null;
  transfer_type: TransferType;
  transfer_pct: number;
  year_offset: number;
  priority: string;
  estimated_tax: number | null;
  notes?: string;
  asset?: Asset;
  from_member?: FamilyMember;
  to_member?: FamilyMember;
}

export interface Corporation {
  id: string;
  family_id: string;
  name: string;
  corp_type: CorpType;
  capital: number;
  annual_revenue: number;
  ceo_salary: number;
  established_year: number | null;
  notes?: string;
  shares?: CorpShare[];
}

export interface CorpShare {
  id: string;
  corp_id: string;
  member_id: string;
  pct: number;
  member?: FamilyMember;
}

export interface MacroSettings {
  id: string;
  family_id: string;
  // ── 금리 ──────────────────────────────────────────────────
  base_rate_pct: number;
  rate_shock_pct: number;
  // ── 부동산 성장률 ─────────────────────────────────────────
  apt_growth_pct: number;
  land_growth_pct: number;
  commercial_growth_pct: number;
  // ── 금융자산 기대수익률 (nullable, DB에서 null 가능) ──────
  deposit_rate_pct?: number | null;          // 예금 이자율
  bond_return_pct?: number | null;           // 채권 기대수익률
  domestic_stock_return_pct?: number | null; // 국내 주식
  foreign_stock_return_pct?: number | null;  // 해외 주식
  unlisted_stock_return_pct?: number | null; // 비상장주식
  // ── 임대 가정 ─────────────────────────────────────────────
  rent_growth_pct?: number | null;           // 임대료 상승률
  vacancy_rate_pct?: number | null;          // 공실률 기본가정
  forced_sale_discount_pct?: number | null;  // 급매 할인율
  financial_stress_drop_pct?: number | null; // 금융자산 스트레스 하락률
  // ── 상속 가정 ─────────────────────────────────────────────
  inheritance_year_offset?: number | null;   // 상속 발생 가정 시점 (0=지금, 5, 10)
  installment_surcharge_pct?: number | null; // 연부연납 가산율 (null=정책 자동)
  // ── 기타 ──────────────────────────────────────────────────
  inflation_pct: number;
}

// ── Computed Types ────────────────────────────────────────────
export interface TaxResult {
  giftTax: number;
  inheritanceTax: number;
  capitalGainsTax: number;
  holdingTax: number;  // 재산세 + 종부세
  incomeTax: number;   // 임대소득세
  acquisitionTax: number;
  totalTax: number;
}

export interface ScenarioResult {
  id: string;
  label: string;
  strategy: string;
  yr5NetWealth: number;
  yr10NetWealth: number;
  yr20NetWealth: number;
  totalTax10yr: number;
  annualCashflow: number;
  inheritanceTax: number;
  liquidityRisk: 'low' | 'medium' | 'high';
  taxRisk: 'low' | 'medium' | 'high';
  complexity: 'low' | 'medium' | 'high';
  pros: string[];
  cons: string[];
  actions: string[];
  isRecommended: boolean;
}

export interface CashflowResult {
  year: number;
  rentalIncome: number;
  holdingTax: number;
  loanInterest: number;
  incomeTax: number;
  netCashflow: number;
  cumulativeCashflow: number;
  assetValue: number;
  debtBalance: number;
  netWorth: number;
}

export interface FamilyLoanAnalysis {
  fairInterest: number;
  actualInterest: number;
  interestGap: number;
  isGiftTaxable: boolean;
  annualGiftTax: number;
  maxZeroRatePrincipal: number;
  riskLevel: 'safe' | 'caution' | 'danger';
  recommendation: string;
}

export interface CorpLoanImputed {
  imputedInterest: number;
  corpTaxImpact: number;
  recipientIncomeTax: number;
  totalTaxCost: number;
}

export interface CorpConversionResult {
  personalTax: number;
  corpTax: number;
  ceoIncomeTax: number;
  totalCorpBurden: number;
  annualSaving: number;
  transferTax: number;
  paybackYears: number;
  notes: string[];
}

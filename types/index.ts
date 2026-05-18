export type Relation =
  | '본인' | '배우자' | '자녀' | '며느리' | '사위'
  | '부모' | '조부모' | '삼촌' | '고모' | '손자녀' | '기타';

export type AssetType =
  | '상업용부동산' | '주거용부동산' | '토지'
  | '금융자산' | '비상장주식' | '예금채권' | '기타';

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
  current_value: number;       // 억
  acquisition_cost: number;    // 억
  acquisition_date: string | null;
  annual_yield_pct: number;    // %
  annual_tax: number;          // 억
  loan_amount: number;         // 억
  loan_rate_pct: number;       // %
  loan_type: 'fixed' | 'variable';
  expected_growth_pct: number; // %
  public_price_ratio: number;  // %
  is_planned_transfer: boolean;
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
  base_rate_pct: number;
  rate_shock_pct: number;
  land_growth_pct: number;
  apt_growth_pct: number;
  commercial_growth_pct: number;
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

/**
 * KYN v2 Python 백엔드(backend/) 호출 클라이언트.
 *
 * 계산 로직은 여기 없다 — 전부 backend/app/engines/*에 있고, 이 파일은
 * fetch 호출과 타입만 담당한다. 로컬 개발 시 백엔드 실행: `uvicorn app.main:app --port 8000`
 */

const BASE_URL = process.env.NEXT_PUBLIC_KYN_BACKEND_URL ?? 'http://localhost:8000';

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`KYN backend ${path} failed (${res.status}): ${detail}`);
  }
  return res.json();
}

export type ValueStatus =
  | 'CALCULATED' | 'ESTIMATED' | 'ASSUMED'
  | 'REQUIRES_DOCUMENT' | 'REQUIRES_EXPERT' | 'NOT_IMPLEMENTED';

export interface LegalCitation {
  statute: string;
  article: string;
  clause?: string | null;
  source_url?: string | null;
  note?: string | null;
}

export interface GiftTaxRequest {
  gift_amount: number; // 억 원
  relation: string;
  recipient_is_adult?: boolean;
  is_generation_skip?: boolean;
  prior_gifts_10yr?: number;
  as_of: string; // YYYY-MM-DD
}

export interface GiftTaxResponse {
  gift_amount: number;
  deduction_applied: number;
  taxable_base_merged: number;
  tax_before_surcharge: number;
  generation_skip_surcharge: number;
  tax_after_surcharge: number;
  voluntary_filing_credit: number;
  final_tax: number;
  status: ValueStatus;
  legal_basis: LegalCitation[];
  rule_ids_used: string[];
  warnings: string[];
}

export function calcGiftTax(req: GiftTaxRequest) {
  return postJson<GiftTaxResponse>('/calc/gift-tax', req);
}

export interface FeasibilityScoreResponse {
  total_score: number;
  grade: string;
  components: Record<string, number>;
  top_constraints: string[];
  improvement_actions: string[];
  hard_blocked: boolean;
  hard_block_reasons: string[];
}

export interface TaxReviewRiskResponse {
  overall_risk_score: number;
  grade: string;
  risk_type_scores: Record<string, number>;
  drivers: string[];
  mitigations: string[];
  disclaimer: string;
}

export interface ImmediateGiftScenarioRequest {
  donor_id: string;
  family_total_assets: number;
  available_cash: number; // 순수 보유 현금(대출 제외)
  recipients: Array<{ person_id: string; relation: string; gift_amount: number; is_adult?: boolean }>;
  annual_growth_rate?: number;
  event_date: string;
  years?: number;
  // 자금조달 재원 구성 — 대출을 현금과 같은 확실성으로 채점하지 않도록 별도 전달
  family_loan_amount?: number;
  bank_loan_amount?: number;
  bank_loan_annual_interest?: number;
  corp_conversion_amount?: number;
  foundation_amount?: number;
}

export interface ScenarioResponse {
  id: string;
  name: string;
  feasibility_score: FeasibilityScoreResponse | null;
  tax_review_risk: TaxReviewRiskResponse | null;
  rejected: boolean;
  rejection_reasons: string[];
}

export function buildImmediateGiftScenario(req: ImmediateGiftScenarioRequest) {
  return postJson<ScenarioResponse>('/scenario/immediate-gift', req);
}

export async function checkBackendHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/health`);
    return res.ok;
  } catch {
    return false;
  }
}

// ── Phase 2: Family Balance Sheet ───────────────────────────────

export type AssetCategory = 'REAL_ESTATE' | 'EQUITY' | 'BONDS' | 'CASH' | 'BUSINESS_EQUITY' | 'OTHER';

export interface BackendAsset {
  id: string;
  owner_id: string;
  ownership_ratio?: number;
  asset_type: string;
  acquisition_date: string;
  acquisition_cost: string | number;
  valuation: { user_estimate?: string | number };
}

export interface BalanceSheetRequest {
  assets: BackendAsset[];
  debts?: unknown[];
  as_of: string;
  annual_total_income?: number | null;
  annual_debt_service?: number | null;
  annual_interest_expense?: number | null;
}

export interface FamilyBalanceSheetResponse {
  as_of: string;
  assets_by_category: Record<AssetCategory, string>;
  liabilities_by_category: Record<string, string>;
}

export interface BalanceSheetMetricsResponse {
  net_worth: string;
  debt_to_equity: number | null;
  ltv: number | null;
  liquid_asset_ratio: number;
  debt_service_ratio: number | null;
  interest_coverage: number | null;
  asset_concentration: number;
  concentration_category: AssetCategory | null;
}

export function computeBalanceSheet(req: BalanceSheetRequest) {
  return postJson<{ balance_sheet: FamilyBalanceSheetResponse; metrics: BalanceSheetMetricsResponse }>(
    '/balance-sheet/compute', req,
  );
}

// ── Phase 3: Leverage & Capital Recycling ───────────────────────

export interface LeverageScenarioRequest {
  asset_value: string | number;
  equity_ratio: number;
  annual_income_yield_pct: number;
  annual_appreciation_pct: number;
  debt: {
    rate_type?: 'FIXED' | 'FLOATING';
    interest_rate_pct: number;
    amortization?: 'INTEREST_ONLY' | 'AMORTIZING';
    maturity_years?: number;
  };
}

export interface LeverageScenarioResultResponse {
  equity_ratio: number;
  debt_ratio: number;
  equity_amount: string;
  loan_amount: string;
  ltv: number;
  annual_income: string;
  annual_interest: string;
  annual_debt_service: string;
  annual_cashflow_to_equity: string;
  cash_on_cash_roe: number | null;
  total_roe: number | null;
  interest_burden: number | null;
  dscr: number | null;
}

export interface DownsideStressResponse {
  asset_value_shock_pct: number;
  stressed_equity_value: string;
  equity_wiped_out: boolean;
  equity_loss_pct: number | null;
  stressed_ltv: number | null;
}

export interface LeverageLevelComparisonResponse {
  scenario: LeverageScenarioResultResponse;
  downside: DownsideStressResponse;
}

export function compareLeverageLevels(base: LeverageScenarioRequest, equity_ratios?: number[], downside_shock_pct = -0.25) {
  return postJson<LeverageLevelComparisonResponse[]>('/leverage/compare', { base, equity_ratios, downside_shock_pct });
}

export interface CapitalRecyclingRequest {
  existing_asset_value: string | number;
  existing_debt: string | number;
  existing_income_yield_pct: number;
  refinance_target_ltv: number;
  new_asset_equity_ratio: number;
  new_asset_income_yield_pct: number;
  new_asset_appreciation_pct: number;
  interest_rate_pct: number;
}

export interface CapitalRecyclingResponse {
  additional_borrowing: string;
  existing_total_debt_after: string;
  existing_ltv_after: number | null;
  new_asset_price: string;
  new_asset_debt: string;
  combined_net_worth: string;
  net_worth_unchanged_at_t0: boolean;
  combined_annual_cashflow: string;
  combined_ltv: number | null;
}

export function simulateCapitalRecycling(req: CapitalRecyclingRequest) {
  return postJson<CapitalRecyclingResponse>('/leverage/capital-recycling', req);
}

// ── Phase 4: Asset Allocation ────────────────────────────────────

export interface AssetClassAssumption {
  category: AssetCategory;
  expected_return_pct: number;
  volatility_pct: number;
  income_yield_pct?: number;
  liquidity_score?: number;
  tax_treatment?: string;
}

export interface PortfolioAllocationRequest {
  weights: Partial<Record<AssetCategory, number>>;
  assumptions: AssetClassAssumption[];
  correlations?: Array<{ category_a: AssetCategory; category_b: AssetCategory; correlation: number }>;
  debt_to_equity?: number | null;
  cost_of_debt_pct?: number | null;
}

export interface PortfolioAllocationResultResponse {
  expected_return_pct: number;
  expected_total_return_pct: number;
  volatility_pct: number;
  income_yield_pct: number;
  liquidity_score: number;
  concentration: number;
  concentration_category: AssetCategory | null;
  leverage_adjusted_return_pct: number | null;
  sharpe_like_ratio: number | null;
}

export function computePortfolioMetrics(req: PortfolioAllocationRequest) {
  return postJson<PortfolioAllocationResultResponse>('/allocation/portfolio-metrics', req);
}

// ── "내 배정대로" 3단계 평가 (자산별 수증자 배정 → 실제 계산) ──────

export interface AssignedAssetRequest {
  asset_id: string;
  label: string;
  value: number;
  category: AssetCategory | 'OTHER';
  growth_rate_pct?: number;
  loan_amount?: number;
  max_ltv_pct?: number;
  recipient_ids: string[];
  liquidity_score_1to5?: number | null;
}

export interface AssignmentRecipientRequest {
  person_id: string;
  name: string;
  relation: string;
  is_adult?: boolean;
  is_generation_skip?: boolean;
  prior_gifts_10yr?: number;
}

export interface MyAssignmentRequest {
  assets: AssignedAssetRequest[];
  recipients: AssignmentRecipientRequest[];
  as_of: string;
  projection_years?: number[];
  max_split_shift_pct?: number;
}

export interface RecipientBreakdownResponse {
  person_id: string;
  name: string;
  relation: string;
  total_gift_value: number;
  gift_tax: number;
}

export interface AssignmentStageResponse {
  label: string;
  splits: Record<string, Record<string, number>>;
  recipients: RecipientBreakdownResponse[];
  total_gift_value: number;
  total_gift_tax: number;
}

export interface LiquidityNoteResponse {
  asset_id: string;
  label: string;
  category: string;
  liquidity_score: number;
  recommended_for_tax_funding: boolean;
  note: string;
}

export interface FutureProjectionResponse {
  asset_id: string;
  label: string;
  year: number;
  projected_value: number;
  ltv_borrowing_capacity: number;
  additional_borrowing_vs_year0: number;
}

export interface MyAssignmentResultResponse {
  stage1: AssignmentStageResponse;
  stage2: AssignmentStageResponse;
  stage2_saving_vs_stage1: number;
  stage3_liquidity: LiquidityNoteResponse[];
  stage3_future: FutureProjectionResponse[];
  stage3_note: string;
}

export function evaluateMyAssignment(req: MyAssignmentRequest) {
  return postJson<MyAssignmentResultResponse>('/scenario/my-assignment', req);
}

/**
 * 한글 자산유형(assets.asset_type) → 백엔드(Python) 분류 매핑.
 * 여러 페이지(engine-v2, scenarios)에서 각자 따로 들고 있던 걸 하나로 합침.
 */

// AssetCategory (거친 분류 — 대차대조표·자산배분·유동성 기본값용)
export const KOREAN_TO_ASSET_CATEGORY: Record<string, string> = {
  '주거용부동산': 'REAL_ESTATE', '상업용부동산': 'REAL_ESTATE', '토지': 'REAL_ESTATE',
  '오피스텔': 'REAL_ESTATE', '농지': 'REAL_ESTATE', '임야': 'REAL_ESTATE',
  '예금': 'CASH', '예금채권': 'CASH', '채권': 'BONDS',
  '금융자산': 'EQUITY', '국내주식': 'EQUITY', '해외주식': 'EQUITY',
  '비상장주식': 'BUSINESS_EQUITY',
};

// AssetType (세부 분류 — Python Asset 모델의 asset_type 필드용)
export const KOREAN_TO_BACKEND_ASSET_TYPE: Record<string, string> = {
  '주거용부동산': 'HOUSE', '상업용부동산': 'COMMERCIAL_BUILDING', '토지': 'LAND',
  '농지': 'FARMLAND', '임야': 'FOREST', '오피스텔': 'OFFICETEL',
  '예금': 'DEPOSIT', '예금채권': 'DEPOSIT', '채권': 'SECURITY', '금융자산': 'SECURITY',
  '국내주식': 'LISTED_SHARE', '해외주식': 'LISTED_SHARE', '비상장주식': 'UNLISTED_SHARE',
  '보험': 'INSURANCE',
};

// Phase 4 자산군별 기대수익·변동성 참고값 — 실측 데이터 아님, 세무사/투자자문 확인 전 ASSUMED.
// engine-v2·scenarios 양쪽에서 같은 가정을 쓰도록 여기 하나로 통일.
export const ALLOCATION_ASSUMPTIONS: Array<{
  category: string; expected_return_pct: number; volatility_pct: number;
  income_yield_pct: number; liquidity_score: number;
}> = [
  { category: 'REAL_ESTATE', expected_return_pct: 0.025, volatility_pct: 0.10, income_yield_pct: 0.02, liquidity_score: 0.1 },
  { category: 'EQUITY', expected_return_pct: 0.07, volatility_pct: 0.18, income_yield_pct: 0.015, liquidity_score: 0.9 },
  { category: 'BONDS', expected_return_pct: 0.03, volatility_pct: 0.05, income_yield_pct: 0.04, liquidity_score: 0.7 },
  { category: 'CASH', expected_return_pct: 0.0, volatility_pct: 0.0, income_yield_pct: 0.03, liquidity_score: 1.0 },
  { category: 'BUSINESS_EQUITY', expected_return_pct: 0.08, volatility_pct: 0.25, income_yield_pct: 0.0, liquidity_score: 0.05 },
  { category: 'OTHER', expected_return_pct: 0.02, volatility_pct: 0.08, income_yield_pct: 0.0, liquidity_score: 0.3 },
];

// 유동성(1=즉시 현금화~5=매각 매우 어려움) → 0~1(높을수록 유동적) 점수.
// assets 페이지에서 자산별로 직접 설정한 값이 있으면 항상 이걸 우선한다.
export function liquidityScore01(liquidityScore1to5: number | null | undefined, category: string): number {
  if (liquidityScore1to5 != null) {
    const clamped = Math.max(1, Math.min(5, liquidityScore1to5));
    return (5 - clamped) / 4;
  }
  const CATEGORY_DEFAULT: Record<string, number> = {
    REAL_ESTATE: 0.1, EQUITY: 0.9, BONDS: 0.7, CASH: 1.0, BUSINESS_EQUITY: 0.05, OTHER: 0.3,
  };
  return CATEGORY_DEFAULT[category] ?? 0.3;
}

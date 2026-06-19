/**
 * 세금 계산 결과 공통 타입
 * 모든 TaxEstimate 객체는 confidence와 assumptions를 포함해야 합니다.
 */

/** 계산 결과 신뢰도 */
export type StrategyConfidence =
  | 'law_based'      // 법령 기반 계산 — 입력값 정확하면 신뢰
  | 'input_estimate' // 입력값 기반 추정 — 일부 가정 포함
  | 'rough_estimate' // 단순 가정 — 방향성 참고용
  | 'expert_review'; // 전문가 확인 필수

/** 회생 수단 상태 */
export type RecoveryOptionStatus =
  | 'immediately_available' // 즉시 사용 가능
  | 'conditionally_available' // 조건부 가능
  | 'expert_review'         // 전문가 검토 필요
  | 'insufficient_input'    // 입력 부족
  | 'not_applicable';       // 적용 불가

export interface TaxAssumption {
  field: string;
  assumed: string;
  actual?: string;
  impact: 'high' | 'medium' | 'low';
}

/** 세금 추정 결과 — 모든 계산 함수의 반환 기본 구조 */
export interface TaxEstimate {
  /** 계산된 세액 (억) */
  amount: number;
  /** 신뢰도 */
  confidence: StrategyConfidence;
  /** 적용된 가정 목록 */
  assumptions: TaxAssumption[];
  /** 경고 메시지 */
  warnings: string[];
  /** 법적 근거 */
  legalBasis: string[];
  /** 추정 범위 */
  range?: { min: number; max: number };
}

/** 부담부증여 입력 */
export interface BurdenedGiftInput {
  /** 자산 시가 (억) */
  marketValue: number;
  /** 공시가격 (억, 없으면 null) */
  assessedValue: number | null;
  /** 취득가 (억) */
  acquisitionCost: number;
  /** 채무 (대출 + 전세보증금, 억) */
  totalDebt: number;
  /** 채무 중 전세보증금 비율 (0~1, 별도 추적용) */
  jeonseRatio?: number;
  /** 보유기간 (년) */
  holdingYears: number;
  /** 수증자 관계 */
  relation: string;
  /** 수증자 나이 */
  recipientAge?: number;
  /** 1세대1주택 해당 여부 */
  isOneHouseOneFamily: boolean;
  /** 다주택 여부 */
  houseCount: number;
  /** 규제지역 여부 */
  isRegulatedArea: boolean;
  /** 주거용 자산 여부 (없으면 true로 간주) */
  isResidential?: boolean;
  /** 수증자가 인수 채무를 상환할 소득·재산을 증명할 수 있는지 */
  recipientCanProveDebtRepayment?: boolean;
  /** 필요경비 (억, 없으면 0) */
  necessaryExpenses?: number;
  /** 10년 내 동일인 사전증여 합계 (억) */
  priorGifts10yr?: number;
}

/** 부담부증여 계산 결과 */
export interface BurdenedGiftResult {
  /** 증여분 (시가 - 채무) */
  giftPortion: TaxEstimate;
  /** 양도분 (채무) */
  transferPortion: TaxEstimate;
  /** 취득세 */
  acquisitionTax: TaxEstimate;
  /** 취득세 중 채무 인수분 (유상취득 간이 추정) */
  acquisitionTaxOnerous: TaxEstimate;
  /** 취득세 중 순증여분 (무상취득 간이 추정) */
  acquisitionTaxGift: TaxEstimate;
  /** 합계 */
  total: TaxEstimate;
  /** 직접 증여 대비 절세액 */
  savingVsDirectGift: number;
  /** 사용된 평가 방법 */
  valuationMethod: 'market_price' | 'supplemental_assessed' | 'unknown';
  /** 평가 방법 변경 가능성 */
  valuationNote: string;
}

/** 가족간 저가매매 입력 */
export interface RelatedPartySaleInput {
  /** 자산 시가 (억) */
  marketValue: number;
  /** 매매 제안가 (억) */
  salePrice: number;
  /** 취득가 (억) */
  acquisitionCost: number;
  /** 보유기간 (년) */
  holdingYears: number;
  /** 1세대1주택 여부 */
  isOneHouseOneFamily: boolean;
  /** 다주택 여부 */
  houseCount: number;
  /** 규제지역 여부 */
  isRegulatedArea: boolean;
  /** 주거용 자산 여부 (없으면 true로 간주) */
  isResidential?: boolean;
  /** 수증자 관계 */
  relation: string;
  /** 필요경비 (억) */
  necessaryExpenses?: number;
  /** 10년 내 동일인 사전증여 합계 (억) */
  priorGifts10yr?: number;
}

/** 가족간 저가매매 결과 */
export interface RelatedPartySaleResult {
  /** 시가와 매매가의 차액 (억) */
  priceDiff: number;
  /** 증여 의제 여부 (상증법 §35) */
  isGiftDeemed: boolean;
  /** 과세 기준 */
  taxableGiftAmount: number;
  /** 증여세 */
  giftTax: TaxEstimate;
  /** 양도세 (매도자) */
  capitalGainsTax: TaxEstimate;
  /** 취득세 (매수자) */
  acquisitionTax: TaxEstimate;
  /** 합계 세금 */
  totalTax: TaxEstimate;
  /** 직접 증여 대비 절세액 */
  savingVsDirectGift: number;
  /** 증여세 0원 가능한 최적 매매가 (억) */
  zeroGiftTaxOptimalPrice: number;
  /** 임계값 설명 */
  thresholdNote: string;
}

/** 가족간 자산 교환 단일 자산 */
export interface ExchangeAsset {
  name: string;
  marketValue: number;
  assessedValue: number | null;
  acquisitionCost: number;
  holdingYears: number;
  assetType: string;
  isResidential: boolean;
  houseCount: number;
  isRegulatedArea: boolean;
  necessaryExpenses?: number;
}

/** 가족간 자산 교환 결과 */
export interface FamilyExchangeResult {
  /** 교환차액 (억, 0이면 동등 교환) */
  exchangeDiff: number;
  /** 교환차액에 대한 증여세 가능성 */
  giftOnDiff: TaxEstimate;
  /** 양도세 (좌측 자산 — 교환 시 시가 기준) */
  cgtLeft: TaxEstimate;
  /** 양도세 (우측 자산) */
  cgtRight: TaxEstimate;
  /** 취득세 (좌측, 우측 각각) */
  acqTaxLeft: TaxEstimate;
  acqTaxRight: TaxEstimate;
  /** 합계 세금 */
  totalTax: TaxEstimate;
  /** 직접 증여 대비 절세액 (좌측 자산 기준) */
  savingVsDirectGift: number;
  /** 교환 시 공시가격 활용 가능 여부 */
  canUseAssessedValue: boolean;
}

/** 6개월 현금 부족 분석 */
export interface SixMonthShortfallAnalysis {
  /** 예상 상속세 (억) */
  inheritanceTax: number;
  /** 신고기한 내 1차 납부액 (연부연납 가정 시) (억) */
  initialPayment: number;
  /** 즉시 가용 현금 합계 (억) */
  availableCash: number;
  /** 즉시 현금화 가능 금융자산 (억) */
  liquidFinancial: number;
  /** 즉시 부족액 (억, 0이면 충분) */
  immediateShortfall: number;
  /** 6개월 내 담보대출 가능액 (억) */
  loanCapacity: number;
  /** 담보대출 포함 후 잔여 부족액 (억) */
  shortfallAfterLoan: number;
  /** 급매 필요 여부 */
  forcedSaleRequired: boolean;
  /** 급매 필요 추정액 (억) */
  forcedSaleAmount: number;
}

/** 연도별 현금흐름 행 */
export interface AnnualCashflowRow {
  year: number;
  /** 연부연납 원금 납부 (억) */
  installmentPrincipal: number;
  /** 연부연납 가산금 (억) */
  installmentSurcharge: number;
  /** 담보대출 이자 (억) */
  loanInterest: number;
  /** 임대수익 (세후) (억) */
  rentalIncome: number;
  /** 금융자산 이자·배당 (억) */
  financialIncome: number;
  /** 연간 순현금흐름 (억, 양수=흑자) */
  netCashflow: number;
  /** 누적 현금흐름 (억) */
  cumulative: number;
  /** 위험 여부 */
  isAtRisk: boolean;
}

/** 10년 회생 분석 */
export interface RecoveryAnalysis {
  /** 6개월 부족 분석 */
  sixMonth: SixMonthShortfallAnalysis;
  /** 연도별 현금흐름 (1~10년) */
  annualCashflows: AnnualCashflowRow[];
  /** 금리 +2%p 스트레스 시 최초 위험 연도 (-1 = 문제없음) */
  rateStressFirstRiskYear: number;
  /** 급매 없이 보존 가능한 자산 비율 (0~1) */
  preservationRatio: number;
  /** 10년 후 잔여 순자산 (억) */
  netWorth10yr: number;
  /** 전체 신뢰도 */
  confidence: StrategyConfidence;
}

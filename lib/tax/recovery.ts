/**
 * 회생 엔진 — 상속세 납부 가능성 분석
 *
 * 핵심 질문:
 *  1. 상속 발생 후 6개월 안에 현금이 얼마나 필요한가?
 *  2. 연부연납으로 10년간 버틸 수 있는가?
 *  3. 금리 상승·공실 발생 시에도 계획이 유지되는가?
 *
 * 근거:
 *  - 상증세법 §67 (신고기한 6개월)
 *  - 상증세법 §71 (연부연납 최대 10년)
 *  - 연부연납 가산율: 2024.3.22~ 3.5%/년 (국세청 고시)
 */

import { getInstallmentSurchargeRate, INSTALLMENT_MAX_YEARS } from './policy';
import type { SixMonthShortfallAnalysis, AnnualCashflowRow, RecoveryAnalysis } from './types';

export interface RecoveryInput {
  /** 예상 상속세 (억) */
  inheritanceTax: number;
  /** 즉시 가용 현금 (피상속인 보유 현금 + 배우자 현금, 억) */
  ownCash: number;
  /** 즉시 현금화 가능 금융자산 (예금·MMF 등, 억) */
  liquidFinancialAssets: number;
  /** 부동산 담보대출 가능액 (LTV 기준, 억) */
  loanCapacity: number;
  /** 연간 임대수익 세후 (억) */
  annualRentalAfterTax: number;
  /** 연간 금융자산 이자·배당 (억) */
  annualFinancialIncome: number;
  /** 대출 연간 이자 총액 (기존 + 신규 담보대출, 억) */
  annualLoanInterest: number;
  /**
   * 대출 원금 (억).
   * 금리 스트레스 계산에 사용: 추가 이자 = loanPrincipal × rateShockPct/100
   * 없으면 스트레스 이자 증가분 = 0
   */
  loanPrincipal?: number;
  /**
   * 금리 스트레스 시나리오 (+%p).
   * 예) 2 → 연간 이자 = annualLoanInterest + loanPrincipal × 2%
   */
  rateShockPct?: number;
  /** 연부연납 기간 (1~10년) */
  installmentYears?: number;
  /** 물납 가능 여부 */
  inKindAvailable?: boolean;
  /** 물납 한도액 (억, 상속세의 50% 한도) */
  inKindAmount?: number;
  /** 급매 후보 자산 가치 합계 (억) */
  forcedSaleAssetTotal?: number;
  /** 급매 할인율 (0~1, 기본 0.15) */
  forcedSaleDiscountPct?: number;
  /** 현재 날짜 (연부연납 가산율 기준일) */
  baseDate?: Date;
}

/**
 * 6개월 내 현금 부족 분석
 */
export function analyzeSixMonthShortfall(input: RecoveryInput): SixMonthShortfallAnalysis {
  const {
    inheritanceTax, ownCash, liquidFinancialAssets, loanCapacity,
    installmentYears = INSTALLMENT_MAX_YEARS,
    inKindAmount = 0,
    forcedSaleAssetTotal = 0, forcedSaleDiscountPct = 0.15,
  } = input;

  // 신고기한 내 최초 납부액 = 허가세액 / (연부연납기간 + 1)
  // 이후 연부연납기간 동안 동일 원금을 매년 납부합니다.
  const normalizedYears = Math.max(1, installmentYears);
  const initialPayment = inheritanceTax / (normalizedYears + 1);

  // 즉시 가용 현금 합계
  const availableCash = ownCash + liquidFinancialAssets;

  // 6개월 내 부족액
  const immediateShortfall = Math.max(0, initialPayment - availableCash - inKindAmount);

  // 담보대출 후 잔여 부족액
  const shortfallAfterLoan = Math.max(0, immediateShortfall - loanCapacity);

  // 급매 필요 여부
  const forcedSaleRequired = shortfallAfterLoan > 0;
  const forcedSaleAmount = forcedSaleRequired
    ? shortfallAfterLoan / (1 - forcedSaleDiscountPct) // 할인을 감안한 매각 필요 자산가치
    : 0;

  return {
    inheritanceTax,
    initialPayment,
    availableCash,
    liquidFinancial: liquidFinancialAssets,
    immediateShortfall,
    loanCapacity,
    shortfallAfterLoan,
    forcedSaleRequired,
    forcedSaleAmount,
  };
}

/**
 * 10년 연도별 현금흐름 계산
 *
 * 연부연납 구조:
 *   - 신고기한: 첫 납부 (세액 / (N + 1)) → analyzeSixMonthShortfall에서 별도 처리
 *   - Year 1~N: 매년 세액/(N + 1)씩 납부 + 잔액에 대한 가산금
 *   - 이 함수는 신고기한 이후 연도별 납부를 보여줌 (6개월 첫 납부 제외)
 *   - 총 납부 = 첫 납부 + 연도별 N회 납부 = 세액
 */
export function calcAnnualCashflows(
  input: RecoveryInput,
  installmentYears: number = INSTALLMENT_MAX_YEARS,
): AnnualCashflowRow[] {
  const {
    inheritanceTax, annualRentalAfterTax, annualFinancialIncome,
    annualLoanInterest, loanPrincipal = 0,
    rateShockPct = 0, baseDate = new Date(),
  } = input;

  const surchargeRate   = getInstallmentSurchargeRate(baseDate);
  const normalizedYears = Math.max(1, installmentYears);
  // 최초 납부 1회 + 연부연납 N회로 균등 분납 (상증세법 §71)
  const annualPrincipal = inheritanceTax / (normalizedYears + 1);

  // 6개월 시점에 이미 첫 납부를 했으므로
  // 연도별 현금흐름은 연부연납 허가 이후의 납부를 보여줍니다.
  const rows: AnnualCashflowRow[] = [];
  let remaining  = Math.max(0, inheritanceTax - annualPrincipal); // 첫 납부 후 잔액
  let cumulative = 0;
  const yearsRemaining = normalizedYears;

  for (let year = 1; year <= yearsRemaining; year++) {
    const principal = annualPrincipal;
    // 연부연납 가산금 — 전년도 말 잔액 기준 (상증세법 §71 ④)
    const surcharge = remaining * surchargeRate;
    // 대출 이자 (금리 스트레스: +rateShockPct %p를 원금에 곱해 추가 이자 계산)
    const stressExtra = loanPrincipal * (rateShockPct / 100);
    const loanInt     = annualLoanInterest + stressExtra;
    // 수입
    const income     = annualRentalAfterTax + annualFinancialIncome;
    // 순현금흐름 (양수 = 흑자, 음수 = 부족)
    const netCashflow = income - principal - surcharge - loanInt;

    cumulative += netCashflow;
    remaining = Math.max(0, remaining - principal);

    rows.push({
      year,
      installmentPrincipal: principal,
      installmentSurcharge:  surcharge,
      loanInterest:          loanInt,
      rentalIncome:          annualRentalAfterTax,
      financialIncome:       annualFinancialIncome,
      netCashflow,
      cumulative,
      isAtRisk:              netCashflow < 0,
    });
  }

  return rows;
}

/**
 * 전체 회생 분석
 */
export function analyzeRecovery(input: RecoveryInput): RecoveryAnalysis {
  const installmentYears = input.installmentYears ?? INSTALLMENT_MAX_YEARS;

  const sixMonth     = analyzeSixMonthShortfall(input);
  const annualCashflows = calcAnnualCashflows(input, installmentYears);

  // 금리 스트레스 (+2%p) 시 최초 위험 연도
  const stressInput  = { ...input, rateShockPct: (input.rateShockPct ?? 0) + 2 };
  const stressFlows  = calcAnnualCashflows(stressInput, installmentYears);
  const rateStressFirstRiskYear = stressFlows.findIndex(r => r.isAtRisk) + 1; // 1-based, -1 없음

  // 급매 없이 보존 가능한 자산 비율 (간이)
  // 급매 필요액이 작을수록 보존율 높음
  const forcedSaleTotal = input.forcedSaleAssetTotal ?? 0;
  const preservationRatio = forcedSaleTotal > 0
    ? Math.max(0, 1 - sixMonth.forcedSaleAmount / forcedSaleTotal)
    : sixMonth.forcedSaleRequired ? 0 : 1;

  // 10년 후 잔여 순자산 (간이: 초기 + 누적 현금흐름)
  const netWorth10yr = annualCashflows[annualCashflows.length - 1]?.cumulative ?? 0;

  return {
    sixMonth,
    annualCashflows,
    rateStressFirstRiskYear: rateStressFirstRiskYear === 0 ? -1 : rateStressFirstRiskYear,
    preservationRatio,
    netWorth10yr,
    confidence: 'rough_estimate',
  };
}

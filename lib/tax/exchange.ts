/**
 * 가족간 자산 교환 — estimateFamilyAssetExchange
 *
 * 중요: 양쪽 자산 정보가 모두 없으면 계산하지 않습니다.
 * 교환은 각 자산의 시가·취득가·보유기간·주택수·지역을 각각 계산해야 합니다.
 *
 * 근거: 상증세법 §35 (교환차액 증여 의제), 소득세법 §95 (양도세)
 */

import { calcProgressiveTax, calcGiftTaxPure } from './gift';
import {
  VOLUNTARY_FILING_CREDIT, RELATED_PARTY_DISCOUNT_RATE_THRESHOLD,
  RELATED_PARTY_DISCOUNT_ABS_THRESHOLD, CGT_BASIC_DEDUCTION,
  LOCAL_INCOME_TAX_RATE, LTHD_RATES, SHORT_TERM_RATES,
  ACQUISITION_TAX_NON_RESIDENTIAL, ACQUISITION_TAX_SURCHARGE,
} from './policy';
import type { ExchangeAsset, FamilyExchangeResult, TaxEstimate, StrategyConfidence } from './types';

function makeEstimate(
  amount: number,
  confidence: StrategyConfidence,
  assumptions: string[] = [],
  warnings: string[] = [],
  legalBasis: string[] = [],
): TaxEstimate {
  return {
    amount,
    confidence,
    assumptions: assumptions.map(a => ({ field: '', assumed: a, impact: 'medium' as const })),
    warnings,
    legalBasis,
  };
}

function calcCGTForExchange(asset: ExchangeAsset, exchangePrice: number): number {
  const gain = Math.max(0, exchangePrice - asset.acquisitionCost - (asset.necessaryExpenses ?? 0));
  if (gain <= 0) return 0;

  if (asset.holdingYears < 1) return gain * SHORT_TERM_RATES.under1yr * (1 + LOCAL_INCOME_TAX_RATE);
  if (asset.holdingYears < 2) return gain * SHORT_TERM_RATES.under2yr * (1 + LOCAL_INCOME_TAX_RATE);

  let lthdRate = 0;
  for (const b of LTHD_RATES) {
    if (asset.holdingYears >= b.minYears) { lthdRate = b.rate; break; }
  }
  const deductedGain = gain * (1 - lthdRate);
  const taxableGain  = Math.max(0, deductedGain - CGT_BASIC_DEDUCTION);

  // 소득세 기본세율
  let incomeTax = 0;
  if (taxableGain <= 0.14)      incomeTax = taxableGain * 0.06;
  else if (taxableGain <= 0.50) incomeTax = 0.0084 + (taxableGain - 0.14) * 0.15;
  else if (taxableGain <= 0.88) incomeTax = 0.0624 + (taxableGain - 0.50) * 0.24;
  else if (taxableGain <= 1.50) incomeTax = 0.1536 + (taxableGain - 0.88) * 0.35;
  else if (taxableGain <= 3.00) incomeTax = 0.3706 + (taxableGain - 1.50) * 0.38;
  else if (taxableGain <= 5.00) incomeTax = 0.9406 + (taxableGain - 3.00) * 0.40;
  else if (taxableGain <= 10.0) incomeTax = 1.7406 + (taxableGain - 5.00) * 0.42;
  else                          incomeTax = 3.8406 + (taxableGain - 10.0) * 0.45;

  return incomeTax * (1 + LOCAL_INCOME_TAX_RATE);
}

/**
 * 취득세 계산
 * @param value       취득 자산의 가액 (억)
 * @param acquiredAsset  취득하는 자산의 특성 (isResidential 등)
 * @param acquirerHouseCount  취득자의 기존 보유 주택 수 (중과 판단 기준)
 * @param acquirerRegulated  취득자 규제지역 여부
 *
 * 취득세율 = 취득 자산 유형 × 취득자 주택 수 기준 중과 여부
 * 참고: 지방세법 §11, §13의2
 */
function calcAcqTaxForExchange(
  value: number,
  acquiredAsset: ExchangeAsset,
  acquirerHouseCount: number,
  acquirerRegulated: boolean,
): number {
  if (!acquiredAsset.isResidential) {
    return value * (ACQUISITION_TAX_NON_RESIDENTIAL + ACQUISITION_TAX_SURCHARGE);
  }
  // 주택 수 중과 (취득자 기준)
  if (acquirerHouseCount >= 3 || (acquirerHouseCount === 2 && acquirerRegulated)) {
    return value * (0.12 + ACQUISITION_TAX_SURCHARGE);
  }
  if (acquirerHouseCount === 2) return value * (0.08 + ACQUISITION_TAX_SURCHARGE);
  // 1주택 이하: 시가 구간별
  if (value <= 6)  return value * (0.010 + ACQUISITION_TAX_SURCHARGE);
  if (value <= 9)  return value * (0.020 + ACQUISITION_TAX_SURCHARGE);
  return value * (0.030 + ACQUISITION_TAX_SURCHARGE);
}

/**
 * 가족간 자산 교환 세금 추정
 *
 * @param left 부모 자산 (넘겨주는 쪽)
 * @param right 자녀 자산 (받는 쪽)
 * @param relation 수증자 관계 (교환차액 증여세 계산용)
 *
 * 반드시 양쪽 자산 정보가 있어야 합니다.
 * 한쪽만 있으면 이 함수를 호출하지 말고 UI에서 "입력 필요" 표시.
 */
export function estimateFamilyAssetExchange(
  left: ExchangeAsset,
  right: ExchangeAsset,
  relation: string,
): FamilyExchangeResult {
  const warnings: string[] = [];

  // ── 교환차액 (시가 기준) ──────────────────────────────────────
  const exchangeDiff = Math.abs(left.marketValue - right.marketValue);
  const higherValue  = Math.max(left.marketValue, right.marketValue);

  // 교환차액 증여 의제 여부 (상증세법 §35 ①)
  const threshold30pct = higherValue * RELATED_PARTY_DISCOUNT_RATE_THRESHOLD;
  const isGiftOnDiff   = exchangeDiff >= threshold30pct || exchangeDiff >= RELATED_PARTY_DISCOUNT_ABS_THRESHOLD;

  // 증여재산가액 = 교환차액 - 기준금액 (상증세법 시행령 §26 ①)
  const baseDeduction    = Math.min(threshold30pct, RELATED_PARTY_DISCOUNT_ABS_THRESHOLD);
  const taxableExchDiff  = isGiftOnDiff ? Math.max(0, exchangeDiff - baseDeduction) : 0;
  const giftDiffAmount   = taxableExchDiff > 0
    ? calcGiftTaxPure(taxableExchDiff, relation, 0, false)
    : 0;

  const giftOnDiff = makeEstimate(
    giftDiffAmount,
    'input_estimate',
    [isGiftOnDiff
      ? `교환차액 ${exchangeDiff.toFixed(2)}억 - 기준금액 ${baseDeduction.toFixed(2)}억 = 증여재산가액 ${taxableExchDiff.toFixed(2)}억`
      : `교환차액 ${exchangeDiff.toFixed(2)}억이 임계값 미만 → 증여세 없음`],
    isGiftOnDiff ? ['교환가액 산정 기준 (시가 vs 공시가) 및 수혜자 관계 세무사 확인'] : [],
    ['상증세법 §35 ① (증여 의제)', '상증세법 시행령 §26 ① (기준금액 차감)'],
  );

  // ── 공시가격 활용 가능 여부 ────────────────────────────────────
  const canUseAssessedLeft  = left.assessedValue !== null && left.assessedValue < left.marketValue;
  const canUseAssessedRight = right.assessedValue !== null && right.assessedValue < right.marketValue;
  const canUseAssessedValue = canUseAssessedLeft || canUseAssessedRight;

  if (canUseAssessedValue) {
    warnings.push(
      '공시가격으로 교환가액 산정 시 교환차액 축소 → 증여세 감소 가능. '
      + '단, 유사 매매사례가액 존재 시 시가로 재산정될 위험 있음. 세무사 확인 필수.'
    );
  }

  // ── 교환 가격 결정 (양도세 계산 기준) ───────────────────────────
  // 교환 시 양도가액 = 교환받는 자산의 시가 (대가로 본 시가)
  // 공시가 활용 가능 여부는 이 함수에서 자동 결정하지 않음 — 사용자 선택
  const leftExchangePrice  = right.marketValue; // 좌측이 받는 대가 = 우측 시가
  const rightExchangePrice = left.marketValue;  // 우측이 받는 대가 = 좌측 시가

  // ── 양도세 ───────────────────────────────────────────────────
  const cgtLeftAmount  = calcCGTForExchange(left,  leftExchangePrice);
  const cgtRightAmount = calcCGTForExchange(right, rightExchangePrice);

  if (left.houseCount >= 2)  warnings.push(`좌측 자산: ${left.houseCount}주택 양도세 중과 검토`);
  if (right.houseCount >= 2) warnings.push(`우측 자산: ${right.houseCount}주택 양도세 중과 검토`);

  const cgtLeft = makeEstimate(
    cgtLeftAmount, 'input_estimate',
    [`양도가액=${leftExchangePrice.toFixed(1)}억(우측시가), 취득가=${left.acquisitionCost.toFixed(1)}억`],
    left.houseCount >= 2 ? [`다주택(${left.houseCount}주택) 중과 검토 필요`] : [],
    ['소득세법 §95 (장기보유특별공제), 지방소득세 포함'],
  );
  const cgtRight = makeEstimate(
    cgtRightAmount, 'input_estimate',
    [`양도가액=${rightExchangePrice.toFixed(1)}억(좌측시가), 취득가=${right.acquisitionCost.toFixed(1)}억`],
    right.houseCount >= 2 ? [`다주택(${right.houseCount}주택) 중과 검토 필요`] : [],
    ['소득세법 §95 (장기보유특별공제), 지방소득세 포함'],
  );

  // ── 취득세 ───────────────────────────────────────────────────
  // 좌측 사람이 취득하는 자산 = right(우측) 자산
  //   → 취득 자산 특성: right.isResidential, right.assetType
  //   → 취득자 주택 수: left.houseCount (좌측 사람의 기존 보유 수)
  // 우측 사람이 취득하는 자산 = left(좌측) 자산
  //   → 취득 자산 특성: left.isResidential, left.assetType
  //   → 취득자 주택 수: right.houseCount (우측 사람의 기존 보유 수)
  const acqLeftAmount  = calcAcqTaxForExchange(
    leftExchangePrice,       // 좌측이 받는 자산 가액 = right.marketValue
    right,                   // 취득하는 자산의 특성 = right
    left.houseCount,         // 취득자(좌측)의 주택 수
    left.isRegulatedArea,
  );
  const acqRightAmount = calcAcqTaxForExchange(
    rightExchangePrice,      // 우측이 받는 자산 가액 = left.marketValue
    left,                    // 취득하는 자산의 특성 = left
    right.houseCount,        // 취득자(우측)의 주택 수
    right.isRegulatedArea,
  );

  const acqTaxLeft  = makeEstimate(
    acqLeftAmount, 'input_estimate',
    [`취득자산=${right.name ?? 'right'}(${leftExchangePrice.toFixed(1)}억), 취득자주택수=${left.houseCount}호`],
    left.houseCount >= 2 ? ['다주택 취득세 중과 적용 (지방세법 §13의2)'] : [],
    ['지방세법 §11, §13의2'],
  );
  const acqTaxRight = makeEstimate(
    acqRightAmount, 'input_estimate',
    [`취득자산=${left.name ?? 'left'}(${rightExchangePrice.toFixed(1)}억), 취득자주택수=${right.houseCount}호`],
    right.houseCount >= 2 ? ['다주택 취득세 중과 적용 (지방세법 §13의2)'] : [],
    ['지방세법 §11, §13의2'],
  );

  // ── 합계 ─────────────────────────────────────────────────────
  const totalAmount = giftDiffAmount + cgtLeftAmount + cgtRightAmount + acqLeftAmount + acqRightAmount;
  const totalTax = makeEstimate(
    totalAmount, 'rough_estimate',
    [],
    [
      ...warnings,
      '⚠️ 간이 추정값 — 교환 시 각 자산의 시가 확정, 실지 거래가액, 다주택·규제지역 여부를 반드시 세무사와 확인하세요.',
      '취득세는 취득 원인, 주택 수, 규제지역 여부에 따라 달라지므로 별도 검토가 필요합니다.',
    ],
    ['상증세법 §35, 소득세법 §95, 지방세법 §11'],
  );

  // ── 직접 증여 대비 절세 ─────────────────────────────────────
  const directGiftTax   = calcGiftTaxPure(left.marketValue, relation, 0, false);
  // 직접 증여 시 취득자(right측)가 left 자산 취득 → 취득자 주택 수=right.houseCount
  const directAcqTax    = calcAcqTaxForExchange(left.marketValue, left, right.houseCount, right.isRegulatedArea);
  const savingVsDirectGift = (directGiftTax + directAcqTax) - totalAmount;

  return {
    exchangeDiff,
    giftOnDiff,
    cgtLeft,
    cgtRight,
    acqTaxLeft,
    acqTaxRight,
    totalTax,
    savingVsDirectGift,
    canUseAssessedValue,
  };
}

/**
 * 증여세 관련 순수 함수
 * - estimateBurdenedGiftTransfer: 부담부증여
 * - estimateRelatedPartySale: 가족간 저가매매
 * - calcProgressiveTax: 누진세 공통
 */

import {
  GIFT_DEDUCTIONS_BY_RELATION, MINOR_GIFT_DEDUCTION, MARRIAGE_BIRTH_BONUS,
  GEN_SKIP_SURCHARGE_GENERAL, GEN_SKIP_SURCHARGE_MINOR_OVER_20BIL, GEN_SKIP_MINOR_THRESHOLD_BIL,
  VOLUNTARY_FILING_CREDIT, INHERITANCE_GIFT_BRACKETS,
  RELATED_PARTY_DISCOUNT_RATE_THRESHOLD, RELATED_PARTY_DISCOUNT_ABS_THRESHOLD,
  CGT_BASIC_DEDUCTION, LOCAL_INCOME_TAX_RATE, LTHD_RATES,
  SHORT_TERM_RATES, ONE_HOUSE_EXEMPT_LIMIT, LTHD_ONE_HOUSE_MAX,
  ACQUISITION_TAX_NON_RESIDENTIAL, ACQUISITION_TAX_GIFT_BASE, ACQUISITION_TAX_SURCHARGE,
} from './policy';

import type {
  TaxEstimate, StrategyConfidence,
  BurdenedGiftInput, BurdenedGiftResult,
  RelatedPartySaleInput, RelatedPartySaleResult,
} from './types';

// ── 공통 유틸 ──────────────────────────────────────────────────

function makeEstimate(
  amount: number,
  confidence: StrategyConfidence,
  assumptions: string[] = [],
  warnings: string[] = [],
  legalBasis: string[] = [],
  range?: { min: number; max: number },
): TaxEstimate {
  return {
    amount,
    confidence,
    assumptions: assumptions.map(a => ({ field: '', assumed: a, impact: 'medium' as const })),
    warnings,
    legalBasis,
    range,
  };
}

export function calcProgressiveTax(base: number): number {
  // 상증세법 세율 구간 (INHERITANCE_GIFT_BRACKETS)
  for (const b of [...INHERITANCE_GIFT_BRACKETS].reverse()) {
    if (base > b.from) {
      return b.base + (base - b.from) * b.rate;
    }
  }
  return 0;
}

/**
 * 증여세 계산 (신고세액공제 포함)
 * @param amount 증여액 (억)
 * @param relation 수증자 관계
 * @param priorGifts 10년 내 동일인 사전증여 합계 (억)
 * @param isGenerationSkip 세대생략 여부
 * @param recipientAge 수증자 나이
 * @param marriageOrBirthBonus 혼인·출산 추가공제
 */
export function calcGiftTaxPure(
  amount: number,
  relation: string,
  priorGifts = 0,
  isGenerationSkip = false,
  recipientAge?: number,
  marriageOrBirthBonus = false,
): number {
  let ded = GIFT_DEDUCTIONS_BY_RELATION[relation] ?? 0.1;

  if (['자녀', '손자녀'].includes(relation) && recipientAge !== undefined) {
    ded = recipientAge >= 19 ? 0.5 : MINOR_GIFT_DEDUCTION;
  }
  if (marriageOrBirthBonus && ['자녀', '손자녀'].includes(relation)) {
    ded += MARRIAGE_BIRTH_BONUS;
  }

  const prevTaxable = Math.max(0, priorGifts - ded);
  const newTaxable  = Math.max(0, priorGifts + amount - ded);
  let tax = calcProgressiveTax(newTaxable) - calcProgressiveTax(prevTaxable);

  if (isGenerationSkip || relation === '손자녀') {
    const isMinor = recipientAge !== undefined && recipientAge < 19;
    const totalGiftAmt = priorGifts + amount;
    const surcharge = (isMinor && totalGiftAmt > GEN_SKIP_MINOR_THRESHOLD_BIL)
      ? GEN_SKIP_SURCHARGE_MINOR_OVER_20BIL
      : GEN_SKIP_SURCHARGE_GENERAL;
    tax *= surcharge;
  }

  tax *= (1 - VOLUNTARY_FILING_CREDIT);
  return Math.max(0, tax);
}

/**
 * 양도소득세 계산 (간이)
 */
function calcCGTPure(params: {
  marketValue: number;
  acquisitionCost: number;
  holdingYears: number;
  isOneHouseOneFamily: boolean;
  houseCount?: number;
  necessaryExpenses?: number;
}): number {
  const { marketValue, acquisitionCost, holdingYears, isOneHouseOneFamily, necessaryExpenses = 0 } = params;
  const gain = Math.max(0, marketValue - acquisitionCost - necessaryExpenses);
  if (gain <= 0) return 0;

  // 1세대1주택 비과세
  if (isOneHouseOneFamily && holdingYears >= 2) {
    if (marketValue <= ONE_HOUSE_EXEMPT_LIMIT) return 0;
    const taxableRatio = (marketValue - ONE_HOUSE_EXEMPT_LIMIT) / marketValue;
    const partialGain  = gain * taxableRatio;
    const lthd = Math.min(LTHD_ONE_HOUSE_MAX, holdingYears >= 10 ? 0.80 : holdingYears >= 5 ? 0.40 : 0.24);
    const taxableGain = Math.max(0, partialGain * (1 - lthd) - CGT_BASIC_DEDUCTION);
    return calcIncomeTaxSimple(taxableGain) * (1 + LOCAL_INCOME_TAX_RATE);
  }

  // 단기양도
  if (holdingYears < 1) return gain * SHORT_TERM_RATES.under1yr * (1 + LOCAL_INCOME_TAX_RATE);
  if (holdingYears < 2) return gain * SHORT_TERM_RATES.under2yr * (1 + LOCAL_INCOME_TAX_RATE);

  // 장기보유특별공제
  let lthdRate = 0;
  for (const bracket of LTHD_RATES) {
    if (holdingYears >= bracket.minYears) { lthdRate = bracket.rate; break; }
  }
  const deductedGain = gain * (1 - lthdRate);
  const taxableGain  = Math.max(0, deductedGain - CGT_BASIC_DEDUCTION);
  return calcIncomeTaxSimple(taxableGain) * (1 + LOCAL_INCOME_TAX_RATE);
}

function calcIncomeTaxSimple(base: number): number {
  // 소득세 기본세율 (억 단위)
  if (base <= 0.14) return base * 0.06;
  if (base <= 0.50) return 0.0084 + (base - 0.14) * 0.15;
  if (base <= 0.88) return 0.0624 + (base - 0.50) * 0.24;
  if (base <= 1.50) return 0.1536 + (base - 0.88) * 0.35;
  if (base <= 3.00) return 0.3706 + (base - 1.50) * 0.38;
  if (base <= 5.00) return 0.9406 + (base - 3.00) * 0.40;
  if (base <= 10.0) return 1.7406 + (base - 5.00) * 0.42;
  return 3.8406 + (base - 10.0) * 0.45;
}

function calcAcquisitionTax(value: number, isResidential: boolean, houseCount: number, isRegulated: boolean): number {
  if (!isResidential) return value * (ACQUISITION_TAX_NON_RESIDENTIAL + ACQUISITION_TAX_SURCHARGE);
  // 주택 수 중과
  if (houseCount >= 3 || (houseCount === 2 && isRegulated)) {
    return value * (0.12 + ACQUISITION_TAX_SURCHARGE);
  }
  if (houseCount === 2) return value * (0.08 + ACQUISITION_TAX_SURCHARGE);
  // 1주택: 시가 구간별
  if (value <= 6)  return value * (0.010 + ACQUISITION_TAX_SURCHARGE);
  if (value <= 9)  return value * (0.020 + ACQUISITION_TAX_SURCHARGE); // 간이
  return value * (0.030 + ACQUISITION_TAX_SURCHARGE);
}

function calcGiftAcquisitionTax(value: number): number {
  return value * (ACQUISITION_TAX_GIFT_BASE + ACQUISITION_TAX_SURCHARGE);
}

// ── 부담부증여 ─────────────────────────────────────────────────

/**
 * 부담부증여 세금 추정
 *
 * 원칙:
 *  - 채무인수분 = 유상이전 → 양도세 (양도가액=채무, 취득가=취득가×채무/시가 비율안분)
 *  - 순증여분 = 시가 - 채무 → 증여세 (시가 평가가 원칙, 보충적 공시가 별도 표기)
 *  - 취득세 = 채무 인수분(유상취득) + 순증여분(무상취득)
 *
 * 근거: 상증세법 §35, 소득세법 시행령 §159조 (안분 계산)
 */
export function estimateBurdenedGiftTransfer(input: BurdenedGiftInput): BurdenedGiftResult {
  const {
    marketValue, assessedValue, acquisitionCost, totalDebt,
    holdingYears, relation, recipientAge, isOneHouseOneFamily,
    houseCount, isRegulatedArea, isResidential = true,
    recipientCanProveDebtRepayment,
    necessaryExpenses = 0, priorGifts10yr = 0,
  } = input;

  const assumptions: string[] = [];
  const warnings:    string[] = [];
  const boundedDebt = Math.min(Math.max(totalDebt, 0), Math.max(marketValue, 0));
  const recognizedDebt = recipientCanProveDebtRepayment === false ? 0 : boundedDebt;

  if (totalDebt > marketValue) {
    warnings.push('입력 채무가 시가를 초과하여 시가 한도로 제한했습니다.');
  }
  if (recipientCanProveDebtRepayment === undefined && recognizedDebt > 0) {
    warnings.push('채무 인수분 인정은 수증자의 소득·재산 및 실제 상환 능력 증명이 필요합니다.');
  }
  if (recipientCanProveDebtRepayment === false && totalDebt > 0) {
    warnings.push('채무 상환 능력 증명이 없어 전액 증여로 간이 계산했습니다.');
  }

  // ── 평가 방법 결정 ────────────────────────────────────────────
  // 시가 평가가 원칙 (상증세법 §60 ①)
  // 공시가격은 비교 가능한 시가가 없는 경우에만 보충적 방법
  let valuationBase = marketValue;
  let valuationMethod: BurdenedGiftResult['valuationMethod'] = 'market_price';
  let valuationNote = '시가 평가 원칙 적용. 실제 신고 시 감정평가 또는 유사 매매사례 가액 확인 필요.';

  if (assessedValue !== null && assessedValue < marketValue) {
    // 공시가 참고 표기 (자동 적용 X)
    valuationNote = `공시가격(${assessedValue.toFixed(1)}억) < 시가(${marketValue.toFixed(1)}억). `
      + `국세청 유사 매매사례 조회 후 시가 산정이 어려운 경우에만 공시가 보충 적용 가능 (상증세법 §60 ②). `
      + `공시가 적용 시 2년 내 매매사례가액 확인 필요.`;
    warnings.push('공시가격 보충 적용 여부는 세무사 확인 필수');
  }

  // ── 채무인수분 양도세 ─────────────────────────────────────────
  // 양도가액 = 채무액 (소득세법 시행령 §159 ①)
  // 취득가액 안분 = 실제취득가 × (채무 / 시가)
  const debtRatio       = marketValue > 0 ? recognizedDebt / marketValue : 0;
  const allocatedCost   = acquisitionCost * debtRatio;
  const allocatedExpenses = necessaryExpenses * debtRatio;

  assumptions.push(`인정채무=${recognizedDebt.toFixed(2)}억, 취득가안분=${allocatedCost.toFixed(2)}억(취득가×인정채무/시가)`);

  const cgtAmount = calcCGTPure({
    marketValue:     recognizedDebt,
    acquisitionCost: allocatedCost,
    holdingYears,
    isOneHouseOneFamily,
    houseCount,
    necessaryExpenses: allocatedExpenses,
  });

  if (isOneHouseOneFamily) assumptions.push('1세대1주택 비과세 요건 적용 (보유·거주기간 별도 확인 필요)');
  if (houseCount >= 2)     warnings.push(`다주택(${houseCount}주택) 양도세 중과 적용 검토 필요`);

  const transferPortion = makeEstimate(
    cgtAmount, 'input_estimate', assumptions, warnings,
    ['소득세법 시행령 §159 (부담부증여 안분 계산)', '지방소득세 포함'],
    { min: cgtAmount * 0.7, max: cgtAmount * 1.4 },
  );

  // ── 순증여분 증여세 ────────────────────────────────────────────
  const netGiftVal = Math.max(0, valuationBase - recognizedDebt);
  const giftTaxAmount = calcGiftTaxPure(netGiftVal, relation, priorGifts10yr, relation === '손자녀', recipientAge);

  const giftAssumptions = [`순증여분=${netGiftVal.toFixed(2)}억(시가-채무), 관계=${relation}`];
  if (priorGifts10yr > 0) giftAssumptions.push(`10년 사전증여 ${priorGifts10yr.toFixed(1)}억 합산`);

  const giftWarnings: string[] = [];
  if (assessedValue && assessedValue < marketValue) {
    giftWarnings.push(`공시가 기준 적용 시 순증여분=${Math.max(0, assessedValue - recognizedDebt).toFixed(2)}억으로 줄어들 수 있음 — 세무사 확인`);
  }

  const giftPortion = makeEstimate(
    giftTaxAmount, 'input_estimate', giftAssumptions, giftWarnings,
    ['상증세법 §35, §53, §69', '신고세액공제 3% 적용'],
  );

  // ── 취득세: 유상취득분 + 무상취득분 ───────────────────────────
  const onerousAcqTaxAmount = calcAcquisitionTax(recognizedDebt, isResidential, houseCount, isRegulatedArea);
  const giftAcqTaxAmount = calcGiftAcquisitionTax(netGiftVal);
  const acqTaxAmount = onerousAcqTaxAmount + giftAcqTaxAmount;
  const acqWarnings: string[] = [];
  if (recognizedDebt > 0) acqWarnings.push('채무 인수분은 유상취득, 나머지는 무상취득으로 나누어 간이 계산했습니다.');
  if (isResidential && isRegulatedArea) acqWarnings.push('조정대상지역 주택의 무상취득 중과 여부는 공시가격·취득자 상황 확인이 필요합니다.');
  if (houseCount >= 2) acqWarnings.push(`${houseCount}주택 유상취득분 중과 여부 확인 필요`);

  const acquisitionTaxOnerous = makeEstimate(
    onerousAcqTaxAmount, 'input_estimate',
    [`유상취득분=${recognizedDebt.toFixed(2)}억(인정채무)`],
    acqWarnings,
    ['지방세법 §7, §11 (부담부증여 채무 인수분 유상취득 검토)'],
  );
  const acquisitionTaxGift = makeEstimate(
    giftAcqTaxAmount, 'input_estimate',
    [`무상취득분=${netGiftVal.toFixed(2)}억(시가-인정채무)`],
    acqWarnings,
    ['지방세법 §11 (무상취득 취득세율)'],
  );

  const acquisitionTax = makeEstimate(
    acqTaxAmount, 'rough_estimate',
    [`유상취득분 취득세=${onerousAcqTaxAmount.toFixed(2)}억, 무상취득분 취득세=${giftAcqTaxAmount.toFixed(2)}억`],
    acqWarnings,
    ['지방세법 §7, §11 (부담부증여 취득세 구분)'],
  );

  // ── 합계 ──────────────────────────────────────────────────────
  const totalAmount = giftTaxAmount + cgtAmount + acqTaxAmount;
  const allWarnings = [
    ...warnings,
    ...giftWarnings,
    ...acqWarnings,
    '간이 추정값 — 실제 세액은 보유기간, 1세대1주택 요건, 다주택 중과, 필요경비 상세에 따라 크게 달라집니다.',
    '세무사 확인 필수.',
  ];

  const total = makeEstimate(
    totalAmount, 'rough_estimate', assumptions, allWarnings,
    ['상증세법 §35, 소득세법 시행령 §159, 지방세법 §11'],
    { min: totalAmount * 0.6, max: totalAmount * 1.5 },
  );

  // ── 직접 증여 대비 절세 ───────────────────────────────────────
  const directGiftTax = calcGiftTaxPure(marketValue, relation, priorGifts10yr, relation === '손자녀', recipientAge);
  const directAcqTax  = calcGiftAcquisitionTax(marketValue);
  const directTotal   = directGiftTax + directAcqTax;
  const savingVsDirectGift = directTotal - totalAmount;

  return {
    giftPortion,
    transferPortion,
    acquisitionTax,
    acquisitionTaxOnerous,
    acquisitionTaxGift,
    total,
    savingVsDirectGift,
    valuationMethod,
    valuationNote,
  };
}

// ── 가족간 저가매매 ────────────────────────────────────────────

/**
 * 가족간 저가매매 세금 추정
 *
 * 상증세법 §35 ① + 시행령 §26: 특수관계인 간 거래에서
 *   차액이 시가×30% 이상 또는 3억 이상이면 증여 의제.
 *   증여재산가액 = 차액 - 기준금액  (기준금액 = min(시가×30%, 3억))
 *
 * 예) 시가 10억, 매매가 6억 → 차액 4억
 *     기준금액 = min(3억, 3억) = 3억
 *     증여재산가액 = 4 - 3 = 1억  ← 전체 4억이 아님
 *
 * 근거: 상증세법 §35 ①, 상증세법 시행령 §26 ①
 */
export function estimateRelatedPartySale(input: RelatedPartySaleInput): RelatedPartySaleResult {
  const {
    marketValue, salePrice, acquisitionCost, holdingYears,
    isOneHouseOneFamily, houseCount, isRegulatedArea,
    relation, isResidential = true, necessaryExpenses = 0, priorGifts10yr = 0,
  } = input;

  const priceDiff      = marketValue - salePrice;
  const threshold30pct = marketValue * RELATED_PARTY_DISCOUNT_RATE_THRESHOLD;
  const threshold3bil  = RELATED_PARTY_DISCOUNT_ABS_THRESHOLD;

  // 과세 여부: 차액이 시가×30% 이상 OR 3억 이상
  const isGiftDeemed = priceDiff >= threshold30pct || priceDiff >= threshold3bil;

  // 기준금액 차감 (상증세법 시행령 §26 ①)
  // 기준금액 = min(시가×30%, 3억)
  const baseDeduction     = Math.min(threshold30pct, threshold3bil);
  const taxableGiftAmount = isGiftDeemed ? Math.max(0, priceDiff - baseDeduction) : 0;

  // 증여세
  const giftTaxAmount = taxableGiftAmount > 0
    ? calcGiftTaxPure(taxableGiftAmount, relation, priorGifts10yr, false)
    : 0;

  const thresholdNote = isGiftDeemed
    ? `차액 ${priceDiff.toFixed(2)}억 - 기준금액 ${baseDeduction.toFixed(2)}억 = 증여재산가액 ${taxableGiftAmount.toFixed(2)}억`
      + ` (상증세법 §35①, 시행령 §26①)`
    : `차액 ${priceDiff.toFixed(2)}억이 임계값 미만 → 증여세 0원`;

  const giftTax = makeEstimate(
    giftTaxAmount,
    'law_based',
    [
      isGiftDeemed
        ? `증여재산가액=차액${priceDiff.toFixed(2)}억-기준금액${baseDeduction.toFixed(2)}억=${taxableGiftAmount.toFixed(2)}억`
        : '임계값 미달 — 증여세 없음',
    ],
    isGiftDeemed && taxableGiftAmount > 0
      ? ['20억 초과 미성년 손자녀는 40% 할증 검토 필요']
      : [],
    ['상증세법 §35 ① (특수관계인 저가양수도 증여 의제)', '상증세법 시행령 §26 ① (기준금액)'],
  );

  // 양도세 (매도자 기준, 매매가로 실현)
  const cgtAmount = calcCGTPure({
    marketValue: salePrice,
    acquisitionCost,
    holdingYears,
    isOneHouseOneFamily,
    houseCount,
    necessaryExpenses,
  });
  const cgtAmountAtMarket = calcCGTPure({
    marketValue,
    acquisitionCost,
    holdingYears,
    isOneHouseOneFamily,
    houseCount,
    necessaryExpenses,
  });

  const warnings: string[] = ['특수관계인 저가양도는 부당행위계산 부인 시 양도세가 시가 기준으로 재계산될 수 있습니다.'];
  if (houseCount >= 2) warnings.push('다주택 양도세 중과 검토 필요');
  if (isRegulatedArea && houseCount >= 2) warnings.push('규제지역 다주택 중과 적용');

  const capitalGainsTax = makeEstimate(
    cgtAmount, 'input_estimate',
    [`양도가액=${salePrice.toFixed(1)}억(매매가), 취득가=${acquisitionCost.toFixed(1)}억`],
    warnings,
    ['소득세법 §95 (장기보유특별공제)', '소득세법 §101 (부당행위계산 부인 검토)', '지방소득세 포함'],
    { min: cgtAmount * 0.7, max: Math.max(cgtAmount, cgtAmountAtMarket) * 1.4 },
  );

  // 취득세 (매수자, 매매가 기준)
  const acqTaxAmount = calcAcquisitionTax(salePrice, isResidential, houseCount, isRegulatedArea);
  const acquisitionTax = makeEstimate(
    acqTaxAmount, 'input_estimate', [], [],
    ['지방세법 §11 (취득세)'],
  );

  const totalAmount = giftTaxAmount + cgtAmount + acqTaxAmount;
  const totalTax = makeEstimate(
    totalAmount, 'rough_estimate',
    [], [...warnings, '간이 추정 — 실제 매매대금 지급과 자금출처 확인이 필요합니다.'],
    ['상증세법 §35, 소득세법 §95, §101, 지방세법 §11'],
    { min: totalAmount * 0.6, max: (totalAmount + Math.max(0, cgtAmountAtMarket - cgtAmount)) * 1.5 },
  );

  // 직접 증여 대비 절세
  const directGiftTax   = calcGiftTaxPure(marketValue, relation, priorGifts10yr, false);
  const directAcqTax    = calcGiftAcquisitionTax(marketValue);
  const savingVsDirectGift = (directGiftTax + directAcqTax) - totalAmount;

  // 증여세 0원 최적 매매가
  const minThreshold = Math.min(threshold30pct, threshold3bil);
  const zeroGiftTaxOptimalPrice = marketValue - minThreshold + 0.01; // 0.01억 여유

  return {
    priceDiff,
    isGiftDeemed,
    taxableGiftAmount,
    giftTax,
    capitalGainsTax,
    acquisitionTax,
    totalTax,
    savingVsDirectGift,
    zeroGiftTaxOptimalPrice,
    thresholdNote,
  };
}

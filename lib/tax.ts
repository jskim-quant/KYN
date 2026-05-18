import { Asset, FamilyMember, MacroSettings, Relation } from '@/types';

// ── 상수 ──────────────────────────────────────────────────────
const GIFT_DEDUCTIONS: Record<string, number> = {
  '배우자': 6.0,
  '자녀': 0.5,
  '며느리': 0.5,
  '사위': 0.5,
  '손자녀': 0.2,
  '부모': 0.5,
  '조부모': 0.5,
  '형제': 0.1,
  '삼촌': 0.1,
  '고모': 0.1,
  '기타': 0.1,
};

// ── 증여세 ───────────────────────────────────────────────────
export function calcGiftTax(
  amount: number,
  relation: string,
  priorGifts = 0,
  isGenerationSkip = false,
  marriageOrBirthBonus = false, // 혼인·출산 증여공제 +1억 (2024년~ 직계존속→자녀)
): number {
  const total = amount + priorGifts;
  let ded = GIFT_DEDUCTIONS[relation] ?? 0.1;

  // 혼인·출산 공제: 직계존속이 자녀에게 증여 시 최대 1억 추가 (상증법 §53의2, 2024~)
  if (marriageOrBirthBonus && (relation === '자녀' || relation === '손자녀')) {
    ded += 1.0;
  }

  const base = Math.max(0, total - ded);
  if (base <= 0) return 0;

  let tax = calcProgressiveTax(base);
  if (isGenerationSkip || relation === '손자녀') tax *= 1.3;
  return tax;
}

function calcProgressiveTax(base: number): number {
  // 현행 세율 (2024, 국회 부결로 50% 유지)
  if (base <= 1)   return base * 0.10;
  if (base <= 5)   return 0.10  + (base - 1)  * 0.20;
  if (base <= 10)  return 0.90  + (base - 5)  * 0.30;
  if (base <= 30)  return 2.40  + (base - 10) * 0.40;
  return             10.40 + (base - 30) * 0.50;
}

// ── 상속세 ───────────────────────────────────────────────────
export function calcInheritanceTax(
  totalEstate: number,
  members: FamilyMember[],
  priorGifts10yr = 0
): { tax: number; taxableBase: number; deductions: Record<string, number> } {
  const hasSpouse = members.some(m => m.relation === '배우자');
  const children  = members.filter(m => m.relation === '자녀');

  const deductions: Record<string, number> = {};
  deductions['기초공제'] = 2.0;
  deductions['자녀공제'] = children.length * 0.5;  // 현행 5천만원
  deductions['미성년공제'] = children
    .filter(c => c.age < 19)
    .reduce((s, c) => s + (19 - c.age) * 0.1, 0);
  deductions['연로자공제'] = members
    .filter(m => m.age >= 65 && m.relation !== '본인')
    .length * 0.5;

  const personalTotal = Object.values(deductions).reduce((s, v) => s + v, 0);
  const lumpSum = 5.0;
  const baseDeduction = Math.max(personalTotal, lumpSum);

  if (hasSpouse) {
    const spouseDeduction = Math.min(30, Math.max(5, totalEstate * 0.4));
    deductions['배우자공제'] = spouseDeduction;
  }

  const totalDeduction = baseDeduction + (deductions['배우자공제'] ?? 0);
  const taxableBase = Math.max(0, totalEstate + priorGifts10yr - totalDeduction);
  const tax = calcProgressiveTax(taxableBase);

  return { tax, taxableBase, deductions };
}

// ── 양도소득세 ───────────────────────────────────────────────
export function calcCapitalGainsTax(asset: Asset): number {
  const gain = Math.max(0, asset.current_value - asset.acquisition_cost);
  if (gain <= 0) return 0;

  const acqYear = asset.acquisition_date
    ? new Date(asset.acquisition_date).getFullYear()
    : new Date().getFullYear() - 5;
  const years = new Date().getFullYear() - acqYear;

  // 장기보유특별공제
  let lthdRate = 0;
  if (['상업용부동산', '주거용부동산', '토지'].includes(asset.asset_type)) {
    if (years >= 15) lthdRate = 0.30;
    else if (years >= 10) lthdRate = 0.20;
    else if (years >= 5)  lthdRate = 0.10;
    else if (years >= 3)  lthdRate = 0.06;
  }

  const deductedGain = gain * (1 - lthdRate);
  const basicDeduction = 0.025; // 250만원
  const taxableGain = Math.max(0, deductedGain - basicDeduction);

  if (asset.asset_type === '금융자산') {
    // 금융투자소득세 2025년 폐지 → 현행 대주주 기준 과세 (일반 소득세율 준용)
    return calcIncomeTax(taxableGain);
  }
  if (years < 1) return taxableGain * 0.50;
  if (years < 2) return taxableGain * 0.40;
  // 🔧 수정: 양도소득세는 소득세율(6~45%) 적용 — 상속세율(10~50%) 오용 버그 수정
  return calcIncomeTax(taxableGain);
}

// ── 종합부동산세 ─────────────────────────────────────────────
// 🔧 수정: 2023년 이후 완화 세율 + 공정시장가액비율 60% 반영
export function calcComprehensiveRealEstateTax(
  assets: Asset[],
  isCorpOwned = false,
  isMultiHouse = false, // 3주택 이상 중과 여부
): number {
  const realEstate = assets.filter(a =>
    ['상업용부동산', '주거용부동산', '토지'].includes(a.asset_type)
  );
  const totalPublicPrice = realEstate.reduce((s, a) =>
    s + a.current_value * (a.public_price_ratio / 100), 0
  );

  const FAIR_MARKET_RATE = 0.60; // 공정시장가액비율 60% (2026 기준)

  if (isCorpOwned) {
    // 법인: 최고세율 단일 적용 (기본공제 없음)
    return totalPublicPrice * FAIR_MARKET_RATE * 0.027;
  }

  // 과세표준 = (공시가 합계 − 9억 기본공제) × 공정시장가액비율
  const taxBase = Math.max(0, (totalPublicPrice - 9) * FAIR_MARKET_RATE);
  if (taxBase <= 0) return 0;

  if (isMultiHouse) {
    // 3주택 이상 중과세율 (2023년 이후)
    if (taxBase <= 3)   return taxBase * 0.005;
    if (taxBase <= 6)   return 0.015 + (taxBase - 3)  * 0.007;
    if (taxBase <= 12)  return 0.036 + (taxBase - 6)  * 0.010;
    if (taxBase <= 25)  return 0.096 + (taxBase - 12) * 0.020;
    if (taxBase <= 50)  return 0.356 + (taxBase - 25) * 0.030;
    if (taxBase <= 94)  return 1.106 + (taxBase - 50) * 0.040;
    return               2.866 + (taxBase - 94) * 0.050;
  }

  // 2주택 이하 일반세율 (2023년 이후 완화)
  if (taxBase <= 3)   return taxBase * 0.005;
  if (taxBase <= 6)   return 0.015 + (taxBase - 3)  * 0.007;
  if (taxBase <= 12)  return 0.036 + (taxBase - 6)  * 0.010;
  if (taxBase <= 25)  return 0.096 + (taxBase - 12) * 0.013;
  if (taxBase <= 50)  return 0.265 + (taxBase - 25) * 0.015; // 🔧 1.8%→1.5%
  if (taxBase <= 94)  return 0.640 + (taxBase - 50) * 0.020; // 🔧 2.5%→2.0%
  return               1.520 + (taxBase - 94) * 0.027;       // 🔧 5.0%→2.7%
}

// ── 임대소득세 ───────────────────────────────────────────────
export function calcRentalIncomeTax(
  annualRent: number,
  otherIncome = 0
): number {
  // 2천만 이하: 분리과세 14% 또는 종합과세 비교
  if (annualRent <= 0.2) {
    const separateTax = annualRent * 0.14;
    const comprehensiveTax = calcIncomeTax(annualRent + otherIncome) - calcIncomeTax(otherIncome);
    return Math.min(separateTax, comprehensiveTax);
  }
  return calcIncomeTax(annualRent + otherIncome) - calcIncomeTax(otherIncome);
}

export function calcIncomeTax(income: number): number {
  if (income <= 0.14)  return income * 0.06;
  if (income <= 0.50)  return 0.0084  + (income - 0.14) * 0.15;
  if (income <= 0.88)  return 0.0624  + (income - 0.50) * 0.24;
  if (income <= 1.50)  return 0.1536  + (income - 0.88) * 0.35;
  if (income <= 3.00)  return 0.3706  + (income - 1.50) * 0.38;
  if (income <= 5.00)  return 0.9406  + (income - 3.00) * 0.40;
  if (income <= 10.00) return 1.7406  + (income - 5.00) * 0.42;
  return                 3.8406  + (income - 10.00) * 0.45;
}

// ── 법인세 ───────────────────────────────────────────────────
// 🔧 수정: 2026년 귀속 세율 반영 (전 구간 1%p 인상, 2025.12 국회 통과)
// 지방소득세(10%) 별도 — 실질 부담률은 각 세율 × 1.1
export function calcCorporateTax(taxableIncome: number): number {
  if (taxableIncome <= 2)    return taxableIncome * 0.10;
  if (taxableIncome <= 200)  return 0.20  + (taxableIncome - 2)   * 0.20;
  if (taxableIncome <= 3000) return 39.80 + (taxableIncome - 200) * 0.22;
  return                       655.80 + (taxableIncome - 3000)    * 0.25;
}

// ── 취득세 ───────────────────────────────────────────────────
export function calcAcquisitionTax(
  value: number,
  assetType: string,
  isCorp = false,
  isMultiHouse = false
): number {
  if (!['상업용부동산', '주거용부동산', '토지'].includes(assetType)) return 0;
  if (isCorp) return value * 0.12;
  if (assetType === '주거용부동산') {
    if (isMultiHouse) return value * 0.08;
    if (value <= 6)  return value * 0.01;
    if (value <= 9)  return value * 0.02;
    return             value * 0.03;
  }
  return value * 0.04;
}

// ── 자산 성장 시뮬레이션 ─────────────────────────────────────
export function projectAssetValue(
  asset: Asset,
  years: number,
  macro: MacroSettings
): number {
  let growthRate: number;
  switch (asset.asset_type) {
    case '토지':
      growthRate = macro.land_growth_pct / 100;
      break;
    case '주거용부동산':
      growthRate = macro.apt_growth_pct / 100;
      break;
    case '상업용부동산':
      growthRate = macro.commercial_growth_pct / 100;
      break;
    default:
      growthRate = asset.expected_growth_pct / 100;
  }
  return asset.current_value * Math.pow(1 + growthRate, years);
}

// ── 현금흐름 계산 ────────────────────────────────────────────
export function calcAnnualCashflow(
  assets: Asset[],
  macro: MacroSettings,
  rateShock = 0
): {
  rentalIncome: number;
  holdingTax: number;
  loanInterest: number;
  netCashflow: number;
} {
  const rentalIncome = assets.reduce(
    (s, a) => s + a.current_value * a.annual_yield_pct / 100, 0
  );
  const holdingTax = assets.reduce((s, a) => s + a.annual_tax, 0);
  const loanInterest = assets.reduce((s, a) => {
    const effectiveRate = a.loan_type === 'variable'
      ? (a.loan_rate_pct + rateShock) / 100
      : a.loan_rate_pct / 100;
    return s + a.loan_amount * effectiveRate;
  }, 0);
  const rentalTax = calcRentalIncomeTax(rentalIncome);
  const netCashflow = rentalIncome - holdingTax - loanInterest - rentalTax;
  return { rentalIncome, holdingTax, loanInterest, netCashflow };
}

// ── LTV / DSR ────────────────────────────────────────────────
export function calcLTV(assets: Asset[]): number {
  const totalValue = assets.reduce((s, a) => s + a.current_value, 0);
  const totalDebt  = assets.reduce((s, a) => s + a.loan_amount, 0);
  return totalValue > 0 ? (totalDebt / totalValue) * 100 : 0;
}

export function calcDSCR(assets: Asset[]): number {
  const rentalIncome = assets.reduce((s, a) => s + a.current_value * a.annual_yield_pct / 100, 0);
  const annualInterest = assets.reduce((s, a) => s + a.loan_amount * a.loan_rate_pct / 100, 0);
  return annualInterest > 0 ? rentalIncome / annualInterest : 99;
}

// ── 자금출처 소명 계산 ───────────────────────────────────────
export function calcFundSourceSoMyung(
  acquisitionCost: number,
  soMyungPossible: number  // 소명 가능한 금액
): {
  required: number;
  possible: number;
  gap: number;
  riskLevel: 'safe' | 'caution' | 'danger';
  giftPresumption: number;
} {
  const required80pct = acquisitionCost * 0.8;
  const gap = Math.max(0, required80pct - soMyungPossible);
  const giftPresumption = soMyungPossible < required80pct
    ? acquisitionCost - soMyungPossible
    : 0;

  let riskLevel: 'safe' | 'caution' | 'danger';
  if (gap === 0) riskLevel = 'safe';
  else if (gap < 2) riskLevel = 'caution';
  else riskLevel = 'danger';

  return {
    required: required80pct,
    possible: soMyungPossible,
    gap,
    riskLevel,
    giftPresumption,
  };
}

// ── 증여 vs 상속 손익분기점 ──────────────────────────────────
export function calcGiftVsInheritBreakeven(
  assetValue: number,
  growthRate: number,     // %
  members: FamilyMember[],
  relation: string
): { breakEvenYears: number; giftTaxNow: number; inheritTaxArr: number[] } {
  const giftTaxNow = calcGiftTax(assetValue, relation);

  const inheritTaxArr = Array.from({ length: 21 }, (_, i) => {
    const futureValue = assetValue * Math.pow(1 + growthRate / 100, i);
    const { tax } = calcInheritanceTax(futureValue, members);
    return tax;
  });

  // 손익분기점: 증여세 < 그 시점 상속세 되는 첫 연도
  const breakEvenYears = inheritTaxArr.findIndex(t => t > giftTaxNow);
  return { breakEvenYears, giftTaxNow, inheritTaxArr };
}

// ── PCI 역산 ─────────────────────────────────────────────────
export function calcPCI(
  assetIncrease: number,   // 재산 증가액 억
  consumption: number,      // 소비지출 억
  reportedIncome: number    // 신고 소득 억
): {
  suspectedAmount: number;
  riskLevel: 'safe' | 'caution' | 'danger';
} {
  const suspectedAmount = Math.max(0, assetIncrease + consumption - reportedIncome);
  let riskLevel: 'safe' | 'caution' | 'danger';
  if (suspectedAmount < 1) riskLevel = 'safe';
  else if (suspectedAmount < 5) riskLevel = 'caution';
  else riskLevel = 'danger';
  return { suspectedAmount, riskLevel };
}

// ── 가족간 차용증 (금전소비대차) 분석 ────────────────────────
// 근거: 상증법 §41의4, 시행령 §31의4, 시행규칙 §10의5
const FAIR_LOAN_RATE = 0.046;        // 적정이자율 4.6% (당좌대출이자율)
const LOAN_GIFT_THRESHOLD = 0.1;     // 1천만원 — 이 미만이면 증여세 비과세

export function calcFamilyLoanAnalysis(
  principal: number,          // 대출 원금 (억)
  actualRatePct: number,      // 실제 이자율 (%, 예: 2.5)
  relation: string,
  priorGifts = 0,
): {
  fairInterest: number;           // 적정이자 연간 (억)
  actualInterest: number;         // 실제 이자 연간 (억)
  interestGap: number;            // 이자 차액 (억)
  isGiftTaxable: boolean;         // 연간 증여세 과세 여부
  annualGiftTax: number;          // 연간 발생 증여세 (억)
  maxZeroRatePrincipal: number;   // 무이자 가능 최대 원금 (억) ≈ 2.17억
  riskLevel: 'safe' | 'caution' | 'danger';
  recommendation: string;
} {
  const actualRate = actualRatePct / 100;
  const fairInterest   = principal * FAIR_LOAN_RATE;
  const actualInterest = principal * actualRate;
  const interestGap    = Math.max(0, fairInterest - actualInterest);
  const isGiftTaxable  = interestGap > LOAN_GIFT_THRESHOLD;
  const annualGiftTax  = isGiftTaxable
    ? calcGiftTax(interestGap, relation, priorGifts)
    : 0;

  // 무이자 한도: 1천만원 ÷ 4.6% ≈ 2.174억
  const maxZeroRatePrincipal = LOAN_GIFT_THRESHOLD / FAIR_LOAN_RATE;

  let riskLevel: 'safe' | 'caution' | 'danger';
  if (!isGiftTaxable) riskLevel = 'safe';
  else if (interestGap < 0.5) riskLevel = 'caution';
  else riskLevel = 'danger';

  let recommendation: string;
  if (actualRate === 0 && principal <= maxZeroRatePrincipal) {
    recommendation = `무이자 가능 — 원금 ${(maxZeroRatePrincipal * 100).toFixed(0)}백만원 이하 시 연 이자상당이익 1천만원 미만으로 비과세`;
  } else if (actualRate >= FAIR_LOAN_RATE) {
    recommendation = `적정이자율(4.6%) 이상 지급 — 증여세 없음. 이자는 수령자 이자소득세 과세.`;
  } else if (!isGiftTaxable) {
    recommendation = `이자 차액 ${(interestGap * 1000).toFixed(0)}만원 — 1천만원 미만 비과세 유지`;
  } else {
    recommendation = `이자 차액 ${(interestGap * 1000).toFixed(0)}만원 초과 → 연 증여세 ${(annualGiftTax * 1000).toFixed(0)}만원 발생. 이자율 ${((LOAN_GIFT_THRESHOLD / principal) * 100).toFixed(2)}% 이상으로 조정 권장`;
  }

  return {
    fairInterest, actualInterest, interestGap,
    isGiftTaxable, annualGiftTax,
    maxZeroRatePrincipal,
    riskLevel, recommendation,
  };
}

// ── 법인-개인 간 자금 대여 (인정이자) ────────────────────────
// 법인이 특수관계인(임직원·주주 등)에게 저리 대출 시 인정이자 과세
// 근거: 법인세법 시행령 §89③, 적정이자율 = 가중평균차입이자율 또는 4.6%
export function calcCorpLoanImputed(
  principal: number,      // 대출 원금 (억)
  actualRatePct: number,  // 실제 이자율 (%)
): {
  imputedInterest: number;    // 인정이자 (억)
  corpTaxImpact: number;      // 법인 손금불산입으로 인한 법인세 증가 (억)
  recipientIncomeTax: number; // 수령인 근로소득 추가 과세 (억)
  totalTaxCost: number;       // 합계 세부담 (억)
} {
  const imputedRate    = Math.max(0, FAIR_LOAN_RATE - actualRatePct / 100);
  const imputedInterest = principal * imputedRate;
  // 법인: 인정이자만큼 익금산입 → 법인세 부담
  const corpTaxImpact = calcCorporateTax(imputedInterest + 0.0001) - calcCorporateTax(0.0001);
  // 수령인: 상여·배당으로 소득세 추가
  const recipientIncomeTax = calcIncomeTax(imputedInterest + 0.0001) - calcIncomeTax(0.0001);
  return {
    imputedInterest,
    corpTaxImpact,
    recipientIncomeTax,
    totalTaxCost: corpTaxImpact + recipientIncomeTax,
  };
}

// ── 법인전환 절세효과 분석 ────────────────────────────────────
// 개인 임대·사업소득을 법인으로 전환 시 세부담 비교
export function calcCorpConversionBenefit(
  annualRentalIncome: number,   // 연 임대·사업소득 (억)
  ceoSalary: number,            // 설계할 대표이사 급여 (억)
  otherPersonalIncome: number,  // 기타 개인소득 (억)
  assets: Asset[],              // 현물출자 대상 자산
): {
  personalTax: number;          // 현행 개인 납세액 (억)
  corpTax: number;              // 법인세 (억)
  ceoIncomeTax: number;         // 대표이사 급여 소득세 (억)
  totalCorpBurden: number;      // 법인세 + 대표이사 소득세 (억)
  annualSaving: number;         // 연간 절세액 (억, 양수면 법인 유리)
  transferTax: number;          // 현물출자 취득세 — 50% 경감 적용 (억)
  paybackYears: number;         // 전환비용 회수 기간 (년)
  notes: string[];
} {
  // 개인: 임대+기타소득 종합과세
  const personalTax = calcIncomeTax(annualRentalIncome + otherPersonalIncome)
                    - calcIncomeTax(otherPersonalIncome);  // 임대분만 추출

  // 법인: 임대소득 − 대표이사 급여(손금) = 과세소득
  const corpTaxableIncome = Math.max(0, annualRentalIncome - ceoSalary);
  const corpTax = calcCorporateTax(corpTaxableIncome);

  // 대표이사: 급여 소득세 (기타소득과 합산)
  const ceoIncomeTax = calcIncomeTax(ceoSalary + otherPersonalIncome)
                     - calcIncomeTax(otherPersonalIncome);

  const totalCorpBurden = corpTax + ceoIncomeTax;
  const annualSaving    = personalTax - totalCorpBurden;

  // 현물출자 취득세: 부동산 시가 × 4% × 50% 경감 = 2% (조특법 §119, ~2027.12.31)
  const reValue = assets
    .filter(a => ['주거용부동산', '상업용부동산', '토지'].includes(a.asset_type))
    .reduce((s, a) => s + a.current_value, 0);
  const transferTax = reValue * 0.02;

  const paybackYears = annualSaving > 0
    ? Math.ceil(transferTax / annualSaving)
    : 999;

  const notes = [
    `현물출자 시 양도소득세 이월과세 가능 (조특법 §32) — 법인이 자산 양도할 때 납부`,
    `취득세 50% 경감 (~2027년 12월 31일까지)`,
    `법인세율 2026년: 10% / 20% / 22% / 25% (지방소득세 +10% 별도)`,
    `대표이사 급여는 법인 손금산입 → 법인 과세소득 절감`,
    `배당 시 배당소득세 14% 추가 발생 (2천만원 초과 시 종합과세)`,
    `법인 전환 후 5년 내 부동산 매각 시 이월과세 취소 위험`,
    `소득분산 효과: 배우자·자녀에게 주식 증여로 배당소득 분산 가능`,
  ];

  return {
    personalTax, corpTax, ceoIncomeTax, totalCorpBurden,
    annualSaving, transferTax, paybackYears, notes,
  };
}

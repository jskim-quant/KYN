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
  isGenerationSkip = false
): number {
  const total = amount + priorGifts;
  const ded = GIFT_DEDUCTIONS[relation] ?? 0.1;
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
    return taxableGain > 3 ? taxableGain * 0.25 : taxableGain * 0.20;
  }
  if (years < 1) return taxableGain * 0.50;
  if (years < 2) return taxableGain * 0.40;
  return calcProgressiveTax(taxableGain);
}

// ── 종합부동산세 ─────────────────────────────────────────────
export function calcComprehensiveRealEstateTax(
  assets: Asset[],
  isCorpOwned = false
): number {
  const realEstate = assets.filter(a =>
    ['상업용부동산', '주거용부동산', '토지'].includes(a.asset_type)
  );
  const totalPublicPrice = realEstate.reduce((s, a) =>
    s + a.current_value * (a.public_price_ratio / 100), 0
  );

  if (isCorpOwned) {
    // 법인: 단일세율 3%
    const base = Math.max(0, totalPublicPrice - 0);
    return base * 0.03;
  }

  // 개인: 누진세율 (주택 기준)
  const base = Math.max(0, totalPublicPrice - 9); // 9억 기본공제
  if (base <= 0) return 0;
  if (base <= 3)   return base * 0.005;
  if (base <= 6)   return 0.015 + (base - 3) * 0.007;
  if (base <= 12)  return 0.036 + (base - 6) * 0.010;
  if (base <= 25)  return 0.096 + (base - 12) * 0.013;
  if (base <= 50)  return 0.265 + (base - 25) * 0.018;
  if (base <= 94)  return 0.715 + (base - 50) * 0.025;
  return               1.815 + (base - 94) * 0.050;
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
export function calcCorporateTax(taxableIncome: number): number {
  if (taxableIncome <= 2)    return taxableIncome * 0.09;
  if (taxableIncome <= 200)  return 0.18 + (taxableIncome - 2) * 0.19;
  if (taxableIncome <= 3000) return 38.20 + (taxableIncome - 200) * 0.21;
  return                       639.20 + (taxableIncome - 3000) * 0.24;
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

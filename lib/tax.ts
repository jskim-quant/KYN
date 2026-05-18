import { Asset, FamilyMember, MacroSettings, TransferType } from '@/types';

// ── 상수 ──────────────────────────────────────────────────────
const GIFT_DEDUCTIONS: Record<string, number> = {
  '배우자': 6.0,
  '자녀': 0.5,
  '며느리': 0.1,   // 기타친족 (4촌 이내 인척) — 상증법§53: 1천만원/10년
  '사위': 0.1,     // 기타친족 (4촌 이내 인척) — 상증법§53: 1천만원/10년
  '손자녀': 0.2,
  '부모': 0.5,
  '조부모': 0.5,
  '형제': 0.1,
  '삼촌': 0.1,
  '고모': 0.1,
  '기타': 0.1,
};

const FAIR_LOAN_RATE      = 0.046;   // 적정이자율 4.6% (상증법§41의4 시행규칙§10의5)
const LOAN_GIFT_THRESHOLD = 0.1;     // 이자상당이익 1천만원 미만 비과세

// ── 누진세율 공통 (증여세·상속세) ──────────────────────────────
function calcProgressiveTax(base: number): number {
  // 현행 세율 (2024.12 국회 부결 → 50% 최고세율 유지)
  if (base <= 1)   return base * 0.10;
  if (base <= 5)   return 0.10  + (base - 1)  * 0.20;
  if (base <= 10)  return 0.90  + (base - 5)  * 0.30;
  if (base <= 30)  return 2.40  + (base - 10) * 0.40;
  return              10.40 + (base - 30) * 0.50;
}

// 한계세율 — 인정이자·마진 계산용
function marginalIncomeTaxRate(income: number): number {
  if (income <= 0.14) return 0.06;
  if (income <= 0.50) return 0.15;
  if (income <= 0.88) return 0.24;
  if (income <= 1.50) return 0.35;
  if (income <= 3.00) return 0.38;
  if (income <= 5.00) return 0.40;
  if (income <= 10.0) return 0.42;
  return 0.45;
}
function marginalCorporateTaxRate(income: number): number {
  if (income <= 2)    return 0.10;
  if (income <= 200)  return 0.20;
  if (income <= 3000) return 0.22;
  return 0.25;
}

// ── 증여세 ───────────────────────────────────────────────────
// 🔧 Bug1 수정: 10년 합산 시 이번 증여분만의 증분세금 반환 (이전: 누적세금 전체 반환)
export function calcGiftTax(
  amount: number,
  relation: string,
  priorGifts = 0,           // 10년 내 동일인 사전증여 합계 (억)
  isGenerationSkip = false,
  marriageOrBirthBonus = false, // 혼인·출산공제 +1억 (상증법§53의2, 2024~)
): number {
  let ded = GIFT_DEDUCTIONS[relation] ?? 0.1;

  // 혼인·출산 추가공제 (직계존속 → 자녀/손자녀, 수증자당 1회)
  if (marriageOrBirthBonus && (relation === '자녀' || relation === '손자녀')) {
    ded += 1.0;
  }

  // 10년 합산 증분세금: tax(priorGifts+amount) - tax(priorGifts)
  const prevTaxable = Math.max(0, priorGifts - ded);
  const newTaxable  = Math.max(0, priorGifts + amount - ded);
  let tax = calcProgressiveTax(newTaxable) - calcProgressiveTax(prevTaxable);

  // 세대생략 할증: 산출세액 × 1.3 (상증법§57)
  if (isGenerationSkip || relation === '손자녀') tax *= 1.3;
  return Math.max(0, tax);
}

// ── 상속세 ───────────────────────────────────────────────────
// 🔧 Bug3 수정: 금융재산공제·기납부증여세공제 추가
export function calcInheritanceTax(
  totalEstate: number,
  members: FamilyMember[],
  priorGifts10yr = 0,        // 10년 내 사전증여액 합계 (억) — 과세표준 합산
  financialAssets = 0,       // 순금융재산 (억) — 금융재산공제 계산용
  priorGiftTaxPaid = 0,      // 10년 내 기납부증여세 (억) — 산출세액에서 공제 (상증법§28)
): { tax: number; taxableBase: number; deductions: Record<string, number> } {
  const hasSpouse = members.some(m => m.relation === '배우자');
  const children  = members.filter(m => m.relation === '자녀');

  const deductions: Record<string, number> = {};
  deductions['기초공제'] = 2.0;
  deductions['자녀공제'] = children.length * 0.5;                          // 자녀 1인당 5천만원 (현행)
  deductions['미성년공제'] = children
    .filter(c => c.age < 19)
    .reduce((s, c) => s + (19 - c.age) * 0.1, 0);                         // 1천만원×잔여연수
  deductions['연로자공제'] = members
    .filter(m => m.age >= 65 && m.relation !== '본인')
    .length * 0.5;                                                          // 65세↑ 1인당 5천만원

  const personalTotal = Object.values(deductions).reduce((s, v) => s + v, 0);
  const lumpSum = 5.0;                                                     // 일괄공제 5억
  const baseDeduction = Math.max(personalTotal, lumpSum);                  // 인적공제합계 vs 5억 중 큰 것

  // 배우자공제: min(배우자 실제상속분, 30억) ≥ 5억 (상증법§19)
  if (hasSpouse) {
    const spouseDeduction = Math.min(30, Math.max(5, totalEstate * 0.4));
    deductions['배우자공제'] = spouseDeduction;
  }

  // 금융재산공제: 순금융재산×20%, 2천만~2억 한도 (상증법§22)
  if (financialAssets > 0) {
    deductions['금융재산공제'] = Math.min(2.0, Math.max(0.2, financialAssets * 0.20));
  }

  const totalDeduction = baseDeduction
    + (deductions['배우자공제']    ?? 0)
    + (deductions['금융재산공제']  ?? 0);

  const taxableBase = Math.max(0, totalEstate + priorGifts10yr - totalDeduction);
  const grossTax    = calcProgressiveTax(taxableBase);

  // 기납부증여세 공제 (상증법§28): 산출세액 한도 내 차감
  const tax = Math.max(0, grossTax - Math.min(priorGiftTaxPaid, grossTax));

  return { tax, taxableBase, deductions };
}

// ── 양도소득세 ───────────────────────────────────────────────
// 🔧 Bug5 수정: 1세대1주택 비과세 추가 (소득세법§89)
export function calcCapitalGainsTax(
  asset: Asset,
  isOneHouseOneFamily = false, // 1세대1주택 2년 이상 보유·거주 여부
): number {
  const gain = Math.max(0, asset.current_value - asset.acquisition_cost);
  if (gain <= 0) return 0;

  const acqYear = asset.acquisition_date
    ? new Date(asset.acquisition_date).getFullYear()
    : new Date().getFullYear() - 5;
  const years = new Date().getFullYear() - acqYear;

  // 1세대1주택 비과세 (주거용부동산, 보유 2년+)
  if (isOneHouseOneFamily && asset.asset_type === '주거용부동산' && years >= 2) {
    const EXEMPT_LIMIT = 12; // 양도가액 12억 이하 전액 비과세
    if (asset.current_value <= EXEMPT_LIMIT) return 0;
    // 12억 초과분 안분 과세
    const taxableRatio = (asset.current_value - EXEMPT_LIMIT) / asset.current_value;
    const partialGain  = gain * taxableRatio;
    // 1세대1주택 장기보유특별공제 (보유+거주 4%+4% = 최대80%/10년)
    const lthd1h = Math.min(0.80, years >= 10 ? 0.80 : years >= 5 ? 0.40 : 0.24);
    const taxableGain = Math.max(0, partialGain * (1 - lthd1h) - 0.025);
    return calcIncomeTax(taxableGain);
  }

  // 일반 장기보유특별공제 (소득세법§95②)
  let lthdRate = 0;
  if (['상업용부동산', '주거용부동산', '토지'].includes(asset.asset_type)) {
    if (years >= 15) lthdRate = 0.30;
    else if (years >= 10) lthdRate = 0.20;
    else if (years >= 5)  lthdRate = 0.10;
    else if (years >= 3)  lthdRate = 0.06;
  }

  const deductedGain  = gain * (1 - lthdRate);
  const basicDeduction = 0.025; // 기본공제 250만원
  const taxableGain    = Math.max(0, deductedGain - basicDeduction);

  if (asset.asset_type === '금융자산') {
    // 금투세 2025 폐지 → 현행 소득세율 준용
    return calcIncomeTax(taxableGain);
  }
  if (years < 1) return taxableGain * 0.50; // 1년 미만 단기 50%
  if (years < 2) return taxableGain * 0.40; // 2년 미만 단기 40%
  return calcIncomeTax(taxableGain);         // 2년+ 기본세율 (6~45%)
}

// ── 종합부동산세 ─────────────────────────────────────────────
// 🔧 Bug4 수정: 주택분·토지분 분리계산 (별도합산토지 세율 적용)
export function calcComprehensiveRealEstateTax(
  assets: Asset[],
  isCorpOwned = false,
  isMultiHouse = false, // 3주택 이상 중과 여부
): number {
  const FAIR_MARKET_RATE = 0.60; // 공정시장가액비율 60% (2026 기준)

  const housingAssets = assets.filter(a => a.asset_type === '주거용부동산');
  const landAssets    = assets.filter(a => ['토지', '상업용부동산'].includes(a.asset_type));

  const housingPublicPrice = housingAssets.reduce((s, a) =>
    s + a.current_value * (a.public_price_ratio / 100), 0);
  const landPublicPrice = landAssets.reduce((s, a) =>
    s + a.current_value * (a.public_price_ratio / 100), 0);

  if (isCorpOwned) {
    // 법인: 기본공제 없음, 주택·토지 모두 최고세율 단일 적용
    return (housingPublicPrice + landPublicPrice) * FAIR_MARKET_RATE * 0.027;
  }

  // ─ 주택분 종부세 ────────────────────────────────────────────
  const housingTaxBase = Math.max(0, (housingPublicPrice - 9) * FAIR_MARKET_RATE);
  let housingTax = 0;
  if (housingTaxBase > 0) {
    if (!isMultiHouse) {
      // 2주택 이하 일반세율 (2023년 이후 완화)
      if (housingTaxBase <= 3)   housingTax = housingTaxBase * 0.005;
      else if (housingTaxBase <= 6)   housingTax = 0.015 + (housingTaxBase - 3)  * 0.007;
      else if (housingTaxBase <= 12)  housingTax = 0.036 + (housingTaxBase - 6)  * 0.010;
      else if (housingTaxBase <= 25)  housingTax = 0.096 + (housingTaxBase - 12) * 0.013;
      else if (housingTaxBase <= 50)  housingTax = 0.265 + (housingTaxBase - 25) * 0.015;
      else if (housingTaxBase <= 94)  housingTax = 0.640 + (housingTaxBase - 50) * 0.020;
      else housingTax = 1.520 + (housingTaxBase - 94) * 0.027;
    } else {
      // 3주택 이상 중과세율
      if (housingTaxBase <= 3)   housingTax = housingTaxBase * 0.005;
      else if (housingTaxBase <= 6)   housingTax = 0.015 + (housingTaxBase - 3)  * 0.007;
      else if (housingTaxBase <= 12)  housingTax = 0.036 + (housingTaxBase - 6)  * 0.010;
      else if (housingTaxBase <= 25)  housingTax = 0.096 + (housingTaxBase - 12) * 0.020;
      else if (housingTaxBase <= 50)  housingTax = 0.356 + (housingTaxBase - 25) * 0.030;
      else if (housingTaxBase <= 94)  housingTax = 1.106 + (housingTaxBase - 50) * 0.040;
      else housingTax = 2.866 + (housingTaxBase - 94) * 0.050;
    }
  }

  // ─ 토지분 종부세 (별도합산토지: 상업용·임대용) ───────────────
  // 별도합산토지 공제 80억, 세율 0.5%/0.6%/0.7% (3구간)
  const landTaxBase = Math.max(0, (landPublicPrice - 80) * FAIR_MARKET_RATE);
  let landTax = 0;
  if (landTaxBase > 0) {
    if (landTaxBase <= 200)      landTax = landTaxBase * 0.005;
    else if (landTaxBase <= 400) landTax = 1.0 + (landTaxBase - 200) * 0.006;
    else landTax = 2.2 + (landTaxBase - 400) * 0.007;
  }

  return housingTax + landTax;
}

// ── 임대소득세 ───────────────────────────────────────────────
// 🔧 Bug2 수정: 필요경비 공제 반영 (분리과세 50%, 종합과세 45% 단순경비율)
export function calcRentalIncomeTax(
  annualRent: number,
  otherIncome = 0,
): number {
  const EXPENSE_RATE_SEP = 0.50;  // 분리과세 필요경비율 50% (소득세법§64의2)
  const BASIC_DED_SEP    = 0.02;  // 분리과세 기본공제 200만원
  const EXPENSE_RATE_GLB = 0.45;  // 종합과세 단순경비율 45% (주택임대)

  if (annualRent <= 0) return 0;

  if (annualRent <= 0.2) {
    // 분리과세: (임대수입×50% - 200만원) × 14%
    const sepTaxable = Math.max(0, annualRent * (1 - EXPENSE_RATE_SEP) - BASIC_DED_SEP);
    const sepTax = sepTaxable * 0.14;
    // 종합과세: 필요경비 45% 차감 후 합산
    const netRentGlobal = annualRent * (1 - EXPENSE_RATE_GLB);
    const globalTax = Math.max(0,
      calcIncomeTax(netRentGlobal + otherIncome) - calcIncomeTax(otherIncome));
    return Math.min(sepTax, globalTax); // 유리한 것 선택
  }
  // 2천만원 초과: 종합과세 강제 (단순경비율 45%)
  const netRent = annualRent * (1 - EXPENSE_RATE_GLB);
  return Math.max(0, calcIncomeTax(netRent + otherIncome) - calcIncomeTax(otherIncome));
}

// ── 소득세 ───────────────────────────────────────────────────
export function calcIncomeTax(income: number): number {
  if (income <= 0)    return 0;
  if (income <= 0.14) return income * 0.06;
  if (income <= 0.50) return 0.0084  + (income - 0.14) * 0.15;
  if (income <= 0.88) return 0.0624  + (income - 0.50) * 0.24;
  if (income <= 1.50) return 0.1536  + (income - 0.88) * 0.35;
  if (income <= 3.00) return 0.3706  + (income - 1.50) * 0.38;
  if (income <= 5.00) return 0.9406  + (income - 3.00) * 0.40;
  if (income <= 10.0) return 1.7406  + (income - 5.00) * 0.42;
  return                 3.8406  + (income - 10.0)  * 0.45;
}

// ── 법인세 ───────────────────────────────────────────────────
// 2026년 귀속: 10%/20%/22%/25% (지방소득세 10% 별도)
export function calcCorporateTax(taxableIncome: number): number {
  if (taxableIncome <= 0)    return 0;
  if (taxableIncome <= 2)    return taxableIncome * 0.10;
  if (taxableIncome <= 200)  return 0.20  + (taxableIncome - 2)   * 0.20;
  if (taxableIncome <= 3000) return 39.80 + (taxableIncome - 200) * 0.22;
  return                        655.80 + (taxableIncome - 3000)   * 0.25;
}

// ── 취득세 ───────────────────────────────────────────────────
// 🔧 Bug6 수정: 법인 상업용·토지 취득세율 수정 (12% → 4.6%)
export function calcAcquisitionTax(
  value: number,
  assetType: string,
  isCorp = false,
  isMultiHouse = false,
): number {
  if (!['상업용부동산', '주거용부동산', '토지'].includes(assetType)) return 0;

  if (isCorp) {
    // 법인 주택 취득: 12% 중과 (지방세법§13의2)
    if (assetType === '주거용부동산') return value * 0.12;
    // 법인 상업용·토지: 기본세율 4.6% (취득세4%+농특세0.2%+지방교육세0.4%)
    return value * 0.046;
  }

  if (assetType === '주거용부동산') {
    if (isMultiHouse) return value * 0.08; // 3주택 이상 중과
    if (value <= 6)   return value * 0.01; // 6억 이하
    if (value <= 9)   return value * 0.02; // 9억 이하
    return              value * 0.03;      // 9억 초과
  }
  return value * 0.04; // 상업용·토지 기본세율
}

// ── 자산 성장 시뮬레이션 ─────────────────────────────────────
export function projectAssetValue(
  asset: Asset,
  years: number,
  macro: MacroSettings,
): number {
  let growthRate: number;
  switch (asset.asset_type) {
    case '토지':             growthRate = macro.land_growth_pct / 100; break;
    case '주거용부동산':     growthRate = macro.apt_growth_pct / 100; break;
    case '상업용부동산':     growthRate = macro.commercial_growth_pct / 100; break;
    default:                 growthRate = asset.expected_growth_pct / 100;
  }
  return asset.current_value * Math.pow(1 + growthRate, years);
}

// ── 현금흐름 계산 ────────────────────────────────────────────
export function calcAnnualCashflow(
  assets: Asset[],
  macro: MacroSettings,
  rateShock = 0,
): {
  rentalIncome: number;
  holdingTax: number;
  loanInterest: number;
  netCashflow: number;
} {
  const rentalIncome = assets.reduce(
    (s, a) => s + a.current_value * a.annual_yield_pct / 100, 0);
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

// ── LTV / DSCR ───────────────────────────────────────────────
export function calcLTV(assets: Asset[]): number {
  const totalValue = assets.reduce((s, a) => s + a.current_value, 0);
  const totalDebt  = assets.reduce((s, a) => s + a.loan_amount, 0);
  return totalValue > 0 ? (totalDebt / totalValue) * 100 : 0;
}

export function calcDSCR(assets: Asset[]): number {
  const rentalIncome   = assets.reduce((s, a) => s + a.current_value * a.annual_yield_pct / 100, 0);
  const annualInterest = assets.reduce((s, a) => s + a.loan_amount * a.loan_rate_pct / 100, 0);
  return annualInterest > 0 ? rentalIncome / annualInterest : 99;
}

// ── 자금출처 소명 ────────────────────────────────────────────
export function calcFundSourceSoMyung(
  acquisitionCost: number,
  soMyungPossible: number,
): {
  required: number;
  possible: number;
  gap: number;
  riskLevel: 'safe' | 'caution' | 'danger';
  giftPresumption: number;
} {
  const required80pct   = acquisitionCost * 0.8;
  const gap             = Math.max(0, required80pct - soMyungPossible);
  const giftPresumption = soMyungPossible < required80pct
    ? acquisitionCost - soMyungPossible
    : 0;
  const riskLevel: 'safe' | 'caution' | 'danger' =
    gap === 0 ? 'safe' : gap < 2 ? 'caution' : 'danger';

  return { required: required80pct, possible: soMyungPossible, gap, riskLevel, giftPresumption };
}

// ── 증여 vs 상속 손익분기점 ──────────────────────────────────
// 🔧 Bug7 수정: 한계 상속세 (이 자산만 포함/제외 차이)로 비교 → apples-to-apples
export function calcGiftVsInheritBreakeven(
  assetValue: number,
  growthRate: number,
  members: FamilyMember[],
  relation: string,
): { breakEvenYears: number; giftTaxNow: number; inheritTaxArr: number[] } {
  const giftTaxNow = calcGiftTax(assetValue, relation);

  const inheritTaxArr = Array.from({ length: 21 }, (_, i) => {
    const futureValue = assetValue * Math.pow(1 + growthRate / 100, i);
    // 이 자산의 한계 상속세: 포함 시 세금 - 미포함 시 세금
    const { tax: with_ }    = calcInheritanceTax(futureValue, members);
    const { tax: without_ } = calcInheritanceTax(0, members);
    return Math.max(0, with_ - without_);
  });

  const breakEvenYears = inheritTaxArr.findIndex(t => t > giftTaxNow);
  return { breakEvenYears, giftTaxNow, inheritTaxArr };
}

// ── PCI 역산 ─────────────────────────────────────────────────
export function calcPCI(
  assetIncrease: number,
  consumption: number,
  reportedIncome: number,
): {
  suspectedAmount: number;
  riskLevel: 'safe' | 'caution' | 'danger';
} {
  const suspectedAmount = Math.max(0, assetIncrease + consumption - reportedIncome);
  const riskLevel: 'safe' | 'caution' | 'danger' =
    suspectedAmount < 1 ? 'safe' : suspectedAmount < 5 ? 'caution' : 'danger';
  return { suspectedAmount, riskLevel };
}

// ── 가족간 차용증 분석 ────────────────────────────────────────
export function calcFamilyLoanAnalysis(
  principal: number,
  actualRatePct: number,
  relation: string,
  priorGifts = 0,
): {
  fairInterest: number;
  actualInterest: number;
  interestGap: number;
  isGiftTaxable: boolean;
  annualGiftTax: number;
  maxZeroRatePrincipal: number;
  riskLevel: 'safe' | 'caution' | 'danger';
  recommendation: string;
} {
  const actualRate     = actualRatePct / 100;
  const fairInterest   = principal * FAIR_LOAN_RATE;
  const actualInterest = principal * actualRate;
  const interestGap    = Math.max(0, fairInterest - actualInterest);
  const isGiftTaxable  = interestGap > LOAN_GIFT_THRESHOLD;
  const annualGiftTax  = isGiftTaxable
    ? calcGiftTax(interestGap, relation, priorGifts)
    : 0;
  const maxZeroRatePrincipal = LOAN_GIFT_THRESHOLD / FAIR_LOAN_RATE; // ≈ 2.17억

  const riskLevel: 'safe' | 'caution' | 'danger' =
    !isGiftTaxable ? 'safe' : interestGap < 0.5 ? 'caution' : 'danger';

  let recommendation: string;
  if (actualRate === 0 && principal <= maxZeroRatePrincipal) {
    recommendation = `무이자 가능 — 원금 ${(maxZeroRatePrincipal * 100).toFixed(0)}백만원 이하 시 이자상당이익 1천만원 미만으로 비과세`;
  } else if (actualRate >= FAIR_LOAN_RATE) {
    recommendation = `적정이자율(4.6%) 이상 지급 — 증여세 없음. 수령 이자는 이자소득세 과세.`;
  } else if (!isGiftTaxable) {
    recommendation = `이자 차액 ${(interestGap * 1000).toFixed(0)}만원 — 1천만원 미만 비과세 유지`;
  } else {
    recommendation = `이자 차액 ${(interestGap * 1000).toFixed(0)}만원 → 연 증여세 ${(annualGiftTax * 1000).toFixed(0)}만원 발생. 이자율 ${((LOAN_GIFT_THRESHOLD / principal) * 100).toFixed(2)}% 이상 조정 권장`;
  }

  return { fairInterest, actualInterest, interestGap, isGiftTaxable, annualGiftTax, maxZeroRatePrincipal, riskLevel, recommendation };
}

// ── 법인-개인 간 인정이자 ────────────────────────────────────
// 🔧 Bug8 수정: +0.0001 트릭 제거 → 한계세율 직접 적용
export function calcCorpLoanImputed(
  principal: number,
  actualRatePct: number,
  corpAnnualIncome = 5,    // 법인 연간 과세소득 (억), 기본 5억
  recipientIncome = 1,     // 수령인 개인소득 (억), 기본 1억
): {
  imputedInterest: number;
  corpTaxImpact: number;
  recipientIncomeTax: number;
  totalTaxCost: number;
} {
  const imputedRate     = Math.max(0, FAIR_LOAN_RATE - actualRatePct / 100);
  const imputedInterest = principal * imputedRate;
  const corpTaxImpact       = imputedInterest * marginalCorporateTaxRate(corpAnnualIncome);
  const recipientIncomeTax  = imputedInterest * marginalIncomeTaxRate(recipientIncome);
  return { imputedInterest, corpTaxImpact, recipientIncomeTax, totalTaxCost: corpTaxImpact + recipientIncomeTax };
}

// ── 법인전환 절세효과 ─────────────────────────────────────────
export function calcCorpConversionBenefit(
  annualRentalIncome: number,
  ceoSalary: number,
  otherPersonalIncome: number,
  assets: Asset[],
): {
  personalTax: number;
  corpTax: number;
  ceoIncomeTax: number;
  totalCorpBurden: number;
  annualSaving: number;
  transferTax: number;
  paybackYears: number;
  notes: string[];
} {
  // 개인: 임대+기타 종합과세 (필요경비 45% 차감)
  const netRental   = annualRentalIncome * 0.55;
  const personalTax = calcIncomeTax(netRental + otherPersonalIncome)
                    - calcIncomeTax(otherPersonalIncome);

  // 법인: 임대 - 급여(손금) = 과세소득
  const corpTaxableIncome = Math.max(0, annualRentalIncome - ceoSalary);
  const corpTax = calcCorporateTax(corpTaxableIncome);

  // 대표이사 급여 소득세
  const ceoIncomeTax = calcIncomeTax(ceoSalary + otherPersonalIncome)
                     - calcIncomeTax(otherPersonalIncome);

  const totalCorpBurden = corpTax + ceoIncomeTax;
  const annualSaving    = personalTax - totalCorpBurden;

  // 현물출자 취득세: 부동산 × 4% × 50% 경감 = 2% (조특법§119, ~2027.12.31)
  const reValue = assets
    .filter(a => ['주거용부동산', '상업용부동산', '토지'].includes(a.asset_type))
    .reduce((s, a) => s + a.current_value, 0);
  const transferTax = reValue * 0.02;
  const paybackYears = annualSaving > 0 ? Math.ceil(transferTax / annualSaving) : 999;

  const notes = [
    `현물출자 양도소득세 이월과세 (조특법§32) — 법인 양도 시점에 납부`,
    `취득세 50% 경감 적용 (~2027.12.31), 법인 설립비용 별도`,
    `법인세율 2026: 10%/20%/22%/25% (지방소득세 10% 추가)`,
    `대표이사 급여 손금 → 법인 과세소득 절감`,
    `배당소득세 14% 추가 (2천만 초과 시 종합과세)`,
    `전환 후 5년 내 매각 시 이월과세 취소 위험`,
    `주식 증여로 배우자·자녀에게 배당소득 분산 가능`,
  ];

  return { personalTax, corpTax, ceoIncomeTax, totalCorpBurden, annualSaving, transferTax, paybackYears, notes };
}

// ── 가족그룹 배분 추천 엔진 ───────────────────────────────────
export interface FamilyGroupUnit {
  id: string;
  label: string;
  head: FamilyMember;
}

export interface AssetDistributionRec {
  assetId: string;
  assetName: string;
  assetValue: number;   // 이전 대상 가치 (억)
  assetType: string;
  targetGroupId: string;
  targetGroupLabel: string;
  targetRelation: string;
  transferPct: number;
  transferType: TransferType;
  yearOffset: number;
  estimatedTax: number;
  effectiveTaxPct: number;
  rationale: string;
}

export interface DistributionPlan {
  groups: FamilyGroupUnit[];
  recommendations: AssetDistributionRec[];
  totalAssetValue: number;
  totalTax: number;
  effectiveTaxPct: number;
  groupSummary: Record<string, { value: number; tax: number }>; // 그룹별 배분액·세금
}

export function recommendFamilyDistribution(
  assets: Asset[],
  members: FamilyMember[],
  _macro?: MacroSettings,
): DistributionPlan {
  // 1. 수증 가능 가족 그룹 식별 (직계비속)
  const RECIPIENT_RELATIONS = ['자녀', '손자녀'];
  const groupHeads = members
    .filter(m => RECIPIENT_RELATIONS.includes(m.relation))
    .sort((a, b) => a.age - b.age); // 나이 오름차순 (나이 많은 순으로 우선 배분)

  if (groupHeads.length === 0) {
    return {
      groups: [], recommendations: [],
      totalAssetValue: 0, totalTax: 0, effectiveTaxPct: 0, groupSummary: {},
    };
  }

  const groups: FamilyGroupUnit[] = groupHeads.map(head => ({
    id: head.id,
    label: `${head.name}(${head.relation}) 가족`,
    head,
  }));

  // 2. 배분 가능 자산 (가치 큰 순)
  const distributableAssets = [...assets]
    .filter(a => a.current_value > 0)
    .sort((a, b) => b.current_value - a.current_value);

  const totalAssetValue = distributableAssets.reduce((s, a) => s + a.current_value, 0);
  const targetPerGroup  = groups.length > 0 ? totalAssetValue / groups.length : 0;

  // 그룹별 누적 배분액 추적
  const groupAccum: Record<string, number> = {};
  groups.forEach(g => { groupAccum[g.id] = 0; });

  const recommendations: AssetDistributionRec[] = [];

  for (const asset of distributableAssets) {
    const av = asset.current_value;

    // 그룹 정렬: 현재 누적 적은 그룹 우선 (균등 배분)
    const sorted = [...groups].sort((a, b) => groupAccum[a.id] - groupAccum[b.id]);

    // 대형 자산 (목표의 1.5배 이상, 그룹 2개+): 50/50 지분 분할
    if (av > targetPerGroup * 1.5 && groups.length >= 2) {
      const [g1, g2] = sorted;
      const splits: [FamilyGroupUnit, number, number][] = [
        [g1, 50, 0],
        [g2, 50, calcOptimalTiming(av * 0.5, g2.head.age) + 1],
      ];
      for (const [grp, pct, yr] of splits) {
        const val  = av * pct / 100;
        const skip = grp.head.relation === '손자녀';
        const tax  = calcGiftTax(val, grp.head.relation, 0, skip);
        recommendations.push({
          assetId: asset.id, assetName: asset.name,
          assetValue: val, assetType: asset.asset_type,
          targetGroupId: grp.id, targetGroupLabel: grp.label,
          targetRelation: grp.head.relation,
          transferPct: pct,
          transferType: skip ? '세대생략증여' : '지분증여',
          yearOffset: yr,
          estimatedTax: tax,
          effectiveTaxPct: val > 0 ? (tax / val) * 100 : 0,
          rationale: buildRationale(asset, grp, val, tax, skip),
        });
        groupAccum[grp.id] += val;
      }
    } else {
      // 단독 배분
      const grp  = sorted[0];
      const skip = grp.head.relation === '손자녀';
      const tax  = calcGiftTax(av, grp.head.relation, 0, skip);
      const yr   = calcOptimalTiming(av, grp.head.age);
      recommendations.push({
        assetId: asset.id, assetName: asset.name,
        assetValue: av, assetType: asset.asset_type,
        targetGroupId: grp.id, targetGroupLabel: grp.label,
        targetRelation: grp.head.relation,
        transferPct: 100,
        transferType: skip ? '세대생략증여' : '증여(생전)',
        yearOffset: yr,
        estimatedTax: tax,
        effectiveTaxPct: av > 0 ? (tax / av) * 100 : 0,
        rationale: buildRationale(asset, grp, av, tax, skip),
      });
      groupAccum[grp.id] += av;
    }
  }

  const totalTax       = recommendations.reduce((s, r) => s + r.estimatedTax, 0);
  const effectiveTaxPct = totalAssetValue > 0 ? (totalTax / totalAssetValue) * 100 : 0;

  // 그룹별 요약
  const groupSummary: Record<string, { value: number; tax: number }> = {};
  for (const grp of groups) {
    const recs = recommendations.filter(r => r.targetGroupId === grp.id);
    groupSummary[grp.id] = {
      value: recs.reduce((s, r) => s + r.assetValue, 0),
      tax:   recs.reduce((s, r) => s + r.estimatedTax, 0),
    };
  }

  return { groups, recommendations, totalAssetValue, totalTax, effectiveTaxPct, groupSummary };
}

function calcOptimalTiming(value: number, recipientAge: number): number {
  // 큰 자산은 빨리, 젊은 수증자는 조금 나중에 (10년 사이클 재활용 고려)
  if (value >= 10) return 0;           // 10억+: 즉시
  if (value >= 5)  return 1;           // 5~10억: 1년 내
  if (recipientAge < 35) return 3;     // 젊은 수증자: 3년 후 (공제 여유 활용)
  return 2;
}

function buildRationale(
  asset: Asset,
  grp: FamilyGroupUnit,
  value: number,
  tax: number,
  isSkip: boolean,
): string {
  const parts: string[] = [];

  if (isSkip) {
    parts.push('세대생략 — 할증 30%이나 상속세 1회 면제');
  }

  const deduction = GIFT_DEDUCTIONS[grp.head.relation] ?? 0.1;
  if (value <= deduction) {
    parts.push(`공제 한도(${(deduction * 100).toFixed(0)}백만원) 내 비과세 가능`);
  } else {
    parts.push(`실효세율 ${tax > 0 ? ((tax / value) * 100).toFixed(1) : 0}%`);
  }

  if (asset.asset_type === '주거용부동산') {
    parts.push('주거 목적 활용 가능');
  } else if (asset.asset_type === '상업용부동산') {
    parts.push('임대 수익 분산 — 가족 소득세 절세');
  } else if (asset.asset_type === '금융자산') {
    parts.push('유동성 높아 즉시 활용 가능');
  } else if (asset.asset_type === '토지') {
    parts.push('장기 보유 후 가치 상승 기대');
  }

  return parts.join(' · ') || '균등 배분 원칙';
}

// ── 이월과세 계산 (소득세법 §97의2) ─────────────────────────────
// 배우자/직계존비속으로부터 증여받은 자산을 5년 이내 양도 시 원취득가 적용
export function calcCarryOverCGT(
  asset: Asset,
  giftValue: number,           // 증여받은 시점 시가 (억)
  saleYearsAfterGift: number,  // 증여 후 매각까지 보유기간 (년)
  projectedSaleValue: number,  // 예상 매각가 (억)
): {
  isCarryOver: boolean;
  costBasis_carryOver: number;  // 이월과세 적용 시 취득가 (원취득가)
  costBasis_normal: number;     // 5년+ 보유 시 취득가 (증여시가)
  cgt_carryOver: number;        // 즉시 매각 시 양도세 (이월과세)
  cgt_normal: number;           // 5년+ 보유 후 매각 시 양도세
  extraTaxCarryOver: number;    // 이월과세로 추가 발생하는 세금 (증여효과 감소분)
} {
  const isCarryOver = saleYearsAfterGift < 5;

  // 원취득가 (이월과세 적용 시)
  const costBasis_carryOver = asset.acquisition_cost;
  // 증여시가 (정상 보유 시)
  const costBasis_normal = giftValue;

  // 이월과세 시: 원취득일부터 매각일까지의 보유기간
  const acqYear = asset.acquisition_date
    ? new Date(asset.acquisition_date).getFullYear()
    : new Date().getFullYear() - 5;
  const yearsFromOriginalAcq = (new Date().getFullYear() - acqYear) + saleYearsAfterGift;

  // 장기보유특별공제 — 일반 부동산
  function lthdForYears(years: number, type: string): number {
    if (!['상업용부동산', '주거용부동산', '토지'].includes(type)) return 0;
    if (years >= 15) return 0.30;
    if (years >= 10) return 0.20;
    if (years >= 5)  return 0.10;
    if (years >= 3)  return 0.06;
    return 0;
  }

  // 이월과세 적용 CGT: 원취득가 기준
  const gain_carryOver = Math.max(0, projectedSaleValue - costBasis_carryOver);
  const lthd_carryOver = lthdForYears(yearsFromOriginalAcq, asset.asset_type);
  const deductedGain_carryOver = gain_carryOver * (1 - lthd_carryOver);
  const taxable_carryOver = Math.max(0, deductedGain_carryOver - 0.025);
  let cgt_carryOver: number;
  if (yearsFromOriginalAcq < 1) cgt_carryOver = taxable_carryOver * 0.50;
  else if (yearsFromOriginalAcq < 2) cgt_carryOver = taxable_carryOver * 0.40;
  else cgt_carryOver = calcIncomeTax(taxable_carryOver);

  // 정상 보유 CGT: 증여시가 기준 (5년 이상 보유 후)
  const gain_normal = Math.max(0, projectedSaleValue - costBasis_normal);
  const lthd_normal = lthdForYears(saleYearsAfterGift, asset.asset_type);
  const deductedGain_normal = gain_normal * (1 - lthd_normal);
  const taxable_normal = Math.max(0, deductedGain_normal - 0.025);
  let cgt_normal: number;
  if (saleYearsAfterGift < 1) cgt_normal = taxable_normal * 0.50;
  else if (saleYearsAfterGift < 2) cgt_normal = taxable_normal * 0.40;
  else cgt_normal = calcIncomeTax(taxable_normal);

  const extraTaxCarryOver = Math.max(0, cgt_carryOver - cgt_normal);

  return {
    isCarryOver,
    costBasis_carryOver,
    costBasis_normal,
    cgt_carryOver,
    cgt_normal,
    extraTaxCarryOver,
  };
}

// ── 배분 전략 인터페이스 ──────────────────────────────────────
export interface StrategyAction {
  recipientId: string;
  recipientName: string;
  recipientRelation: string;
  assetId: string;
  assetName: string;
  assetType: string;
  originalCost: number;         // 원취득가 (억) — for carry-over warning
  giftValue: number;            // 이전 가치 (억)
  transferPct: number;          // 이전 비율 (%)
  yearOffset: number;           // 실행 시점 (몇 년 후)
  giftTax: number;              // 예상 증여세
  deductionUsed: number;        // 이번에 사용된 공제액
  cgtIfImmediateSale: number;   // 증여 후 즉시 매각 시 양도세 (이월과세 적용)
  cgtIf5yrHoldSale: number;    // 5년 이상 보유 후 매각 시 양도세
  extraTaxIfImmediate: number;  // 즉시 매각 시 이월과세로 추가 세금
  carryOverWarning: boolean;    // 이월과세 주의 여부 (추가세금 > 500만원)
  gainPct: number;              // 시세차익률 (current/acquisition - 1) × 100
}

export interface FamilyDistributionStrategy {
  id: string;
  label: string;
  tagline: string;
  actions: StrategyAction[];
  totalGiftTax: number;
  cgtSellImmediately: number;   // gift + CGT if all sold right after gift (최악)
  cgtSellAfter5yr: number;      // gift + CGT if all held 5yr then sold
  inheritanceAlt: number;       // 증여 안 하고 상속 시 예상 상속세 (10년 후)
  netToFamilyGiftHold: number;  // 총 자산가치 - giftTax - cgtSellAfter5yr
  netToFamilyInherit: number;   // 총 자산가치 - inheritanceAlt
  pros: string[];
  cons: string[];
  keyRules: string[];
  isRecommended: boolean;
}

// ── 전략 생성 메인 함수 ──────────────────────────────────────
export function generateDistributionStrategies(
  selectedAssets: Asset[],
  recipients: FamilyMember[],
  macro?: MacroSettings | null,
  allMembers?: FamilyMember[],
): FamilyDistributionStrategy[] {
  if (selectedAssets.length === 0 || recipients.length === 0) return [];

  const totalValue = selectedAssets.reduce((s, a) => s + a.current_value, 0);

  // 수증자를 공제 한도 큰 순으로 정렬
  const deductionOrder = ['배우자', '자녀', '부모', '조부모', '손자녀', '며느리', '사위', '기타'];
  const sortedRecipients = [...recipients].sort((a, b) => {
    const ia = deductionOrder.indexOf(a.relation);
    const ib = deductionOrder.indexOf(b.relation);
    const da = (ia === -1 ? 99 : ia);
    const db = (ib === -1 ? 99 : ib);
    if (da !== db) return da - db;
    return (GIFT_DEDUCTIONS[b.relation] ?? 0.1) - (GIFT_DEDUCTIONS[a.relation] ?? 0.1);
  });

  // 10년 후 자산 가치 추정 (상속 대안 비교용)
  function getGrowthRate(asset: Asset): number {
    if (!macro) return 0.03;
    switch (asset.asset_type) {
      case '토지': return macro.land_growth_pct / 100;
      case '주거용부동산': return macro.apt_growth_pct / 100;
      case '상업용부동산': return macro.commercial_growth_pct / 100;
      default: return asset.expected_growth_pct / 100;
    }
  }

  const projectedValue10yr = selectedAssets.reduce(
    (s, a) => s + a.current_value * Math.pow(1 + getGrowthRate(a), 10), 0);

  // 상속세 추정 (allMembers 또는 recipients 기반)
  const membersForInherit = allMembers ?? recipients;
  const { tax: inheritanceTaxNow } = calcInheritanceTax(totalValue, membersForInherit);
  const { tax: inheritanceTax10yr } = calcInheritanceTax(projectedValue10yr, membersForInherit);

  // ── 헬퍼: action 생성 ────────────────────────────────────
  function buildAction(
    asset: Asset,
    recipient: FamilyMember,
    transferPct: number,
    yearOffset: number,
    priorGifts: number,
  ): StrategyAction {
    const giftValue = asset.current_value * (transferPct / 100);
    const isSkip = recipient.relation === '손자녀';
    const giftTax = calcGiftTax(giftValue, recipient.relation, priorGifts, isSkip);
    const deduction = GIFT_DEDUCTIONS[recipient.relation] ?? 0.1;
    const deductionUsed = Math.min(giftValue, Math.max(0, deduction - priorGifts));

    // 즉시 매각 시 (이월과세 적용, saleYearsAfterGift=0)
    const immediate = calcCarryOverCGT(asset, giftValue, 0, giftValue);
    // 5년 보유 후 매각 — 예상 매각가에 성장률 반영
    const projectedSale5yr = giftValue * Math.pow(1 + getGrowthRate(asset), 5);
    const hold5yr = calcCarryOverCGT(asset, giftValue, 5, projectedSale5yr);

    const gainPct = asset.acquisition_cost > 0
      ? ((asset.current_value - asset.acquisition_cost) / asset.acquisition_cost) * 100
      : 0;

    return {
      recipientId: recipient.id,
      recipientName: recipient.name,
      recipientRelation: recipient.relation,
      assetId: asset.id,
      assetName: asset.name,
      assetType: asset.asset_type,
      originalCost: asset.acquisition_cost * (transferPct / 100),
      giftValue,
      transferPct,
      yearOffset,
      giftTax,
      deductionUsed,
      cgtIfImmediateSale: immediate.cgt_carryOver,
      cgtIf5yrHoldSale: hold5yr.cgt_normal,
      extraTaxIfImmediate: immediate.extraTaxCarryOver,
      carryOverWarning: immediate.extraTaxCarryOver > 0.05, // > 500만원
      gainPct,
    };
  }

  // ── 전략 1: 즉시 분산 증여 (공제 최대화) ──────────────────
  function buildStrategy1(): FamilyDistributionStrategy {
    const actions: StrategyAction[] = [];
    // 수증자별 잔여 공제 추적
    const remainingDeduction: Record<string, number> = {};
    for (const r of sortedRecipients) {
      remainingDeduction[r.id] = GIFT_DEDUCTIONS[r.relation] ?? 0.1;
    }
    const priorGiftsMap: Record<string, number> = {};
    for (const r of sortedRecipients) priorGiftsMap[r.id] = 0;

    for (const asset of selectedAssets) {
      let remainingValue = asset.current_value;

      // 잔여 공제 많은 수증자 우선
      const recipBySurplus = [...sortedRecipients].sort(
        (a, b) => (remainingDeduction[b.id] ?? 0) - (remainingDeduction[a.id] ?? 0));

      for (const recip of recipBySurplus) {
        if (remainingValue <= 0) break;
        const surplus = remainingDeduction[recip.id] ?? 0;
        if (surplus <= 0) continue;

        const giftAmt = Math.min(remainingValue, surplus);
        const pct = (giftAmt / asset.current_value) * 100;
        actions.push(buildAction(asset, recip, pct, 0, priorGiftsMap[recip.id]));
        priorGiftsMap[recip.id] += giftAmt;
        remainingDeduction[recip.id] = Math.max(0, (remainingDeduction[recip.id] ?? 0) - giftAmt);
        remainingValue -= giftAmt;
      }

      // 남은 가치가 있으면 공제 초과분 첫 번째 수증자에게
      if (remainingValue > 0.001) {
        const recip = sortedRecipients[0];
        const pct = (remainingValue / asset.current_value) * 100;
        actions.push(buildAction(asset, recip, pct, 0, priorGiftsMap[recip.id]));
        priorGiftsMap[recip.id] += remainingValue;
      }
    }

    const totalGiftTax = actions.reduce((s, a) => s + a.giftTax, 0);
    const cgtImmediate = actions.reduce((s, a) => s + a.cgtIfImmediateSale, 0);
    const cgt5yr = actions.reduce((s, a) => s + a.cgtIf5yrHoldSale, 0);

    return {
      id: 'strategy1',
      label: '즉시 분산 증여',
      tagline: '공제 한도 최대 활용 — 지금 당장 세부담 최소화',
      actions,
      totalGiftTax,
      cgtSellImmediately: totalGiftTax + cgtImmediate,
      cgtSellAfter5yr: totalGiftTax + cgt5yr,
      inheritanceAlt: inheritanceTax10yr,
      netToFamilyGiftHold: totalValue - totalGiftTax - cgt5yr,
      netToFamilyInherit: totalValue - inheritanceTaxNow,
      pros: [
        '공제 한도 내 증여분은 즉시 비과세 이전 가능',
        '증여 시점에 취득가 확정 → 5년 보유 후 양도세 절감',
        '자산을 빠르게 가족에게 이전하여 향후 상속세 기반 축소',
      ],
      cons: [
        '공제 초과분은 즉시 증여세 납부 부담',
        '5년 내 매각 시 이월과세(소득세법§97의2) 적용 — 양도세 폭탄 주의',
        '일시에 여러 자산 이전 시 유동성 부담 발생 가능',
      ],
      keyRules: [
        '상증법§53: 수증자별 10년 합산 공제 한도 적용',
        '소득세법§97의2: 5년 이내 매각 시 원취득가 기준 양도세',
        '상증법§57: 손자녀 세대생략 시 산출세액 30% 할증',
      ],
      isRecommended: true,
    };
  }

  // ── 전략 2: 10년 분할 (2사이클 공제 활용) ─────────────────
  function buildStrategy2(): FamilyDistributionStrategy {
    const actions: StrategyAction[] = [];

    // 사이클 1 (yearOffset=0): 공제 한도까지만 무세 증여
    for (const asset of selectedAssets) {
      let remainingValue = asset.current_value;
      for (const recip of sortedRecipients) {
        if (remainingValue <= 0) break;
        const ded = GIFT_DEDUCTIONS[recip.relation] ?? 0.1;
        const cycle1Amt = Math.min(remainingValue, ded);
        const pct = (cycle1Amt / asset.current_value) * 100;
        actions.push(buildAction(asset, recip, pct, 0, 0));
        remainingValue -= cycle1Amt;
      }

      // 남은 분 — 사이클 2 (yearOffset=10)
      if (remainingValue > 0.001) {
        let rem2 = remainingValue;
        for (const recip of sortedRecipients) {
          if (rem2 <= 0) break;
          const ded = GIFT_DEDUCTIONS[recip.relation] ?? 0.1;
          const cycle2Amt = Math.min(rem2, ded);
          const pct = (cycle2Amt / asset.current_value) * 100;
          // 사이클 2: 공제 리셋 기준이므로 priorGifts=0
          actions.push(buildAction(asset, recip, pct, 10, 0));
          rem2 -= cycle2Amt;
        }

        // 최종 잔여분 (yearOffset=20)
        if (rem2 > 0.001) {
          const recip = sortedRecipients[0];
          const pct = (rem2 / asset.current_value) * 100;
          actions.push(buildAction(asset, recip, pct, 20, 0));
        }
      }
    }

    const totalGiftTax = actions.reduce((s, a) => s + a.giftTax, 0);
    const cgtImmediate = actions.reduce((s, a) => s + a.cgtIfImmediateSale, 0);
    const cgt5yr = actions.reduce((s, a) => s + a.cgtIf5yrHoldSale, 0);

    return {
      id: 'strategy2',
      label: '10년 분할 (2사이클 공제)',
      tagline: '공제를 두 번 써서 세금 없이 이전 — 장기 플랜',
      actions,
      totalGiftTax,
      cgtSellImmediately: totalGiftTax + cgtImmediate,
      cgtSellAfter5yr: totalGiftTax + cgt5yr,
      inheritanceAlt: inheritanceTax10yr,
      netToFamilyGiftHold: totalValue - totalGiftTax - cgt5yr,
      netToFamilyInherit: totalValue - inheritanceTaxNow,
      pros: [
        '사이클 1 공제 한도 내 이전분은 증여세 0원',
        '10년 후 공제 리셋 → 사이클 2도 무세 구간 활용',
        '장기간 분산하여 각 시점 증여세 부담 최소화',
      ],
      cons: [
        '20년 이상의 장기 계획 필요 — 계획 변경 위험',
        '기간 내 자산이 증여자 명의 유지 → 상속세 노출 지속',
        '자산 가격 상승 시 미래 증여가액 증가 → 절세 효과 감소',
      ],
      keyRules: [
        '상증법§53: 10년 이내 동일인 증여 합산 → 10년 경과 후 공제 리셋',
        '공제 리셋 시점 이후 새 10년 사이클 공제 재사용 가능',
        '소득세법§97의2: 각 증여 후 5년 내 매각 시 이월과세 주의',
      ],
      isRecommended: false,
    };
  }

  // ── 전략 3: 증여 + 5년 보유 매각 전략 ────────────────────
  function buildStrategy3(): FamilyDistributionStrategy {
    // 전략 1과 동일한 배분, 핵심 메시지가 5년 보유
    const actions: StrategyAction[] = [];
    const remainingDeduction: Record<string, number> = {};
    for (const r of sortedRecipients) {
      remainingDeduction[r.id] = GIFT_DEDUCTIONS[r.relation] ?? 0.1;
    }
    const priorGiftsMap: Record<string, number> = {};
    for (const r of sortedRecipients) priorGiftsMap[r.id] = 0;

    for (const asset of selectedAssets) {
      let remainingValue = asset.current_value;
      const recipBySurplus = [...sortedRecipients].sort(
        (a, b) => (remainingDeduction[b.id] ?? 0) - (remainingDeduction[a.id] ?? 0));

      for (const recip of recipBySurplus) {
        if (remainingValue <= 0) break;
        const surplus = remainingDeduction[recip.id] ?? 0;
        if (surplus <= 0) continue;
        const giftAmt = Math.min(remainingValue, surplus);
        const pct = (giftAmt / asset.current_value) * 100;
        actions.push(buildAction(asset, recip, pct, 0, priorGiftsMap[recip.id]));
        priorGiftsMap[recip.id] += giftAmt;
        remainingDeduction[recip.id] = Math.max(0, (remainingDeduction[recip.id] ?? 0) - giftAmt);
        remainingValue -= giftAmt;
      }
      if (remainingValue > 0.001) {
        const recip = sortedRecipients[0];
        const pct = (remainingValue / asset.current_value) * 100;
        actions.push(buildAction(asset, recip, pct, 0, priorGiftsMap[recip.id]));
        priorGiftsMap[recip.id] += remainingValue;
      }
    }

    const totalGiftTax = actions.reduce((s, a) => s + a.giftTax, 0);
    const cgtImmediate = actions.reduce((s, a) => s + a.cgtIfImmediateSale, 0);
    const cgt5yr = actions.reduce((s, a) => s + a.cgtIf5yrHoldSale, 0);

    // 5년 후 예상 가치
    const projectedValue5yr = selectedAssets.reduce(
      (s, a) => s + a.current_value * Math.pow(1 + getGrowthRate(a), 5), 0);

    return {
      id: 'strategy3',
      label: '증여 후 5년 보유 매각',
      tagline: '5년 보유 필수 — 이월과세 회피로 양도세 최소화',
      actions,
      totalGiftTax,
      cgtSellImmediately: totalGiftTax + cgtImmediate,
      cgtSellAfter5yr: totalGiftTax + cgt5yr,
      inheritanceAlt: inheritanceTax10yr,
      netToFamilyGiftHold: projectedValue5yr - totalGiftTax - cgt5yr,
      netToFamilyInherit: totalValue - inheritanceTaxNow,
      pros: [
        '5년 이상 보유 시 증여시가가 취득가로 확정 → 양도세 대폭 절감',
        `즉시 매각 대비 양도세 절감 예상: ${(cgtImmediate - cgt5yr).toFixed(2)}억원`,
        `5년 후 예상 자산가치: ${projectedValue5yr.toFixed(1)}억 (성장 반영)`,
      ],
      cons: [
        '5년간 자산 매각 불가 → 유동성 제약',
        '5년 내 매각 강행 시 이월과세로 원취득가 기준 양도세 부과',
        '증여세는 즉시 납부 필요 (5년 유예 없음)',
      ],
      keyRules: [
        '소득세법§97의2: 증여 후 5년 이내 양도 시 수증자의 양도차익 = 매각가 - 증여자 원취득가',
        '5년 경과 후 양도 시 취득가 = 증여받은 시점 시가 (정상 적용)',
        '보유기간에 따른 장기보유특별공제: 3년+6%, 5년+10%, 10년+20%, 15년+30%',
      ],
      isRecommended: false,
    };
  }

  // ── 전략 4: 상속 유지 (증여 없음) ────────────────────────
  function buildStrategy4(): FamilyDistributionStrategy {
    return {
      id: 'strategy4',
      label: '상속 유지',
      tagline: '지금은 그대로 — 상속으로 이전 (세금 비교용)',
      actions: [],
      totalGiftTax: 0,
      cgtSellImmediately: inheritanceTaxNow,
      cgtSellAfter5yr: inheritanceTax10yr,
      inheritanceAlt: inheritanceTax10yr,
      netToFamilyGiftHold: totalValue - inheritanceTaxNow,
      netToFamilyInherit: totalValue - inheritanceTax10yr,
      pros: [
        '지금 당장 증여세 없음 — 유동성 유지',
        '자산 운용의 자유 유지 (매각·담보 등)',
        '복잡한 증여 절차·서류 불필요',
      ],
      cons: [
        `10년 후 자산 가치 ${projectedValue10yr.toFixed(1)}억 기준 상속세 예상: ${inheritanceTax10yr.toFixed(2)}억`,
        '자산 가치 상승할수록 상속세 부담 증가',
        '취득가 리셋 기회 없음 → 상속받은 자녀의 추후 양도세 증가 가능',
      ],
      keyRules: [
        '상증법§13: 10년 내 사전증여 합산 — 지금이라도 증여하면 상속세 과표 절감 가능',
        '상증법§19: 배우자공제 최대 30억',
        '상증법§22: 금융재산공제 최대 2억',
      ],
      isRecommended: false,
    };
  }

  return [
    buildStrategy1(),
    buildStrategy2(),
    buildStrategy3(),
    buildStrategy4(),
  ];
}

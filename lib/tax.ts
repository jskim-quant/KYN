import { Asset, FamilyMember, MacroSettings, TransferType } from '@/types';

// ── 상수 ──────────────────────────────────────────────────────
export const GIFT_DEDUCTIONS: Record<string, number> = {
  '배우자': 6.0,
  '자녀': 0.5,
  '며느리': 0.1,   // 기타친족 (4촌 이내 인척) — 상증법§53: 1천만원/10년
  '사위': 0.1,     // 기타친족 (4촌 이내 인척) — 상증법§53: 1천만원/10년
  '손자녀': 0.5,   // 성년 기준; calcGiftTax에서 나이가 있으면 미성년 2천만원으로 조정
  '부모': 0.5,
  '조부모': 0.5,
  '형제': 0.1,
  '삼촌': 0.1,
  '고모': 0.1,
  '기타': 0.1,
};

const FAIR_LOAN_RATE      = 0.046;   // 적정이자율 4.6% (상증법§41의4 시행규칙§10의5)
const LOAN_GIFT_THRESHOLD = 0.1;     // 이자상당이익 1천만원 미만 비과세
const BANK_GIFT_LOAN_RATE = 0.055;   // 증여세 재원용 담보대출 보수 가정: 연 5.5%
const MIN_DSCR_AFTER_NEW_LOAN = 1.5; // 신규 대출 후 임대수익/이자비용 최소 커버리지
const CASHFLOW_DEBT_SERVICE_USE_RATIO = 0.70; // 반복 순현금흐름 중 이자 상환에 쓸 수 있는 보수 한도

export interface CompliantFamilyLoanPlan {
  recipientCashUsed: number;
  requestedFamilyLoan: number;
  familyLoanAmount: number;
  annualInterest: number;
  annualPrincipalRepayment: number;
  annualDebtService: number;
  annualRepaymentCapacity: number;
  canFund: boolean;
  canService: boolean;
  eligible: boolean;
  reason: string;
}

/**
 * 증여세 재원용 가족간 차용의 실행 가능성을 보수적으로 점검합니다.
 * 연소득의 30%와 증여 지분의 임대수익만 상환 재원으로 인정합니다.
 * 이 함수는 세법상 차용 인정 여부를 확정하지 않으며, 실제 계약·이체·상환 증빙이 필요합니다.
 */
export function calcCompliantFamilyLoanPlan(
  ownerCashAvailable: number,
  giftTax: number,
  recipientCash: number,
  recipientAnnualIncome: number,
  giftedAnnualIncome: number,
  termYears = 10,
): CompliantFamilyLoanPlan {
  const safeGiftTax = Math.max(0, giftTax);
  const recipientCashUsed = Math.min(Math.max(0, recipientCash), safeGiftTax);
  const requestedFamilyLoan = Math.max(0, safeGiftTax - recipientCashUsed);
  const familyLoanAmount = Math.min(Math.max(0, ownerCashAvailable), requestedFamilyLoan);
  const noInterestMax = LOAN_GIFT_THRESHOLD / FAIR_LOAN_RATE;
  const annualInterest = familyLoanAmount > noInterestMax
    ? familyLoanAmount * FAIR_LOAN_RATE
    : 0;
  const annualPrincipalRepayment = familyLoanAmount / Math.max(1, termYears);
  const annualDebtService = annualInterest + annualPrincipalRepayment;
  const annualRepaymentCapacity = Math.max(0, recipientAnnualIncome) * 0.30
    + Math.max(0, giftedAnnualIncome);
  const canFund = requestedFamilyLoan <= familyLoanAmount + 1e-9;
  const canService = familyLoanAmount <= 1e-9
    || annualRepaymentCapacity + 1e-9 >= annualDebtService;
  const eligible = canFund && canService;

  const reason = requestedFamilyLoan <= 1e-9
    ? '수증자 본인 현금으로 증여세 납부 가능'
    : !canFund
      ? '피상속인 보유 현금이 차용 필요액보다 부족'
      : !canService
        ? '수증자의 추정 원리금 상환 능력이 부족'
        : '실제 차용 계약·계좌이체·원리금 상환 증빙을 전제로 검토 가능';

  return {
    recipientCashUsed,
    requestedFamilyLoan,
    familyLoanAmount,
    annualInterest,
    annualPrincipalRepayment,
    annualDebtService,
    annualRepaymentCapacity,
    canFund,
    canService,
    eligible,
    reason,
  };
}

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
  recipientAge?: number,    // 수증자 나이 — 직계비속 성년/미성년 공제 구분
): number {
  let ded = GIFT_DEDUCTIONS[relation] ?? 0.1;

  // 직계비속(자녀·손자녀) 성년/미성년 공제 구분 (상증법§53)
  // 성년(19세 이상): 5천만원 / 미성년: 2천만원
  if (['자녀', '손자녀'].includes(relation) && recipientAge !== undefined) {
    ded = recipientAge >= 19 ? 0.5 : 0.2;
  }

  // 혼인·출산 추가공제 (직계존속 → 자녀/손자녀, 수증자당 1회)
  if (marriageOrBirthBonus && (relation === '자녀' || relation === '손자녀')) {
    ded += 1.0;
  }

  // 10년 합산 증분세금: tax(priorGifts+amount) - tax(priorGifts)
  const prevTaxable = Math.max(0, priorGifts - ded);
  const newTaxable  = Math.max(0, priorGifts + amount - ded);
  let tax = calcProgressiveTax(newTaxable) - calcProgressiveTax(prevTaxable);

  // 세대생략 할증 (상증법§57)
  // 일반: 30% / 미성년자 + 증여재산 20억 초과: 40%
  if (isGenerationSkip || relation === '손자녀') {
    const isMinor = recipientAge !== undefined && recipientAge < 19;
    const totalGiftAmt = priorGifts + amount;
    const surcharge = (isMinor && totalGiftAmt > 20) ? 1.40 : 1.30;
    tax *= surcharge;
  }

  // 신고세액공제 3% (상증법§69): 기한 내 자진신고 시 적용
  const FILING_CREDIT = 0.03;
  tax = tax * (1 - FILING_CREDIT);

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
  if (lumpSum > personalTotal) {
    deductions['일괄공제 추가'] = lumpSum - personalTotal;
  }

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
  const afterGiftCredit = Math.max(0, grossTax - Math.min(priorGiftTaxPaid, grossTax));

  // 신고세액공제 3% (상증법§69): 기한 내 자진신고 시 산출세액의 3% 공제
  const FILING_CREDIT_RATE = 0.03;
  const filingCredit = afterGiftCredit * FILING_CREDIT_RATE;
  const tax = Math.max(0, afterGiftCredit - filingCredit);

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

  const housingAssets = assets.filter(a =>
    a.asset_type === '주거용부동산' || (a.asset_type === '오피스텔' && a.housing_use === true));
  const landAssets    = assets.filter(a =>
    ['토지', '농지', '임야', '상업용부동산'].includes(a.asset_type)
    || (a.asset_type === '오피스텔' && a.housing_use !== true));

  const housingPublicPrice = housingAssets.reduce((s, a) =>
    s + getAssessedValue(a), 0);
  const landPublicPrice = landAssets.reduce((s, a) =>
    s + getAssessedValue(a), 0);

  if (isCorpOwned) {
    // 법인: 기본공제 없음, 주택·토지 모두 최고세율 단일 적용
    const baseTax = (housingPublicPrice + landPublicPrice) * FAIR_MARKET_RATE * 0.027;
    return baseTax * 1.20; // 농어촌특별세 20% 근사 포함
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

  return (housingTax + landTax) * 1.20; // 농어촌특별세 20% 근사 포함
}

// ── 재산세·종부세·보유세 ─────────────────────────────────────
// 단위는 모두 억입니다. 실제 재산세/종부세는 용도지역, 과세대상 구분,
// 1세대1주택 여부, 세부담상한, 지방교육세·도시지역분에 따라 달라집니다.
// 여기서는 시뮬레이션용 기본값을 만들고, asset.annual_tax가 있으면 사용자 입력을 우선합니다.
export interface HoldingTaxBreakdown {
  propertyTax: number;                 // 재산세 본세
  localEducationTax: number;           // 지방교육세 근사
  cityAreaTax: number;                 // 도시지역분 근사
  comprehensiveRealEstateTax: number;  // 종부세 + 농특세 근사
  manualOverride: number;              // 사용자가 직접 입력한 보유세
  total: number;
  byAsset: Array<{
    assetId: string;
    assetName: string;
    assetType: string;
    assessedValue: number;
    taxBase: number;
    propertyTax: number;
    localEducationTax: number;
    cityAreaTax: number;
    manualOverride: number;
    total: number;
  }>;
  assumptions: string[];
  warnings: string[];
}

function isRealEstateAsset(asset: Asset): boolean {
  return [
    '주거용부동산',
    '상업용부동산',
    '토지',
    '농지',
    '임야',
    '오피스텔',
  ].includes(asset.asset_type);
}

function isHousingAsset(asset: Asset): boolean {
  return asset.asset_type === '주거용부동산'
    || (asset.asset_type === '오피스텔' && asset.housing_use === true);
}

export function getAssessedValue(asset: Asset): number {
  const explicit = Number(asset.assessed_value ?? 0);
  if (explicit > 0) return explicit;
  const ratio = Number(asset.public_price_ratio ?? 0);
  if (ratio > 0) return asset.current_value * ratio / 100;
  if (isHousingAsset(asset)) return asset.current_value * 0.70;
  if (isRealEstateAsset(asset)) return asset.current_value * 0.65;
  return asset.current_value;
}

function calcHousePropertyTax(taxBase: number): number {
  if (taxBase <= 0.6) return taxBase * 0.001;
  if (taxBase <= 1.5) return 0.0006 + (taxBase - 0.6) * 0.0015;
  if (taxBase <= 3.0) return 0.00195 + (taxBase - 1.5) * 0.0025;
  return 0.0057 + (taxBase - 3.0) * 0.004;
}

function calcLandPropertyTax(taxBase: number): number {
  if (taxBase <= 0) return 0;
  if (taxBase <= 5) return taxBase * 0.002;
  if (taxBase <= 10) return 0.010 + (taxBase - 5) * 0.003;
  return 0.025 + (taxBase - 10) * 0.005;
}

export function calcAnnualPropertyTaxForAsset(asset: Asset): HoldingTaxBreakdown['byAsset'][number] {
  if (!isRealEstateAsset(asset)) {
    return {
      assetId: asset.id,
      assetName: asset.name,
      assetType: asset.asset_type,
      assessedValue: 0,
      taxBase: 0,
      propertyTax: 0,
      localEducationTax: 0,
      cityAreaTax: 0,
      manualOverride: 0,
      total: 0,
    };
  }

  const assessedValue = getAssessedValue(asset);
  const taxBaseRate = isHousingAsset(asset) ? 0.60 : 0.70;
  const taxBase = Math.max(0, assessedValue * taxBaseRate);
  const propertyTax = isHousingAsset(asset)
    ? calcHousePropertyTax(taxBase)
    : asset.asset_type === '상업용부동산' || asset.asset_type === '오피스텔'
      ? taxBase * 0.0025
      : calcLandPropertyTax(taxBase);
  const localEducationTax = propertyTax * 0.20;
  const cityAreaTax = ['주거용부동산', '상업용부동산', '오피스텔'].includes(asset.asset_type)
    ? taxBase * 0.0014
    : 0;
  const manualOverride = Math.max(0, Number(asset.annual_tax ?? 0));
  const calculatedTotal = propertyTax + localEducationTax + cityAreaTax;

  return {
    assetId: asset.id,
    assetName: asset.name,
    assetType: asset.asset_type,
    assessedValue,
    taxBase,
    propertyTax,
    localEducationTax,
    cityAreaTax,
    manualOverride,
    total: manualOverride > 0 ? manualOverride : calculatedTotal,
  };
}

export function calcAnnualHoldingTaxes(
  assets: Asset[],
  options: { isCorpOwned?: boolean; isMultiHouse?: boolean } = {},
): HoldingTaxBreakdown {
  const byAsset = assets.map(calcAnnualPropertyTaxForAsset);
  const propertyTax = byAsset.reduce((s, a) => s + a.propertyTax, 0);
  const localEducationTax = byAsset.reduce((s, a) => s + a.localEducationTax, 0);
  const cityAreaTax = byAsset.reduce((s, a) => s + a.cityAreaTax, 0);
  const manualOverride = byAsset.reduce((s, a) => s + a.manualOverride, 0);
  const manualAssetIds = new Set(byAsset.filter(a => a.manualOverride > 0).map(a => a.assetId));
  const calculatedAssetHoldingTax = byAsset.reduce((s, a) => s + (manualAssetIds.has(a.assetId) ? a.manualOverride : a.propertyTax + a.localEducationTax + a.cityAreaTax), 0);
  const comprehensiveRealEstateTax = calcComprehensiveRealEstateTax(
    assets,
    options.isCorpOwned ?? false,
    options.isMultiHouse ?? assets.filter(isHousingAsset).length >= 3,
  );

  return {
    propertyTax,
    localEducationTax,
    cityAreaTax,
    comprehensiveRealEstateTax,
    manualOverride,
    byAsset,
    total: calculatedAssetHoldingTax + comprehensiveRealEstateTax,
    assumptions: [
      '공시가격이 없으면 주택 70%, 비주거 부동산 65%의 공시가격/시가 비율을 임시 적용했습니다.',
      '재산세는 재산세 본세, 지방교육세 20%, 도시지역분 0.14%를 보수적으로 포함했습니다.',
      '종부세는 주택·토지 과세표준에 농어촌특별세 20%를 포함한 근사값입니다.',
    ],
    warnings: [
      '실제 보유세는 세부담상한, 1세대1주택 고령·장기보유 공제, 별도합산/종합합산 토지 구분에 따라 달라집니다.',
      '자산 목록의 보유세 직접 입력값이 있으면 해당 자산은 직접 입력값을 우선했습니다.',
    ],
  };
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
  acquisitionKind: 'purchase' | 'gift' | 'inheritance' = 'purchase',
): number {
  if (!['상업용부동산', '주거용부동산', '토지', '농지', '임야', '오피스텔'].includes(assetType)) return 0;

  if (acquisitionKind === 'inheritance') {
    if (assetType === '주거용부동산' || assetType === '오피스텔') return value * 0.028;
    return value * 0.032;
  }
  if (acquisitionKind === 'gift') {
    if ((assetType === '주거용부동산' || assetType === '오피스텔') && (isCorp || isMultiHouse)) return value * 0.122;
    return value * 0.038;
  }

  if (isCorp) {
    // 법인 주택 취득: 12% 중과 (지방세법§13의2)
    if (assetType === '주거용부동산' || assetType === '오피스텔') return value * 0.12;
    // 법인 상업용·토지: 기본세율 4.6% (취득세4%+농특세0.2%+지방교육세0.4%)
    return value * 0.046;
  }

  if (assetType === '주거용부동산' || assetType === '오피스텔') {
    if (isMultiHouse) return value * 0.082; // 중과 + 부가세 근사
    if (value <= 6)   return value * 0.012; // 6억 이하 + 부가세 근사
    if (value <= 9)   return value * 0.022; // 9억 이하 + 부가세 근사
    return              value * 0.032;      // 9억 초과 + 부가세 근사
  }
  if (assetType === '농지') return value * 0.034;
  return value * 0.046; // 상업용·토지 기본세율 + 농특세·지방교육세 근사
}

// ── 자산 성장 시뮬레이션 ─────────────────────────────────────
export function getAssetGrowthRate(
  asset: Asset,
  macro: MacroSettings | null,
): number {
  const assetGrowthPct = asset.expected_growth_pct;
  if (
    assetGrowthPct !== null
    && assetGrowthPct !== undefined
    && Number.isFinite(Number(assetGrowthPct))
  ) {
    return Number(assetGrowthPct) / 100;
  }

  // Legacy records created before asset-level growth rates use macro defaults.
  if (!macro) return 0;

  switch (asset.asset_type) {
    case '토지':
    case '농지':
    case '임야':
      return macro.land_growth_pct / 100;
    case '주거용부동산':
      return macro.apt_growth_pct / 100;
    case '상업용부동산':
    case '오피스텔':
      return macro.commercial_growth_pct / 100;
    case '예금':
    case '예금채권':
      return Number(macro.deposit_rate_pct ?? 0) / 100;
    case '채권':
      return Number(macro.bond_return_pct ?? 0) / 100;
    case '국내주식':
      return Number(macro.domestic_stock_return_pct ?? 0) / 100;
    case '해외주식':
      return Number(macro.foreign_stock_return_pct ?? 0) / 100;
    case '비상장주식':
      return Number(macro.unlisted_stock_return_pct ?? 0) / 100;
    default:
      return 0;
  }
}

export function projectAssetValue(
  asset: Asset,
  years: number,
  macro: MacroSettings | null,
): number {
  const growthRate = getAssetGrowthRate(asset, macro);
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
  rentalTax: number;
  netCashflow: number;
} {
  const rentalIncome = assets.reduce(
    (s, a) => s + a.current_value * a.annual_yield_pct / 100, 0);
  const holdingTax = calcAnnualHoldingTaxes(assets).total;
  const loanInterest = assets.reduce((s, a) => {
    const effectiveRate = a.loan_type === 'variable'
      ? (a.loan_rate_pct + rateShock) / 100
      : a.loan_rate_pct / 100;
    return s + a.loan_amount * effectiveRate;
  }, 0);
  const rentalTax = calcRentalIncomeTax(rentalIncome);
  const netCashflow = rentalIncome - holdingTax - loanInterest - rentalTax;
  return { rentalIncome, holdingTax, loanInterest, rentalTax, netCashflow };
}

// ── 회생방안 전략 분석 ───────────────────────────────────────────

export interface ExecutionStep {
  timing: string;        // e.g. "즉시", "1~2주차", "상속 개시 시"
  title: string;
  description: string;
  actor: string;         // e.g. "세무사", "법무사", "본인", "감정평가사"
  estimatedCost?: string; // e.g. "약 100~300만원"
}

export interface RecoveryStrategy {
  id: string;
  title: string;
  category: '즉시' | '단기' | '중기' | '장기';
  legalBasis: string;
  description: string;
  taxSavingEstimate: number;   // 예상 절세액 (억)
  costEstimate: number;        // 비용/세금 부담 (억, 양수=비용)
  netBenefit: number;          // 순편익 (억)
  feasibility: 'high' | 'medium' | 'low'; // 실행 가능성
  riskLevel: 'low' | 'medium' | 'high';
  actionItems: string[];
  risks: string[];
  isApplicable: boolean;       // 이 가족에게 해당되는지
  notApplicableReason?: string;
  executionSteps: ExecutionStep[];
  executionWeeks: number;
}

export function calcRecoveryStrategies(
  totalEstate: number,
  members: FamilyMember[],
  assets: Asset[],
  inheritanceTax: number,
  donorAge: number,
  priorGifts10yr = 0,
): RecoveryStrategy[] {
  const hasSpouse     = members.some(m => m.relation === '배우자');
  const children      = members.filter(m => m.relation === '자녀');
  const daughterInLaw = members.filter(m => m.relation === '며느리' || m.relation === '사위');
  const urgency       = calcDonorUrgency(donorAge);
  const GROWTH_RATE   = 0.03;
  const yearsLeft     = urgency.lifeExpectancyYears;

  const realEstateValue = assets
    .filter(a => ['주거용부동산','상업용부동산','토지'].includes(a.asset_type))
    .reduce((s, a) => s + a.current_value, 0);

  const strategies: RecoveryStrategy[] = [];

  // ── 1. 배우자 공제 최적화 ────────────────────────────────────
  const withSpouseTax = (() => {
    const deduction = Math.min(30, Math.max(5, totalEstate * 0.4));
    const base = Math.max(0, totalEstate - 5 - deduction);
    const gross = calcProgressiveTax(base);
    return Math.max(0, gross * 0.97); // 신고세액공제
  })();
  strategies.push({
    id: 'spouse_deduction',
    title: '배우자 공제 최대화',
    category: '즉시',
    legalBasis: '상증법 §19',
    description: '배우자(할머니)가 실제 상속받는 금액에 따라 최소 5억~최대 30억 공제. 1차 상속에서 배우자에게 최대한 배분하고, 2차 상속(배우자→자녀) 시 다시 공제 활용.',
    taxSavingEstimate: Math.max(0, inheritanceTax - withSpouseTax),
    costEstimate: 0,
    netBenefit: Math.max(0, inheritanceTax - withSpouseTax),
    feasibility: hasSpouse ? 'high' : 'low',
    riskLevel: 'low',
    actionItems: [
      '상속 신고기한(6개월) 내 협의분할서 제출',
      '배우자 실제 상속분 결정 — 세무사와 최적 분할 비율 계산',
      '배우자가 상속받은 재산에 대한 등기이전 완료',
      '2차 상속 대비: 배우자 연령·건강 상태 고려해 2차 상속세도 미리 설계',
    ],
    risks: [
      '배우자가 상속재산을 실제 분할받지 못하면 30억 공제 불가 (5억으로 제한)',
      '배우자 고령 시 2차 상속도 곧 발생 → 2차 상속세 설계 필요',
      '신고기한 후 9개월 내 분할 완료 못 하면 최대 공제 불적용',
    ],
    isApplicable: hasSpouse,
    notApplicableReason: hasSpouse ? undefined : '배우자(할머니)가 없거나 이미 돌아가심',
    executionWeeks: 4,
    executionSteps: [
      { timing: '즉시', title: '상속 분할 비율 설계', description: '세무사와 배우자/자녀 최적 분할 비율 시뮬레이션. 배우자 30억 공제 최대화 기준으로 역산', actor: '세무사' },
      { timing: '사망 후 6개월 내', title: '협의분할서 작성·제출', description: '공동상속인 전원 협의 → 협의분할서 작성 → 상속세 신고 시 제출 (기한 초과 시 30억 공제 → 5억으로 축소)', actor: '법무사', estimatedCost: '약 50~100만원' },
      { timing: '사망 후 6개월 내', title: '배우자 명의 등기이전', description: '배우자가 실제 상속받은 부동산 소유권 이전 등기 완료', actor: '법무사', estimatedCost: '취득세 0% (배우자 상속)' },
      { timing: '이후', title: '2차 상속 설계', description: '배우자 사후 자녀에게의 2차 상속세도 미리 계산. 배우자 기대여명 고려해 최적 자산 구성 준비', actor: '세무사' },
    ],
  });

  // ── 2. 며느리/사위 즉시 증여 (5년 룩백) ─────────────────────
  const dilGiftAmt = Math.min(totalEstate * 0.1, 5); // 자산의 10% or 최대 5억
  const dilGiftTax = daughterInLaw.reduce((s, m) => s + calcGiftTax(dilGiftAmt / daughterInLaw.length, m.relation), 0);
  const dilSaving  = hasSpouse
    ? (donorAge < 80 ? dilGiftAmt * 0.5 : dilGiftAmt * 0.3)
    : (donorAge < 80 ? dilGiftAmt * 0.5 : dilGiftAmt * 0.25);
  strategies.push({
    id: 'dil_5yr_lookback',
    title: '며느리·사위 즉시 증여 (5년 룩백 탈출)',
    category: '즉시',
    legalBasis: '상증법 §13 ②항',
    description: '자녀는 10년 합산이지만 며느리·사위는 상속인이 아니므로 5년만 합산됩니다. 기대여명이 5년 이상이라면 지금 증여하면 상속 합산에서 제외될 가능성이 있습니다.',
    taxSavingEstimate: daughterInLaw.length > 0 ? dilSaving : 0,
    costEstimate: dilGiftTax,
    netBenefit: daughterInLaw.length > 0 ? Math.max(0, dilSaving - dilGiftTax) : 0,
    feasibility: (daughterInLaw.length > 0 && yearsLeft >= 5) ? 'medium' : 'low',
    riskLevel: 'medium',
    actionItems: [
      `며느리·사위에게 현금 또는 부동산 즉시 증여 (공제 1천만원)`,
      '증여 후 최소 5년 생존 시 상속 합산 제외',
      '증여세 신고·납부 (신고기한: 증여일이 속한 달의 말일부터 3개월)',
    ],
    risks: [
      `기대여명 ${yearsLeft.toFixed(0)}년 — 5년 이내 사망 시 상속 합산됨`,
      '며느리·사위 공제: 1천만원 (자녀 5천만원 대비 낮음) → 세율 높음',
      '향후 이혼 시 증여 재산 처리 문제',
    ],
    isApplicable: daughterInLaw.length > 0,
    notApplicableReason: daughterInLaw.length === 0 ? '며느리·사위 구성원 없음' : undefined,
    executionWeeks: 3,
    executionSteps: [
      { timing: '1주차', title: '증여 대상·금액 확정', description: '며느리/사위별 공제(1천만원) 고려, 최적 증여액 계산. 5년 룩백 탈출 기대 시 증여세 부담 대비 효과 확인', actor: '세무사' },
      { timing: '2주차', title: '증여계약서 작성', description: '현금이면 계좌이체 증빙, 부동산이면 감정평가 후 등기이전', actor: '본인+법무사' },
      { timing: '3주차~3개월', title: '증여세 신고·납부', description: '증여일 속한 달 말일부터 3개월 내 신고. 공제 1천만원 적용', actor: '세무사', estimatedCost: '증여세: 증여액에 따라 상이' },
    ],
  });

  // ── 3. 즉시 증여 (자산 성장분 절세) ─────────────────────────
  const growthFactor  = Math.pow(1 + GROWTH_RATE, Math.min(yearsLeft, 10)) - 1;
  const estGrowth     = totalEstate * growthFactor;
  const growthTaxSave = estGrowth * 0.50 * 0.97; // 성장분 × 최고세율 × 신고공제
  strategies.push({
    id: 'immediate_gift_growth',
    title: '즉시 증여 — 자산 성장분 상속세 제외',
    category: '즉시',
    legalBasis: '상증법 §13 ① (증여 당시 가액으로 합산)',
    description: `합산되어도 합산액은 "증여 당시 가액"입니다. 지금 이전한 자산이 ${yearsLeft.toFixed(0)}년간 성장하면 그 성장분은 상속세 과세 밖으로 나옵니다. 증여세는 기납부세액으로 상속세에서 공제되므로 이중과세가 아닙니다.`,
    taxSavingEstimate: growthTaxSave,
    costEstimate: 0, // 증여세는 어차피 상속세에서 공제
    netBenefit: growthTaxSave,
    feasibility: 'high',
    riskLevel: 'low',
    actionItems: [
      '수익률 낮고 성장 가능성 높은 자산부터 먼저 이전',
      '자녀에게 즉시 이전 — 성장분(연 3% × 7년 ≈ +23%)은 영구 비과세',
      '증여세 신고·납부 (산출세액은 향후 상속세에서 공제)',
      '부동산은 공시가·시가 낮을 때 이전이 유리',
    ],
    risks: [
      '10년 내 사망 시 증여 원금은 상속세 합산 (성장분만 절세)',
      '증여세 선납 → 일시적 현금 부담',
    ],
    isApplicable: true,
    executionWeeks: 8,
    executionSteps: [
      { timing: '1주차', title: '이전 자산 선정', description: '성장 가능성 높은 자산 우선 선정. 공시가 낮은 시점 활용. 현금·예금보다 부동산·주식 먼저', actor: '세무사' },
      { timing: '2~3주차', title: '증여 가액 감정평가 (부동산)', description: '공시가 기준 vs 시가 기준 비교 — 낮은 쪽으로 신고 가능. 증여세 최소화', actor: '감정평가사', estimatedCost: '약 200~500만원' },
      { timing: '4주차', title: '증여계약서·이전 등기', description: '부동산 소유권 이전 등기. 취득세 납부 (수증자 부담)', actor: '법무사', estimatedCost: '취득세 = 시가 × 3.5%' },
      { timing: '3개월 내', title: '증여세 신고·납부', description: '기한 내 신고 필수 (가산세 방지). 납부세액은 향후 상속세에서 기납부세액으로 공제됨', actor: '세무사' },
    ],
  });

  // ── 4. 법인 전환 ─────────────────────────────────────────────
  const acquisitionTaxSave = 0; // 취득세 감면은 자산·사업·시점별 적용 요건 확인 전 자동 반영 금지
  const corpTaxAdvantage   = realEstateValue > 0
    ? (realEstateValue * 0.05) * (0.50 - 0.20) // 임대수익 × (상속세율 - 법인세율)
    : 0;
  strategies.push({
    id: 'corp_conversion',
    title: '법인 전환 (부동산 → 임대법인)',
    category: '단기',
    legalBasis: '조특법 §32 (이월과세 가능 여부), 지방세 감면은 개별 요건 검토',
    description: '부동산을 법인에 현물출자하는 구조입니다. 양도세 이월과세와 지방세 감면은 자산·사업·시점별 요건을 충족하는지 확인한 경우에만 반영해야 합니다. 비상장주식 평가, 배당세, 법인 유지비용도 함께 검토합니다.',
    taxSavingEstimate: acquisitionTaxSave + corpTaxAdvantage,
    costEstimate: realEstateValue * 0.04, // 감면 미적용 보수 추정
    netBenefit: acquisitionTaxSave,
    feasibility: realEstateValue > 0 ? 'medium' : 'low',
    riskLevel: 'medium',
    actionItems: [
      '감정평가를 통한 현물출자가액 산정',
      '법인 설립 → 현물출자 등기',
      '취득세·등록면허세와 적용 가능한 지방세 감면을 세무사에게 개별 확인',
      '대표이사 급여 설정 — 법인 비용처리로 법인세 절감',
      '비상장주식 가치 평가 방법 사전 검토 (순자산가치 기준)',
    ],
    risks: [
      '법인전환 후 5년 내 해산·매각 시 이월과세 추징',
      '부동산과다보유법인: 상속 시 비상장주식을 순자산가치로 평가 (할인 어려움)',
      '취득세, 등록면허세 등 전환 비용 발생',
      '85세 고령자 법인 운영의 실무적 어려움',
    ],
    isApplicable: realEstateValue > 0,
    notApplicableReason: realEstateValue === 0 ? '부동산 자산 없음' : undefined,
    executionWeeks: 12,
    executionSteps: [
      { timing: '1~2주차', title: '사전 타당성 검토', description: '취득세 감면 적용 가능 여부 확인 (부동산임대업 최근 판례 강화). 이월과세 5년 의무 보유 확인', actor: '세무사' },
      { timing: '2~3주차', title: '부동산 감정평가', description: '현물출자 자산가액 산정. 이게 법인 자본금이 됨', actor: '감정평가사', estimatedCost: '약 300~800만원' },
      { timing: '3~4주차', title: '법인 설립 등기', description: '정관 작성 → 자본금 납입 → 설립등기. 자녀를 공동대표 또는 이사로 등재 권장 (고령자 운영 대비)', actor: '법무사', estimatedCost: '약 100~200만원' },
      { timing: '4~8주차', title: '현물출자 이전 등기', description: '부동산 소유권 개인→법인 이전. 취득세와 적용 가능한 감면을 개별 확인', actor: '법무사', estimatedCost: '취득세 부동산가 × 4% 보수 추정 (감면 미반영)' },
      { timing: '이전 등기 후', title: '지방세 적용 요건 확인', description: '자산 유형·사업 실체·실행 시점에 따른 감면 가능 여부를 세무사에게 확인', actor: '세무사' },
      { timing: '법인 운영 시작', title: '대표이사 급여·배당 설계', description: '급여(손금처리)+배당(2천만원까지 15.4%) 조합으로 매년 절세. 과다 급여 주의(동종업계 3배 이내)', actor: '세무사' },
    ],
  });

  // ── 5. 공익법인 출연 ─────────────────────────────────────────
  const charityAmt     = totalEstate * 0.1;  // 자산의 10% 출연 가정
  const charityTaxSave = charityAmt * 0.50 * 0.97;
  strategies.push({
    id: 'charity_foundation',
    title: '공익법인(재단) 출연',
    category: '단기',
    legalBasis: '상증법 §16 (공익법인 출연 과세가액 불산입)',
    description: '공익법인 출연재산은 법정 요건을 충족하면 상속세 과세가액 불산입을 검토할 수 있습니다. 출연재산은 공익목적에 사용해야 하며 상속인의 사적 재산 이전 수단으로 사용할 수 없습니다.',
    taxSavingEstimate: charityTaxSave,
    costEstimate: 0,
    netBenefit: charityTaxSave,
    feasibility: 'medium',
    riskLevel: 'medium',
    actionItems: [
      '공익법인 설립 허가 신청 (관할 행정청)',
      '상속세 신고기한 내 재산 출연 완료',
      '출연 재산의 법정 기한 내 공익목적 사용 및 연간 사용 의무 이행',
      '가족 이사 선임 (단, 특수관계인 이사 비율 제한)',
    ],
    risks: [
      '출연 재산을 상속인에게 귀속하면 상속세 추징',
      '공익목적 사용·연간 사용·사후관리 의무 — 자산 사적 사용 불가',
      '공익법인 운영 관련 행정 부담 및 외부 감사 의무',
      '실질적인 가족 재산 통제력 약화',
    ],
    isApplicable: true,
    executionWeeks: 16,
    executionSteps: [
      { timing: '1~2주차', title: '공익법인 목적 결정', description: '장학사업, 복지사업, 문화사업 중 실질적으로 수행할 공익목적과 운영 의무 검토', actor: '세무사+법무사' },
      { timing: '2~8주차', title: '주무관청 설립허가 신청', description: '관할 행정청(교육부/복지부 등)에 신청. 심사 기간 약 2~3개월', actor: '법무사', estimatedCost: '약 500~1,000만원 (설립비용)' },
      { timing: '허가 후', title: '재단법인 설립 등기', description: '허가 취득 후 법원 등기소에 설립 등기', actor: '법무사' },
      { timing: '상속세 신고 기한 내', title: '재산 출연·이전', description: '상속세 신고기한(사망 후 6개월) 내 출연 완료해야 과세가액 불산입 인정', actor: '세무사+법무사' },
      { timing: '이후 매년', title: '공익목적 사용 이행', description: '법정 기한 내 직접 공익목적 사용과 연간 사용 의무를 이행합니다. 이사회 운영, 결산 공시, 국세청 보고서 제출 요건을 함께 확인합니다.', actor: '본인(이사진)' },
    ],
  });

  // ── 6. 연부연납 (납부 충격 분산) ─────────────────────────────
  strategies.push({
    id: 'installment',
    title: '연부연납 10년 — 납부 충격 분산',
    category: '즉시',
    legalBasis: '상증법 §71 (연부연납 허가)',
    description: `상속세 ${inheritanceTax.toFixed(1)}억을 10년에 걸쳐 분할납부. 연간 ${(inheritanceTax / 10).toFixed(2)}억씩 납부하면 자산 강제 매각 없이 현금흐름으로 해결 가능합니다.`,
    taxSavingEstimate: 0,
    costEstimate: inheritanceTax * 0.03 * 5, // 이자 가산 (대략)
    netBenefit: 0, // 절세는 아니지만 유동성 확보
    feasibility: 'high',
    riskLevel: 'low',
    actionItems: [
      '상속세 신고 시 연부연납 신청서 제출',
      '담보 제공 (부동산·유가증권 등)',
      `연간 납부액 ${(inheritanceTax / 10).toFixed(2)}억 재원 마련 계획 수립`,
      '변동금리 대출 있는 경우 금리 리스크 헤지 검토',
    ],
    risks: [
      '이자 가산금 부담 (기준금리 + 가산율)',
      '담보 제공 자산 처분 시 연부연납 취소 위험',
    ],
    isApplicable: inheritanceTax > 0.2,
    executionWeeks: 2,
    executionSteps: [
      { timing: '사망 후 신고 시', title: '연부연납 신청서 제출', description: '상속세 신고서와 함께 연부연납 신청. 세무서 허가 필요', actor: '세무사' },
      { timing: '신청 후 1~2주', title: '담보 제공', description: '부동산·유가증권 등 담보 설정. 담보가액 ≥ 연부연납 세액', actor: '법무사', estimatedCost: '담보 설정 비용 약 50만원' },
      { timing: '허가 후 매년', title: '분할 납부 실행', description: '1/11씩 매년 납부. 이자 가산금 = 납부일 현재 이자율 적용. 담보 자산 처분 시 즉시 전액 납부 의무', actor: '본인' },
    ],
  });

  // ── 7. 생명보험 납부 재원 ─────────────────────────────────────
  strategies.push({
    id: 'life_insurance',
    title: '생명보험 — 상속세 납부 재원 확보',
    category: '즉시',
    legalBasis: '상증법 §8 (보험금 상속재산 포함, 비과세 한도 內)',
    description: `사망보험금을 수익자(자녀)가 받아 상속세 ${inheritanceTax.toFixed(1)}억 납부에 사용. 현금 없는 경우 부동산 강제 매각을 방지하는 마지막 안전망입니다. 85세 고령이라 가입 가능 여부·보험료 수준 확인 필요.`,
    taxSavingEstimate: 0, // 절세가 아닌 납부 재원 마련
    costEstimate: 0,
    netBenefit: 0,
    feasibility: donorAge <= 80 ? 'medium' : 'low',
    riskLevel: 'low',
    actionItems: [
      '종신보험 가입 가능 여부 확인 (건강 고지)',
      '보험금 수익자 = 자녀(상속세 납부자)로 지정',
      '보험료 vs 예상 상속세 납부 부담 비교',
      '기존 가입 보험 수익자 확인 및 변경',
    ],
    risks: [
      '85세 이상 종신보험 가입 거절 또는 고액 보험료',
      '사망보험금도 상속재산에 포함 (다만 법정상속인 × 500만원 비과세)',
    ],
    isApplicable: true,
    executionWeeks: 2,
    executionSteps: [
      { timing: '즉시', title: '보험사 가입 가능 여부 확인', description: '85세 이상 종신보험 언더라이팅. 건강 고지 필수. 가입 거절 가능성 높음 — 여러 보험사 동시 문의 권장', actor: '본인' },
      { timing: '가입 결정 후', title: '종신보험 가입', description: '보험금 수익자 = 자녀(상속세 납부자)로 지정. 보험금액 = 예상 상속세 이상으로 설정', actor: '본인', estimatedCost: '월 보험료: 고령일수록 고액' },
      { timing: '기존 보험 확인', title: '기존 보험 수익자 변경', description: '이미 가입된 보험의 수익자를 자녀로 변경. 사망보험금 법정상속인 × 500만원 비과세 한도 활용', actor: '본인' },
    ],
  });

  // ── 8. 가족 차용증 ────────────────────────────────────────────
  const maxLoanNoTax = 1.0 / 0.046; // 이자차액 1천만원 미만 = 2.17억
  strategies.push({
    id: 'family_loan',
    title: '가족 차용증 — 자녀에게 자금 이전',
    category: '즉시',
    legalBasis: '상증법 §41의4, 시행령 §31의4 (적정이자율 4.6%)',
    description: `자녀에게 2.17억 이하로 무이자 차용하면 이자차액이 연 1천만원 미만으로 증여세 없이 자금 이전 가능. 차용증 작성·이자 지급 이행 시 증여로 보지 않습니다.`,
    taxSavingEstimate: maxLoanNoTax * 0.10, // 차용 원금에 대한 증여세 절감
    costEstimate: 0,
    netBenefit: maxLoanNoTax * 0.10,
    feasibility: 'high',
    riskLevel: 'low',
    actionItems: [
      '공증 차용증 작성 (원금·이자율·상환기간 명기)',
      '4.6% 이자 계좌 이체 증빙 보관 (또는 2.17억 이하 무이자)',
      '원금 상환 계획 수립',
    ],
    risks: [
      '이자 미지급 또는 형식적 차용 시 전액 증여로 과세',
      '원금 미상환 시 증여로 추징',
    ],
    isApplicable: children.length > 0,
    executionWeeks: 1,
    executionSteps: [
      { timing: '즉시', title: '공증 차용증 작성', description: '원금·이자율(4.6%)·상환기간·상환방법 명시. 법무사 공증 받아야 증여 추정 방어 가능', actor: '법무사', estimatedCost: '공증 비용 약 10~30만원' },
      { timing: '즉시', title: '계좌이체 실행', description: '차용금액 계좌이체 (반드시 이체 기록 보관). 2.17억 이하 무이자 가능, 초과분은 4.6% 이자 지급', actor: '본인' },
      { timing: '매년', title: '이자 지급 실행', description: '4.6% 이자를 계좌이체로 지급 (증빙 보관). 미지급 시 전액 증여로 과세. 차용인(자녀)이 이자소득세 신고', actor: '본인' },
    ],
  });

  // 우선순위 정렬: 순편익 높은 순
  return strategies.sort((a, b) => b.netBenefit - a.netBenefit);
}

// ── 자산별 현금흐름 상세 & 납부 재원 분석 ──────────────────────

export interface AssetCashflowDetail {
  assetId: string;
  assetName: string;
  assetType: string;
  currentValue: number;
  loanAmount: number;
  loanRatePct: number;
  isLoanVariable: boolean;
  annualRevenue: number;     // 연수익 (억)
  annualInterest: number;    // 연 대출이자 (억)
  annualHoldingTax: number;  // 보유세 (억)
  annualRentalTax: number;   // 임대소득세 (억, 안분)
  netCashflow: number;       // 순현금흐름 (억)
  ltv: number;               // %
  dscr: number;              // 이자보상배율
}

export interface RecoveryPlanAnalysis {
  assetDetails: AssetCashflowDetail[];
  totalValue: number;
  totalLoan: number;
  totalRevenue: number;
  totalInterest: number;
  totalHoldingTax: number;
  totalRentalTax: number;
  totalNetCashflow: number;
  overallLTV: number;
  overallDSCR: number;
  // 상속세 납부 재원 분석
  inheritanceTax: number;
  installment10yr: number;       // 연부연납 10년 시 연간 납부액
  installment5yr: number;        // 연부연납 5년 시 연간 납부액
  canPayBy10yr: boolean;
  surplusAfter10yr: number;      // 납부 후 잔여 현금흐름 (양수 = 여유, 음수 = 부족)
  yearsToPayOff: number;         // 순현금흐름으로 전액 납부 시 소요 연수
  physicalPaymentPossible: boolean;   // 물납 가능 여부
  realEstateRatio: number;       // 부동산 비율 %
  recommendedMethod: 'immediate' | 'installment10' | 'installment5' | 'physical' | 'sell';
  recommendedReason: string;
}

export function calcRecoveryPlan(
  assets: Asset[],
  inheritanceTax: number,
  rateShock = 0,
): RecoveryPlanAnalysis {
  // 1. 전체 임대수익 합산 → 임대소득세 계산 후 자산별 안분
  const totalRevenue = assets.reduce(
    (s, a) => s + a.current_value * a.annual_yield_pct / 100, 0);
  const totalRentalTax = calcRentalIncomeTax(totalRevenue);

  // 2. 자산별 상세 계산
  const assetDetails: AssetCashflowDetail[] = assets.map(a => {
    const annualRevenue  = a.current_value * a.annual_yield_pct / 100;
    const effectiveRate  = a.loan_type === 'variable'
      ? (a.loan_rate_pct + rateShock) / 100
      : a.loan_rate_pct / 100;
    const annualInterest = a.loan_amount * effectiveRate;
    const annualHoldingTax = calcAnnualPropertyTaxForAsset(a).total;
    // 임대소득세 안분 (수익 비율)
    const annualRentalTax = totalRevenue > 0
      ? totalRentalTax * (annualRevenue / totalRevenue)
      : 0;
    const netCashflow = annualRevenue - annualInterest - annualHoldingTax - annualRentalTax;
    const ltv  = a.current_value > 0 ? (a.loan_amount / a.current_value) * 100 : 0;
    const dscr = annualInterest > 0 ? annualRevenue / annualInterest : 99;

    return {
      assetId: a.id,
      assetName: a.name,
      assetType: a.asset_type,
      currentValue: a.current_value,
      loanAmount: a.loan_amount,
      loanRatePct: a.loan_rate_pct,
      isLoanVariable: a.loan_type === 'variable',
      annualRevenue,
      annualInterest,
      annualHoldingTax,
      annualRentalTax,
      netCashflow,
      ltv,
      dscr,
    };
  });

  // 3. 합계
  const totalLoan        = assetDetails.reduce((s, d) => s + d.loanAmount, 0);
  const totalInterest    = assetDetails.reduce((s, d) => s + d.annualInterest, 0);
  const totalHoldingTax  = calcAnnualHoldingTaxes(assets).total;
  const assetOnlyHoldingTax = assetDetails.reduce((s, d) => s + d.annualHoldingTax, 0);
  const portfolioTaxAdjustment = totalHoldingTax - assetOnlyHoldingTax;
  if (assetDetails.length > 0 && Math.abs(portfolioTaxAdjustment) > 1e-9) {
    assetDetails[0].annualHoldingTax += portfolioTaxAdjustment;
    assetDetails[0].netCashflow -= portfolioTaxAdjustment;
  }
  const totalNetCashflow = assetDetails.reduce((s, d) => s + d.netCashflow, 0);
  const totalValue       = assetDetails.reduce((s, d) => s + d.currentValue, 0);
  const overallLTV       = totalValue > 0 ? (totalLoan / totalValue) * 100 : 0;
  const overallDSCR      = totalInterest > 0 ? totalRevenue / totalInterest : 99;

  // 4. 납부 재원 분석
  const installment10yr = inheritanceTax / 10;
  const installment5yr  = inheritanceTax / 5;
  const canPayBy10yr    = totalNetCashflow >= installment10yr;
  const surplusAfter10yr = totalNetCashflow - installment10yr;
  const yearsToPayOff   = totalNetCashflow > 0
    ? Math.ceil(inheritanceTax / totalNetCashflow) : 999;

  // 5. 물납 가능 여부 (부동산 50% 초과 + 세금 2천만원 초과)
  const realEstateValue  = assets
    .filter(a => ['주거용부동산','상업용부동산','토지'].includes(a.asset_type))
    .reduce((s, a) => s + a.current_value, 0);
  const realEstateRatio  = totalValue > 0 ? (realEstateValue / totalValue) * 100 : 0;
  const physicalPaymentPossible = realEstateRatio > 50 && inheritanceTax > 0.2;

  // 6. 권장 납부 방법
  let recommendedMethod: RecoveryPlanAnalysis['recommendedMethod'];
  let recommendedReason: string;

  if (inheritanceTax === 0) {
    recommendedMethod = 'immediate';
    recommendedReason = '상속세 없음 — 즉시 납부';
  } else if (canPayBy10yr) {
    recommendedMethod = 'installment10';
    recommendedReason = `연부연납 10년 신청 — 연 ${(installment10yr * 100).toFixed(0)}백만원씩, 순현금흐름(${(totalNetCashflow * 100).toFixed(0)}백만원/년)으로 충분히 납부 가능`;
  } else if (totalNetCashflow >= installment5yr) {
    recommendedMethod = 'installment5';
    recommendedReason = `연부연납 5년 신청 — 연 ${(installment5yr * 100).toFixed(0)}백만원씩`;
  } else if (physicalPaymentPossible) {
    recommendedMethod = 'physical';
    recommendedReason = '현금흐름 부족 — 부동산 물납 검토 (부동산 비율 50% 초과, 상증법§73)';
  } else {
    recommendedMethod = 'sell';
    recommendedReason = '현금흐름 부족 — 수익률 낮은 자산 일부 매각 후 납부 고려';
  }

  return {
    assetDetails,
    totalValue, totalLoan, totalRevenue, totalInterest,
    totalHoldingTax, totalRentalTax, totalNetCashflow,
    overallLTV, overallDSCR,
    inheritanceTax,
    installment10yr, installment5yr,
    canPayBy10yr, surplusAfter10yr, yearsToPayOff,
    physicalPaymentPossible, realEstateRatio,
    recommendedMethod, recommendedReason,
  };
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
  interestGap: number;       // max(0, 적정이자 - 실제이자): 미달분 (증여 간주 기준)
  interestDiff: number;      // 실제이자 - 적정이자: +초과 / -미달 (부호 있음)
  isOverpaying: boolean;     // 실제이자율 > 적정이자율
  isGiftTaxable: boolean;
  annualGiftTax: number;
  maxZeroRatePrincipal: number;
  riskLevel: 'safe' | 'caution' | 'danger';
  recommendation: string;
} {
  const actualRate     = actualRatePct / 100;
  const fairInterest   = principal * FAIR_LOAN_RATE;
  const actualInterest = principal * actualRate;
  const interestDiff   = actualInterest - fairInterest;          // +초과, -미달
  const interestGap    = Math.max(0, fairInterest - actualInterest); // 미달분만 (증여세 산정)
  const isOverpaying   = actualRate > FAIR_LOAN_RATE;
  const isGiftTaxable  = interestGap > LOAN_GIFT_THRESHOLD;
  const annualGiftTax  = isGiftTaxable
    ? calcGiftTax(interestGap, relation, priorGifts)
    : 0;
  const maxZeroRatePrincipal = LOAN_GIFT_THRESHOLD / FAIR_LOAN_RATE; // ≈ 2.17억

  const riskLevel: 'safe' | 'caution' | 'danger' =
    !isGiftTaxable ? 'safe' : interestGap < 0.5 ? 'caution' : 'danger';

  let recommendation: string;
  if (isOverpaying) {
    const overAmt = (interestDiff * 1000).toFixed(0);
    recommendation = `실제이자(${actualRatePct}%)가 적정이자율(4.6%) 초과 — 연 ${overAmt}만원 과납. 대여자는 이자소득세 신고 필요. 증여세 없음.`;
  } else if (actualRate === 0 && principal <= maxZeroRatePrincipal) {
    recommendation = `무이자 가능 — 원금 ${(maxZeroRatePrincipal * 100).toFixed(0)}백만원 이하 시 이자 미달액 1천만원 미만으로 증여세 비과세`;
  } else if (!isGiftTaxable) {
    recommendation = `이자 미달액 ${(interestGap * 1000).toFixed(0)}만원 — 1천만원 미만 비과세 유지`;
  } else {
    recommendation = `이자 미달액 ${(interestGap * 1000).toFixed(0)}만원 → 연 증여세 ${(annualGiftTax * 1000).toFixed(0)}만원 발생. 이자율 ${((LOAN_GIFT_THRESHOLD / principal) * 100).toFixed(2)}% 이상 조정 권장`;
  }

  return { fairInterest, actualInterest, interestGap, interestDiff, isOverpaying, isGiftTaxable, annualGiftTax, maxZeroRatePrincipal, riskLevel, recommendation };
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

  // 현물출자 취득세: 감면 적용 여부를 자동 가정하지 않는 보수 추정
  const reValue = assets
    .filter(a => ['주거용부동산', '상업용부동산', '토지'].includes(a.asset_type))
    .reduce((s, a) => s + a.current_value, 0);
  const transferTax = reValue * 0.04;
  const paybackYears = annualSaving > 0 ? Math.ceil(transferTax / annualSaving) : 999;

  const notes = [
    `현물출자 양도소득세 이월과세 (조특법§32) — 법인 양도 시점에 납부`,
    `취득세는 4% 보수 추정. 지방세 감면은 자산·사업·시점별 적용 요건을 별도 확인`,
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
  currentGiftValue: number;     // 현재 시점 가치 (억) — 지분 × 현재가
  annualGrowthRate: number;     // 성장률 % (연간)
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
  userPriorGifts?: Record<string, number>,  // recipientId → 억 (기수증액)
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
    return getAssetGrowthRate(asset, macro ?? null);
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
    projectedAssetValue?: number,  // asset value at time of transfer (for future-dated gifts)
  ): StrategyAction {
    const baseValue = projectedAssetValue ?? asset.current_value;
    const giftValue = baseValue * (transferPct / 100);
    const currentGiftValue = asset.current_value * (transferPct / 100);
    const annualGrowthRate = getGrowthRate(asset) * 100;
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
      currentGiftValue,
      annualGrowthRate,
    };
  }

  // ── 전략 1: 즉시 분산 증여 (공제 최대화) ──────────────────
  function buildStrategy1(): FamilyDistributionStrategy {
    const actions: StrategyAction[] = [];
    // 수증자별 잔여 공제 추적
    const priorGiftsMap: Record<string, number> = {};
    for (const r of sortedRecipients) {
      priorGiftsMap[r.id] = userPriorGifts?.[r.id] ?? 0;
    }
    const remainingDeduction: Record<string, number> = {};
    for (const r of sortedRecipients) {
      const ded = GIFT_DEDUCTIONS[r.relation] ?? 0.1;
      remainingDeduction[r.id] = Math.max(0, ded - (priorGiftsMap[r.id]));
    }

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

    // ── 사이클 1 (Year 0): 전체 자산에 걸쳐 공제 한도까지 배분 ──
    // 수증자별 priorGifts (기수증액 포함) & 잔여 공제 추적
    const prior1: Record<string, number> = {};
    const dedRemain1: Record<string, number> = {};
    for (const r of sortedRecipients) {
      prior1[r.id] = userPriorGifts?.[r.id] ?? 0;
      const ded = GIFT_DEDUCTIONS[r.relation] ?? 0.1;
      dedRemain1[r.id] = Math.max(0, ded - prior1[r.id]);
    }

    // 각 자산의 잔여 가치 (cycle1 처리 후 cycle2로 넘길 분)
    const assetRem1: Record<string, number> = {};
    for (const asset of selectedAssets) assetRem1[asset.id] = asset.current_value;

    // Pass 1: 공제 한도까지 (수증자 순서대로, 자산 순서대로)
    for (const recip of sortedRecipients) {
      for (const asset of selectedAssets) {
        if (dedRemain1[recip.id] <= 0.0001) break;
        const avail = assetRem1[asset.id];
        if (avail <= 0.0001) continue;
        const giveAmt = Math.min(avail, dedRemain1[recip.id]);
        const pct = (giveAmt / asset.current_value) * 100;
        actions.push(buildAction(asset, recip, pct, 0, prior1[recip.id]));
        prior1[recip.id] += giveAmt;
        assetRem1[asset.id] -= giveAmt;
        dedRemain1[recip.id] -= giveAmt;
      }
    }

    // ── 사이클 2 (Year 10): 잔여분을 10년 후 가치로, 공제 리셋 ──
    const prior2: Record<string, number> = {};
    const dedRemain2: Record<string, number> = {};
    for (const r of sortedRecipients) {
      prior2[r.id] = 0; // 10년 경과 → 공제 사이클 리셋
      dedRemain2[r.id] = GIFT_DEDUCTIONS[r.relation] ?? 0.1;
    }

    for (const asset of selectedAssets) {
      const rem = assetRem1[asset.id];
      if (rem <= 0.0001) continue;

      const projVal10 = asset.current_value * Math.pow(1 + getGrowthRate(asset), 10);
      // 잔여 비율이 10년 후 얼마인지 (현재 가치 비율 × 10년 후 자산가)
      const projRem = projVal10 * (rem / asset.current_value);
      let projLeft = projRem;

      // 공제 한도까지 무세 배분 (cycle 2, 수증자별)
      for (const recip of sortedRecipients) {
        if (projLeft <= 0.0001) break;
        if (dedRemain2[recip.id] <= 0.0001) continue;
        const giveAmt = Math.min(projLeft, dedRemain2[recip.id]);
        const pct = (giveAmt / projVal10) * 100;
        actions.push(buildAction(asset, recip, pct, 10, prior2[recip.id], projVal10));
        prior2[recip.id] += giveAmt;
        dedRemain2[recip.id] -= giveAmt;
        projLeft -= giveAmt;
      }

      // 초과분(과세): 공제 한도 큰 수증자에게 집중
      if (projLeft > 0.0001) {
        const recip = sortedRecipients[0];
        const pct = (projLeft / projVal10) * 100;
        actions.push(buildAction(asset, recip, pct, 10, prior2[recip.id], projVal10));
        prior2[recip.id] += projLeft;
      }
    }

    const totalGiftTax = actions.reduce((s, a) => s + a.giftTax, 0);
    const cgtImmediate = actions.reduce((s, a) => s + a.cgtIfImmediateSale, 0);
    const cgt5yr = actions.reduce((s, a) => s + a.cgtIf5yrHoldSale, 0);

    return {
      id: 'strategy2',
      label: '10년 분할 증여',
      tagline: '공제 2사이클 활용 — 세금 최소화, 시간 분산',
      actions,
      totalGiftTax,
      cgtSellImmediately: totalGiftTax + cgtImmediate,
      cgtSellAfter5yr: totalGiftTax + cgt5yr,
      inheritanceAlt: inheritanceTax10yr,
      netToFamilyGiftHold: projectedValue10yr - totalGiftTax - cgt5yr,
      netToFamilyInherit: projectedValue10yr - inheritanceTax10yr,
      pros: [
        '2회 공제 사이클 활용으로 증여세 최소화',
        '10년 후 자산 성장분까지 포함한 증여 계획',
        '공제 한도 내 무세 이전 극대화',
      ],
      cons: [
        '10년이라는 긴 시간 소요 — 증여자 건강 리스크',
        '10년 후 자산 가치 상승으로 세금 예측 어려움',
        '사이클 2 시점에 자산가 상승 → 증여세 증가 가능',
      ],
      keyRules: [
        '상증법§53: 10년 합산 공제 리셋 (동일인→수증자)',
        '소득세법§97의2: 5년 이내 매각 시 원취득가 양도세',
        '자산 성장률 반영: 10년 후 이전가치는 현재보다 높음',
      ],
      isRecommended: false,
    };
  }

  // ── 전략 3: 증여 + 5년 보유 매각 전략 ────────────────────
  function buildStrategy3(): FamilyDistributionStrategy {
    // 전략 1과 동일한 배분, 핵심 메시지가 5년 보유
    const actions: StrategyAction[] = [];
    const priorGiftsMap: Record<string, number> = {};
    for (const r of sortedRecipients) {
      priorGiftsMap[r.id] = userPriorGifts?.[r.id] ?? 0;
    }
    const remainingDeduction: Record<string, number> = {};
    for (const r of sortedRecipients) {
      const ded = GIFT_DEDUCTIONS[r.relation] ?? 0.1;
      remainingDeduction[r.id] = Math.max(0, ded - (priorGiftsMap[r.id]));
    }

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
      tagline: '지금 증여 후 5년 보유 → 이월과세 탈출 후 매각 (5년 후 예상 가치 반영)',
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
        '5년 보유 기간 동안 자산 성장분도 수증자가 누림',
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

// ── 단계별 유동성 기반 증여 플랜 ─────────────────────────────
// 수증자별 현금 납부 능력·10년 공제 사이클 상태를 고려한 현실적 실행 계획

// 내부: 최대 증여 가능 금액 (증여세 ≤ 현금한도)
function findMaxAffordableGift(
  cashLimit: number,    // 사용 가능 현금 (억)
  relation: string,
  priorGifts: number,   // 기수증액
): number {
  if (cashLimit < 0) cashLimit = 0;
  // 이진 탐색: calcGiftTax(X) ≤ cashLimit 인 최대 X
  let lo = 0, hi = 500;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const isSkip = relation === '손자녀';
    if (calcGiftTax(mid, relation, priorGifts, isSkip) <= cashLimit) lo = mid;
    else hi = mid;
  }
  return lo;
}

// 내부: 현재 소득으로 세금 납부까지 몇 년?
function yearsToSaveForTax(
  giftTax: number,
  currentCash: number,
  annualIncome: number,
  savingsRate = 0.30,   // 소득의 30% 저축 가정
): number {
  const usableCash = currentCash * 0.9; // 생활비 10% 여유
  const shortfall  = giftTax - usableCash;
  if (shortfall <= 0) return 0;
  const annualSavings = annualIncome * savingsRate;
  if (annualSavings <= 0) return 99;
  return Math.ceil(shortfall / annualSavings);
}

export interface PhaseRecipient {
  memberId: string;
  memberName: string;
  relation: string;
  deductionLimit: number;     // 10년 공제 한도 (억)
  priorGifts: number;         // 기수증액 (억)
  deductionRemaining: number; // 잔여 공제 (억)
  cashHold: number;           // 현재 현금 보유 (억)
  annualIncome: number;       // 연 소득 (억)
  targetAmount: number;       // 이번 단계 배분 목표액 (억)
  actualAmount: number;       // 실제 이번 단계 증여액 (억)
  giftTax: number;            // 이번 단계 증여세 (억)
  canAffordNow: boolean;      // 현재 현금으로 납부 가능
  cashAfterTax: number;       // 세금 납부 후 잔여 현금 (억)
  yearsToSave: number;        // 세금 납부까지 몇 년 필요 (0=즉시 가능)
  isBlocked: boolean;         // 이번 단계 참여 불가 (공제 소진)
  blockReason?: string;       // 불가 사유
  deferredToPhase?: number;   // 몇 단계로 이연되는지
}

export interface GiftPhase {
  phaseNum: number;
  yearOffset: number;   // 몇 년 후 실행
  label: string;        // "1단계 (지금)", "2단계 (3년 후)" 등
  trigger: string;      // 이 단계를 실행하는 조건
  recipients: PhaseRecipient[];
  totalAmount: number;  // 총 증여액
  totalTax: number;     // 총 증여세
  blocked: PhaseRecipient[];  // 이 단계에서 못 받는 수증자
}

export interface PhasedGiftPlan {
  totalToDistribute: number;   // 총 배분 목표 (억)
  phases: GiftPhase[];
  unallocated: number;          // 모든 단계 후 잔여 (상속 대기)
  inheritanceFallback: number;  // 잔여분 상속 시 예상 세금 (억)
  totalGiftTax: number;
  keyInsights: string[];        // 핵심 조언 (아빠 공제 상황 등)
}

export function generatePhasedGiftPlan(
  totalToDistribute: number,
  recipients: FamilyMember[],
  priorGiftsMap: Record<string, number>,  // memberId → 기수증액 (억)
  allMembers: FamilyMember[],
  macro?: MacroSettings | null,
): PhasedGiftPlan {
  if (recipients.length === 0 || totalToDistribute <= 0) {
    return {
      totalToDistribute, phases: [],
      unallocated: totalToDistribute, inheritanceFallback: 0,
      totalGiftTax: 0, keyInsights: [],
    };
  }

  // 수증자별 공제 상태 파악
  const recipientData = recipients.map(m => {
    const ded   = GIFT_DEDUCTIONS[m.relation] ?? 0.1;
    const prior = priorGiftsMap[m.id] ?? 0;
    const dedRemaining = Math.max(0, ded - prior);
    const isBlocked    = prior >= ded && prior > 0;
    return { m, ded, prior, dedRemaining, isBlocked };
  });

  // 공제 기반 최적 배분 목표 계산 (손자녀 세대생략 비효율 고려)
  // 1. 공제 잔여분이 큰 순서로 무세 배분 (배우자→자녀→부모→기타 순)
  // 2. 초과분은 손자녀 제외하고 효율적 수증자에게 배분 (세대생략 30% 할증 회피)
  // 3. 그래도 남으면 전체 균등
  const computeTargetMap = (): Record<string, number> => {
    const tgt: Record<string, number> = {};
    for (const { m } of recipientData) tgt[m.id] = 0;
    let rem = totalToDistribute;

    // Step 1: 공제 잔여분부터 채우기 (효율 큰 순)
    const sortedByDed = [...recipientData].sort(
      (a, b) => (b.ded - b.prior) - (a.ded - a.prior)
    );
    for (const { m, ded, prior } of sortedByDed) {
      if (rem <= 0.001) break;
      const dedRem = Math.max(0, ded - prior);
      const give   = Math.min(dedRem, rem);
      tgt[m.id]   += give;
      rem          -= give;
    }

    // Step 2: 과세분 잔여 — 손자녀 제외 (세대생략 30% 할증 비효율)
    if (rem > 0.001) {
      const efficient = sortedByDed.filter(r => r.m.relation !== '손자녀');
      if (efficient.length > 0) {
        const share = rem / efficient.length;
        for (const { m } of efficient) { tgt[m.id] += share; rem -= share; }
      }
    }

    // Step 3: 아직 남으면 전체 균등 (모두 손자녀여도 처리)
    if (rem > 0.001) {
      const share = rem / recipients.length;
      for (const { m } of recipientData) tgt[m.id] += share;
    }

    return tgt;
  };
  const targetMap = computeTargetMap();
  // (하위 호환용) 1인당 평균 — insight 메시지에만 사용
  const activeCount = recipientData.filter(r => !r.isBlocked).length || recipients.length;
  void activeCount;

  let remaining = totalToDistribute;
  const phases: GiftPhase[] = [];
  const keyInsights: string[] = [];
  let totalGiftTax = 0;

  // ── Phase 1: 지금 — 전체 목표액 즉시 증여 (대출 필요 시 표시) ─
  // 원칙: 자산가치 상승 전에 빨리 증여하는 게 유리.
  //       현금이 부족해도 Phase 3(10년)으로 미루지 않고,
  //       즉시 가능한 만큼 증여 + 나머지는 Phase 2(단기 저축/대출)로 처리.
  {
    const phaseRecips: PhaseRecipient[] = [];
    const blockedRecips: PhaseRecipient[] = [];

    for (const rd of recipientData) {
      const { m, ded, prior, dedRemaining, isBlocked } = rd;

      // 공제 사이클 차단 → Phase 3 전용
      if (isBlocked) {
        blockedRecips.push({
          memberId: m.id, memberName: m.name, relation: m.relation,
          deductionLimit: ded, priorGifts: prior, deductionRemaining: 0,
          cashHold: m.cash_hold, annualIncome: m.annual_income,
          targetAmount: targetMap[m.id], actualAmount: 0, giftTax: 0,
          canAffordNow: false, cashAfterTax: m.cash_hold, yearsToSave: 0,
          isBlocked: true,
          blockReason: `최근 10년 내 ${(prior * 100).toFixed(0)}백만원 수증 — 공제 한도 소진. 10년 경과 후 재사용 가능.`,
          deferredToPhase: 3,
        });
        keyInsights.push(`${m.name}(${m.relation}): 공제 사이클 사용 중 → 10년 후 Phase 3으로 이연`);
        continue;
      }

      const myTarget = targetMap[m.id];
      const isSkip   = m.relation === '손자녀';

      // 즉시 납부 가능한 현금으로 처리할 수 있는 최대 증여액
      const usableCash    = m.cash_hold * 0.9;
      const maxAffordable = findMaxAffordableGift(usableCash, m.relation, prior);

      // Phase 1에서 줄 금액: 현금 납부 가능 범위까지
      const giftNow  = Math.min(myTarget, Math.min(remaining, maxAffordable));
      const taxNow   = calcGiftTax(giftNow, m.relation, prior, isSkip);
      const canAfford = usableCash >= taxNow;
      const cashAfter = m.cash_hold - taxNow;
      const yrsToSave = yearsToSaveForTax(
        calcGiftTax(myTarget, m.relation, prior, isSkip),
        m.cash_hold, m.annual_income,
      );

      // Phase 1에 포함 (현금 부족이면 대출 필요 표시, 나머지는 Phase 2로)
      phaseRecips.push({
        memberId: m.id, memberName: m.name, relation: m.relation,
        deductionLimit: ded, priorGifts: prior, deductionRemaining: dedRemaining,
        cashHold: m.cash_hold, annualIncome: m.annual_income,
        targetAmount: myTarget, actualAmount: giftNow, giftTax: taxNow,
        canAffordNow: canAfford, cashAfterTax: cashAfter, yearsToSave: yrsToSave,
        isBlocked: false,
        blockReason: !canAfford
          ? `현금 ${(m.cash_hold * 100).toFixed(0)}백만원 부족 — 증여세 ${(taxNow * 100).toFixed(0)}백만원 중 ${(Math.max(0, taxNow - usableCash) * 100).toFixed(0)}백만원 대출 필요`
          : undefined,
      });

      if (giftNow < myTarget - 0.001) {
        keyInsights.push(`${m.name}: 현금 한도로 ${(giftNow * 100).toFixed(0)}백만원 즉시 증여, 잔여 ${((myTarget - giftNow) * 100).toFixed(0)}백만원은 단기 저축 후 Phase 2에서 완결`);
      }

      totalGiftTax += taxNow;
      remaining    -= giftNow;
    }

    phases.push({
      phaseNum: 1, yearOffset: 0,
      label: '1단계 — 지금 (즉시 증여, 현금 납부 가능 범위)',
      trigger: '자산가치 상승 전 즉시 이전 — 현금 납부 가능 금액 우선, 잔여는 단기 저축 후 완결',
      recipients: phaseRecips,
      blocked: blockedRecips,
      totalAmount: phaseRecips.reduce((s, r) => s + r.actualAmount, 0),
      totalTax: phaseRecips.reduce((s, r) => s + r.giftTax, 0),
    });
  }

  // ── Phase 2: 단기 저축 후 잔여분 완결 (10년 아님, 수증자별 최소 시점) ──
  // Phase 1에서 현금 부족으로 못 준 나머지를 최대한 빠른 시점에 처리.
  // Phase 3(공제 리셋)까지 기다리지 않고 3~5년 내 마무리.
  if (remaining > 0.01) {
    const phaseRecips2: PhaseRecipient[] = [];
    const stillBlocked: PhaseRecipient[] = [];

    // 수증자별 필요 저축기간 계산 → 가장 늦은 시점을 Phase 2 기준으로
    const neededYears: number[] = [];
    for (const rd of recipientData) {
      const { m, isBlocked } = rd;
      if (isBlocked) continue;
      const p1Given = phases[0].recipients.find(r => r.memberId === m.id)?.actualAmount ?? 0;
      const myRem   = targetMap[m.id] - p1Given;
      if (myRem < 0.001) continue;

      const priorForP2    = (priorGiftsMap[m.id] ?? 0) + p1Given;
      const taxOnRem      = calcGiftTax(myRem, m.relation, priorForP2, m.relation === '손자녀');
      const p1TaxPaid     = phases[0].recipients.find(r => r.memberId === m.id)?.giftTax ?? 0;
      const cashAfterP1   = Math.max(0, m.cash_hold - p1TaxPaid);
      const yrs           = yearsToSaveForTax(taxOnRem, cashAfterP1, m.annual_income);
      neededYears.push(Math.max(1, Math.min(yrs, 7))); // 최대 7년 내
    }
    const phase2Yr = neededYears.length > 0 ? Math.max(1, Math.min(...neededYears)) : 2;

    for (const rd of recipientData) {
      const { m, ded, prior, isBlocked } = rd;
      if (isBlocked) {
        stillBlocked.push({
          memberId: m.id, memberName: m.name, relation: m.relation,
          deductionLimit: ded, priorGifts: prior, deductionRemaining: 0,
          cashHold: m.cash_hold, annualIncome: m.annual_income,
          targetAmount: targetMap[m.id], actualAmount: 0, giftTax: 0,
          canAffordNow: false, cashAfterTax: m.cash_hold, yearsToSave: 0,
          isBlocked: true, blockReason: '10년 공제 사이클 미해소 — Phase 3으로 이연', deferredToPhase: 3,
        });
        continue;
      }

      const p1Recip       = phases[0].recipients.find(r => r.memberId === m.id);
      const p1Given       = p1Recip?.actualAmount ?? 0;
      const myRem         = targetMap[m.id] - p1Given;
      if (myRem < 0.001 || remaining < 0.001) continue;

      const priorForP2    = (priorGiftsMap[m.id] ?? 0) + p1Given;
      const isSkip        = m.relation === '손자녀';
      // Phase 2 시점의 예상 현금: Phase 1 세금 차감 후 + 저축
      const p1TaxPaid     = p1Recip?.giftTax ?? 0;
      const savedByP2     = m.annual_income * 0.3 * phase2Yr;
      const cashAtP2      = Math.max(0, m.cash_hold - p1TaxPaid + savedByP2);

      // 잔여분 전부 Phase 2에서 처리 (현금 부족하면 대출 필요 표시)
      const giftAmt2      = Math.min(myRem, remaining);
      const giftTax2      = calcGiftTax(giftAmt2, m.relation, priorForP2, isSkip);
      const canAfford2    = cashAtP2 * 0.9 >= giftTax2;
      const loanNeeded    = Math.max(0, giftTax2 - cashAtP2 * 0.9);

      phaseRecips2.push({
        memberId: m.id, memberName: m.name, relation: m.relation,
        deductionLimit: ded, priorGifts: priorForP2, deductionRemaining: Math.max(0, ded - priorForP2),
        cashHold: cashAtP2, annualIncome: m.annual_income,
        targetAmount: myRem, actualAmount: giftAmt2, giftTax: giftTax2,
        canAffordNow: canAfford2, cashAfterTax: cashAtP2 - giftTax2, yearsToSave: 0,
        isBlocked: false,
        blockReason: !canAfford2
          ? `${phase2Yr}년 저축 후에도 ${(loanNeeded * 100).toFixed(0)}백만원 부족 — 대출 또는 분할 증여 고려`
          : undefined,
      });

      if (!canAfford2) {
        keyInsights.push(`${m.name}: Phase 2 세금 ${(giftTax2 * 100).toFixed(0)}백만원 중 ${(loanNeeded * 100).toFixed(0)}백만원 대출 필요 — 지금 증여 vs 10년 대기보다 대출이 유리할 수 있음`);
      }

      totalGiftTax += giftTax2;
      remaining    -= giftAmt2;
    }

    if (phaseRecips2.length > 0) {
      phases.push({
        phaseNum: 2, yearOffset: phase2Yr,
        label: `2단계 — ${phase2Yr}년 후 (단기 저축 후 잔여분 완결)`,
        trigger: `${phase2Yr}년간 소득 저축으로 세금 준비 후 즉시 완결 — 자산 추가 상승 전 마무리`,
        recipients: phaseRecips2,
        blocked: stillBlocked,
        totalAmount: phaseRecips2.reduce((s, r) => s + r.actualAmount, 0),
        totalTax: phaseRecips2.reduce((s, r) => s + r.giftTax, 0),
      });
    }
  }

  // ── Phase 3: 10년 후 — 공제 사이클 차단 수증자 전용 ────────
  // 원칙: Phase 1/2에서 처리 못 한 잔여분을 Phase 3에 밀지 않는다.
  //       Phase 3은 오직 공제 사이클이 차단(isBlocked)된 수증자에게만 해당.
  //       10년 경과 후 공제가 리셋되면 그때 배분.
  if (recipientData.some(r => r.isBlocked)) {
    const blockedMembers = recipientData.filter(r => r.isBlocked).map(r => r.m);
    const allForPhase3 = blockedMembers;

    const phaseRecips3: PhaseRecipient[] = [];

    for (const m of allForPhase3) {
      const alreadyTotal = phases.reduce((s, p) => s + (p.recipients.find(r => r.memberId === m.id)?.actualAmount ?? 0), 0);
      const myTarget = targetMap[m.id] - alreadyTotal;
      if (myTarget < 0.001 || remaining < 0.001) continue;
      const ded    = GIFT_DEDUCTIONS[m.relation] ?? 0.1;
      const isSkip = m.relation === '손자녀';
      // 10년 후: 공제 리셋 (새 사이클) + 10년치 저축 예상
      const cashAt10   = m.cash_hold + m.annual_income * 0.3 * 10;
      // Phase 3에서도 현금 납부 가능한 범위로만 배분
      const maxAff3    = findMaxAffordableGift(cashAt10 * 0.9, m.relation, 0);
      const giftAmt3   = Math.min(myTarget, Math.min(remaining, maxAff3));
      if (giftAmt3 < 0.001) {
        // 현금 부족 — 남은 금액 상속으로 처리
        if (isSkip) keyInsights.push(`${m.name}(손자녀): Phase 3 증여세 납부 한도 초과 — 잔여분 부모 통해 상속 권장 (세대생략 30% 할증 회피)`);
        continue;
      }
      const giftTax3   = calcGiftTax(giftAmt3, m.relation, 0, isSkip);
      const canAfford3 = cashAt10 * 0.9 >= giftTax3;

      // 손자녀에게 공제(2천만) 초과 금액이 배분되면 안내
      if (isSkip && giftAmt3 > ded + 0.001) {
        keyInsights.push(`${m.name}(손자녀): 공제(2천만) 초과분 ${((giftAmt3 - ded) * 100).toFixed(0)}백만원에 세대생략 30% 할증 적용 — 부모 경유 증여와 비교 필요`);
      }

      phaseRecips3.push({
        memberId: m.id, memberName: m.name, relation: m.relation,
        deductionLimit: ded, priorGifts: 0, deductionRemaining: ded,
        cashHold: cashAt10, annualIncome: m.annual_income,
        targetAmount: myTarget, actualAmount: giftAmt3, giftTax: giftTax3,
        canAffordNow: canAfford3, cashAfterTax: cashAt10 - giftTax3, yearsToSave: 0,
        isBlocked: false,
      });

      totalGiftTax += giftTax3;
      remaining    -= giftAmt3;
    }

    if (phaseRecips3.length > 0) {
      phases.push({
        phaseNum: 3, yearOffset: 10,
        label: '3단계 — 10년 후 (공제 사이클 리셋)',
        trigger: '10년 경과 → 모든 수증자 공제 재사용 가능. 공제 블록 해제 및 잔여분 이전.',
        recipients: phaseRecips3,
        blocked: [],
        totalAmount: phaseRecips3.reduce((s, r) => s + r.actualAmount, 0),
        totalTax: phaseRecips3.reduce((s, r) => s + r.giftTax, 0),
      });
    }
  }

  // 상속세 추정 (잔여분 상속 시)
  const inheritanceFallback = remaining > 0.01
    ? calcInheritanceTax(remaining, allMembers).tax
    : 0;

  if (remaining > 0.01) {
    keyInsights.push(`잔여 ${(remaining * 100).toFixed(0)}백만원은 상속으로 처리 예정 (예상 상속세 ${(inheritanceFallback * 100).toFixed(0)}백만원).`);
  }

  return {
    totalToDistribute,
    phases,
    unallocated: Math.max(0, remaining),
    inheritanceFallback,
    totalGiftTax,
    keyInsights,
  };
}

// ══════════════════════════════════════════════════════════════════
// 증여자 나이·상속구간·대출분석 (2026 기준)
// ══════════════════════════════════════════════════════════════════

// ── 통계청 2022 생명표 기반 기대여명 추정 ─────────────────────────
function koreanLifeExpectancy(currentAge: number): number {
  // 현재 나이에서 추가로 살 것으로 기대되는 연수 (남녀 평균)
  const table: [number, number][] = [
    [50, 33.7], [55, 29.1], [60, 24.6], [65, 20.3],
    [70, 16.3], [75, 12.6], [80, 9.4],  [85, 6.9],
    [90, 4.9],  [95, 3.5],  [100, 2.4],
  ];
  if (currentAge <= table[0][0]) return table[0][1] + (table[0][0] - currentAge);
  if (currentAge >= table[table.length - 1][0]) return table[table.length - 1][1];
  const lower = table.filter(([a]) => a <= currentAge).pop()!;
  const upper = table.find(([a]) => a > currentAge)!;
  const ratio = (currentAge - lower[0]) / (upper[0] - lower[0]);
  return lower[1] + (upper[1] - lower[1]) * ratio;
}

// ── 증여자 긴급도 프로파일 ─────────────────────────────────────────
export interface DonorUrgencyProfile {
  donorAge: number;
  lifeExpectancyYears: number;      // 잔여 기대여명
  safeGiftingWindow: number;        // 10년 룩백 탈출 가능한 남은 기간 (기대여명 - 10)
  remaining10yrCycles: number;      // 10년 공제 사이클 몇 회 더 가능한가
  urgencyLevel: 'low' | 'medium' | 'high' | 'critical';
  urgencyLabel: string;
  urgencyReason: string;
  lookbackEscapeViable: boolean;    // 증여 후 10년 생존 가능성 있는가
  lookbackEscapeNote: string;
}

export function calcDonorUrgency(donorAge: number): DonorUrgencyProfile {
  const lifeExp = koreanLifeExpectancy(donorAge);
  const safeGiftingWindow = Math.max(0, lifeExp - 10); // 10년 룩백 탈출 가능 기간
  const remaining10yrCycles = Math.floor(safeGiftingWindow / 10);
  const lookbackEscapeViable = safeGiftingWindow >= 1;

  let urgencyLevel: DonorUrgencyProfile['urgencyLevel'];
  let urgencyLabel: string;
  let urgencyReason: string;
  let lookbackEscapeNote: string;

  if (safeGiftingWindow <= 0) {
    urgencyLevel = 'critical';
    urgencyLabel = '⚠ 긴급 — 룩백 탈출 불가';
    urgencyReason = `기대여명 ${lifeExp.toFixed(0)}년 이하로 모든 증여가 10년 룩백에 포함. 증여해도 상속세 합산 가능성 높음. 공제 극대화·분할 전략에 집중.`;
    lookbackEscapeNote = '사전증여 효과 제한적 — 배우자·자녀 공제 및 일괄공제 극대화 우선';
  } else if (safeGiftingWindow < 5) {
    urgencyLevel = 'high';
    urgencyLabel = '🔴 매우 급함';
    urgencyReason = `10년 룩백 탈출 가능 기간이 ${safeGiftingWindow.toFixed(0)}년 뿐. 즉시 실행하지 않으면 상속세 절감 효과 반감.`;
    lookbackEscapeNote = `향후 ${safeGiftingWindow.toFixed(0)}년 이내 증여 완료해야 룩백 탈출 가능`;
  } else if (safeGiftingWindow < 15) {
    urgencyLevel = 'medium';
    urgencyLabel = '🟡 계획적 실행 필요';
    urgencyReason = `10년 사이클 ${remaining10yrCycles}회 가능. 지금 시작해야 공제를 최대한 활용 가능.`;
    lookbackEscapeNote = `${remaining10yrCycles}회 10년 사이클 활용 가능 (공제 총 ${remaining10yrCycles}회 리셋)`;
  } else {
    urgencyLevel = 'low';
    urgencyLabel = '🟢 여유 있음';
    urgencyReason = `기대여명 ${lifeExp.toFixed(0)}년, 10년 사이클 ${remaining10yrCycles}회 이상 가능. 분산 증여로 세금 최소화.`;
    lookbackEscapeNote = `${remaining10yrCycles}회 이상 10년 공제 사이클 활용 가능`;
  }

  return {
    donorAge, lifeExpectancyYears: lifeExp, safeGiftingWindow,
    remaining10yrCycles, urgencyLevel, urgencyLabel, urgencyReason,
    lookbackEscapeViable, lookbackEscapeNote,
  };
}

// ── 상속세 구간 절감 분석 ─────────────────────────────────────────
export interface EstateBracketTarget {
  targetLabel: string;           // ex. "40% 구간으로 절감"
  targetMarginalRate: number;    // 목표 한계세율
  currentTaxableBase: number;
  targetTaxableBase: number;
  requiredGift: number;          // 이 구간 경계로 낮추는 데 필요한 증여액
  giftTaxCost: number;           // 자녀 증여 기준 증여세
  inheritanceTaxReduction: number;  // 절감되는 상속세
  netBenefit: number;            // 순편익 (절감 - 증여세)
  netBenefitPct: number;         // 투자 대비 순편익률 (netBenefit / requiredGift)
  lookbackNote: string;          // 10년 룩백 관련 설명
  isViable: boolean;             // 나이 고려 현실적인가
}

export interface EstateBracketAnalysis {
  currentEstate: number;
  currentTaxableBase: number;
  currentInheritanceTax: number;
  currentMarginalRate: number;
  totalDeductions: number;
  targets: EstateBracketTarget[];
  priorGifts10yr: number;
  projectedEstate5yr: number;
  projectedInheritanceTax5yr: number;
  projectedEstate10yr: number;
  projectedInheritanceTax10yr: number;
}

export function calcEstateBracketAnalysis(
  totalEstate: number,
  allMembers: FamilyMember[],
  donorAge: number,
  priorGifts10yr = 0,
  growthRate = 0.03,
): EstateBracketAnalysis {
  const urgency = calcDonorUrgency(donorAge);

  // 현재 상속세 계산
  const current = calcInheritanceTax(totalEstate, allMembers, priorGifts10yr);
  const currentBase = current.taxableBase;
  const currentTax  = current.tax;
  const totalDed    = totalEstate + priorGifts10yr - currentBase;

  // 현재 한계세율
  let currentMarginalRate = 0.10;
  if (currentBase > 30) currentMarginalRate = 0.50;
  else if (currentBase > 10) currentMarginalRate = 0.40;
  else if (currentBase > 5)  currentMarginalRate = 0.30;
  else if (currentBase > 1)  currentMarginalRate = 0.20;

  // 각 구간 경계 (30억·10억·5억) 로 낮추는 전략
  const THRESHOLDS: Array<{ base: number; rate: number; label: string }> = [
    { base: 30, rate: 0.40, label: '40% 구간 (과세표준 30억 이하)' },
    { base: 10, rate: 0.30, label: '30% 구간 (과세표준 10억 이하)' },
    { base: 5,  rate: 0.20, label: '20% 구간 (과세표준 5억 이하)' },
  ];

  const targets: EstateBracketTarget[] = [];

  for (const t of THRESHOLDS) {
    if (currentBase <= t.base) continue; // 이미 이 구간 이하
    if (targets.length >= 2) break;      // 최대 2개 목표만

    // 과세표준을 t.base로 낮추려면 증여해야 할 금액 = currentBase - t.base
    // 하지만 증여분이 10년 내라면 다시 합산되므로, "실질적인" 감소를 위해
    // requiredGift = currentBase - t.base (10년 룩백 탈출 전제)
    const requiredGift = currentBase - t.base;

    // 증여세 (자녀에게 순차 증여 기준, 기수증 0 가정)
    const giftTaxCost = calcGiftTax(requiredGift, '자녀', 0);

    // 증여 후 상속세 (10년 룩백 탈출 전제 → priorGifts10yr에 포함 안 됨)
    const afterEstate  = totalEstate - requiredGift;
    const afterInherit = calcInheritanceTax(afterEstate, allMembers, Math.max(0, priorGifts10yr - requiredGift));
    const inheritanceTaxReduction = currentTax - afterInherit.tax;

    const netBenefit    = inheritanceTaxReduction - giftTaxCost;
    const netBenefitPct = requiredGift > 0 ? (netBenefit / requiredGift) * 100 : 0;

    // 10년 룩백 참고
    let lookbackNote: string;
    let isViable: boolean;
    if (!urgency.lookbackEscapeViable) {
      isViable = false;
      lookbackNote = `⚠ 기대여명 ${urgency.lifeExpectancyYears.toFixed(0)}년 → 룩백 탈출 불가. 증여해도 상속세에 합산 가능성 높음.`;
    } else if (urgency.safeGiftingWindow < 3) {
      isViable = true;
      lookbackNote = `⏰ 향후 ${urgency.safeGiftingWindow.toFixed(0)}년 이내 실행해야 10년 룩백 탈출 가능.`;
    } else {
      isViable = true;
      lookbackNote = `✓ ${urgency.safeGiftingWindow.toFixed(0)}년 여유 — 10년 룩백 탈출 충분히 가능.`;
    }

    targets.push({
      targetLabel: t.label,
      targetMarginalRate: t.rate,
      currentTaxableBase: currentBase,
      targetTaxableBase: t.base,
      requiredGift,
      giftTaxCost,
      inheritanceTaxReduction,
      netBenefit,
      netBenefitPct,
      lookbackNote,
      isViable,
    });
  }

  const projEstate5yr  = totalEstate * Math.pow(1 + growthRate, 5);
  const projEstate10yr = totalEstate * Math.pow(1 + growthRate, 10);
  const proj5 = calcInheritanceTax(projEstate5yr, allMembers, priorGifts10yr);
  const proj10 = calcInheritanceTax(projEstate10yr, allMembers, priorGifts10yr);

  return {
    currentEstate: totalEstate,
    currentTaxableBase: currentBase,
    currentInheritanceTax: currentTax,
    currentMarginalRate,
    totalDeductions: totalDed,
    targets,
    priorGifts10yr,
    projectedEstate5yr: projEstate5yr,
    projectedInheritanceTax5yr: proj5.tax,
    projectedEstate10yr: projEstate10yr,
    projectedInheritanceTax10yr: proj10.tax,
  };
}

// ── 대출 활용 증여 분석 ──────────────────────────────────────────
export interface LoanGiftAnalysis {
  recipientName: string;
  relation: string;
  giftAmount: number;
  giftTax: number;
  cashHold: number;
  canAffordCash: boolean;
  cashShortfall: number;
  loanAmount: number;
  loanRatePct: number;
  annualInterest: number;
  totalInterest5yr: number;
  totalInterest10yr: number;
  // 이 금액을 상속 받을 때의 한계세율 기준 절감액
  inheritanceTaxSaving: number;
  breakEvenYears: number;
  netBenefitAt5yr: number;
  netBenefitAt10yr: number;
  isRecommended: boolean;
  reason: string;
}

export function calcLoanGiftAnalysis(
  recipientName: string,
  relation: string,
  giftAmount: number,
  priorGifts: number,
  cashHold: number,
  marginalInheritanceRate: number,   // 현재 한계 상속세율 (ex. 0.50)
  loanRatePct = 5.5,                 // 은행 담보대출 평균 (2026 기준)
): LoanGiftAnalysis {
  const giftTax        = calcGiftTax(giftAmount, relation, priorGifts);
  const canAffordCash  = cashHold * 0.9 >= giftTax;
  const cashShortfall  = Math.max(0, giftTax - cashHold * 0.9);
  const loanAmount     = cashShortfall;
  const annualInterest = loanAmount * (loanRatePct / 100);

  // 이 자산을 나중에 상속받는 대신 지금 증여 → 상속세 절감
  const inheritanceTaxSaving = giftAmount * marginalInheritanceRate;
  // 순편익 = 상속세 절감 - 증여세
  const savingVsTax = inheritanceTaxSaving - giftTax;

  const totalInterest5yr  = annualInterest * 5;
  const totalInterest10yr = annualInterest * 10;

  const netBenefitAt5yr  = savingVsTax - totalInterest5yr;
  const netBenefitAt10yr = savingVsTax - totalInterest10yr;

  const breakEvenYears = savingVsTax > 0 && annualInterest > 0
    ? parseFloat((savingVsTax / annualInterest).toFixed(1))
    : annualInterest === 0 ? 0 : 9999;

  const isRecommended = canAffordCash || netBenefitAt5yr > 0
    || (netBenefitAt10yr > 0 && cashShortfall < giftTax * 0.4);

  let reason: string;
  if (canAffordCash) {
    reason = '현금 납부 가능 — 대출 불필요';
  } else if (netBenefitAt5yr > 0) {
    reason = `대출이자 ${(annualInterest * 100).toFixed(0)}백만/년이나 5년 내 순편익 ${(netBenefitAt5yr * 100).toFixed(0)}백만 확보 → 추천`;
  } else if (netBenefitAt10yr > 0) {
    reason = `10년 보유 시 순편익 ${(netBenefitAt10yr * 100).toFixed(0)}백만 — 장기 보유 전제 시 검토 가능`;
  } else {
    reason = `이자 누적(5년 ${(totalInterest5yr * 100).toFixed(0)}백만)이 절감액 초과 — 대출 비추천`;
  }

  return {
    recipientName, relation, giftAmount, giftTax, cashHold,
    canAffordCash, cashShortfall, loanAmount, loanRatePct,
    annualInterest, totalInterest5yr, totalInterest10yr,
    inheritanceTaxSaving, breakEvenYears,
    netBenefitAt5yr, netBenefitAt10yr,
    isRecommended, reason,
  };
}

// ── 증여자 기준 관계 파생 ─────────────────────────────────────
// 가족 구성원의 관계는 "본인" 기준으로 저장되어 있지만,
// 세금 계산은 증여자 기준 관계가 필요함.
// ex) 본인=손자, 증여자=조부모(할아버지) → 아빠(부모)의 할아버지 기준 관계 = 자녀
export function deriveGiftRelation(
  donorRelation: string,   // 증여자의 관계 (본인 기준)
  recipientRelation: string, // 수증자의 관계 (본인 기준)
): string {
  // 증여자가 본인이면 그대로
  if (donorRelation === '본인') return recipientRelation;

  // 증여자가 조부모(할아버지·할머니)
  if (donorRelation === '조부모') {
    switch (recipientRelation) {
      case '본인':    return '손자녀';   // 나(손자) → 조부모 기준 손자녀
      case '부모':    return '자녀';     // 아빠·엄마 → 조부모 기준 자녀 or 며느리
      case '며느리':  return '며느리';   // 아들의 배우자 → 조부모 기준 며느리
      case '사위':    return '사위';     // 딸의 배우자 → 조부모 기준 사위
      case '배우자':  return '기타';     // 나의 배우자 → 조부모 기준 손자며느리 (기타)
      case '자녀':    return '손자녀';   // 나의 자녀 → 조부모 기준 증손자녀
      case '형제':    return '손자녀';   // 나의 형제 → 조부모 기준 손자녀
      case '삼촌':    return '자녀';     // 나의 삼촌 → 조부모의 자녀
      case '고모':    return '자녀';     // 나의 고모 → 조부모의 자녀
      case '손자녀':  return '손자녀';   // 이미 손자녀
      default:        return '기타';
    }
  }

  // 증여자가 부모(아빠·엄마)
  if (donorRelation === '부모') {
    switch (recipientRelation) {
      case '본인':    return '자녀';     // 나 → 부모 기준 자녀
      case '배우자':  return '며느리';   // 나의 배우자 → 부모 기준 며느리/사위
      case '자녀':    return '손자녀';   // 나의 자녀 → 부모 기준 손자녀
      case '형제':    return '자녀';     // 나의 형제 → 부모의 자녀
      case '조부모':  return '부모';     // 나의 조부모 → 부모의 부모
      case '삼촌':    return '형제';     // 나의 삼촌 → 부모의 형제
      case '고모':    return '형제';
      default:        return '기타';
    }
  }

  // 증여자가 배우자
  if (donorRelation === '배우자') {
    switch (recipientRelation) {
      case '본인':    return '배우자';
      case '자녀':    return '자녀';     // 공동 자녀
      case '며느리':  return '며느리';
      case '사위':    return '사위';
      case '손자녀':  return '손자녀';
      default:        return '기타';
    }
  }

  // 증여자가 자녀
  if (donorRelation === '자녀') {
    switch (recipientRelation) {
      case '본인':    return '부모';     // 나 → 자녀 기준 부모
      case '배우자':  return '기타';
      case '조부모':  return '조부모';
      case '형제':    return '기타';
      default:        return '기타';
    }
  }

  return '기타'; // fallback
}

// ── 생애 이벤트 연계 증여 계획 ──────────────────────────────────
export type LifeEventType = 'marriage' | 'housing' | 'business' | 'education';

export interface LifeEvent {
  type: LifeEventType;
  yearsFromNow: number;       // 몇 년 후
  targetAmount?: number;      // 목표 자금 (억) - 자가마련 등
  label: string;
}

export interface LifeEventGiftPhase {
  yearOffset: number;
  phaseLabel: string;
  description: string;
  giftAmount: number;         // 억 (해당 시점 가치)
  giftAmountCurrentValue: number; // 억 (현재 가치 기준)
  giftTax: number;            // 억
  deductionUsed: number;      // 억
  marriageBonusUsed: boolean;
  priorGiftsEntering: number; // 억 (이 페이즈 진입 시 누적 기수증)
  note: string;
}

export interface LifeEventGiftPlan {
  relation: string;
  phases: LifeEventGiftPhase[];
  totalGifted: number;        // 억 (시점 기준)
  totalGiftedCurrentValue: number; // 억 (현재 가치 기준)
  totalTax: number;           // 억
  targetAmount: number;       // 억 (총 목표)
  targetCoverage: number;     // 0~1 (충당률)
  shortfall: number;          // 억 (부족분)
  keyInsights: string[];
}

export function calcLifeEventGiftPlan(
  relation: string,
  lifeEvents: LifeEvent[],
  totalAvailableCurrentValue: number,  // 억 (현재 가치 기준 증여 가능 자산)
  priorGifts: number = 0,              // 기수증액 (억)
  growthRate: number = 0.03,           // 연간 자산 성장률
): LifeEventGiftPlan {
  const ded = GIFT_DEDUCTIONS[relation] ?? 0.1;
  const isSkip = relation === '손자녀';

  // Sort life events by yearsFromNow ascending
  const sortedEvents = [...lifeEvents].sort((a, b) => a.yearsFromNow - b.yearsFromNow);

  let cumulativePrior = priorGifts;
  let remainingCurrentValue = totalAvailableCurrentValue;
  const phases: LifeEventGiftPhase[] = [];

  const marr = sortedEvents.find(e => e.type === 'marriage');
  const housingEvent = sortedEvents.find(e => e.type === 'housing');

  // ── Phase A: 즉시 (Year 0) 무세 증여 ──
  const taxFreeNow = Math.max(0, ded - cumulativePrior);
  const giftNow = Math.min(remainingCurrentValue, taxFreeNow);

  if (giftNow > 0.001) {
    phases.push({
      yearOffset: 0,
      phaseLabel: '즉시 무세 증여',
      description: '공제 한도 내 즉시 이전',
      giftAmount: giftNow,
      giftAmountCurrentValue: giftNow,
      giftTax: 0,
      deductionUsed: giftNow,
      marriageBonusUsed: false,
      priorGiftsEntering: cumulativePrior,
      note: '공제 한도 내 무세 이전',
    });
    cumulativePrior += giftNow;
    remainingCurrentValue -= giftNow;
  }

  // 즉시 과세 증여 — 5년 내 이벤트가 없는 경우만
  const hasEventWithin5yr = sortedEvents.some(e => e.yearsFromNow <= 5);
  if (remainingCurrentValue > 0.01 && !hasEventWithin5yr) {
    const taxableNowCurrentValue = Math.min(remainingCurrentValue, 1.0); // 부분만
    if (taxableNowCurrentValue > 0.001) {
      const tax = calcGiftTax(taxableNowCurrentValue, relation, cumulativePrior, isSkip);
      phases.push({
        yearOffset: 0,
        phaseLabel: '즉시 과세 증여',
        description: '공제 초과분 즉시 이전 (세금 발생)',
        giftAmount: taxableNowCurrentValue,
        giftAmountCurrentValue: taxableNowCurrentValue,
        giftTax: tax,
        deductionUsed: 0,
        marriageBonusUsed: false,
        priorGiftsEntering: cumulativePrior,
        note: `증여세율 구간 적용 — 기수증 ${cumulativePrior.toFixed(1)}억 합산`,
      });
      cumulativePrior += taxableNowCurrentValue;
      remainingCurrentValue -= taxableNowCurrentValue;
    }
  }

  // ── Phase B: 결혼 시점 ──
  if (marr && (relation === '자녀' || relation === '손자녀')) {
    const projectedValue = remainingCurrentValue * Math.pow(1 + growthRate, marr.yearsFromNow);
    const dedResetted = marr.yearsFromNow >= 10;
    const dedAtEvent = dedResetted ? ded : Math.max(0, ded - cumulativePrior);
    const marriageBonus = 1.0; // 혼인공제
    const totalTaxFreeAtEvent = dedAtEvent + marriageBonus;
    const giftAtEvent = Math.min(projectedValue, totalTaxFreeAtEvent);

    if (giftAtEvent > 0.001) {
      const giftAmountCurrentValue = giftAtEvent / Math.pow(1 + growthRate, marr.yearsFromNow);
      phases.push({
        yearOffset: marr.yearsFromNow,
        phaseLabel: `${marr.yearsFromNow}년 후 결혼 시점 증여`,
        description: '혼인공제 활용 무세 이전',
        giftAmount: giftAtEvent,
        giftAmountCurrentValue,
        giftTax: 0,
        deductionUsed: dedAtEvent,
        marriageBonusUsed: true,
        priorGiftsEntering: dedResetted ? 0 : cumulativePrior,
        note: dedResetted
          ? '10년 경과 공제 리셋 + 혼인공제 1억'
          : '잔여 공제 + 혼인공제 1억',
      });
      remainingCurrentValue -= giftAmountCurrentValue;
      cumulativePrior = dedResetted ? giftAtEvent : cumulativePrior + giftAtEvent;
    }

    // 결혼 시점 과세 초과분
    if (projectedValue > totalTaxFreeAtEvent) {
      const taxable = projectedValue - totalTaxFreeAtEvent;
      const tax = calcGiftTax(taxable, relation, totalTaxFreeAtEvent, isSkip);
      const taxableCurrentValue = taxable / Math.pow(1 + growthRate, marr.yearsFromNow);
      phases.push({
        yearOffset: marr.yearsFromNow,
        phaseLabel: `${marr.yearsFromNow}년 후 결혼 시점 과세 증여`,
        description: '혼인공제 초과분 이전 (세금 발생)',
        giftAmount: taxable,
        giftAmountCurrentValue: taxableCurrentValue,
        giftTax: tax,
        deductionUsed: 0,
        marriageBonusUsed: false,
        priorGiftsEntering: totalTaxFreeAtEvent,
        note: `혼인공제 한도 초과 — 증여세 ${(tax * 100).toFixed(0)}백만원`,
      });
      remainingCurrentValue -= taxableCurrentValue;
    }
  }

  // ── Phase C: 10년 후 사이클 2 ──
  const marrYears = marr?.yearsFromNow;
  if (remainingCurrentValue > 0.01 && marrYears !== 10) {
    const proj10 = remainingCurrentValue * Math.pow(1 + growthRate, 10);
    const giftPhase2 = Math.min(proj10, ded);
    const tax2 = giftPhase2 > ded ? calcGiftTax(giftPhase2, relation, 0, isSkip) : 0;
    const giftPhase2CurrentValue = giftPhase2 / Math.pow(1 + growthRate, 10);

    phases.push({
      yearOffset: 10,
      phaseLabel: '10년 후 공제 리셋 증여',
      description: '10년 공제 사이클 리셋 후 무세 이전',
      giftAmount: giftPhase2,
      giftAmountCurrentValue: giftPhase2CurrentValue,
      giftTax: tax2,
      deductionUsed: giftPhase2,
      marriageBonusUsed: false,
      priorGiftsEntering: 0,
      note: `10년 공제 리셋 — ${relation} 공제 ${(ded * 10).toFixed(0)}천만원 재활용`,
    });
    remainingCurrentValue -= giftPhase2CurrentValue;
  }

  // 합산
  const totalGifted = phases.reduce((s, p) => s + p.giftAmount, 0);
  const totalGiftedCurrentValue = phases.reduce((s, p) => s + p.giftAmountCurrentValue, 0);
  const totalTax = phases.reduce((s, p) => s + p.giftTax, 0);

  const housingGoal = housingEvent?.targetAmount ?? 0;
  const coverage = housingGoal > 0 ? Math.min(1, totalGiftedCurrentValue / housingGoal) : 1;
  const shortfall = housingGoal > 0 ? Math.max(0, housingGoal - totalGiftedCurrentValue) : 0;

  // 핵심 인사이트
  const keyInsights: string[] = [];
  if (marr && (relation === '자녀' || relation === '손자녀')) {
    keyInsights.push(`결혼 시점 혼인공제 1억 추가 → 최대 ${(ded + 1).toFixed(1)}억 무세`);
  }
  if (isSkip) {
    keyInsights.push('손자녀 직접 증여 시 세대생략 할증 30% → 부모 통한 단계 증여 비교 검토');
  }
  if (housingGoal > 0) {
    keyInsights.push(`자가마련 목표 ${housingGoal}억 대비 충당률: ${(coverage * 100).toFixed(0)}%`);
  }
  if (shortfall > 0) {
    keyInsights.push(`부족분 ${shortfall.toFixed(1)}억 → 대출 또는 추가 과세 증여 필요`);
  }

  return {
    relation,
    phases,
    totalGifted,
    totalGiftedCurrentValue,
    totalTax,
    targetAmount: housingEvent?.targetAmount ?? 0,
    targetCoverage: coverage,
    shortfall,
    keyInsights,
  };
}

// 파생 관계 설명 (UI 표시용)
export function deriveGiftRelationNote(
  donorRelation: string,
  recipientRelation: string,
  derivedRelation: string,
): string {
  if (donorRelation === '본인') return '';
  if (derivedRelation === recipientRelation) return '';
  return `${donorRelation} 기준 → ${derivedRelation}`;
}

// ── 공익법인 출연 시나리오 ─────────────────────────────────────────
export interface PublicFoundationScenario {
  donationPct: number;              // 출연 비율 %
  donatedValue: number;             // 출연 자산가액 (억)
  nonTaxableAmount: number;         // 과세가액 불산입액 (억) — 상증법§16
  remainingEstate: number;          // 출연 후 남은 과세 대상 자산 (억)
  originalTax: number;              // 기존 상속세 (억)
  newTax: number;                   // 출연 후 상속세 (억)
  inheritanceTaxReduction: number;  // 상속세 감소액 (억) — 과세가액 불산입 효과
  giftTaxSaved: number;             // 자녀에게 직접 증여 시 낼 증여세 (절약 증여세, 억)
  taxSaving: number;                // 주 절세 지표 = giftTaxSaved (증여세 기준)
  controlLossValue: number;         // 통제권 상실 가치 (억) — 출연 자산의 30% 추정
  netBenefit: number;               // 순편익 = taxSaving - 통제권상실가치
  executionSteps: ExecutionStep[];
}

export interface PublicFoundationPortfolioAdjustment {
  donationPct: number;
  donatedValue: number;
  remainingEstate: number;
  originalTax: number;
  adjustedTax: number;
  taxReduction: number;
  confidence: 'expert_review';
  warnings: string[];
}

/**
 * 공익법인 출연을 포트폴리오 단위로 비교하기 위한 사전 검토용 추정치입니다.
 * 선택한 금액 전부가 법정 요건을 충족하는 적격 출연재산이라는 가정만 반영합니다.
 */
export function estimatePublicFoundationPortfolioAdjustment(
  totalEstate: number,
  members: FamilyMember[],
  donationPct: number,
  priorGifts10yr = 0,
): PublicFoundationPortfolioAdjustment {
  const safePct = Math.min(100, Math.max(0, Number(donationPct) || 0));
  const donatedValue = Math.max(0, totalEstate) * (safePct / 100);
  const remainingEstate = Math.max(0, totalEstate - donatedValue);
  const { tax: originalTax } = calcInheritanceTax(totalEstate, members, priorGifts10yr);
  const { tax: adjustedTax } = calcInheritanceTax(remainingEstate, members, priorGifts10yr);

  return {
    donationPct: safePct,
    donatedValue,
    remainingEstate,
    originalTax,
    adjustedTax,
    taxReduction: Math.max(0, originalTax - adjustedTax),
    confidence: 'expert_review',
    warnings: [
      '출연재산은 가족의 사유재산으로 이전되지 않습니다.',
      '공익목적 사용, 신고기한, 주식 출연 한도와 사후관리 요건은 자산별 전문가 확인이 필요합니다.',
    ],
  };
}

export function calcPublicFoundationScenario(
  targetAsset: Asset,           // 출연 대상 자산
  donationPct: number,          // 출연 비율 (0~100)
  totalEstate: number,          // 전체 자산 (억)
  members: FamilyMember[],      // 상속인
  priorGifts10yr = 0,
  priorGiftTaxPaid = 0,
): PublicFoundationScenario {
  const donatedValue = targetAsset.current_value * (donationPct / 100);

  // 상증법§16: 공익법인 출연재산 과세가액 불산입
  // 단, 내국법인 주식 5% 초과 시 초과분 과세 — 부동산은 전액 불산입
  const isStock = targetAsset.asset_type === '비상장주식';
  const nonTaxableAmount = isStock
    ? Math.min(donatedValue, targetAsset.current_value * 0.05) // 주식 5% 한도
    : donatedValue; // 부동산·금융자산 전액 불산입

  const remainingEstate = totalEstate - nonTaxableAmount;

  const { tax: originalTax } = calcInheritanceTax(totalEstate, members, priorGifts10yr, 0, priorGiftTaxPaid);
  const { tax: newTax } = calcInheritanceTax(remainingEstate, members, priorGifts10yr, 0, priorGiftTaxPaid);

  const inheritanceTaxReduction = Math.max(0, originalTax - newTax);
  // 자녀에게 직접 증여했을 때 낼 증여세 — 공익법인 출연 시 이 세금이 0이 됨 (상증법§48 비과세)
  const giftTaxSaved = calcGiftTax(nonTaxableAmount, '자녀', priorGifts10yr);
  // 주 절세 지표는 "증여세 기준": 자녀에게 직접 줬을 때 냈을 증여세를 아끼는 것
  const taxSaving = giftTaxSaved;
  const controlLossValue = donatedValue * 0.30; // 통제권 상실 = 출연액의 30% 추정
  const netBenefit = taxSaving - controlLossValue;

  const executionSteps: ExecutionStep[] = [
    { timing: '즉시', title: '공익법인 유형 결정', description: '장학재단·복지법인·문화재단 중 실제 수행할 목적 선택. 특수관계인 이사 제한과 사적 사용 금지를 포함해 관할 주무관청 확인', actor: '세무사+법무사' },
    { timing: '1~8주차', title: '주무관청 설립허가 신청', description: '관할 행정청(교육부/복지부 등) 신청. 심사 기간 약 2~3개월. 정관·사업계획서·재정계획 제출', actor: '법무사', estimatedCost: '설립 비용 약 500~1,000만원' },
    { timing: '허가 후 2주', title: '재단법인 설립 등기', description: '법원 등기소 설립 등기 완료. 법인 설립일 확정', actor: '법무사', estimatedCost: '등록면허세 약 30~50만원' },
    { timing: '상속세 신고기한(6개월) 내', title: `자산 출연 — ${donationPct}% 이전`, description: `${targetAsset.name} 중 ${donationPct}% (약 ${donatedValue.toFixed(1)}억)를 재단에 현물 출연. 상속세 신고기한 내 완료해야 과세가액 불산입 인정 (상증법§16④)`, actor: '세무사+법무사', estimatedCost: '취득세 감면 적용 여부 별도 확인' },
    { timing: '이후 매년', title: '공익목적 사용 및 보고', description: '법정 기한 내 직접 공익목적 사용과 연간 사용 의무를 이행합니다. 이사회 운영, 결산 공시, 국세청 보고서 제출. 위반 시 출연재산 가액과 가산세 등 추징 가능', actor: '본인(이사진)' },
  ];

  return { donationPct, donatedValue, nonTaxableAmount, remainingEstate, originalTax, newTax, inheritanceTaxReduction, giftTaxSaved, taxSaving, controlLossValue, netBenefit, executionSteps };
}

// ── 법인전환 시나리오 (상세) ──────────────────────────────────────
export interface CorpConversionScenarioResult {
  realEstateValue: number;       // 이전 부동산 가액 (억)
  acquisitionTaxSaving: number;  // 취득세 절감 (4% → 2%, 억)
  annualPersonalTax: number;     // 개인 임대소득세 (억/년)
  annualCorpTax: number;         // 법인세 + CEO 소득세 (억/년)
  annualTaxSaving: number;       // 연간 절세 (억)
  transferTaxCost: number;       // 양도세 이월과세 비용 (억)
  paybackYears: number;          // 투자 회수 기간 (년)
  tenYearBenefit: number;        // 10년 누적 순편익 (억)
  executionSteps: ExecutionStep[];
}

export function calcCorpConversionScenario(
  assets: Asset[],
  ceoSalary: number,             // 대표이사 연봉 (억)
  members: FamilyMember[],
): CorpConversionScenarioResult {
  const realEstateAssets = assets.filter(a =>
    ['상업용부동산', '주거용부동산', '토지'].includes(a.asset_type)
  );
  const realEstateValue = realEstateAssets.reduce((s, a) => s + a.current_value, 0);
  const totalRentalIncome = assets.reduce((s, a) => s + a.current_value * (a.annual_yield_pct / 100), 0);
  const ownerIncome = members.find(m => m.relation === '본인')?.annual_income ?? 0;

  // 개인 임대소득세
  const annualPersonalTax = calcIncomeTax(totalRentalIncome + ownerIncome) - calcIncomeTax(ownerIncome);

  // 법인세 + CEO 소득세 (임대수익 - CEO 급여 = 법인 과세소득)
  const corpTaxableIncome = Math.max(0, totalRentalIncome - ceoSalary);
  const corpTax = calcCorporateTax(corpTaxableIncome) * 1.1; // 지방소득세 포함
  const ceoIncomeTax = calcIncomeTax(ceoSalary + ownerIncome) - calcIncomeTax(ownerIncome);
  const annualCorpTax = corpTax + ceoIncomeTax;

  const annualTaxSaving = Math.max(0, annualPersonalTax - annualCorpTax);

  // 지방세 감면은 적용 요건 확인 전 자동 절세액에 넣지 않음
  const acquisitionTaxSaving = 0;
  const acquisitionTaxEstimate = realEstateValue * 0.04;

  // 양도세 이월과세 비용 (현물출자 시 0, 법인 매각 시 과세)
  const deferredCapitalGain = realEstateAssets.reduce((s, a) =>
    s + Math.max(0, a.current_value - a.acquisition_cost), 0
  );
  const transferTaxCost = deferredCapitalGain * 0.22; // 법인세율 적용 추정

  const paybackYears = annualTaxSaving > 0
    ? (0.3 + acquisitionTaxEstimate) / annualTaxSaving
    : 99;
  const tenYearBenefit = annualTaxSaving * 10 - acquisitionTaxEstimate - 0.3;

  const ownerName = members.find(m => m.relation === '본인')?.name ?? '본인';

  const executionSteps: ExecutionStep[] = [
    { timing: '1~2주차', title: '감정평가 의뢰', description: '이전 부동산 감정평가액 산정 (공시가 아닌 시가 기준). 법인에 현물출자 시 기준가액이 됨', actor: '감정평가사', estimatedCost: '감정평가 비용 약 100~300만원' },
    { timing: '2~4주차', title: '법인 설립', description: `주식회사 또는 유한회사 설립. 자본금 결정, 정관 작성, 임원 구성. CEO=${ownerName} 연봉 ${ceoSalary.toFixed(1)}억으로 설계`, actor: '법무사', estimatedCost: '설립 비용 약 50~100만원' },
    { timing: '4~8주차', title: '현물출자 신청 및 법원 인가', description: '현물출자 검사인 선임 → 법원 심사 → 출자 완료. 조특법§32 현물출자 이월과세 적용 신청', actor: '법무사+세무사', estimatedCost: '검사인 비용 약 30~50만원' },
    { timing: '인가 후', title: '소유권 이전 등기', description: `부동산 ${realEstateValue.toFixed(1)}억 → 법인 명의 이전. 취득세 감면은 자산·사업·시점별 적용 요건 별도 확인`, actor: '법무사', estimatedCost: `취득세 약 ${acquisitionTaxEstimate.toFixed(1)}억 보수 추정 (감면 미반영)` },
    { timing: '이후', title: '법인 운영 및 급여 설계', description: `CEO 급여 ${ceoSalary.toFixed(1)}억 → 법인 비용 처리. 임대수익의 법인 귀속, 연간 절세 약 ${annualTaxSaving.toFixed(1)}억 효과`, actor: '세무사' },
    { timing: '매년', title: '법인세 신고 및 배당 설계', description: '법인세 신고 (사업연도 종료 후 3개월 내). 배당 시 개인 소득세 추가 고려. 배당금은 가족 구성원에게 분산 가능', actor: '세무사' },
  ];

  return {
    realEstateValue, acquisitionTaxSaving, annualPersonalTax, annualCorpTax,
    annualTaxSaving, transferTaxCost, paybackYears, tenYearBenefit, executionSteps,
  };
}

// ── 커스텀 시나리오 ───────────────────────────────────────────────
export interface CustomAssetTransfer {
  assetId: string;
  transferType: 'gift' | 'foundation' | 'corp' | 'sell';
  recipientMemberId?: string;
  transferPct: number;           // 이전 비율 0~100
}

export interface CustomScenarioConfig {
  assetTransfers: CustomAssetTransfer[];
  selectedStrategyIds: string[];
  foundationDonationPct: number; // 공익법인 출연 비율
  corpConversionEnabled: boolean;
  ceoSalary: number;
}

export interface CustomScenarioResult {
  // 자산 이전 효과
  totalTransferredValue: number;  // 이전한 자산 총액 (억)
  totalGiftTax: number;           // 증여세 합계 (억)
  totalFoundationTax: number;     // 공익법인 절세 (억)
  totalCorpSaving: number;        // 법인전환 절세 (억)
  // 상속세 계산
  remainingEstate: number;        // 이전 후 남은 자산 (억)
  newInheritanceTax: number;      // 새 상속세 (억)
  originalInheritanceTax: number; // 기존 상속세 (억)
  inheritanceTaxSaving: number;   // 상속세 절감액 (억)
  // 전략 효과
  strategyTaxSaving: number;      // 선택 전략 절세 합계 (억)
  // 종합
  totalTaxBurden: number;         // 총 세금 부담 (억)
  totalTaxSaving: number;         // 총 절세 (억)
  netWealthAfter: number;         // 세후 순자산 (억)
}

export function calcCustomScenario(
  config: CustomScenarioConfig,
  assets: Asset[],
  members: FamilyMember[],
  totalEstate: number,
  originalInheritanceTax: number,
  allStrategies: RecoveryStrategy[],
): CustomScenarioResult {
  let remainingEstate = totalEstate;
  let totalGiftTax = 0;
  let totalFoundationTax = 0;
  let totalCorpSaving = 0;
  let totalTransferredValue = 0;

  for (const transfer of config.assetTransfers) {
    const asset = assets.find(a => a.id === transfer.assetId);
    if (!asset) continue;
    const transferredValue = asset.current_value * (transfer.transferPct / 100);
    totalTransferredValue += transferredValue;

    if (transfer.transferType === 'gift' && transfer.recipientMemberId) {
      const recipient = members.find(m => m.id === transfer.recipientMemberId);
      if (recipient) {
        const giftTax = calcGiftTax(transferredValue, recipient.relation);
        totalGiftTax += giftTax;
        // 룩백으로 합산되지만 당시 가액으로 — 절세 효과는 상속세에서 공제
        remainingEstate -= transferredValue * 0.7; // 대략 70% 상속세 절감 효과 반영
      }
    } else if (transfer.transferType === 'foundation') {
      const isStock = asset.asset_type === '비상장주식';
      const nonTaxable = isStock ? Math.min(transferredValue, asset.current_value * 0.05) : transferredValue;
      remainingEstate -= nonTaxable;
      totalFoundationTax += nonTaxable * 0.4; // 절세 효과 추산
    } else if (transfer.transferType === 'corp') {
      // 법인전환: 임대소득세 절세 효과
      const annualRentalIncome = asset.current_value * (asset.annual_yield_pct / 100);
      totalCorpSaving += annualRentalIncome * 0.15 * 10; // 15% 절세 × 10년
    }
  }

  const { tax: newInheritanceTax } = calcInheritanceTax(Math.max(0, remainingEstate), members);
  const inheritanceTaxSaving = Math.max(0, originalInheritanceTax - newInheritanceTax);

  // 전략 절세
  const strategyTaxSaving = allStrategies
    .filter(s => config.selectedStrategyIds.includes(s.id))
    .reduce((sum, s) => sum + s.netBenefit, 0);

  const totalTaxBurden = newInheritanceTax + totalGiftTax;
  const totalTaxSaving = inheritanceTaxSaving + strategyTaxSaving + totalCorpSaving;
  const netWealthAfter = totalEstate - totalTaxBurden;

  return {
    totalTransferredValue, totalGiftTax, totalFoundationTax, totalCorpSaving,
    remainingEstate: Math.max(0, remainingEstate), newInheritanceTax, originalInheritanceTax,
    inheritanceTaxSaving, strategyTaxSaving, totalTaxBurden, totalTaxSaving, netWealthAfter,
  };
}

// ── 전략 선택 후 실시간 조정 상속세 ─────────────────────────────
// 상속세를 실제로 줄이는 전략(과세표준 감소)과 그렇지 않은 전략 분리
const ESTATE_REDUCER_IDS = new Set([
  'charity_foundation', 'public_foundation', 'dil_5yr_lookback', 'immediate_gift_growth',
]);
const CASHFLOW_ONLY_IDS = new Set(['installment', 'life_insurance', 'family_loan']);

export interface AdjustedTaxResult {
  adjustedEstate: number;   // 전략 적용 후 추정 과세 자산 (억)
  adjustedTax: number;      // 조정 상속세 (억)
  originalTax: number;      // 기존 상속세 (억)
  totalReduction: number;   // 절세 합계 (억)
  breakdown: Array<{
    strategyId: string;
    strategyTitle: string;
    type: 'estate_reduction' | 'tax_credit' | 'cashflow_only';
    taxReducedBy: number;
  }>;
}

export function calcAdjustedTaxFromStrategies(
  totalEstate: number,
  members: FamilyMember[],
  priorGifts10yr: number,
  strategies: RecoveryStrategy[],
  selectedIds: string[],
  foundationDonationAmt = 0, // 공익법인 출연액(억) — PublicFoundationCard에서 전달
): AdjustedTaxResult {
  const { tax: originalTax } = calcInheritanceTax(totalEstate, members, priorGifts10yr);
  const selected = strategies.filter(s => selectedIds.includes(s.id));
  const breakdown: AdjustedTaxResult['breakdown'] = [];

  let adjustedEstate = totalEstate;
  let directCreditTotal = 0;

  for (const s of selected) {
    if (CASHFLOW_ONLY_IDS.has(s.id)) {
      breakdown.push({ strategyId: s.id, strategyTitle: s.title, type: 'cashflow_only', taxReducedBy: 0 });
      continue;
    }
    if (ESTATE_REDUCER_IDS.has(s.id)) {
      // taxSavingEstimate ≈ estateReduction × 한계세율(50%)
      const impliedEstateReduction = s.taxSavingEstimate > 0 ? s.taxSavingEstimate / 0.50 : 0;
      adjustedEstate = Math.max(0, adjustedEstate - impliedEstateReduction);
      breakdown.push({ strategyId: s.id, strategyTitle: s.title, type: 'estate_reduction', taxReducedBy: s.taxSavingEstimate });
    } else {
      // 직접 세액 공제 (배우자공제 이미 기본 포함, 법인전환은 소득세 절감)
      directCreditTotal += s.netBenefit;
      breakdown.push({ strategyId: s.id, strategyTitle: s.title, type: 'tax_credit', taxReducedBy: s.netBenefit });
    }
  }

  // 공익법인 추가 출연액 반영
  if (foundationDonationAmt > 0) {
    adjustedEstate = Math.max(0, adjustedEstate - foundationDonationAmt);
  }

  const { tax: estateAdjustedTax } = calcInheritanceTax(adjustedEstate, members, priorGifts10yr);
  const adjustedTax = Math.max(0, estateAdjustedTax - directCreditTotal);
  const totalReduction = Math.max(0, originalTax - adjustedTax);

  return { adjustedEstate, adjustedTax, originalTax, totalReduction, breakdown };
}

// ── 최적 전략 도출 엔진 ──────────────────────────────────────────

// 자산별 지분 배분 상세 (다중 자산 배분 시 자산당 항목)
export interface AssetEquitySlice {
  assetId: string;
  assetName: string;
  assetType: string;
  currentValue: number;       // 자산 현재가치 (억)
  yieldPct: number;           // 수익률 (%)
  growthPct: number;          // 기대 성장률 (%)
  rank: number;               // 수익률 or 성장률 순위
  allocAmount: number;        // 배분 증여액 (억)
  equityPct: number;          // 해당 자산 내 지분율 (%)
  annualRental: number;       // 이 지분에서 나오는 연 임대수익 (억)
  dscrLoan: number;           // 이 지분 담보 DSCR 대출 (억)
  sortKey: 'yield' | 'growth'; // 배분 기준
}

export interface OptimalGiftPlan {
  memberId: string;
  memberName: string;
  relation: string;
  // ── 증여 대상 자산 (지분) ── 대표 자산 (기존 호환)
  assetId: string;
  assetName: string;
  assetYieldPct: number;         // 해당 자산 수익률 (%)
  equityPct: number;             // 대표 자산 지분율 (%)
  // ── 다중 자산 배분 상세 ──
  breakdown: AssetEquitySlice[];  // 자산별 지분 배분 내역
  // ── 증여세 계산 ──
  giftAmount: number;            // 증여액 총합 (억)
  deductionUsed: number;
  taxableAmount: number;
  giftTax: number;
  isGenSkip: boolean;
  genSkipSurcharge: number;
  totalTaxCost: number;
  // ── 절세 효과 ──
  estateReduction10yr: number;
  inheritanceTaxSaved: number;
  netBenefit: number;
  // ── 지분 현금흐름 (수증자 기준) ──
  annualRentalFromEquity: number; // 연 임대수익 (억/년)
  equityBackedLoan: number;       // 지분 담보 DSCR 대출 (억)
  childTotalFunding10yr: number;  // 10년간 확정 기여 현금흐름 (임대×10, 억)
  recipientCashForGiftTax: number; // 수증자 본인 자금으로 납부할 증여세 (억)
  familyLoanForGiftTax: number;    // 피상속인에게 실제 차용할 증여세 재원 (억)
  familyLoanAnnualDebtService: number; // 가족간 차용 연 원리금 상환액 (억)
  familyLoanRepaymentCapacity: number; // 수증자 추정 연 상환 재원 (억)
  bankLoanForGiftTax: number;       // 현금흐름으로 감당 가능한 담보대출 중 증여세 재원 투입액 (억)
  bankLoanAnnualInterestForGiftTax: number; // 위 대출의 연 이자 부담 (억/년)
  rationale: string;
}

// 자산별 LTV 대출 여력 (담보대출 계획용)
export interface AssetLoanSlice {
  assetId: string;
  assetName: string;
  assetType: string;
  currentValue: number;   // 현재 가치 (억)
  currentLoan: number;    // 현재 대출 잔액 (억)
  ltvPct: number;         // 적용 LTV (%, 기본 40)
  maxDebt: number;        // LTV 한도액 = currentValue × ltvPct/100 (억)
  additionalCapacity: number; // 추가 가능 대출 = maxDebt - currentLoan (억)
}

export interface OptimalFundingPlan {
  ownCash: number;                  // 가족간 차용 실행 후 피상속인 잔여 현금 (억)
  recipientExistingCash: number;    // 수증자 현금 중 증여세 납부 후 잔여 → 상속세 재원 (억)
  totalGiftTaxBudget: number;       // 증여세 재원 합계: 수증자 본인 현금 + 적법성 검토를 통과한 가족간 차용 (억)
  recipientCashUsedForGiftTax: number; // 증여세에 실제 투입되는 수증자 현금 (억)
  familyLoanForGiftTax: number;     // 증여세 재원용 가족간 차용 합계 (억)
  familyLoanAnnualDebtService: number; // 가족간 차용 연 원리금 상환 합계 (억)
  bankLoanForGiftTax: number;       // 증여세 재원용 담보대출 합계 (억)
  bankLoanAnnualInterestForGiftTax: number; // 증여세 재원 대출의 연 이자 합계 (억/년)
  bankLoanGiftTaxCapacity: number;  // DSCR·현금흐름으로 검증한 증여세 재원 대출 한도 (억)
  annualDebtServiceCapacityForGiftTax: number; // 신규 대출 이자 감당 가능액 (억/년)
  ownerCashReserveAfterLoans: number;  // 가족간 차용 후 피상속인 잔여 현금 (억)
  maxBankLoan: number;              // 피상속인 추가 담보대출 합계 (억)
  assetLoanBreakdown: AssetLoanSlice[]; // 자산별 LTV 대출 여력 상세
  equityRentalCashflow10yr: number; // 수증자들 지분 임대수익 10년 합계 (억)
  equityBackedChildLoans: number;   // 수증자들 지분 담보대출 합계 (억)
  accRentalAfterTax: number;        // 피상속인 잔여 임대수익 10년 세후 (억)
  installmentReserve: number;       // 연부연납 연간 납부액 (억)
  annualEstateRentalAfterTax: number; // 피상속인 잔여 세후 임대 현금흐름 (억/년)
  annualGiftedRental: number;       // 수증자 지분 임대 현금흐름 (억/년)
  annualRecurringCashflow: number;  // 등록 자산에서 확인되는 연간 반복 현금흐름 (억/년)
  annualInstallmentGap: number;     // 연부연납 연간 납부액 대비 반복 현금흐름 부족액 (억/년)
  annualReserveTarget: number;      // 상속 시 부족액을 10년 동안 보완하려면 필요한 연 적립액 (억/년)
  shortfallAfterOptionalLoans: number; // 선택 대출 한도를 모두 심사 통과해도 남는 부족액 (억)
  confirmedAvailable: number;       // 대출 실행 전 확인 가능한 재원 합계 (억)
  optionalLoanCapacity: number;     // 별도 심사 후 선택 가능한 대출 한도 (억)
  totalAvailable: number;           // 기존 UI 호환: confirmedAvailable과 동일
  inheritanceTaxTarget: number;
  surplus: number;
  riskLevel: 'safe' | 'tight' | 'danger';
}

export interface OptimalStrategyResult {
  // ── 현황 ──
  totalEstateNow: number;
  totalEstate10yr: number;
  totalEstate20yr: number;
  inheritanceTaxNow: number;
  inheritanceTaxAt10yr: number;   // 아무것도 안 할 경우
  inheritanceTaxAt20yr: number;   // 아무것도 안 할 경우
  marginalRate: number;           // 현재 한계세율 (0~0.5)

  // ── 증여 권고 ──
  giftPlans: OptimalGiftPlan[];
  totalGiftAmount: number;        // 총 증여액
  totalGiftTax: number;           // 총 증여세
  estateAfterGifts: number;       // 증여 후 과세가액
  useGenSkip: boolean;            // 세대생략 포함 여부
  genSkipReason: string;

  // ── 10년 후 최적화 기준 상속세 ──
  estateAfterGifts10yr: number;
  inheritanceTaxAt10yrOptimized: number;
  totalTaxSaving: number;         // vs 아무것도 안 할 때
  netSavingAfterGiftTax: number;  // 증여세 공제 후 순절세

  // ── 자금 조달 계획 ──
  funding: OptimalFundingPlan;

  // ── 실행 계획 ──
  actions: Array<{
    seq: number;
    timing: string;
    category: 'gift' | 'loan' | 'corp' | 'foundation' | 'tax_payment';
    title: string;
    amount: number;
    description: string;
    urgency: 'immediate' | 'within1yr' | 'plan';
  }>;

  // ── 핵심 요약 ──
  headline: string;
  keyStats: Array<{ label: string; value: string; highlight: boolean }>;
  warnings: string[];

  // ── 납부 전략 비교 (물납 / 지분 매각 / 차용증) ──
  paymentStrategies: Array<{
    type: 'in_kind' | 'equity_sale' | 'gift_tax_loan';
    name: string;
    coverageAmt: number;    // 상속세 충당 가능액 (억)
    taxCost: number;        // 이 전략에서 추가 발생하는 세금 (억)
    netCoverage: number;    // 세후 실 충당액 (억)
    coverageRatio: number;  // 상속세 대비 충당률 (%)
    pros: string[];
    cons: string[];
    condition: string;      // 적용 조건 요약
  }>;
}

export type OptimalStrategyMode =
  | 'optimal'          // 기본 — 한계분석으로 최적 증여액 산출
  | 'deduction_only'   // 공제 한도 내 — 증여세 0원만
  | 'force_gen_skip';  // 세대생략 강제 포함

export function calcOptimalStrategy(
  assets: Asset[],
  members: FamilyMember[],
  macro: MacroSettings | null,
  ownCash: number,                          // 보유 현금 (억)
  priorGifts10yr = 0,
  yearsHorizon = 10,
  ltvMap: Record<string, number> = {},      // 자산별 LTV 오버라이드 (assetId → %, 미지정 시 40%)
  mode: OptimalStrategyMode = 'optimal',   // 전략 모드
): OptimalStrategyResult {

  // ── 1. 기본 자산·세금 현황 ──────────────────────────────────
  const grossAssetValue = assets.reduce((s, a) => s + a.current_value, 0);
  const totalDebt      = assets.reduce((s, a) => s + a.loan_amount, 0);
  const annualRental   = assets.reduce((s, a) => s + a.current_value * a.annual_yield_pct / 100, 0);

  const projectedAssets10yr = assets.reduce((s, a) => s + projectAssetValue(a, 10, macro), 0);
  const projectedAssets20yr = assets.reduce((s, a) => s + projectAssetValue(a, 20, macro), 0);
  const avgGrowthPct = grossAssetValue > 0
    ? Math.pow(projectedAssets10yr / grossAssetValue, 1 / 10) - 1
    : 0;

  // 피상속인 현금도 상속재산입니다. 입력된 채무는 증빙 가능한 공제채무라는 전제로 차감합니다.
  // 현금·채무의 장래 변동은 알 수 없으므로 보수적으로 현재 금액을 유지합니다.
  const totalEstateNow = Math.max(0, grossAssetValue + ownCash - totalDebt);
  const totalEstate10yr = Math.max(0, projectedAssets10yr + ownCash - totalDebt);
  const totalEstate20yr = Math.max(0, projectedAssets20yr + ownCash - totalDebt);

  const { tax: inheritanceTaxNow, taxableBase: taxableBaseNow } = calcInheritanceTax(totalEstateNow, members, priorGifts10yr);
  const marginalRate =
    taxableBaseNow > 30 ? 0.50 :
    taxableBaseNow > 10 ? 0.40 :
    taxableBaseNow > 5  ? 0.30 :
    taxableBaseNow > 1  ? 0.20 : 0.10;
  const { tax: inheritanceTax10yr } = calcInheritanceTax(totalEstate10yr, members, 0);
  const { tax: inheritanceTax20yr } = calcInheritanceTax(totalEstate20yr, members, 0);

  // ── 2. 세대생략 여부 ──────────────────────────────────────────
  const grandchildren = members.filter(m => m.relation === '손자녀');
  const useGenSkip =
    mode === 'force_gen_skip'
      ? grandchildren.length > 0                                // 강제 포함
      : (grandchildren.length > 0 && marginalRate >= 0.40);    // 효율성 기준
  const genSkipReason = mode === 'force_gen_skip' && grandchildren.length > 0
    ? `세대생략 강제 포함 — 한계세율 ${(marginalRate * 100).toFixed(0)}%, 세대생략 할증 검토`
    : useGenSkip
      ? `한계상속세율 ${(marginalRate * 100).toFixed(0)}% → 세대생략 할증을 포함한 2세대 비교 필요`
      : grandchildren.length === 0
        ? '손자녀 없음 — 세대생략 해당 없음'
        : `한계상속세율 ${(marginalRate * 100).toFixed(0)}% — 세대생략 할증 감안 시 효과 미미`;

  // ── 3. 지분 증여 최적화 ─────────────────────────────────────
  // 원칙: 수증자 1인 = 자산 1개 (나중에 매각·관리 시 공유지분 복잡성 최소화)
  // 배정 방식: 수익률(자녀/손자녀) or 성장률(며느리/사위) 순위로 수증자마다 다른 자산 배정
  //   자녀1 → 수익률 1위, 자녀2 → 수익률 2위, 며느리 → 성장률 1위 …
  //   자산이 부족하면 남은 자산 중 가장 높은 순위 자산 재사용

  const yieldSortedAssets = [...assets].sort((a, b) => b.annual_yield_pct - a.annual_yield_pct);
  const growthSortedAssets = [...assets].sort((a, b) => getAssetGrowthRate(b, macro) - getAssetGrowthRate(a, macro));

  // 증여세 납부 주체는 수증자입니다.
  // 증여자가 세금을 대신 납부하면 추가 증여 문제가 생길 수 있으므로
  // 피상속인 현금은 수증자의 증여세 예산에 자동 합산하지 않습니다.

  const children = members.filter(m => m.relation === '자녀');
  const dilSil   = members.filter(m => ['며느리', '사위'].includes(m.relation));
  const giftRecipients: Array<{ member: FamilyMember; priority: number }> = [
    ...children.map(m   => ({ member: m, priority: 1 })),
    ...(useGenSkip ? grandchildren.map(m => ({ member: m, priority: 2 })) : []),
    ...dilSil.map(m     => ({ member: m, priority: 3 })),
  ].sort((a, b) => a.priority - b.priority);

  // ── 수증자별 전담 자산 사전 배정 (1인 1자산) ───────────────────
  // 자녀/손자녀 그룹: 수익률 순, 며느리/사위 그룹: 성장률 순
  // 같은 그룹 내 수증자마다 순서대로 다른 자산 배정 → 공유지분 최소화
  const yieldQueue   = [...yieldSortedAssets];   // 자녀/손자녀용 큐 (소비되면 첫번째로 fallback)
  const growthQueue  = [...growthSortedAssets];  // 며느리/사위용 큐
  const assignedAsset = new Map<string, Asset>();

  for (const { member } of giftRecipients) {
    if (['자녀', '손자녀'].includes(member.relation)) {
      assignedAsset.set(member.id, yieldQueue.shift() ?? yieldSortedAssets[0]);
    } else {
      assignedAsset.set(member.id, growthQueue.shift() ?? growthSortedAssets[0]);
    }
  }

  // 수증자 전체 현금 합계 (증여세 예산 계산용) — Supabase numeric→string 방어
  const totalRecipientCash = giftRecipients.reduce((s, { member }) => s + Number(member.cash_hold ?? 0), 0);

  // 증여세 재원으로 쓸 수 있는 담보대출은 자산 LTV만 보지 않고,
  // 신규 이자 부담을 현재 반복 현금흐름과 DSCR 기준으로 다시 제한합니다.
  const DEFAULT_LTV = 40;
  const assetLoanBreakdown: AssetLoanSlice[] = assets.map(a => {
    const ltvPct         = ltvMap[a.id] ?? DEFAULT_LTV;
    const maxDebt        = a.current_value * ltvPct / 100;
    const additionalCapacity = Math.max(0, maxDebt - a.loan_amount);
    return {
      assetId: a.id, assetName: a.name, assetType: a.asset_type,
      currentValue: a.current_value, currentLoan: a.loan_amount,
      ltvPct, maxDebt, additionalCapacity,
    };
  });
  const maxBankLoan = assetLoanBreakdown.reduce((s, b) => s + b.additionalCapacity, 0);
  const currentAnnualDebtService = assets.reduce(
    (s, a) => s + a.loan_amount * Math.max(0, a.loan_rate_pct) / 100,
    0,
  );
  const annualHoldingTaxNow = calcAnnualHoldingTaxes(assets).total;
  const annualRentalTaxNow = calcRentalIncomeTax(annualRental, 0);
  const annualNetCashflowBeforeGiftLoans = Math.max(
    0,
    annualRental - annualHoldingTaxNow - annualRentalTaxNow - currentAnnualDebtService,
  );
  const dscrDebtServiceHeadroom = Math.max(
    0,
    annualRental / MIN_DSCR_AFTER_NEW_LOAN - currentAnnualDebtService,
  );
  const cashflowDebtServiceHeadroom = annualNetCashflowBeforeGiftLoans * CASHFLOW_DEBT_SERVICE_USE_RATIO;
  const annualDebtServiceCapacityForGiftTax = Math.max(
    0,
    Math.min(dscrDebtServiceHeadroom, cashflowDebtServiceHeadroom),
  );
  const cashflowBackedBankLoanCapacity = annualDebtServiceCapacityForGiftTax / BANK_GIFT_LOAN_RATE;
  const bankLoanGiftTaxCapacity = Math.min(maxBankLoan, cashflowBackedBankLoanCapacity);

  const giftPlans: OptimalGiftPlan[] = [];
  const allocatedByAsset = new Map<string, number>();
  let remainingOwnerLoanCash = Math.max(0, ownCash);
  let remainingBankGiftTaxCapacity = bankLoanGiftTaxCapacity;
  let remainingBankGiftTaxAnnualInterestCapacity = annualDebtServiceCapacityForGiftTax;

  for (const { member } of giftRecipients) {
    const isGenSkip = member.relation === '손자녀';

    // 증여 대상 자산: 사전 배정된 전담 자산 (1인 1자산)
    const preferredAsset = assignedAsset.get(member.id) ?? assets[0];
    const rankedAssets = ['자녀', '손자녀'].includes(member.relation)
      ? yieldSortedAssets
      : growthSortedAssets;
    const targetAsset = (preferredAsset && (allocatedByAsset.get(preferredAsset.id) ?? 0) < preferredAsset.current_value)
      ? preferredAsset
      : rankedAssets.find(a => (allocatedByAsset.get(a.id) ?? 0) < a.current_value) ?? preferredAsset;
    const assetYieldPct  = targetAsset?.annual_yield_pct ?? 0;
    const assetYieldRate = assetYieldPct / 100;
    const assetGrowthRate = targetAsset ? getAssetGrowthRate(targetAsset, macro) : avgGrowthPct;
    const availableTargetValue = targetAsset
      ? Math.max(0, targetAsset.current_value - (allocatedByAsset.get(targetAsset.id) ?? 0))
      : 0;

    // 수증자별 증여세 재원: 본인 현금 + 실제 상환 능력이 있는 가족간 차용만 허용
    const recipientOwnCash = Number(member.cash_hold ?? 0);
    const recipientAnnualIncome = Number(member.annual_income ?? 0);

    // 직계비속 성년/미성년 공제 적용 (상증법§53)
    const deduction = ['자녀', '손자녀'].includes(member.relation)
      ? (member.age >= 19 ? 0.5 : 0.2)
      : (GIFT_DEDUCTIONS[member.relation] ?? 0.1);

    // ① 공제 한도 이내: 항상 권고 (증여세 0, 예산 무관)
    let giftAmount = Math.min(deduction, availableTargetValue);

    // ② 공제 초과 증여: deduction_only 모드에서는 생략 (증여세 0 유지)
    //    편익 = 상속세 절감 + 수증자 10년 임대수익 + 수증자 DSCR 대출
    if (mode === 'deduction_only') {
      // 공제 한도만 사용 — 루프 생략
    }
    for (let extra = 0.5; mode !== 'deduction_only' && extra <= 100; extra += 0.5) {
      const candidateGift = deduction + extra;
      if (candidateGift > availableTargetValue) break;
      const candidateTax  = calcGiftTax(candidateGift, member.relation, 0, isGenSkip, false, member.age);
      const prevTax        = calcGiftTax(candidateGift - 0.5, member.relation, 0, isGenSkip, false, member.age);
      const marginalGiftTax = candidateTax - prevTax;

      // 한계 편익: 0.5억이 10년간 성장한 미래가치만큼 과표에서 제외되는 효과.
      // 임대수익과 담보대출은 부를 새로 만들지 않으므로 절세 편익에 더하지 않고,
      // 아래 가족간 차용 상환 능력 및 상속세 재원 검증에만 사용합니다.
      const marginalEstateSaving  = 0.5 * Math.pow(1 + assetGrowthRate, 10) * marginalRate;
      const candidateLoan = calcCompliantFamilyLoanPlan(
        remainingOwnerLoanCash,
        candidateTax,
        recipientOwnCash,
        recipientAnnualIncome,
        candidateGift * assetYieldRate,
      );
      const candidateFamilyLoan = candidateLoan.canService ? candidateLoan.familyLoanAmount : 0;
      const candidateAfterRecipientFamily = Math.max(
        0,
        candidateTax - candidateLoan.recipientCashUsed - candidateFamilyLoan,
      );
      const candidateBankLoanInterest = candidateAfterRecipientFamily * BANK_GIFT_LOAN_RATE;
      const candidateBankLoanOk = candidateAfterRecipientFamily <= remainingBankGiftTaxCapacity + 1e-9
        && candidateBankLoanInterest <= remainingBankGiftTaxAnnualInterestCapacity + 1e-9;

      if (candidateAfterRecipientFamily > 1e-9 && !candidateBankLoanOk) break;
      if (marginalGiftTax > marginalEstateSaving * 1.1) break; // 한계 비효율
      giftAmount = candidateGift;
    }

    // giftAmount가 자산 가치를 초과할 수 없으므로 캡 적용
    const cappedGiftAmount = targetAsset
      ? Math.min(giftAmount, targetAsset.current_value)
      : giftAmount;
    const equityPct = targetAsset ? (cappedGiftAmount / targetAsset.current_value) * 100 : 0;

    // ── 단일 자산 breakdown (1인 1자산 원칙) ─────────────────────
    const useYieldRank = ['자녀', '손자녀'].includes(member.relation);
    const annualRentalFromEquity = cappedGiftAmount * assetYieldRate;
    const dscrLoan = assetYieldRate > 0
      ? annualRentalFromEquity / (0.046 * 1.5) : 0;
    const ltvLoan  = cappedGiftAmount * 0.70;
    const equityBackedLoan = Math.min(dscrLoan, ltvLoan);

    // 수익률/성장률 전체 순위 계산 (몇 번째로 좋은 자산인지 표시용)
    const rankList = useYieldRank ? yieldSortedAssets : growthSortedAssets;
    const assetRank = rankList.findIndex(a => a.id === targetAsset?.id) + 1;

    const breakdown: AssetEquitySlice[] = targetAsset ? [{
      assetId: targetAsset.id, assetName: targetAsset.name, assetType: targetAsset.asset_type,
      currentValue: targetAsset.current_value,
      yieldPct: targetAsset.annual_yield_pct, growthPct: assetGrowthRate * 100,
      rank: assetRank || 1,
      allocAmount: cappedGiftAmount, equityPct,
      annualRental: annualRentalFromEquity, dscrLoan: equityBackedLoan,
      sortKey: useYieldRank ? 'yield' : 'growth',
    }] : [];

    const giftTax = calcGiftTax(cappedGiftAmount, member.relation, 0, isGenSkip, false, member.age);
    const genSkipSurcharge = isGenSkip ? giftTax - calcGiftTax(cappedGiftAmount, '자녀', 0, false, false, member.age) : 0;
    const taxableAmount = Math.max(0, cappedGiftAmount - deduction);

    const estateReduction10yr = cappedGiftAmount * Math.pow(1 + assetGrowthRate, 10);
    const inheritanceTaxSaved = estateReduction10yr * marginalRate;
    const netBenefit = inheritanceTaxSaved - giftTax;
    const childTotalFunding10yr = annualRentalFromEquity * 10;
    const giftTaxFunding = calcCompliantFamilyLoanPlan(
      remainingOwnerLoanCash,
      giftTax,
      recipientOwnCash,
      recipientAnnualIncome,
      annualRentalFromEquity,
    );
    const familyLoanForGiftTax = giftTaxFunding.canService ? giftTaxFunding.familyLoanAmount : 0;
    const familyLoanAnnualDebtService = familyLoanForGiftTax > 0 ? giftTaxFunding.annualDebtService : 0;
    const giftTaxAfterRecipientFamily = Math.max(
      0,
      giftTax - giftTaxFunding.recipientCashUsed - familyLoanForGiftTax,
    );
    const bankLoanForGiftTax = Math.min(remainingBankGiftTaxCapacity, giftTaxAfterRecipientFamily);
    const bankLoanAnnualInterestForGiftTax = bankLoanForGiftTax * BANK_GIFT_LOAN_RATE;
    remainingOwnerLoanCash = Math.max(0, remainingOwnerLoanCash - familyLoanForGiftTax);
    remainingBankGiftTaxCapacity = Math.max(0, remainingBankGiftTaxCapacity - bankLoanForGiftTax);
    remainingBankGiftTaxAnnualInterestCapacity = Math.max(
      0,
      remainingBankGiftTaxAnnualInterestCapacity - bankLoanAnnualInterestForGiftTax,
    );
    if (targetAsset) {
      allocatedByAsset.set(
        targetAsset.id,
        (allocatedByAsset.get(targetAsset.id) ?? 0) + cappedGiftAmount,
      );
    }

    // ── 근거 문장 ──
    const rentalNote = annualRentalFromEquity >= 0.01
      ? `연 임대 ${annualRentalFromEquity.toFixed(2)}억`
      : `연 임대 ${(annualRentalFromEquity * 10000).toFixed(0)}만원`;
    const rankLabel = assetRank ? ` (수익률 ${assetRank}위)` : '';
    const rationale = isGenSkip
      ? `세대생략 지분증여: ${targetAsset?.name ?? ''}${rankLabel} ${equityPct.toFixed(1)}%(${cappedGiftAmount.toFixed(1)}억). 할증 ${genSkipSurcharge.toFixed(2)}억 감수 → 자녀→손자녀 2차 상속세 절약. ${rentalNote}, 10년 누적 현금흐름 ${childTotalFunding10yr.toFixed(1)}억`
      : giftTax === 0
        ? `지분증여 — 증여세 0. ${targetAsset?.name ?? ''}${rankLabel} ${equityPct.toFixed(1)}%(${cappedGiftAmount.toFixed(1)}억). ${rentalNote}, 10년 누적 현금흐름 ${childTotalFunding10yr.toFixed(1)}억`
        : `지분증여세 ${giftTax.toFixed(2)}억 → 상속세 절감 ${inheritanceTaxSaved.toFixed(1)}억 + 기여 ${childTotalFunding10yr.toFixed(1)}억, 총 편익 ${netBenefit.toFixed(1)}억`;

    giftPlans.push({
      memberId: member.id,
      memberName: member.name,
      relation: member.relation,
      assetId: targetAsset?.id ?? '',
      assetName: targetAsset?.name ?? '해당 자산',
      assetYieldPct,
      equityPct,
      breakdown,
      giftAmount: cappedGiftAmount,
      deductionUsed: deduction,
      taxableAmount,
      giftTax,
      isGenSkip,
      genSkipSurcharge,
      totalTaxCost: giftTax,
      estateReduction10yr,
      inheritanceTaxSaved,
      netBenefit,
      annualRentalFromEquity,
      equityBackedLoan,
      childTotalFunding10yr,
      recipientCashForGiftTax: giftTaxFunding.recipientCashUsed,
      familyLoanForGiftTax,
      familyLoanAnnualDebtService,
      familyLoanRepaymentCapacity: giftTaxFunding.annualRepaymentCapacity,
      bankLoanForGiftTax,
      bankLoanAnnualInterestForGiftTax,
      rationale,
    });
  }

  const totalGiftAmount = giftPlans.reduce((s, p) => s + p.giftAmount, 0);
  const totalGiftTax    = giftPlans.reduce((s, p) => s + p.giftTax, 0);
  const estateAfterGifts = Math.max(0, totalEstateNow - totalGiftAmount);

  // ── 4. 10년 후 최적화 상속세 ─────────────────────────────────
  const giftFutureValue10yr = giftPlans.reduce((s, p) => s + p.estateReduction10yr, 0);
  const estateAfterGifts10yr = Math.max(0, totalEstate10yr - giftFutureValue10yr);
  const { tax: inheritanceTaxAt10yrOptimized } = calcInheritanceTax(estateAfterGifts10yr, members, 0);
  const totalTaxSaving = Math.max(0, inheritanceTax10yr - inheritanceTaxAt10yrOptimized);
  const netSavingAfterGiftTax = Math.max(0, totalTaxSaving - totalGiftTax);

  // ── 5. 자금 조달 계획 ─────────────────────────────────────────

  // 자녀들이 지분 담보로 빌릴 수 있는 총액 (DSCR 기반)
  const equityBackedChildLoans = giftPlans.reduce((s, p) => s + p.equityBackedLoan, 0);

  // 자녀들이 지분에서 얻는 10년 임대수익 합계
  const equityRentalCashflow10yr = giftPlans.reduce((s, p) => s + p.annualRentalFromEquity * 10, 0);

  // 피상속인 잔여 임대수익: 전체 임대에서 증여한 지분 임대 차감
  const giftedAnnualRental = giftPlans.reduce((s, p) => s + p.annualRentalFromEquity, 0);
  const remainingAnnualRental = Math.max(0, annualRental - giftedAnnualRental);
  const annualRentalAfterTax = Math.max(0, remainingAnnualRental - calcRentalIncomeTax(remainingAnnualRental, 0));
  const accRentalAfterTax = annualRentalAfterTax * 10;

  // 수증자 현금: 증여세 납부에 먼저 사용 → 잔여분이 상속세 재원
  // 피상속인 현금은 수증자에게 자동 증여하지 않고, 상환 능력을 확인한 가족간 차용으로만 반영합니다.
  const recipientCashUsedForGiftTax = giftPlans.reduce((s, p) => s + p.recipientCashForGiftTax, 0);
  const familyLoanForGiftTax = giftPlans.reduce((s, p) => s + p.familyLoanForGiftTax, 0);
  const familyLoanAnnualDebtService = giftPlans.reduce((s, p) => s + p.familyLoanAnnualDebtService, 0);
  const bankLoanForGiftTax = giftPlans.reduce((s, p) => s + p.bankLoanForGiftTax, 0);
  const bankLoanAnnualInterestForGiftTax = giftPlans.reduce((s, p) => s + p.bankLoanAnnualInterestForGiftTax, 0);
  const totalGiftTaxBudget = totalRecipientCash + familyLoanForGiftTax + bankLoanForGiftTax;
  const recipientExistingCash = Math.max(
    0,
    totalRecipientCash - recipientCashUsedForGiftTax,
  );

  const installmentReserve = inheritanceTaxAt10yrOptimized / 11;

  const ownerCashAfterGift = Math.max(0, ownCash - familyLoanForGiftTax);
  const confirmedAvailable = Math.max(0, ownerCashAfterGift
    + recipientExistingCash
    + equityRentalCashflow10yr
    + accRentalAfterTax
    - bankLoanAnnualInterestForGiftTax * 10);
  const optionalLoanCapacity = Math.max(0, maxBankLoan - bankLoanForGiftTax) + equityBackedChildLoans;
  const totalAvailable = confirmedAvailable;
  const surplus = confirmedAvailable - inheritanceTaxAt10yrOptimized;
  const annualRecurringCashflow = annualRentalAfterTax + giftedAnnualRental - bankLoanAnnualInterestForGiftTax;
  const annualInstallmentGap = Math.max(0, installmentReserve - annualRecurringCashflow);
  const annualReserveTarget = Math.max(0, -surplus) / 10;
  const shortfallAfterOptionalLoans = Math.max(0, -surplus - optionalLoanCapacity);

  const riskLevel: 'safe' | 'tight' | 'danger' =
    surplus > inheritanceTaxAt10yrOptimized * 0.3 ? 'safe'
    : surplus > 0 ? 'tight'
    : 'danger';

  const funding: OptimalFundingPlan = {
    ownCash: ownerCashAfterGift,
    recipientExistingCash,
    totalGiftTaxBudget,
    recipientCashUsedForGiftTax,
    familyLoanForGiftTax,
    familyLoanAnnualDebtService,
    bankLoanForGiftTax,
    bankLoanAnnualInterestForGiftTax,
    bankLoanGiftTaxCapacity,
    annualDebtServiceCapacityForGiftTax,
    ownerCashReserveAfterLoans: ownerCashAfterGift,
    maxBankLoan,
    assetLoanBreakdown,
    equityRentalCashflow10yr,
    equityBackedChildLoans,
    accRentalAfterTax,
    installmentReserve,
    annualEstateRentalAfterTax: annualRentalAfterTax,
    annualGiftedRental: giftedAnnualRental,
    annualRecurringCashflow,
    annualInstallmentGap,
    annualReserveTarget,
    shortfallAfterOptionalLoans,
    confirmedAvailable,
    optionalLoanCapacity,
    totalAvailable,
    inheritanceTaxTarget: inheritanceTaxAt10yrOptimized,
    surplus,
    riskLevel,
  };

  // ── 6. 실행 계획 ─────────────────────────────────────────────
  const actions: OptimalStrategyResult['actions'] = [];
  let seq = 1;

  // 즉시: 지분 증여 (자녀)
  const childGifts = giftPlans.filter(p => p.relation === '자녀');
  if (childGifts.length > 0) {
    const childGiftTotal = childGifts.reduce((s, p) => s + p.giftAmount, 0);
    const childGiftTax   = childGifts.reduce((s, p) => s + p.giftTax, 0);
    const childLoanTotal = childGifts.reduce((s, p) => s + p.equityBackedLoan, 0);
    actions.push({
      seq: seq++, timing: '지금 즉시', category: 'gift', urgency: 'immediate',
      title: `자녀 ${childGifts.length}명에게 자산 지분 증여`,
      amount: childGiftTotal,
      description: `총 ${childGiftTotal.toFixed(1)}억 지분 이전 (증여세 ${childGiftTax.toFixed(2)}억). `
        + `지분 이전 후 연 임대 현금흐름을 별도 적립하고, 부족할 때만 지분 담보대출 한도 ${childLoanTotal.toFixed(1)}억을 비교. `
        + `지분 등기·증여세 신고 증여일로부터 3개월 이내.`,
    });
  }

  // 즉시: 손자녀 세대생략
  if (useGenSkip && giftPlans.filter(p => p.isGenSkip).length > 0) {
    const skipGifts = giftPlans.filter(p => p.isGenSkip);
    const skipTotal = skipGifts.reduce((s, p) => s + p.giftAmount, 0);
    actions.push({
      seq: seq++, timing: '지금 즉시 (자녀증여와 동시)', category: 'gift', urgency: 'immediate',
      title: `손자녀 ${skipGifts.length}명에게 세대생략 지분 증여`,
      amount: skipTotal,
      description: `총 ${skipTotal.toFixed(1)}억 세대생략증여. 일반 30%, 미성년 고액증여 40% 할증 가능성을 반영해 1차·2차 상속을 별도 비교.`,
    });
  }

  // 증여세 재원용 가족간 차용: 피상속인 현금이 있고 실제 원리금 상환 능력을 확인한 경우에만 반영
  if (familyLoanForGiftTax > 0) {
    actions.push({
      seq: seq++, timing: '증여 계약 전', category: 'loan', urgency: 'immediate',
      title: '수증자별 증여세 재원 차용 계약',
      amount: familyLoanForGiftTax,
      description: `피상속인 현금 중 ${familyLoanForGiftTax.toFixed(2)}억을 수증자에게 실제 대여. `
        + `추정 연 원리금 상환액 ${familyLoanAnnualDebtService.toFixed(2)}억. `
        + `계약서·계좌이체·정기 상환 내역을 남기고, 미상환 채권은 피상속인 상속재산에 포함해 관리.`,
    });
  }

  if (bankLoanForGiftTax > 0) {
    actions.push({
      seq: seq++, timing: '증여 계약 전', category: 'loan', urgency: 'immediate',
      title: '현금흐름 한도 내 담보대출로 증여세 재원 확보',
      amount: bankLoanForGiftTax,
      description: `자산별 LTV와 DSCR ${MIN_DSCR_AFTER_NEW_LOAN.toFixed(1)}배, 반복 순현금흐름 ${(CASHFLOW_DEBT_SERVICE_USE_RATIO * 100).toFixed(0)}% 한도 안에서 ${bankLoanForGiftTax.toFixed(2)}억을 증여세 재원으로 먼저 배정합니다. `
        + `보수 금리 ${(BANK_GIFT_LOAN_RATE * 100).toFixed(1)}% 기준 연 이자 ${bankLoanAnnualInterestForGiftTax.toFixed(2)}억은 이후 현금흐름과 확인 재원에서 차감했습니다. `
        + `실제 실행 전 은행 심사, 임대차 안정성, 금리 상승 스트레스를 다시 확인해야 합니다.`,
    });
  }

  if (surplus < 0) {
    actions.push({
      seq: seq++, timing: '증여 계약 전 또는 동시에', category: 'tax_payment', urgency: 'immediate',
      title: '상속세 부족액 보완안 확정',
      amount: Math.abs(surplus),
      description: `10년 후 상속세 ${inheritanceTaxAt10yrOptimized.toFixed(1)}억 대비 확인 재원은 ${confirmedAvailable.toFixed(1)}억입니다. `
        + `남은 ${Math.abs(surplus).toFixed(1)}억은 금융자산 적립, 일부 매각, 물납, 생명보험 인수 가능 여부, 상환 가능한 대출을 금액별로 비교해 확정해야 합니다. `
        + `연부연납은 납부 시점만 나누며 부족 재원을 만들지 않습니다.`,
    });
  }

  // 연부연납
  actions.push({
    seq: seq++, timing: '상속 발생 시 즉시 (신고기한 6개월 내)', category: 'tax_payment', urgency: 'plan',
    title: '연부연납 10년 분할 신청',
    amount: inheritanceTaxAt10yrOptimized,
    description: `신고기한 내 최초 ${installmentReserve.toFixed(2)}억 납부 후, 연 ${installmentReserve.toFixed(2)}억 × 10년. `
      + `등록된 반복 현금흐름은 피상속인 잔여 임대 ${annualRentalAfterTax.toFixed(2)}억/년 + 수증자 지분 임대 ${giftedAnnualRental.toFixed(2)}억/년 = ${annualRecurringCashflow.toFixed(2)}억/년입니다. `
      + (annualInstallmentGap > 0
        ? `따라서 연 ${annualInstallmentGap.toFixed(2)}억이 부족합니다. 별도 재원 없이 연부연납만 신청하는 안은 실행 가능한 납부안이 아닙니다.`
        : '등록 현금흐름 범위에서는 연간 납부액을 충당할 수 있습니다.'),
  });

  // ── 7. 경고 ──────────────────────────────────────────────────
  const warnings: string[] = [];
  if (riskLevel === 'danger') {
    warnings.push(`⚠ 10년 후 상속세 ${inheritanceTaxAt10yrOptimized.toFixed(1)}억 대비 확인 재원 ${confirmedAvailable.toFixed(1)}억 — ${Math.abs(surplus).toFixed(1)}억 부족. 금융자산 확보, 증여 규모 조정, 연부연납, 물납, 일부 매각을 먼저 비교하세요.`);
    warnings.push(`📌 연부연납 원금은 연 ${installmentReserve.toFixed(2)}억이지만 등록 반복 현금흐름은 연 ${annualRecurringCashflow.toFixed(2)}억입니다. 연 ${annualInstallmentGap.toFixed(2)}억 갭을 별도 재원으로 확정해야 합니다.`);
  }
  if (riskLevel === 'tight') {
    warnings.push(`📌 자금이 빠듯합니다. 연부연납 연 ${installmentReserve.toFixed(2)}억 — 임대수익(피상속인 ${annualRentalAfterTax.toFixed(2)}억 + 자녀 ${giftedAnnualRental.toFixed(2)}억)으로 충당 가능 여부 매년 점검.`);
  }
  if (familyLoanForGiftTax > 0) {
    warnings.push(`📄 가족간 차용 ${familyLoanForGiftTax.toFixed(2)}억은 자동 절세가 아닙니다. 실제 원리금 상환, 계좌이체, 계약서 보관이 전제이며 미상환 채권은 상속재산에 남습니다.`);
  }
  if (bankLoanForGiftTax > 0) {
    warnings.push(`🏦 증여세 재원 담보대출 ${bankLoanForGiftTax.toFixed(2)}억을 반영했습니다. 연 이자 ${bankLoanAnnualInterestForGiftTax.toFixed(2)}억을 반복 현금흐름에서 차감했으며, 금리·공실 스트레스 시 증여 규모를 줄여야 합니다.`);
  }
  if (annualRecurringCashflow < 0) {
    warnings.push(`🚨 증여세 재원 대출 후 등록 반복 현금흐름이 연 ${annualRecurringCashflow.toFixed(2)}억입니다. 절세 효과와 별개로 매년 버티는 구조가 아니므로 대출 비중 또는 증여액을 낮춰야 합니다.`);
  }
  if (totalGiftTax > 0 && ownCash > 0 && familyLoanForGiftTax >= ownCash * 0.8) {
    warnings.push(`💡 증여세 재원용 가족간 차용이 보유 현금의 ${(familyLoanForGiftTax / ownCash * 100).toFixed(0)}%입니다. 피상속인 생활비·비상자금 유보액을 별도로 확정하세요.`);
  }
  if (yieldSortedAssets[0] && yieldSortedAssets[0].annual_yield_pct > 4) {
    const top = yieldSortedAssets[0];
    warnings.push(`🏠 수익률 ${top.annual_yield_pct}% ${top.name}을 우선 증여 — 수증자 임대수익이 가장 높아 장기 현금흐름 개선 효과가 큽니다.`);
  }

  // ── 8. 핵심 요약 ─────────────────────────────────────────────
  const totalChildFunding = giftPlans.reduce((s, p) => s + p.childTotalFunding10yr, 0);
  const headline = riskLevel === 'safe'
    ? `지분 ${totalGiftAmount.toFixed(1)}억 즉시 이전 → 수증자 10년 임대수익 ${totalChildFunding.toFixed(1)}억. 10년 후 상속세 ${inheritanceTaxAt10yrOptimized.toFixed(1)}억 (절세 ${totalTaxSaving.toFixed(1)}억)`
    : riskLevel === 'tight'
    ? `지분 증여 후 확인 재원이 빠듯합니다 — 연부연납·물납·일부 매각을 비교하세요`
    : `납부 재원 부족 — 금융자산 확보·분할증여·물납·일부 매각을 먼저 비교하세요`;

  const keyStats: OptimalStrategyResult['keyStats'] = [
    { label: '현재 상속세',          value: `${inheritanceTaxNow.toFixed(1)}억`,              highlight: false },
    { label: '10년후 상속세 (현상유지)', value: `${inheritanceTax10yr.toFixed(1)}억`,          highlight: false },
    { label: '전략 후 10년 상속세',   value: `${inheritanceTaxAt10yrOptimized.toFixed(1)}억`, highlight: true  },
    { label: '총 지분 증여액',        value: `${totalGiftAmount.toFixed(1)}억`,               highlight: false },
    { label: '증여세 비용',           value: `${totalGiftTax.toFixed(2)}억`,                  highlight: false },
    { label: '수증자 10년 임대수익', value: `${totalChildFunding.toFixed(1)}억`,             highlight: true  },
    { label: '확인 재원 합계',        value: `${confirmedAvailable.toFixed(1)}억`,            highlight: false },
    { label: '선택 가능 대출 한도',  value: `${optionalLoanCapacity.toFixed(1)}억`,           highlight: false },
    { label: '납부 여유/부족',        value: `${surplus >= 0 ? '+' : ''}${surplus.toFixed(1)}억`, highlight: true },
  ];

  // ── 9. 납부 전략 비교 ────────────────────────────────────────
  const taxTarget = inheritanceTaxAt10yrOptimized;
  const paymentStrategies: OptimalStrategyResult['paymentStrategies'] = [];

  // ① 물납 (상증법 §73): 부동산 현물로 상속세 납부
  // - 상속재산 중 부동산으로 납부, 상속세 전액 충당 가능
  // - 매각 없이 납부하지만 해당 자산을 잃음
  const realEstateAssets = assets.filter(a => ['주거용부동산', '상업용부동산', '토지'].includes(a.asset_type));
  const realEstateValue10yr = realEstateAssets.reduce((s, a) => s + projectAssetValue(a, 10, macro), 0);
  if (realEstateValue10yr > 0) {
    const inKindCoverage = Math.min(taxTarget, realEstateValue10yr);
    paymentStrategies.push({
      type: 'in_kind',
      name: '부동산 물납',
      coverageAmt: inKindCoverage,
      taxCost: 0,
      netCoverage: inKindCoverage,
      coverageRatio: taxTarget > 0 ? (inKindCoverage / taxTarget) * 100 : 0,
      pros: [
        '현금 없이 부동산 현물로 납부 가능',
        '급매 없이 시간 확보 (물납 신청 후 6개월)',
        '담보 제공 불필요',
      ],
      cons: [
        '해당 부동산을 국가에 귀속 (소유권 상실)',
        '물납 심사 과정에서 감정평가 필요',
        '분양·임대 중인 부동산은 물납 제한 가능',
      ],
      condition: `상속세 ${taxTarget.toFixed(1)}억 > 2천만원 ✓ / 상속 부동산 ${realEstateValue10yr.toFixed(1)}억으로 전액 물납 가능`,
    });
  }

  // ② 증여받은 지분 매각 → 양도소득세 납부 후 상속세 충당
  // 취득가액: 증여 시 시가 (기준시가 아닌 시가로 계산, 유리)
  // 10년 보유 후 매각 → 장기보유특별공제 20%
  if (totalGiftAmount > 0) {
    const HOLD_YEARS = 10;
    const saleValue = giftPlans.reduce(
      (s, p) => s + p.giftAmount * Math.pow(1 + (p.breakdown[0]?.growthPct ?? avgGrowthPct * 100) / 100, HOLD_YEARS),
      0,
    );
    const capitalGain = Math.max(0, saleValue - totalGiftAmount); // 취득가 = 증여 시 시가
    const lthdRate = HOLD_YEARS >= 10 ? 0.20 : HOLD_YEARS >= 5 ? 0.10 : HOLD_YEARS >= 3 ? 0.06 : 0;
    const deductedGain = capitalGain * (1 - lthdRate);
    const taxableGain = Math.max(0, deductedGain - 0.025);
    const capGainsTax = calcIncomeTax(taxableGain); // 2년+ → 기본세율
    const netProceeds = saleValue - capGainsTax;
    const coverage = Math.min(netProceeds, taxTarget);
    paymentStrategies.push({
      type: 'equity_sale',
      name: '지분 매각 후 납부',
      coverageAmt: saleValue,
      taxCost: capGainsTax,
      netCoverage: netProceeds,
      coverageRatio: taxTarget > 0 ? (netProceeds / taxTarget) * 100 : 0,
      pros: [
        `취득가액 = 증여 시 시가 → 양도차익 = 가치상승분(${capitalGain.toFixed(1)}억)만 과세`,
        `${HOLD_YEARS}년 장기보유특별공제 ${(lthdRate * 100).toFixed(0)}% → 과세표준 압축`,
        '수익률 높은 지분 유지하다 필요 시 일부만 매각 가능',
      ],
      cons: [
        `양도소득세 ${capGainsTax.toFixed(1)}억 발생 (기본세율 ${HOLD_YEARS}년 보유)`,
        '매각 시점 부동산 시장 여건 의존',
        '매각 전 DSCR·LTV 관리 필요',
      ],
      condition: `증여 지분 ${HOLD_YEARS}년 보유 후 매각 예상가 ${saleValue.toFixed(1)}억 → 양도세 ${capGainsTax.toFixed(1)}억 → 순수입 ${netProceeds.toFixed(1)}억`,
    });
  }

  // ③ 차용증으로 증여세 납부: 피상속인이 수증자에게 실제로 대여
  // 무이자 한도: 1천만원 ÷ 4.6% ≈ 2.17억
  // 이자 > 1천만원이면 4.6% 이자 납부 필요 (안 내면 증여로 간주)
  if (familyLoanForGiftTax > 0) {
    const NO_INTEREST_MAX = LOAN_GIFT_THRESHOLD / FAIR_LOAN_RATE; // ≈ 2.17억
    const loanFromOwner = familyLoanForGiftTax;
    const annualInterest = loanFromOwner > NO_INTEREST_MAX ? loanFromOwner * FAIR_LOAN_RATE : 0;
    const totalRentalFromGifts = giftPlans.reduce((s, p) => s + p.annualRentalFromEquity, 0);
    const rentalCoversInterest = totalRentalFromGifts >= annualInterest;
    paymentStrategies.push({
      type: 'gift_tax_loan',
      name: '차용증으로 증여세 납부',
      coverageAmt: loanFromOwner,
      taxCost: annualInterest * 10, // 10년 이자 총액
      netCoverage: loanFromOwner,
      coverageRatio: totalGiftTax > 0 ? (loanFromOwner / totalGiftTax) * 100 : 0,
      pros: [
        '피상속인 현금을 적법한 차용 구조로 증여세 재원에 활용',
        `이자상당이익 임계금액을 역산한 참고액 ${NO_INTEREST_MAX.toFixed(1)}억`,
        '지분 임대수익과 수증자 소득으로 실제 원리금 상환 계획 수립',
      ],
      cons: [
        '계약서 + 실제 원리금 계좌이체 내역 보관 필수',
        loanFromOwner > NO_INTEREST_MAX
          ? `원금 ${loanFromOwner.toFixed(2)}억 > 무이자한도 → 연 이자 ${(annualInterest * 100).toFixed(0)}만원 납부 필요`
          : `원금 ${loanFromOwner.toFixed(2)}억 ≤ 무이자한도(${NO_INTEREST_MAX.toFixed(1)}억) → 무이자 가능`,
        '피상속인 사망 시 잔여 차용금은 상속재산에 포함',
      ],
      condition: rentalCoversInterest
        ? `지분 임대수익 연 ${totalRentalFromGifts.toFixed(2)}억 > 이자 ${annualInterest.toFixed(2)}억 ✓ 임대로 이자 상환 가능`
        : `지분 임대수익 연 ${totalRentalFromGifts.toFixed(2)}억 < 이자 ${annualInterest.toFixed(2)}억 ⚠ 추가 현금 필요`,
    });
  }

  return {
    totalEstateNow, totalEstate10yr, totalEstate20yr,
    inheritanceTaxNow, inheritanceTaxAt10yr: inheritanceTax10yr, inheritanceTaxAt20yr: inheritanceTax20yr,
    marginalRate,
    giftPlans, totalGiftAmount, totalGiftTax, estateAfterGifts,
    useGenSkip, genSkipReason,
    estateAfterGifts10yr, inheritanceTaxAt10yrOptimized, totalTaxSaving, netSavingAfterGiftTax,
    funding, actions, headline, keyStats, warnings, paymentStrategies,
  };
}

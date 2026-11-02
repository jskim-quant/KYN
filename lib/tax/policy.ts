/**
 * 세법 정책 상수 — 시행일 기준 관리
 * 세율·한도 변경 시 이 파일만 수정하면 전체 반영됩니다.
 *
 * 근거:
 *  - 상증세법 §53 (증여공제), §57 (세대생략 할증), §69 (신고세액공제)
 *  - 상증세법 §35 (저가양수도 증여 의제)
 *  - 소득세법 §95 (장기보유특별공제), §89 (1세대1주택 비과세)
 *  - 국세청 연부연납 가산율 고시 (2024.3.22 이후 3.5%)
 */

// ── 증여공제 (상증세법 §53) ─────────────────────────────────────
/** 관계별 10년 증여공제 한도 (단위: 억) */
export const GIFT_DEDUCTIONS_BY_RELATION: Record<string, number> = {
  배우자:  6.0,
  자녀:    0.5,   // 성년 기준; 미성년=0.2 (calcGiftTax에서 별도 분기)
  손자녀:  0.5,   // 성년 기준; 미성년=0.2
  며느리:  0.1,
  사위:    0.1,
  부모:    0.5,
  조부모:  0.5,
  형제:    0.1,
  삼촌:    0.1,
  고모:    0.1,
  기타:    0.1,
};

/** 미성년 자녀·손자녀 증여공제 (억) */
export const MINOR_GIFT_DEDUCTION = 0.2;

/** 혼인·출산 추가공제 (2024~ / 상증세법 §53의2) */
export const MARRIAGE_BIRTH_BONUS = 1.0;

// ── 세대생략 할증 (상증세법 §57) ───────────────────────────────
export const GEN_SKIP_SURCHARGE_GENERAL  = 1.30; // 일반 30%
export const GEN_SKIP_SURCHARGE_MINOR_OVER_20BIL = 1.40; // 미성년+20억 초과 40%
export const GEN_SKIP_MINOR_THRESHOLD_BIL = 20;  // 20억 (억 단위)

// ── 신고세액공제 (상증세법 §69) ────────────────────────────────
export const VOLUNTARY_FILING_CREDIT = 0.03; // 3%

// ── 상증세 누진세율 과세표준 구간 (억 단위) ────────────────────
export interface TaxBracket {
  upTo: number;     // 이하 (억, Infinity = 초과)
  rate: number;     // 세율
  base: number;     // 누적 산출세액 시작값 (억)
  from: number;     // 구간 시작 (억)
}
export const INHERITANCE_GIFT_BRACKETS: TaxBracket[] = [
  { from: 0,  upTo: 1,        rate: 0.10, base: 0    },
  { from: 1,  upTo: 5,        rate: 0.20, base: 0.10 },
  { from: 5,  upTo: 10,       rate: 0.30, base: 0.90 },
  { from: 10, upTo: 30,       rate: 0.40, base: 2.40 },
  { from: 30, upTo: Infinity, rate: 0.50, base: 10.40},
];

// ── 저가양수도 증여 의제 기준 (상증세법 §35) ───────────────────
/** 특수관계인 간: 시가 대비 차액 비율 임계값 */
export const RELATED_PARTY_DISCOUNT_RATE_THRESHOLD = 0.30;
/** 특수관계인 간: 차액 절대값 임계값 (억) */
export const RELATED_PARTY_DISCOUNT_ABS_THRESHOLD  = 3.0;

// ── 양도소득세 ──────────────────────────────────────────────────
/** 1세대1주택 양도가액 비과세 한도 (억) */
export const ONE_HOUSE_EXEMPT_LIMIT = 12;
/** 단기양도세율 */
export const SHORT_TERM_RATES = {
  under1yr:  0.50,
  under2yr:  0.40,
};
/** 일반 장기보유특별공제 (부동산) */
export const LTHD_RATES: Array<{ minYears: number; rate: number }> = [
  { minYears: 15, rate: 0.30 },
  { minYears: 10, rate: 0.20 },
  { minYears:  5, rate: 0.10 },
  { minYears:  3, rate: 0.06 },
];
/** 1세대1주택 장기보유특별공제 최대 */
export const LTHD_ONE_HOUSE_MAX = 0.80;
/** 기본공제 (억) */
export const CGT_BASIC_DEDUCTION = 0.025;
/** 지방소득세율 (양도세의 10%) */
export const LOCAL_INCOME_TAX_RATE = 0.10;

// ── 취득세 (지방세법) ──────────────────────────────────────────
/** 주택 취득세 기본세율 (시가 기준 구간별) */
export const ACQUISITION_TAX_RESIDENTIAL = {
  /** 6억 이하 */
  under6:  0.010,
  /** 6~9억 (비례 계산) */
  /** 9억 초과 */
  over9:   0.030,
};
/** 비주거용 취득세 기본세율 */
export const ACQUISITION_TAX_NON_RESIDENTIAL = 0.040;
/** 증여 무상취득 기본세율. 주택 중과 여부는 별도 검토가 필요합니다. */
export const ACQUISITION_TAX_GIFT_BASE = 0.035;
/** 농지 취득세 */
export const ACQUISITION_TAX_FARMLAND = 0.030;
/** 다주택 취득세 중과 간이값. 조정대상지역·주택 수·법인 여부에 따라 달라지므로 rough_estimate로만 사용 */
export const ACQUISITION_TAX_MULTI_HOUSE: Record<number, number> = {
  2: 0.08,
  3: 0.12,
};
/** 취득세 추가세율 (지방교육세 등 합산 근사치) */
export const ACQUISITION_TAX_SURCHARGE = 0.002; // 농어촌특별세 + 지방교육세

// ── 연부연납 (상증세법 §71) ────────────────────────────────────
/** 연부연납 최대 기간 (연) */
export const INSTALLMENT_MAX_YEARS = 10;
/** 연부연납 가산율 (2024.3.22 이후, 국세청 고시) — 정책 변경 시 이 값만 수정 */
export const INSTALLMENT_SURCHARGE_POLICY: Array<{
  from: string; // ISO date
  rate: number; // 연율
}> = [
  { from: '2024-03-22', rate: 0.035 }, // 3.5%/년
  { from: '2022-03-22', rate: 0.018 }, // 1.8% (이전)
];
export function getInstallmentSurchargeRate(date: Date = new Date()): number {
  const sorted = [...INSTALLMENT_SURCHARGE_POLICY].sort(
    (a, b) => new Date(b.from).getTime() - new Date(a.from).getTime()
  );
  for (const p of sorted) {
    if (date >= new Date(p.from)) return p.rate;
  }
  return sorted[sorted.length - 1].rate;
}

// ── 상속 신고기한 ──────────────────────────────────────────────
/** 상속세 신고·납부 기한: 상속개시일 속한 달 말일부터 6개월 (상증세법 §67) */
export const INHERITANCE_FILING_MONTHS = 6;

// ── 물납 (상증세법 §73) ────────────────────────────────────────
/** 물납 허용 비율: 납부세액 중 부동산·유가증권 물납 가능 비율 (최대 50%) */
export const IN_KIND_MAX_RATIO = 0.50;

// ── 차용증 이자 (상증세법 §41의4) ─────────────────────────────
/** 적정이자율 */
export const FAIR_LOAN_RATE = 0.046;
/** 이자 미납 시 증여세 부과 기준 (억) */
export const LOAN_GIFT_THRESHOLD = 0.10; // 1천만원

// ── LTV 기본값 ─────────────────────────────────────────────────
export const DEFAULT_LTV_PCT = 40;

// ── 상속세 공제 (상증세법 §18~22) ─────────────────────────────
export const INHERITANCE_BASIC_DEDUCTION    = 2.0;  // 기초공제 2억
export const INHERITANCE_CHILD_DEDUCTION    = 0.5;  // 자녀 1인당 5천만원
export const INHERITANCE_MINOR_ANNUAL       = 0.1;  // 미성년 1천만원×잔여연수
export const INHERITANCE_ELDERLY_DEDUCTION  = 0.5;  // 65세+ 연로자공제
export const INHERITANCE_LUMP_SUM           = 5.0;  // 일괄공제 5억
export const INHERITANCE_SPOUSE_MIN         = 5.0;  // 배우자공제 최소 5억
export const INHERITANCE_SPOUSE_MAX         = 30.0; // 배우자공제 최대 30억
export const INHERITANCE_FUNERAL_DEDUCTION  = 0.15; // 장례비용 공제 (한도 1,500만원)
export const INHERITANCE_FILING_CREDIT      = 0.03; // 신고세액공제 3%
export const INHERITANCE_FINANCIAL_DEDUCT_RATE = 0.20; // 금융재산공제 20%
export const INHERITANCE_FINANCIAL_DEDUCT_MIN  = 0.20; // 최소 2천만원
export const INHERITANCE_FINANCIAL_DEDUCT_MAX  = 2.00; // 최대 2억
/** 동거주택 상속공제 한도 (상증세법 §23의2) */
export const LIVE_IN_HOME_DEDUCTION_MAX = 6.0;

// ── 과거 증여 합산 기간 ───────────────────────────────────────
/** 상속인에게 한 사전 증여 합산 기간 (년) */
export const PRIOR_GIFT_HEIR_YEARS    = 10;
/** 상속인 외에 한 사전 증여 합산 기간 (년) */
export const PRIOR_GIFT_NON_HEIR_YEARS = 5;

// ── 이월과세 적용기간 (소득세법 §97의2) ──────────────────────────
// 배우자·직계존비속에게 증여받은 부동산을 기간 내 양도하면 증여자의 취득가액을 적용한다.
// 기간: 증여일 2023-01-01 이후 10년, 2022-12-31 이전 5년.
// 근거: 실무 소스 4건 일치(Taxly·watax·wikidocs·해온세무) + 개정 연혁(신김 Legal Update, 5년 시기).
// 공식 원문(law.go.kr) 대조 필요 — docs: KYN 세무 전략 리서치 Report 1 #6, 마지막 확인 2026-10-02.
// 주식(소득세법 §94①3호) 1년(2025 개정)은 과세대상 주식 판정이 필요해 아직 반영하지 않는다.
export const CARRYOVER_RULE_CHANGE_DATE = '2023-01-01';
export const CARRYOVER_YEARS_REAL_ESTATE_CURRENT = 10;
export const CARRYOVER_YEARS_REAL_ESTATE_LEGACY = 5;
export const REAL_ESTATE_ASSET_TYPES: string[] = ['주거용부동산', '상업용부동산', '토지', '농지', '임야', '오피스텔'];

/** 증여일 기준 이월과세 적용기간(년). 부동산이 아닌 자산은 기존 동작(5년)을 유지한다. */
export function carryOverPeriodYears(assetType: string, giftDate: string | Date = new Date()): number {
  if (!REAL_ESTATE_ASSET_TYPES.includes(assetType)) return CARRYOVER_YEARS_REAL_ESTATE_LEGACY;
  const iso = typeof giftDate === 'string' ? giftDate.slice(0, 10) : giftDate.toISOString().slice(0, 10);
  return iso >= CARRYOVER_RULE_CHANGE_DATE
    ? CARRYOVER_YEARS_REAL_ESTATE_CURRENT
    : CARRYOVER_YEARS_REAL_ESTATE_LEGACY;
}

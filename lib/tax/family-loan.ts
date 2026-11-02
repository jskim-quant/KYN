/**
 * 가족 간 금전대여 + 연부연납 순수 계산 함수
 *
 * 근거:
 *  - 상증세법 §41의4 (금전 무상대출 등에 따른 이익의 증여)
 *    적정이자율 4.6%와 실제 이자의 차액이 연 1천만원 미만이면 증여로 보지 않음
 *    → 무이자 가능 원금 한도 = 0.1억 / 0.046 ≈ 2.17억
 *  - 상증세법 §71 (연부연납): 상속세 최대 10년, 증여세 최대 5년
 */

import { FAIR_LOAN_RATE, LOAN_GIFT_THRESHOLD, getInstallmentSurchargeRate } from './policy';

/** 증여세 연부연납 최대 기간 (상증세법 §71 — 상속세 10년과 다름) */
export const GIFT_INSTALLMENT_MAX_YEARS = 5;

/** 무이자 차용 가능 최대 원금 (억) = 연 1천만원 / 4.6% ≈ 2.17억 */
export function maxInterestFreeLoanPrincipal(): number {
  return LOAN_GIFT_THRESHOLD / FAIR_LOAN_RATE;
}

export interface FamilyLoanBorrower {
  name: string;
  relation: string;
  /** 필요 자금 (억) */
  need: number;
}

export interface FamilyLoanAllocation {
  name: string;
  relation: string;
  /** 배분 원금 (억) */
  principal: number;
  /** 무이자 가능 여부 (인별 2.17억 이하) */
  interestFree: boolean;
  /** 무이자 한도 초과분 (억) — 이 부분엔 적정이자 4.6% 수취 필요 */
  excessOverLimit: number;
  /** 초과분에 대해 수취해야 하는 최소 연 이자 (억) */
  requiredAnnualInterest: number;
  notes: string[];
}

export interface FamilyLoanPlan {
  allocations: FamilyLoanAllocation[];
  totalPrincipal: number;
  /** 전원 무이자 세팅 가능 여부 */
  allInterestFree: boolean;
  /** 무이자 한도 (인별, 억) */
  perPersonLimit: number;
  warnings: string[];
}

/**
 * 총 대여금을 가족 구성원별로 배분하고 인별 무이자 한도(≈2.17억)를 검증한다.
 * 한도 초과분은 적정이자 4.6% 수취가 필요함을 표시한다.
 */
export function planFamilyLoanSplit(borrowers: FamilyLoanBorrower[]): FamilyLoanPlan {
  const limit = maxInterestFreeLoanPrincipal();
  const warnings: string[] = [];

  const allocations: FamilyLoanAllocation[] = borrowers.map(b => {
    const principal = Math.max(0, b.need);
    const excess = Math.max(0, principal - limit);
    const interestFree = excess <= 0.0001;
    const notes: string[] = [];
    if (interestFree && principal > 0) {
      notes.push(`무이자 차용증 가능 (원금 ${principal.toFixed(2)}억 ≤ 한도 ${limit.toFixed(2)}억)`);
      notes.push('차용증에 만기·상환 방법 명시 필수 — 만기 없는 차용은 증여로 재구성될 위험');
    }
    if (excess > 0) {
      notes.push(`한도 초과분 ${excess.toFixed(2)}억에는 연 ${(FAIR_LOAN_RATE * 100).toFixed(1)}% 이자 수취 필요`);
    }
    return {
      name: b.name,
      relation: b.relation,
      principal,
      interestFree,
      excessOverLimit: excess,
      requiredAnnualInterest: excess * FAIR_LOAN_RATE,
      notes,
    };
  });

  const totalPrincipal = allocations.reduce((s, a) => s + a.principal, 0);
  const allInterestFree = allocations.every(a => a.interestFree);

  if (!allInterestFree) {
    warnings.push('일부 차용이 무이자 한도(약 2.17억/인)를 초과 — 초과분 이자 수취 및 이자소득세 신고 필요');
  }
  warnings.push('실제 자금 사용 내역(유학비 송금 등) 증빙 보관 필수 — 자금출처조사 대비');
  warnings.push('대여자의 이자소득(수취 시)은 비영업대금 이익으로 27.5% 원천징수 대상');

  return { allocations, totalPrincipal, allInterestFree, perPersonLimit: limit, warnings };
}

export interface InstallmentSchedule {
  /** 신고 시 즉시 납부액 (1/(n+1)) (억) */
  firstPayment: number;
  /** 연부연납 대상액 (억) */
  deferredTotal: number;
  /** 연간 원금 납부액 (억) */
  annualPrincipal: number;
  /** 총 가산금 (억) */
  totalSurcharge: number;
  /** 연도별 납부액 [{year, principal, surcharge, total}] */
  schedule: Array<{ year: number; principal: number; surcharge: number; total: number }>;
  /** 적용 가산율 */
  surchargeRate: number;
  years: number;
  warnings: string[];
}

/**
 * 증여세 연부연납 스케줄 (상증세법 §71).
 * 신고 시 1/(n+1) 납부, 잔액을 n년간 분할. 미납 잔액에 가산율 적용.
 * 요건: 납부세액 2천만원 초과, 납세담보 제공.
 */
export function planGiftTaxInstallment(
  giftTax: number,
  years: number = GIFT_INSTALLMENT_MAX_YEARS,
): InstallmentSchedule {
  const n = Math.min(Math.max(1, Math.floor(years)), GIFT_INSTALLMENT_MAX_YEARS);
  const rate = getInstallmentSurchargeRate();
  const warnings: string[] = [];

  if (giftTax <= 0.2) {
    warnings.push('납부세액 2천만원 이하 — 연부연납 신청 불가 (일시납)');
  }
  warnings.push('연부연납은 납세담보(부동산 등) 제공 필요');
  warnings.push(`증여세 연부연납 최대 ${GIFT_INSTALLMENT_MAX_YEARS}년 (상속세 10년과 다름)`);

  const firstPayment = giftTax / (n + 1);
  const deferredTotal = giftTax - firstPayment;
  const annualPrincipal = deferredTotal / n;

  const schedule: InstallmentSchedule['schedule'] = [];
  let remaining = deferredTotal;
  let totalSurcharge = 0;
  for (let y = 1; y <= n; y++) {
    const surcharge = remaining * rate;
    schedule.push({ year: y, principal: annualPrincipal, surcharge, total: annualPrincipal + surcharge });
    totalSurcharge += surcharge;
    remaining -= annualPrincipal;
  }

  return {
    firstPayment, deferredTotal, annualPrincipal, totalSurcharge,
    schedule, surchargeRate: rate, years: n, warnings,
  };
}

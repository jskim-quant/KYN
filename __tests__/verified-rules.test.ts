/**
 * 공식·실무 소스에 나온 숫자 예시를 그대로 검증값으로 쓴다. (docs: KYN 세무 전략 리서치 2차 점검, 2026-10-02)
 * 이 테스트는 ‘소스가 말한 계산을 코드가 재현하는지’만 확인한다. 소스 자체의 정확성은 원문 대조가 필요하다.
 */
import { describe, it, expect } from 'vitest';
import { calcGiftTax, calcCarryOverCGT, calcFamilyLoanAnalysis } from '../lib/tax';
import { estimateRelatedPartySale } from '../lib/tax/gift';
import { carryOverPeriodYears } from '../lib/tax/policy';
import type { Asset } from '../types';

describe('§53 증여재산공제 / §53의2 혼인·출산 (조문 인용: korea.legal, 이투데이)', () => {
  it('성년 자녀 5천만 원, 미성년 2천만 원 — 공제 내는 0원, 넘으면 과세', () => {
    expect(calcGiftTax(0.5, '자녀', 0, false, false, 30)).toBe(0);
    expect(calcGiftTax(0.51, '자녀', 0, false, false, 30)).toBeGreaterThan(0);
    expect(calcGiftTax(0.2, '자녀', 0, false, false, 10)).toBe(0);
    expect(calcGiftTax(0.21, '자녀', 0, false, false, 10)).toBeGreaterThan(0);
  });
  it('배우자 6억 원', () => {
    expect(calcGiftTax(6, '배우자')).toBe(0);
    expect(calcGiftTax(6.1, '배우자')).toBeGreaterThan(0);
  });
  it('며느리·사위는 인척이라 기타친족 1천만 원 (직계존속 5천만 원이 아니다)', () => {
    for (const rel of ['며느리', '사위']) {
      expect(calcGiftTax(0.1, rel)).toBe(0);
      expect(calcGiftTax(0.11, rel)).toBeGreaterThan(0);
    }
  });
  it('혼인·출산 공제 +1억 → 성년 자녀는 1.5억까지 비과세', () => {
    expect(calcGiftTax(1.5, '자녀', 0, false, true, 30)).toBe(0);
    expect(calcGiftTax(1.6, '자녀', 0, false, true, 30)).toBeGreaterThan(0);
    expect(calcGiftTax(1.5, '자녀', 0, false, false, 30)).toBeGreaterThan(0);
  });
});

describe('§57 세대생략 할증 (조문 인용: 로톡·시행령 §46조의3)', () => {
  const ratio = (amount: number, prior: number, age: number) =>
    calcGiftTax(amount, '손자녀', prior, true, false, age) / calcGiftTax(amount, '자녀', prior, false, false, age);
  it('일반 30%', () => expect(ratio(5, 0, 30)).toBeCloseTo(1.3, 10));
  it('미성년 + 20억 초과면 40%', () => expect(ratio(21, 0, 10)).toBeCloseTo(1.4, 10));
  it('20억 ‘초과’이므로 정확히 20억이면 30%', () => expect(ratio(20, 0, 10)).toBeCloseTo(1.3, 10));
  it('시행령 §46의3: 10년 내 가산 증여를 포함해 20억을 판정한다', () => expect(ratio(16, 5, 10)).toBeCloseTo(1.4, 10));
  it('성년이면 20억을 넘어도 30%', () => expect(ratio(21, 0, 30)).toBeCloseTo(1.3, 10));
});

describe('§35 특수관계인 저가양수 (국세청 서면-2016-상속증여-4969 외 소스 예시)', () => {
  const run = (marketValue: number, salePrice: number) => estimateRelatedPartySale({
    marketValue, salePrice, acquisitionCost: 1, holdingYears: 10, isOneHouseOneFamily: false,
    houseCount: 1, isRegulatedArea: false, relation: '자녀',
  });
  it('조세일보: 시가 3억 토지를 1.5억에 → 증여재산가액 6천만 원', () => {
    const r = run(3, 1.5);
    expect(r.isGiftDeemed).toBe(true);
    expect(r.taxableGiftAmount).toBeCloseTo(0.6, 10);
  });
  it('소셜포커스: 시가 12억을 8억에 → 4억 − min(3.6억, 3억) = 1억', () => {
    expect(run(12, 8).taxableGiftAmount).toBeCloseTo(1.0, 10);
  });
  it('Taxly 예시: 5억 재산을 3억에 → 5천만 원 (min 규칙과 일치)', () => {
    expect(run(5, 3).taxableGiftAmount).toBeCloseTo(0.5, 10);
  });
  it('차액이 min(30%, 3억) 미만이면 과세하지 않는다', () => {
    const r = run(10, 8.5);
    expect(r.isGiftDeemed).toBe(false);
    expect(r.taxableGiftAmount).toBe(0);
  });
  it('차액이 정확히 3억이면 요건은 충족하지만 증여재산가액은 0', () => {
    const r = run(20, 17);
    expect(r.isGiftDeemed).toBe(true);
    expect(r.taxableGiftAmount).toBeCloseTo(0, 10);
  });
});

describe('§41의4 금전 무상·저리 대출 (KB Think 칼럼, 국세청 해석 인용 Taxly 1870)', () => {
  it('2억을 연 1%로 → 적정이자 920만 − 실제 200만 = 720만 < 1천만 → 비과세', () => {
    const r = calcFamilyLoanAnalysis(2, 1, '자녀');
    expect(r.interestGap).toBeCloseTo(0.072, 10);
    expect(r.isGiftTaxable).toBe(false);
  });
  it('3억을 연 2%로 → 1,380만 − 600만 = 780만 → 비과세', () => {
    const r = calcFamilyLoanAnalysis(3, 2, '자녀');
    expect(r.interestGap).toBeCloseTo(0.078, 10);
    expect(r.isGiftTaxable).toBe(false);
  });
  it('3억 무이자 → 1,380만 ≥ 1천만 → 과세', () => {
    const r = calcFamilyLoanAnalysis(3, 0, '자녀');
    expect(r.interestGap).toBeCloseTo(0.138, 10);
    expect(r.isGiftTaxable).toBe(true);
  });
  it('무이자 가능 한도는 1천만 ÷ 4.6% ≈ 2.17억', () => {
    expect(calcFamilyLoanAnalysis(2, 0, '자녀').maxZeroRatePrincipal).toBeCloseTo(2.1739, 3);
    expect(calcFamilyLoanAnalysis(2.17, 0, '자녀').isGiftTaxable).toBe(false);
    expect(calcFamilyLoanAnalysis(2.2, 0, '자녀').isGiftTaxable).toBe(true);
  });
});

describe('§97의2 이월과세 기간 (실무 소스 4건 일치, 신김 Legal Update의 5년 시기 연혁)', () => {
  const asset = { id: 'a', asset_type: '주거용부동산', acquisition_cost: 1, acquisition_date: '2000-01-01', current_value: 10 } as unknown as Asset;
  it('부동산: 증여일 2023-01-01 이후 10년, 2022-12-31 이전 5년', () => {
    expect(carryOverPeriodYears('주거용부동산', '2023-01-01')).toBe(10);
    expect(carryOverPeriodYears('토지', '2026-10-04')).toBe(10);
    expect(carryOverPeriodYears('상업용부동산', '2022-12-31')).toBe(5);
  });
  it('2026년 증여: 7년 뒤 매각은 아직 이월과세 기간 (옛 5년 규칙이면 놓치던 구간)', () => {
    const r = calcCarryOverCGT(asset, 10, 7, 14, '2026-10-04');
    expect(r.carryOverPeriodYears).toBe(10);
    expect(r.isCarryOver).toBe(true);
    expect(r.cgt_applicable).toBe(r.cgt_carryOver);
    expect(r.cgt_carryOver).toBeGreaterThan(r.cgt_normal);
  });
  it('10년이 지나면 이월과세가 끝난다', () => {
    const r = calcCarryOverCGT(asset, 10, 10, 14, '2026-10-04');
    expect(r.isCarryOver).toBe(false);
    expect(r.cgt_applicable).toBe(r.cgt_normal);
  });
  it('2022년 증여분은 5년 규칙이 유지된다', () => {
    expect(calcCarryOverCGT(asset, 10, 6, 14, '2022-06-01').isCarryOver).toBe(false);
    expect(calcCarryOverCGT(asset, 10, 4, 14, '2022-06-01').isCarryOver).toBe(true);
  });
  it('부동산이 아닌 자산은 기존 동작(5년)을 유지한다 — 주식 1년 규정은 미반영(레지스트리 openIssues)', () => {
    expect(carryOverPeriodYears('비상장주식', '2026-10-04')).toBe(5);
  });
});

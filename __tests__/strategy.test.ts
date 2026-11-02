import { describe, it, expect } from 'vitest';
import { compareComputablePlans, generateFamilyCorpPlans, maxLoanBelowSpecificCorpThreshold } from '../lib/strategy';
import type { FamilySnapshot } from '../lib/strategy';

const E = 100_000_000;
const base = (over: Partial<FamilySnapshot> = {}): FamilySnapshot => ({
  asOf: '2026-10-04',
  persons: [
    { id: 'p1', name: '부', role: 'parent', age: 62 },
    { id: 'c1', name: '자', role: 'child', age: 35 },
  ],
  companies: [],
  parentCashKRW: 30 * E,
  targetTransferKRW: 30 * E,
  ...over,
});
const plan = (id: string, snap = base(), opt = {}) => generateFamilyCorpPlans(snap, opt).find(p => p.id === id)!;

describe('최대 무이자 대여 원금 (실무 칼럼의 21.7억을 산식으로 재현)', () => {
  it('지분 100%·무이자 → 약 21.74억, 경계에서 평가기와 일치', () => {
    const max = maxLoanBelowSpecificCorpThreshold(100, 0)!;
    expect(max).toBeGreaterThan(2_173_000_000);
    expect(max).toBeLessThan(2_174_000_000);
    // 그 금액은 연 1억 미만, 1원 더 빌리면 1억 이상
    expect(Math.round(max * 0.046)).toBeLessThan(E);
    expect(Math.round((max + 1) * 0.046)).toBeGreaterThanOrEqual(E);
  });
  it('이자율이 4.6% 이상이면 제한이 없다', () => {
    expect(maxLoanBelowSpecificCorpThreshold(100, 0.046)).toBeNull();
    expect(maxLoanBelowSpecificCorpThreshold(100, 0.06)).toBeNull();
  });
  it('지분율이 낮으면 한도가 커진다', () => {
    expect(maxLoanBelowSpecificCorpThreshold(50, 0)!).toBeGreaterThan(maxLoanBelowSpecificCorpThreshold(100, 0)! * 1.99);
  });
});

describe('법인이 없는 가족: 자녀 법인 설립 + 부모 대여', () => {
  it('설립 단계(증여공제 내 자본금 → 법인 설립)가 자동으로 생성된다', () => {
    const p = plan('CHILD_CORP_LOAN');
    expect(p.steps.map(s => s.kind)).toEqual(['gift_cash', 'create_company', 'loan_to_company', 'company_invest']);
    expect(p.steps[0].amountKRW).toBe(5000 * 10_000);      // 성년 자녀 공제 5천만 원
    expect(p.steps[0].taxKRW).toBe(0);
  });
  it('미성년 자녀는 2천만 원, 혼인·출산 공제가 있으면 +1억', () => {
    expect(plan('CHILD_CORP_LOAN', base({ persons: [
      { id: 'p1', name: '부', role: 'parent', age: 50 }, { id: 'c1', name: '자', role: 'child', age: 15 }] })).steps[0].amountKRW).toBe(2000 * 10_000);
    const withBonus = plan('CHILD_CORP_LOAN', base({ marriageOrBirthBonus: { c1: true } }));
    expect(withBonus.steps[0].amountKRW).toBe(150 * 1_000_000);
    expect(withBonus.steps[0].taxKRW).toBe(0);
  });
  it('이미 자녀 법인이 있으면 설립 단계를 만들지 않는다', () => {
    const p = plan('CHILD_CORP_LOAN', base({ companies: [{ id: 'cc', name: '기존', owners: [{ personId: 'c1', pct: 100 }] }] }));
    expect(p.steps.map(s => s.kind)).not.toContain('create_company');
    expect(p.steps[0].kind).toBe('loan_to_company');
  });
  it('한도 이하 대여는 증여의제가 없고, 넘으면 과세·경고가 붙는다', () => {
    const under = plan('CHILD_CORP_LOAN', base(), { loanPrincipalKRW: 21 * E });
    expect(under.steps.find(s => s.kind === 'loan_to_company')!.taxKRW).toBe(0);
    expect(under.auditFlags.some(f => f.code === 'DEEMED_GIFT_OVER_THRESHOLD')).toBe(false);
    const over = plan('CHILD_CORP_LOAN', base(), { loanPrincipalKRW: 22 * E });
    expect(over.steps.find(s => s.kind === 'loan_to_company')!.taxKRW).toBeGreaterThan(0);
    expect(over.auditFlags.find(f => f.code === 'DEEMED_GIFT_OVER_THRESHOLD')?.severity).toBe('high');
  });
  it('적정이자율 이상 이자를 내면 증여의제가 없고 무이자 경고도 없다', () => {
    const p = plan('CHILD_CORP_LOAN', base(), { loanAnnualRate: 0.046 });
    expect(p.steps.find(s => s.kind === 'loan_to_company')!.taxKRW).toBe(0);
    expect(p.auditFlags.some(f => f.code === 'ZERO_INTEREST_LOAN')).toBe(false);
  });
  it('무이자 대여에는 실질 증여 재분류 경고가 붙는다', () => {
    expect(plan('CHILD_CORP_LOAN', base(), { loanPrincipalKRW: 10 * E }).auditFlags.some(f => f.code === 'ZERO_INTEREST_LOAN')).toBe(true);
  });
});

describe('법인이 없는 가족: 부모 법인 + 자녀 법인 둘 다 설립', () => {
  const p = plan('PARENT_AND_CHILD_CORP');
  it('두 법인의 설립과 법인 간 거래 단계가 생성된다', () => {
    const kinds = p.steps.map(s => s.kind);
    expect(kinds.filter(k => k === 'create_company')).toHaveLength(2);
    expect(kinds).toEqual(expect.arrayContaining(['company_loan', 'company_asset_sale', 'company_dividend']));
  });
  it('검증되지 않은 법인 간 단계는 세액을 추정하지 않는다', () => {
    for (const s of p.steps.filter(x => ['company_loan', 'company_asset_sale', 'company_dividend'].includes(x.kind))) {
      expect(s.computation).toBe('NOT_COMPUTED');
      expect(s.taxKRW).toBeNull();
      expect(s.notComputedReason!.length).toBeGreaterThan(0);
    }
    expect(p.coverage.computed).toBeLessThan(p.coverage.total);
  });
  it('필요한 미검증 규칙 목록과 감사 플래그를 낸다', () => {
    expect(p.openRules.join(' ')).toContain('일감몰아주기');
    expect(p.auditFlags.map(f => f.code)).toEqual(expect.arrayContaining(['INTERCOMPANY_REPEATED_TRADES', 'SUPER_CAR_TOLL_CASE']));
    expect(p.auditFlags.find(f => f.code === 'INTERCOMPANY_REPEATED_TRADES')!.basis).toBe('unverified_lead');
  });
  it('이미 부모 법인이 있으면 부모 법인 설립을 건너뛴다', () => {
    const q = plan('PARENT_AND_CHILD_CORP', base({ companies: [{ id: 'pc', name: '부모법인', owners: [{ personId: 'p1', pct: 100 }] }] }));
    expect(q.steps.filter(s => s.kind === 'create_company')).toHaveLength(1);
  });
});

describe('계획 비교: 계산이 끝난 계획만 비교한다', () => {
  const plans = generateFamilyCorpPlans(base());
  it('법인 구조 계획은 미검증 단계가 있어 세액 비교에서 제외된다', () => {
    expect(plans.find(p => p.id === 'CHILD_CORP_LOAN')!.comparable).toBe(false);
    expect(plans.find(p => p.id === 'PARENT_AND_CHILD_CORP')!.comparable).toBe(false);
    expect(compareComputablePlans(plans).map(p => p.id).sort()).toEqual(['DIRECT_GIFT', 'STAGED_GIFT']);
  });
  it('분할 증여는 누진세율 때문에 일시 증여보다 세액이 낮다 (계산 결과이며 최적 전략 판정이 아니다)', () => {
    const direct = plans.find(p => p.id === 'DIRECT_GIFT')!;
    const staged = plans.find(p => p.id === 'STAGED_GIFT')!;
    expect(staged.computedTaxKRW).toBeLessThan(direct.computedTaxKRW);
    expect(staged.steps).toHaveLength(3);
    expect(staged.steps.reduce((s, x) => s + (x.amountKRW ?? 0), 0)).toBe(30 * E);
  });
  it('자녀가 없으면 구조를 만들 수 없다', () => {
    expect(() => generateFamilyCorpPlans(base({ persons: [{ id: 'p1', name: '부', role: 'parent', age: 60 }] }))).toThrow('자녀');
  });
});

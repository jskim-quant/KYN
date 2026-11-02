import { describe, it, expect } from 'vitest';
import { VERIFIED_RULES, evaluateSpecificCorp, getRule } from '../lib/rules';

const E = 100_000_000;

describe('규칙 레지스트리 게이트 — 근거 없는 규칙은 등록할 수 없다', () => {
  it('모든 규칙은 출처·확인일·구현 위치를 가진다', () => {
    for (const r of VERIFIED_RULES) {
      expect(r.sources.length, r.ruleId).toBeGreaterThan(0);
      expect(r.sources.every(s => /^\d{4}-\d{2}-\d{2}$/.test(s.accessedOn)), r.ruleId).toBe(true);
      expect(r.lastVerified, r.ruleId).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(r.implementedIn.length, r.ruleId).toBeGreaterThan(0);
      expect(r.legalBasis.length, r.ruleId).toBeGreaterThan(0);
    }
  });
  it('시행일을 모르면 이유를 openIssues에 적는다', () => {
    for (const r of VERIFIED_RULES.filter(x => x.effectiveFrom === null)) {
      expect(r.openIssues.length, r.ruleId).toBeGreaterThan(0);
    }
  });
  it('ruleId는 중복되지 않고 UNVERIFIED 상태는 없다', () => {
    const ids = VERIFIED_RULES.map(r => r.ruleId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(VERIFIED_RULES.some(r => (r.status as string) === 'UNVERIFIED')).toBe(false);
    expect(getRule('KR-GIFT-S45-5-SPECIFIC-CORP')?.status).toBe('SUPPORTED_WITH_CONDITIONS');
  });
});

describe('§45의5 특정법인 증여의제', () => {
  const tx = (id: string, date: string, benefit: number, type: 'free_provision' | 'capital_transaction' = 'free_provision', extra = {}) =>
    ({ id, date, type, corpBenefitKRW: benefit, ...extra });

  it('지배주주 등 보유비율 30% 미만이면 특정법인이 아니다 (경계: 29.99% vs 30%)', () => {
    expect(evaluateSpecificCorp({ controllingHoldersPct: 29.99, transactions: [tx('a', '2026-01-10', 10 * E)] }).isSpecificCorp).toBe(false);
    const r = evaluateSpecificCorp({ controllingHoldersPct: 30, transactions: [tx('a', '2026-01-10', 10 * E)] });
    expect(r.isSpecificCorp).toBe(true);
    expect(r.items[0].deemedGiftKRW).toBe(3 * E);
  });

  it('1억 기준은 이상(≥)이다 — 정확히 1억이면 과세, 1원 부족하면 비과세', () => {
    expect(evaluateSpecificCorp({ controllingHoldersPct: 100, transactions: [tx('a', '2026-01-10', E)] }).items[0].meetsThreshold).toBe(true);
    expect(evaluateSpecificCorp({ controllingHoldersPct: 100, transactions: [tx('a', '2026-01-10', E - 1)] }).items[0].meetsThreshold).toBe(false);
  });

  it('거래 유형이 다르면 합산하지 않는다 (예규 서면-2025-자본거래-3489)', () => {
    const r = evaluateSpecificCorp({ controllingHoldersPct: 60, transactions: [
      tx('a', '2026-03-01', E),                              // 6천만
      tx('b', '2026-03-01', E, 'capital_transaction'),       // 6천만, 합치면 1.2억
    ] });
    expect(r.items.every(i => i.deemedGiftKRW === 0.6 * E)).toBe(true);
    expect(r.items.some(i => i.meetsThreshold)).toBe(false);
  });

  it('같은 유형이 소급 1년 이내면 합산하고, 1년을 넘으면 합산하지 않는다 (§43 ②)', () => {
    const within = evaluateSpecificCorp({ controllingHoldersPct: 60, transactions: [tx('a', '2026-01-10', E), tx('b', '2026-09-10', E)] });
    expect(within.items.map(i => i.meetsThreshold)).toEqual([false, true]);
    expect(within.items[1].windowAggregateKRW).toBe(1.2 * E);
    const apart = evaluateSpecificCorp({ controllingHoldersPct: 60, transactions: [tx('a', '2026-01-10', E), tx('b', '2027-02-10', E)] });
    expect(apart.items.map(i => i.meetsThreshold)).toEqual([false, false]);
  });

  it('무상대여 채권이 소멸시효로 소멸한 뒤의 이익은 없다 (대법원 2025-12-04)', () => {
    const r = evaluateSpecificCorp({ controllingHoldersPct: 100, transactions: [tx('a', '2026-01-10', 5 * E, 'free_provision', { receivableExtinguished: true })] });
    expect(r.items[0].deemedGiftKRW).toBe(0);
    expect(r.items[0].meetsThreshold).toBe(false);
    expect(r.items[0].reason).toContain('소멸시효');
  });

  it('특정법인이 아니면 이익이 커도 의제하지 않는다', () => {
    const r = evaluateSpecificCorp({ controllingHoldersPct: 10, transactions: [tx('a', '2026-01-10', 50 * E)] });
    expect(r.items[0]).toMatchObject({ deemedGiftKRW: 0, meetsThreshold: false });
  });

  it('미확정 사항을 결과에 항상 명시한다', () => {
    expect(evaluateSpecificCorp({ controllingHoldersPct: 100, transactions: [] }).notes.join(' ')).toContain('UNVERIFIED');
  });
});

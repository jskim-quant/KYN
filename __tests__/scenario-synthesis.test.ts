import { describe, it, expect } from 'vitest';
import { synthesizeScenarioSummary } from '@/lib/scenario-synthesis';

const scenario = { label: '직접 설계', netWealth10yr: 42.5, totalTax10yr: 3.2 };

describe('synthesizeScenarioSummary', () => {
  it('항상 순자산·세부담 문장을 첫 줄로 포함한다', () => {
    const out = synthesizeScenarioSummary(scenario, null, null);
    expect(out[0]).toContain('직접 설계');
    expect(out[0]).toContain('42.5억');
    expect(out[0]).toContain('3.2억');
  });

  it('hard_blocked이면 탈락 사유를 권장 문장에 반영한다', () => {
    const out = synthesizeScenarioSummary(scenario, {
      feasibilityScore: 20, feasibilityGrade: 'D', hardBlocked: true,
      topConstraint: '초기 자금 부족', riskScore: null, riskGrade: null, topDriver: null,
    }, null);
    expect(out.some(s => s.includes('하드 탈락'))).toBe(true);
    expect(out[out.length - 1]).toContain('초기 자금 부족');
  });

  it('LTV가 60% 이상이면 위험 구간으로 표시하고 대출 축소를 권장한다', () => {
    const out = synthesizeScenarioSummary(scenario, null, {
      ltvBeforePct: 0.3, ltvAfterPct: 0.62,
      netWorthBefore: 40, netWorthAfter: 42.5,
      expectedReturnBeforePct: null, expectedReturnAfterPct: null,
    });
    expect(out.some(s => s.includes('위험 구간'))).toBe(true);
    expect(out[out.length - 1]).toContain('대출 비율을 낮추');
  });

  it('문제 없으면 기본 실행 권장 문장으로 끝난다', () => {
    const out = synthesizeScenarioSummary(scenario, {
      feasibilityScore: 90, feasibilityGrade: 'A', hardBlocked: false,
      topConstraint: null, riskScore: 10, riskGrade: 'A', topDriver: null,
    }, {
      ltvBeforePct: 0.2, ltvAfterPct: 0.35,
      netWorthBefore: 40, netWorthAfter: 42.5,
      expectedReturnBeforePct: 0.02, expectedReturnAfterPct: 0.025,
    });
    expect(out[out.length - 1]).toContain('실행 가능해 보입니다');
  });
});

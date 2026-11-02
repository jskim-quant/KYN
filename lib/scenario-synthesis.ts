/**
 * "AI 종합 추천" — 세금·리스크·레버리지·자산배분을 각자 따로 보여주던 걸
 * 한 문단으로 조합한다. 실제 LLM 호출 없이 규칙 기반으로 즉시 생성한다
 * (비용 없음·API 키 불필요 — 나중에 실제 LLM 호출로 교체 가능하도록
 * 입력·출력 구조만 그대로 유지).
 */

export interface SynthesisScenarioInput {
  label: string;
  netWealth10yr: number;
  totalTax10yr: number;
}

export interface SynthesisRiskInput {
  feasibilityScore: number | null;
  feasibilityGrade: string | null;
  hardBlocked: boolean;
  topConstraint: string | null;
  riskScore: number | null;
  riskGrade: string | null;
  topDriver: string | null;
}

export interface SynthesisLeverageInput {
  ltvBeforePct: number | null;
  ltvAfterPct: number | null;
  netWorthBefore: number;
  netWorthAfter: number;
  expectedReturnBeforePct: number | null;
  expectedReturnAfterPct: number | null;
}

function fmtEok(n: number): string {
  if (!Number.isFinite(n)) return '0억';
  return `${(Math.round(n * 10) / 10).toLocaleString('ko-KR')}억`;
}

export function synthesizeScenarioSummary(
  scenario: SynthesisScenarioInput,
  risk: SynthesisRiskInput | null,
  leverage: SynthesisLeverageInput | null,
): string[] {
  const sentences: string[] = [];

  sentences.push(
    `${scenario.label}을 실행하면 10년 후 순자산은 ${fmtEok(scenario.netWealth10yr)}, 10년 누적 세부담은 ${fmtEok(scenario.totalTax10yr)}으로 계산됩니다.`,
  );

  if (risk) {
    if (risk.hardBlocked) {
      sentences.push(
        `다만 이 계획은 현재 조건에서 하드 탈락 상태입니다 — ${risk.topConstraint ?? '재원 조건'}을 먼저 해결해야 실행할 수 있습니다.`,
      );
    } else if (risk.feasibilityScore != null) {
      const feasNote = risk.feasibilityScore >= 80
        ? '실행 자체는 무난합니다'
        : risk.feasibilityScore >= 60
        ? '실행 가능하지만 재원 확보가 다소 빠듯합니다'
        : '실행 여건이 약해 보완이 필요합니다';
      sentences.push(
        `실현가능성 ${risk.feasibilityScore.toFixed(0)}점(${risk.feasibilityGrade ?? '-'})으로 ${feasNote}.`
        + (risk.topConstraint ? ` 가장 큰 제약은 "${risk.topConstraint}"입니다.` : ''),
      );
    }
    if (risk.riskScore != null) {
      sentences.push(
        `세무상 설명부담은 ${risk.riskScore.toFixed(0)}점(${risk.riskGrade ?? '-'})입니다`
        + (risk.topDriver ? ` — 주요 요인: ${risk.topDriver}` : '') + '.',
      );
    }
  }

  if (leverage) {
    const ltvDelta = leverage.ltvAfterPct != null && leverage.ltvBeforePct != null
      ? leverage.ltvAfterPct - leverage.ltvBeforePct
      : null;
    if (leverage.ltvAfterPct != null) {
      const ltvNote = leverage.ltvAfterPct >= 0.6 ? '위험 구간' : leverage.ltvAfterPct >= 0.4 ? '주의 구간' : '양호';
      sentences.push(
        `담보대출 LTV는 ${((leverage.ltvBeforePct ?? 0) * 100).toFixed(0)}% → ${(leverage.ltvAfterPct * 100).toFixed(0)}%로 `
        + `${ltvDelta != null && ltvDelta > 0 ? '올라가며' : '유지되며'} ${ltvNote}입니다.`,
      );
    }
    if (leverage.expectedReturnBeforePct != null && leverage.expectedReturnAfterPct != null) {
      sentences.push(
        `포트폴리오 기대수익률은 ${(leverage.expectedReturnBeforePct * 100).toFixed(1)}% → ${(leverage.expectedReturnAfterPct * 100).toFixed(1)}%로 변합니다.`,
      );
    }
  }

  // 권장 사항 — 가장 시급한 항목 하나만 뽑는다
  if (risk?.hardBlocked) {
    sentences.push(`권장: "${risk.topConstraint ?? '재원 조건'}"부터 먼저 정리하세요.`);
  } else if (risk?.topDriver?.includes('계약') || risk?.topDriver?.includes('문서')) {
    sentences.push(`권장: ${risk.topDriver} 부분부터 먼저 정리하는 것을 권장합니다.`);
  } else if (leverage?.ltvAfterPct != null && leverage.ltvAfterPct >= 0.6) {
    sentences.push('권장: 담보대출 비중이 높습니다 — 대출 비율을 낮추거나 상환 계획을 먼저 세우세요.');
  } else if (risk?.feasibilityScore != null && risk.feasibilityScore < 60) {
    sentences.push('권장: 재원 확보 방안을 보강한 뒤 실행하세요.');
  } else {
    sentences.push('권장: 현재 조건대로 실행 가능해 보입니다 — 세부 절차는 세무사·법무사와 최종 확인하세요.');
  }

  return sentences;
}

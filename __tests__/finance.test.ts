/**
 * 금융 엔진(대차대조표·월 현금흐름) 테스트. 모든 데이터는 합성 값이다.
 * 이 테스트는 회계 항등식과 처리 규칙을 검증한다. 세법·모델 가정의 현실적 정확성은 검증하지 않는다.
 */
import { describe, it, expect } from 'vitest';
import {
  allocateByWeights, consolidatedBalanceSheet, convertLegacy, eokToWon, InvalidInputError,
  IN_CATS, OUT_CATS, personBalanceSheet, runCashflow, validateInput,
} from '../lib/finance';
import type { BalanceInput, CashflowInput, FinAsset, Liability } from '../lib/finance';
import { calcAnnualHoldingTaxes } from '../lib/tax';
import type { Asset, FamilyMember } from '../types';

const E = eokToWon;
const persons = [
  { id: 'A', name: 'A', relation: '본인', age: 70 },
  { id: 'B', name: 'B', relation: '자녀', age: 40 },
];

function asset(over: Partial<FinAsset> = {}): FinAsset {
  return {
    id: 'a1', name: '건물', cls: 'real_estate', marketValue: E(10), valuationDate: null, acquisitionCost: E(5),
    owners: [{ personId: 'A', pct: 100 }], liquid: false, sellable: true, sellCostPct: 0, sellLeadMonths: 0,
    annualCashYield: 0, annualOperatingCost: 0, priceGrowthAnnual: 0, ...over,
  };
}
function loan(over: Partial<Liability> = {}): Liability {
  return {
    id: 'L1', borrowerId: 'A', lenderId: null, principal: E(3), annualRate: 0.06, rateType: 'fixed',
    repayment: 'interest_only', remainingTermMonths: null, collateralAssetId: 'a1', feeKRW: 0,
    repayOnCollateralSale: true, ...over,
  };
}
function base(over: Partial<CashflowInput> = {}): CashflowInput {
  return { persons, assets: [asset()], liabilities: [], cash: { A: 0, B: 0 }, startMonth: '2026-01', horizonMonths: 12, ...over };
}
const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

describe('단위·배분', () => {
  it('억 → 원 변환은 정수이고 부동소수 오차가 없다', () => {
    expect(E(0.1)).toBe(10_000_000);
    expect(E(15)).toBe(1_500_000_000);
    expect(Number.isInteger(E(0.3))).toBe(true);
  });
  it('정수 배분의 합계는 항상 원금액과 같다', () => {
    for (const total of [1, 7, 100, 999_999_937]) {
      expect(sum(allocateByWeights(total, [1, 1, 1]))).toBe(total);
      expect(sum(allocateByWeights(total, [3, 5, 7, 11]))).toBe(total);
    }
  });
});

describe('대차대조표', () => {
  const input: BalanceInput = {
    persons, assets: [asset(), asset({ id: 'a2', name: '예금', cls: 'deposit', liquid: true, marketValue: E(2), owners: [{ personId: 'B', pct: 100 }] })],
    liabilities: [loan()], cash: { A: E(1), B: E(0.5) },
  };
  it('자산 - 부채 = 순자산 (개인별)', () => {
    const a = personBalanceSheet(input, 'A');
    expect(a.totalAssets - a.totalLiabilities).toBe(a.netWorth);
    expect(a.netWorth).toBe(E(10) + E(1) - E(3));
  });
  it('가족 내부 대출은 개인 장부에 남고 연결에서는 제거되며 연결 순자산을 늘리지 않는다', () => {
    const without = consolidatedBalanceSheet(input);
    const withFamily: BalanceInput = {
      ...input,
      liabilities: [...input.liabilities, loan({ id: 'F', borrowerId: 'B', lenderId: 'A', principal: E(1), collateralAssetId: null })],
      cash: { A: E(1) - E(1), B: E(0.5) + E(1) }, // A가 B에게 1억을 빌려줌(현금 이동)
    };
    const c = consolidatedBalanceSheet(withFamily);
    expect(c.eliminatedFamilyLoans).toBe(E(1));
    expect(c.externalDebt).toBe(without.externalDebt);
    expect(c.netWorth).toBe(without.netWorth);
    const pa = personBalanceSheet(withFamily, 'A'), pb = personBalanceSheet(withFamily, 'B');
    expect(pa.familyReceivable).toBe(E(1));
    expect(pb.familyPayable).toBe(E(1));
    expect(pa.netWorth + pb.netWorth).toBe(c.netWorth);
  });
  it('지분 합계가 100%를 넘으면 오류, 100% 미만이면 가족 몫만 연결에 반영', () => {
    const over: BalanceInput = { ...input, assets: [asset({ owners: [{ personId: 'A', pct: 70 }, { personId: 'B', pct: 40 }] })] };
    expect(validateInput(over).some(i => i.code === 'SHARE_OVER_100')).toBe(true);
    expect(() => runCashflow({ ...base(), assets: over.assets })).toThrow(InvalidInputError);
    const partial: BalanceInput = { ...input, assets: [asset({ owners: [{ personId: 'A', pct: 60 }] })], liabilities: [], cash: {} };
    expect(consolidatedBalanceSheet(partial).assetValue).toBe(E(6));
  });
  it('법인 지분은 지분가치로 한 번만 잡힌다(법인 보유자산 look-through 없음)', () => {
    const corp = asset({ id: 'c1', name: '가족법인 지분', cls: 'unlisted_equity', marketValue: E(8) });
    const c = consolidatedBalanceSheet({ persons, assets: [corp], liabilities: [], cash: {} });
    expect(c.assetValue).toBe(E(8));
  });
});

describe('현금흐름: 회계 처리', () => {
  it('기초현금 + 유입 - 유출 = 기말현금, 가족 내부 이전은 연결에서 상계', () => {
    const r = runCashflow(base({
      assets: [asset({ annualCashYield: E(0.6), annualOperatingCost: E(0.06), sellLeadMonths: 2, sellCostPct: 1 })],
      liabilities: [loan({ repayment: 'annuity', remainingTermMonths: 24, principal: E(2) })],
      cash: { A: E(1), B: E(0.2) },
      incomesMonthly: [{ personId: 'B', amount: E(0.03) }],
      livingCostMonthly: { A: E(0.01), B: E(0.01) },
      scheduledTaxes: [{ month: 3, personId: 'A', amount: E(0.1), label: '세금' }],
      events: [
        { type: 'transfer', month: 1, fromId: 'A', toId: 'B', amount: E(0.1), kind: 'gift' },
        { type: 'transfer', month: 2, fromId: 'A', toId: 'B', amount: E(0.1), kind: 'loan', loanTerms: { annualRate: 0.04, repayment: 'interest_only', termMonths: null } },
        { type: 'sell', month: 6, assetId: 'a1', taxKRW: E(0.2) },
      ],
      horizonMonths: 12,
    }));
    for (const p of persons) {
      const inflow = sum(r.months.map(m => sum(IN_CATS.map(c => m.flows[p.id].in[c]))));
      const outflow = sum(r.months.map(m => sum(OUT_CATS.map(c => m.flows[p.id].out[c]))));
      const open = p.id === 'A' ? E(1) : E(0.2);
      expect(open + inflow - outflow).toBe(r.months[r.months.length - 1].cash[p.id]);
    }
    for (const m of r.months) {
      expect(m.consolidatedFlows.in.family_in).toBe(m.consolidatedFlows.out.family_out);
      expect(sum(persons.map(p => m.personNetWorth[p.id]))).toBe(m.balance.netWorth);
    }
  });

  it('차입은 소득이 아니고, 순자산을 늘리지 않는다', () => {
    const r = runCashflow(base({
      events: [{ type: 'borrow', month: 0, borrowerId: 'A', collateralAssetId: 'a1', amount: E(3), annualRate: 0.05, rateType: 'fixed', repayment: 'interest_only', termMonths: null, maxLtv: 0.4 }],
    }));
    const m0 = r.months[0];
    expect(m0.flows.A.in.borrowing).toBe(E(3));
    expect(m0.flows.A.in.wage + m0.flows.A.in.rent_dividend + m0.flows.A.in.sale_proceeds).toBe(0);
    expect(m0.balance.netWorth).toBe(E(10)); // 현금 +3억, 부채 +3억
    expect(m0.loanBalance).toBe(E(3));
  });

  it('원금상환은 순자산을 줄이지 않고 이자만 순자산을 줄인다. 원리금균등은 만기에 0이 된다', () => {
    const r = runCashflow(base({
      liabilities: [loan({ repayment: 'annuity', remainingTermMonths: 12, principal: E(3) })],
      cash: { A: E(5), B: 0 },
    }));
    const initialNW = E(10) + E(5) - E(3);
    expect(r.months[11].loanBalance).toBe(0);
    expect(r.metrics.principalPaid).toBe(E(3));
    expect(r.metrics.interestPaid).toBeGreaterThan(0);
    expect(r.metrics.finalNetWorth).toBe(initialNW - r.metrics.interestPaid);
  });

  it('이자만 내는 대출은 만기월에 원금을 일시상환한다', () => {
    const r = runCashflow(base({
      liabilities: [loan({ remainingTermMonths: 6, principal: E(3) })], cash: { A: E(5), B: 0 },
    }));
    expect(r.months[4].loanBalance).toBe(E(3));
    expect(r.months[5].loanBalance).toBe(0);
    expect(r.months[5].flows.A.out.principal).toBe(E(3));
  });

  it('변동금리만 금리 경로의 영향을 받는다', () => {
    const run = (rateType: 'fixed' | 'variable') => runCashflow(base({
      liabilities: [loan({ rateType })], cash: { A: E(5), B: 0 }, horizonMonths: 1, ratePathAdd: [0.02],
    })).months[0].flows.A.out.interest;
    expect(run('fixed')).toBe(Math.round(E(3) * 0.06 / 12));
    expect(run('variable')).toBe(Math.round(E(3) * 0.08 / 12));
  });

  it('가격수익과 현금수익을 이중 계산하지 않는다', () => {
    const g = 0.03, yearly = E(0.4);
    const r = runCashflow(base({ assets: [asset({ priceGrowthAnnual: g, annualCashYield: yearly })], horizonMonths: 13 }));
    for (const m of [0, 6, 12]) {
      const expected = Math.round(E(10) * Math.pow(1 + g, m / 12)) + (m + 1) * Math.round(yearly / 12);
      expect(r.months[m].balance.netWorth).toBe(expected);
    }
  });

  it('세금은 실제 지급월에만 현금·순자산에 반영된다(미납 잠재세금은 차감하지 않음)', () => {
    const r = runCashflow(base({ cash: { A: E(1), B: 0 }, scheduledTaxes: [{ month: 3, personId: 'A', amount: E(0.3), label: '세금' }] }));
    expect(r.months[2].balance.netWorth).toBe(E(11));
    expect(r.months[3].balance.netWorth).toBe(E(11) - E(0.3));
    expect(r.metrics.taxPaid).toBe(E(0.3));
  });
});

describe('매각', () => {
  const sellInput = () => base({
    assets: [asset({ sellLeadMonths: 3, sellCostPct: 1 })],
    liabilities: [loan({ annualRate: 0 })],
    cash: { A: E(1), B: 0 },
    events: [{ type: 'sell', month: 1, assetId: 'a1', taxKRW: E(1) }],
    horizonMonths: 8,
  });
  it('매각 소요기간 전에는 현금을 쓸 수 없고, 수령월에 비용·담보상환·세금이 순서대로 반영된다', () => {
    const r = runCashflow(sellInput());
    const nw0 = r.months[0].balance.netWorth;
    expect(r.months[3].cash.A).toBe(E(1));                  // 아직 대금 없음
    expect(r.months[3].balance.netWorth).toBe(nw0);         // 미수금으로 순자산 유지
    expect(r.months[4].cash.A).toBe(E(1) + E(10) - E(0.1) - E(3)); // 수령 - 비용 - 담보대출 상환
    expect(r.months[4].balance.netWorth).toBe(nw0 - E(0.1));       // 순자산 감소는 매각비용뿐
    expect(r.months[5].cash.A).toBe(r.months[4].cash.A);    // 세금은 수령 2개월 후
    expect(r.months[6].cash.A).toBe(r.months[4].cash.A - E(1));
    expect(r.months[6].balance.netWorth).toBe(nw0 - E(0.1) - E(1));
  });
});

describe('실현 가능성 검사 — 불가능한 거래는 거부하고 기록한다', () => {
  it('중복 매각, 소유자 없는 자산 매각', () => {
    const r = runCashflow(base({
      assets: [asset(), asset({ id: 'a2', name: '무주', owners: [] })],
      events: [
        { type: 'sell', month: 0, assetId: 'a1' }, { type: 'sell', month: 1, assetId: 'a1' },
        { type: 'sell', month: 1, assetId: 'a2' }, { type: 'sell', month: 1, assetId: 'nope' },
      ],
    }));
    expect(r.infeasible.map(i => i.reason)).toEqual([
      expect.stringContaining('중복 매각'), expect.stringContaining('가족 소유 지분이 없는'), expect.stringContaining('존재하지 않는'),
    ]);
  });
  it('담보한도를 넘는 차입, 소유하지 않은 담보', () => {
    const b = (amount: number, borrowerId = 'A') => ({
      type: 'borrow' as const, month: 0, borrowerId, collateralAssetId: 'a1', amount,
      annualRate: 0.05, rateType: 'fixed' as const, repayment: 'interest_only' as const, termMonths: null, maxLtv: 0.4,
    });
    const r = runCashflow(base({ events: [b(E(4)), b(1), b(E(1), 'B')] }));
    expect(r.infeasible).toHaveLength(2);
    expect(r.infeasible[0].reason).toContain('담보한도 초과');
    expect(r.infeasible[1].reason).toContain('소유하지 않습니다');
    expect(r.months[0].loanBalance).toBe(E(4));
  });
  it('가족 대여자의 현금이 부족하면 이전하지 못한다. 같은 달 의무 지급이 먼저 반영된다', () => {
    const r = runCashflow(base({
      cash: { A: E(1), B: 0 },
      scheduledTaxes: [{ month: 0, personId: 'A', amount: E(0.9), label: '세금' }],
      events: [{ type: 'transfer', month: 0, fromId: 'A', toId: 'B', amount: E(0.5), kind: 'gift' }],
    }));
    expect(r.infeasible).toHaveLength(1);
    expect(r.infeasible[0].reason).toContain('현금 부족');
    expect(r.months[0].cash.B).toBe(0);
  });
  it('보유 지분보다 큰 지분은 증여할 수 없다', () => {
    const r = runCashflow(base({ events: [{ type: 'giftAsset', month: 0, assetId: 'a1', fromId: 'A', toId: 'B', pct: 120 }] }));
    expect(r.infeasible).toHaveLength(1);
  });
});

describe('현금 부족은 숨기거나 자동으로 메우지 않는다', () => {
  it('생활비로 현금이 마르면 부족액을 기록하고 대출·매각을 만들지 않는다', () => {
    const r = runCashflow(base({ livingCostMonthly: { A: E(0.1) }, horizonMonths: 12 }));
    expect(r.metrics.firstShortfallMonth).toBe(0);
    expect(r.metrics.shortfallMonths).toBe(12);
    expect(r.metrics.maxConsolidatedShortfall).toBe(E(1.2));
    expect(r.months.every(m => m.loanBalance === 0)).toBe(true);
    expect(r.months[11].balance.assetValue).toBe(E(10));
    expect(r.metrics.anyPersonShortfall).toBe(true);
  });
  it('같은 달 차입금이 의무 지급 직후의 부족을 가리지 않는다', () => {
    const r = runCashflow(base({
      cash: { A: E(0.5), B: 0 },
      scheduledTaxes: [{ month: 0, personId: 'A', amount: E(0.9), label: '세금' }],
      events: [{ type: 'borrow', month: 0, borrowerId: 'A', collateralAssetId: 'a1', amount: E(3), annualRate: 0.05, rateType: 'fixed', repayment: 'interest_only', termMonths: null, maxLtv: 0.5 }],
    }));
    expect(r.months[0].consolidatedCash).toBeGreaterThan(0);          // 월말 현금은 양수
    expect(r.months[0].consolidatedShortfall).toBe(E(0.4));           // 그래도 부족으로 기록
    expect(r.metrics.firstShortfallMonth).toBe(0);
    expect(r.metrics.minConsolidatedCash).toBe(-E(0.4));
  });
});

describe('가족 내부 거래', () => {
  it('내부 대출·증여는 연결 현금과 연결 순자산을 바꾸지 않는다(세금 제외). 내부 이자는 상계된다', () => {
    const r = runCashflow(base({
      cash: { A: E(2), B: 0 },
      events: [{ type: 'transfer', month: 0, fromId: 'A', toId: 'B', amount: E(1), kind: 'loan', loanTerms: { annualRate: 0.06, repayment: 'interest_only', termMonths: null } }],
      horizonMonths: 6,
    }));
    for (const m of r.months) {
      expect(m.consolidatedCash).toBe(E(2));
      expect(m.balance.netWorth).toBe(E(12));
      expect(sum(persons.map(p => m.personNetWorth[p.id]))).toBe(E(12));
    }
    expect(r.months[0].familyLoanBalance).toBe(E(1));
    expect(r.months[1].flows.B.out.family_out).toBe(Math.round(E(1) * 0.06 / 12));
    expect(r.metrics.interestPaid).toBe(0);
  });
  it('지분 증여 후 임대수익은 새 소유 지분을 따라가고, 증여세는 수증자가 납부한다', () => {
    const r = runCashflow(base({
      assets: [asset({ annualCashYield: E(1.2) })],
      cash: { A: 0, B: E(1) },
      events: [{ type: 'giftAsset', month: 2, assetId: 'a1', fromId: 'A', toId: 'B', pct: 30, taxKRW: E(0.3) }],
      horizonMonths: 8,
    }));
    const monthly = E(1.2) / 12;
    expect(r.months[2].flows.B.in.rent_dividend).toBe(0);
    expect(r.months[3].flows.A.in.rent_dividend).toBe(Math.round(monthly * 0.7));
    expect(r.months[3].flows.B.in.rent_dividend).toBe(Math.round(monthly * 0.3));
    expect(r.months[5].flows.B.out.tax).toBe(E(0.3));
  });
});

describe('재현성', () => {
  it('같은 입력은 같은 결과를 내고 입력 객체를 바꾸지 않는다', () => {
    const input = base({
      assets: [asset({ priceGrowthAnnual: 0.02, annualCashYield: E(0.3) })], liabilities: [loan()], cash: { A: E(1), B: 0 },
      events: [{ type: 'sell', month: 5, assetId: 'a1', taxKRW: E(0.2) }],
    });
    const snapshot = JSON.stringify(input);
    const r1 = runCashflow(input), r2 = runCashflow(input);
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });
});

// ── 기존 DB 모델 변환 ────────────────────────────────────────────
function legacyAsset(o: Record<string, unknown> = {}): Asset {
  return {
    id: 'x1', family_id: 'f', owner_member_id: 'm1', name: '공장', asset_type: '상업용부동산',
    current_value: 15, acquisition_cost: 3, acquisition_date: '2005-01-01', assessed_value: null, public_price_ratio: 70,
    appraisal_value: null, valuation_source: null, necessary_expenses: null, annual_yield_pct: 2, expected_growth_pct: 1.5,
    annual_tax: 0, monthly_rent: null, vacancy_rate_pct: null, maintenance_cost: null, dividend_yield_pct: null,
    loan_amount: 0, loan_rate_pct: 0, loan_type: 'fixed', jeonse_deposit: null, other_assumed_debt: null,
    is_planned_transfer: false, is_primary_residence: null, is_regulated_area: null, housing_use: null, house_count: null,
    ownership_share_pct: null, co_owner_count: null, collateral_available: null, liquidity_score: null,
    forced_sale_discount_pct: null, sale_lead_months: null, notes: '', created_at: '', updated_at: '', ...o,
  } as unknown as Asset;
}
function legacyMember(o: Record<string, unknown> = {}): FamilyMember {
  return { id: 'm1', family_id: 'f', name: '가', relation: '본인', generation: 0, age: 70, annual_income: 0.5, cash_hold: 2, total_debt: 0, color: '', ...o } as unknown as FamilyMember;
}

describe('기존 DB 모델 변환', () => {
  const opt = { startMonth: '2026-01', horizonMonths: 24, macro: null };
  it('억 단위를 원 단위 정수로 바꾸고 기존 대출을 담보부 외부 부채로 옮긴다', () => {
    const conv = convertLegacy([legacyAsset({ loan_amount: 4, loan_rate_pct: 5 })], [legacyMember()], opt);
    expect(conv.base.assets[0].marketValue).toBe(E(15));
    expect(conv.base.cash.m1).toBe(E(2));
    expect(conv.base.liabilities[0]).toMatchObject({ principal: E(4), annualRate: 0.05, collateralAssetId: 'x1', lenderId: null });
    const c = consolidatedBalanceSheet({ ...conv.base, receivables: {} });
    expect(c.netWorth).toBe(E(15) + E(2) - E(4));
  });
  it('소유자 미지정 자산은 조용히 포함하지 않고 제외 목록에 표시한다', () => {
    const conv = convertLegacy([legacyAsset(), legacyAsset({ id: 'x2', name: '토지', owner_member_id: null })], [legacyMember()], opt);
    expect(conv.excludedAssets).toEqual([expect.objectContaining({ id: 'x2' })]);
    expect(conv.base.assets).toHaveLength(1);
  });
  it('월 임대료가 있으면 수익률보다 우선하고, 불일치는 경고한다', () => {
    const conv = convertLegacy([legacyAsset({ monthly_rent: 100, vacancy_rate_pct: 10, annual_yield_pct: 8 })], [legacyMember()], opt);
    expect(conv.base.assets[0].annualCashYield).toBe(100 * 10_000 * 12 * 0.9);
    expect(conv.warnings.some(w => w.includes('월 임대료 환산 수익률'))).toBe(true);
  });
  it('쓰이지 않는 지분율 입력은 무시하고 경고한다', () => {
    const conv = convertLegacy([legacyAsset({ ownership_share_pct: 50 })], [legacyMember()], opt);
    expect(conv.base.assets[0].owners).toEqual([{ personId: 'm1', pct: 100 }]);
    expect(conv.warnings.some(w => w.includes('지분율 입력'))).toBe(true);
  });
  it('변환 결과로 10년 현금흐름을 끝까지 계산하고 NaN이 없다', () => {
    const conv = convertLegacy(
      [legacyAsset({ loan_amount: 4, loan_rate_pct: 5, annual_tax: 0.1 }), legacyAsset({ id: 'x3', name: '대지', asset_type: '토지', current_value: 4, annual_yield_pct: 0 })],
      [legacyMember()], { ...opt, horizonMonths: 120 },
    );
    const r = runCashflow(conv.base);
    expect(r.months).toHaveLength(120);
    expect(r.annual).toHaveLength(10);
    expect(r.months.every(m => Number.isFinite(m.balance.netWorth) && Number.isFinite(m.consolidatedCash))).toBe(true);
    expect(conv.warnings.some(w => w.includes('생활비'))).toBe(true);
  });
  it('보유세 납부월: 재산세 7·9월, 임대소득세 5월, 종부세 12월(기존 함수의 종부세가 0보다 클 때만)', () => {
    const taxMonths = (assets: Asset[]) => {
      const conv = convertLegacy(assets, [legacyMember()], { ...opt, horizonMonths: 24 }); // 2026-01 시작
      const byLabel = (label: string) => Array.from(new Set(conv.base.scheduledTaxes!.filter(t => t.label.startsWith(label)).map(t => t.month % 12))).sort((a, b) => a - b);
      return { prop: byLabel('재산세'), income: byLabel('임대소득세'), cre: byLabel('종합부동산세') };
    };
    const factory = taxMonths([legacyAsset(), legacyAsset({ id: 'x3', asset_type: '토지', current_value: 4 })]);
    expect(factory.prop).toEqual([6, 8]);
    expect(factory.income).toEqual([4]);
    expect(calcAnnualHoldingTaxes([legacyAsset(), legacyAsset({ id: 'x3', asset_type: '토지', current_value: 4 })]).comprehensiveRealEstateTax).toBe(0);
    expect(factory.cre).toEqual([]);
    const housing = [legacyAsset({ id: 'h', asset_type: '주거용부동산', current_value: 40 })];
    expect(calcAnnualHoldingTaxes(housing).comprehensiveRealEstateTax).toBeGreaterThan(0);
    expect(taxMonths(housing).cre).toEqual([11]);
  });
});

import type { BalanceInput, FinAsset, InputIssue, Liability, RateType, Repayment } from './types';
import { InvalidInputError } from './types';
import {
  assertValid, collateralCapacity, consolidatedBalanceSheet, familyPct, ltvByAsset, ownerPct,
  personBalanceSheet,
} from './balance-sheet';
import type { ConsolidatedBalance } from './balance-sheet';
import { allocateByWeights } from './units';
import type { KRW } from './units';

/**
 * 월 단위 현금흐름 엔진 (결정론적).
 *
 * 월별 처리 순서 (고정 규칙):
 *   0. 자산 가격 갱신(가격수익만. 현금수익과 분리)
 *   1. 수익 발생: 소득, 임대·배당, 만기 도래한 매각대금
 *   2. 의무 지급: 생활비·운영비, 세금, 담보해제 상환, 대출 이자·원금
 *   3. 계획된 거래: 매각 결정, 차입, 가족 간 이전, 지분 증여 (입력 순서)
 *   4. 잔액 확인: 현금이 음수면 부족액으로 기록 — 자동 대출·매각으로 메우지 않는다.
 * 같은 달의 차입금은 그 달의 의무 지급(2)보다 늦게 들어오므로, 의무 지급을 메우지 못한다.
 */

export type InCat = 'wage' | 'rent_dividend' | 'sale_proceeds' | 'borrowing' | 'family_in';
export type OutCat = 'living' | 'maintenance' | 'tax' | 'interest' | 'principal' | 'fees' | 'family_out';
export interface Flows { in: Record<InCat, KRW>; out: Record<OutCat, KRW> }

export const IN_CATS: InCat[] = ['wage', 'rent_dividend', 'sale_proceeds', 'borrowing', 'family_in'];
export const OUT_CATS: OutCat[] = ['living', 'maintenance', 'tax', 'interest', 'principal', 'fees', 'family_out'];

export interface ScheduledTax { month: number; personId: string; amount: KRW; label: string }

interface BaseEvent { month: number; label?: string }
export interface SellEvent extends BaseEvent {
  type: 'sell'; assetId: string;
  /** 이 매각에 대한 총 세금(기존 세법 함수로 계산한 값). 엔진은 세법을 계산하지 않는다. */
  taxKRW?: KRW;
  /** 대금 수령월 이후 납부까지 개월 수. 기본 2 (양도소득세 예정신고 기한 가정) */
  taxDelayMonths?: number;
}
export interface BorrowEvent extends BaseEvent {
  type: 'borrow'; borrowerId: string; collateralAssetId: string; amount: KRW;
  annualRate: number; rateType: RateType; repayment: Repayment; termMonths: number | null;
  feeKRW?: KRW;
  /** 사용자 가정: 차입자 지분 담보가치 대비 최대 LTV (0~1) */
  maxLtv: number;
}
export interface TransferEvent extends BaseEvent {
  type: 'transfer'; fromId: string; toId: string; amount: KRW; kind: 'gift' | 'loan';
  taxKRW?: KRW; taxDelayMonths?: number;
  loanTerms?: { annualRate: number; rateType?: RateType; repayment: Repayment; termMonths: number | null };
}
export interface GiftAssetEvent extends BaseEvent {
  type: 'giftAsset'; assetId: string; fromId: string; toId: string;
  /** 자산 전체 기준 이전 지분(%p) */
  pct: number;
  taxKRW?: KRW; taxDelayMonths?: number;
}
export type ScenarioEvent = SellEvent | BorrowEvent | TransferEvent | GiftAssetEvent;

export interface CashflowInput extends BalanceInput {
  /** 시작 월 YYYY-MM */
  startMonth: string;
  horizonMonths: number;
  incomesMonthly?: Array<{ personId: string; amount: KRW; label?: string }>;
  livingCostMonthly?: Record<string, KRW>;
  scheduledTaxes?: ScheduledTax[];
  events?: ScenarioEvent[];
  /** 변동금리 대출에 더하는 금리 경로(소수, 월 인덱스). 길이가 짧으면 마지막 값을 유지한다. */
  ratePathAdd?: number[];
}

export interface InfeasibleEvent { month: number; eventIndex: number; type: ScenarioEvent['type']; reason: string }

export interface MonthRecord {
  month: number;
  label: string;
  flows: Record<string, Flows>;
  consolidatedFlows: Flows;
  cash: Record<string, KRW>;
  consolidatedCash: KRW;
  /** 의무 지급 직후(계획된 거래 전) 연결 현금. 같은 달 차입금이 부족을 가리지 못하게 따로 기록한다. */
  consolidatedCashAfterObligations: KRW;
  /** 월중 최저 연결 현금 부족액(양수). 의무 지급 직후와 월말 중 더 나쁜 값 */
  consolidatedShortfall: KRW;
  personShortfall: Record<string, KRW>;
  balance: ConsolidatedBalance;
  personNetWorth: Record<string, KRW>;
  loanBalance: KRW;
  familyLoanBalance: KRW;
  ltv: Record<string, number | null>;
}

export interface AnnualSummary {
  year: number;
  fromLabel: string;
  toLabel: string;
  inflow: Record<InCat, KRW>;
  outflow: Record<OutCat, KRW>;
  closingCash: KRW;
  minCash: KRW;
  closingNetWorth: KRW;
}

export interface CashflowMetrics {
  minConsolidatedCash: KRW;
  minConsolidatedCashMonth: number;
  maxConsolidatedShortfall: KRW;
  firstShortfallMonth: number | null;
  shortfallMonths: number;
  anyPersonShortfall: boolean;
  personMinCash: Record<string, KRW>;
  finalNetWorth: KRW;
  /** 기간 중 실제 납부한 세금 합계(미납 세금은 차감하지 않음) */
  taxPaid: KRW;
  interestPaid: KRW;
  principalPaid: KRW;
  maxLtv: number | null;
}

export interface CashflowResult {
  months: MonthRecord[];
  annual: AnnualSummary[];
  infeasible: InfeasibleEvent[];
  unpaidAtHorizon: ScheduledTax[];
  metrics: CashflowMetrics;
  warnings: InputIssue[];
  assumptions: string[];
}

export const ENGINE_ASSUMPTIONS: string[] = [
  '모든 금액은 원 단위 정수이며, 월별 처리 순서는 수익 → 의무 지급 → 계획된 거래 → 잔액 확인입니다.',
  '현금이 부족해도 자동으로 대출·매각을 만들지 않고 부족액으로 기록합니다.',
  '순자산은 실제 납부한 세금만 반영합니다. 아직 납부하지 않았거나 매각하지 않은 자산의 잠재세금은 차감하지 않습니다.',
  '자산 가격 상승률은 가격수익만 의미하며, 임대료·배당은 별도의 명목 고정 현금수익으로 처리합니다(이중 계산 방지).',
  '세금은 입력된 금액을 지정한 월에 지급합니다. 엔진은 세법 규칙을 계산하지 않습니다.',
  '담보대출 한도는 차입자 지분에 해당하는 담보가치 × 사용자가 지정한 최대 LTV입니다.',
  '담보자산을 매각하면 대금 수령월에 해당 담보대출을 상환합니다(담보 해제 가정).',
  '만기를 모르는 대출은 이자만 납부하고 만기를 연장한다고 가정합니다.',
  '변동금리 대출은 입력한 금리 경로를 더한 금리로 매월 이자를 계산하며, 원리금균등은 매월 잔액 기준으로 재계산합니다.',
];

interface LoanState { def: Liability; balance: KRW; remaining: number | null; firstPaymentMonth: number }
interface Pending { assetId: string; personId: string; gross: KRW; cost: KRW; arrival: number }

function emptyFlows(): Flows {
  return {
    in: { wage: 0, rent_dividend: 0, sale_proceeds: 0, borrowing: 0, family_in: 0 },
    out: { living: 0, maintenance: 0, tax: 0, interest: 0, principal: 0, fees: 0, family_out: 0 },
  };
}

function addFlows(into: Flows, from: Flows) {
  for (const c of IN_CATS) into.in[c] += from.in[c];
  for (const c of OUT_CATS) into.out[c] += from.out[c];
}

function parseStart(startMonth: string): { y: number; m: number } {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(startMonth);
  if (!match) {
    throw new InvalidInputError([{ severity: 'error', code: 'BAD_START', message: '시작 월은 YYYY-MM 형식이어야 합니다.' }]);
  }
  return { y: Number(match[1]), m: Number(match[2]) };
}

export function monthLabel(startMonth: string, offset: number): string {
  const { y, m } = parseStart(startMonth);
  const idx = y * 12 + (m - 1) + offset;
  const yy = Math.floor(idx / 12);
  const mm = (idx % 12) + 1;
  return `${yy}-${String(mm).padStart(2, '0')}`;
}

/** 해당 월 인덱스의 달력 월(1~12) */
export function calendarMonth(startMonth: string, offset: number): number {
  return Number(monthLabel(startMonth, offset).slice(5, 7));
}

function monthlyServiceFor(loan: LoanState, m: number, ratePath: number[]): { interest: KRW; principal: KRW } {
  if (loan.balance <= 0 || m < loan.firstPaymentMonth) return { interest: 0, principal: 0 };
  const add = loan.def.rateType === 'variable' && ratePath.length > 0
    ? ratePath[Math.min(m, ratePath.length - 1)] : 0;
  const r = Math.max(0, loan.def.annualRate + add) / 12;
  const interest = Math.round(loan.balance * r);
  const rem = loan.remaining;
  let principal = 0;
  if (rem !== null && rem <= 1) {
    principal = loan.balance;
  } else if (loan.def.repayment === 'annuity' && rem !== null) {
    const pmt = r === 0 ? loan.balance / rem : (loan.balance * r) / (1 - Math.pow(1 + r, -rem));
    principal = Math.min(loan.balance, Math.max(0, Math.round(pmt) - interest));
  }
  return { interest, principal };
}

export function runCashflow(input: CashflowInput): CashflowResult {
  const warnings = assertValid(input);
  const H = input.horizonMonths;
  if (!Number.isInteger(H) || H < 1 || H > 600) {
    throw new InvalidInputError([{ severity: 'error', code: 'BAD_HORIZON', message: '기간은 1~600개월의 정수여야 합니다.' }]);
  }
  parseStart(input.startMonth);

  const personIds = input.persons.map(p => p.id);
  const assets = new Map<string, FinAsset>(
    input.assets.map(a => [a.id, { ...a, owners: a.owners.map(o => ({ ...o })) }]),
  );
  const baseValue = new Map(input.assets.map(a => [a.id, a.marketValue]));
  const sold = new Set<string>();
  const cash: Record<string, KRW> = {};
  for (const id of personIds) cash[id] = input.cash[id] ?? 0;
  const loans: LoanState[] = input.liabilities.map(l => ({
    def: { ...l }, balance: l.principal, remaining: l.remainingTermMonths, firstPaymentMonth: 0,
  }));
  let pending: Pending[] = [];
  const taxes: ScheduledTax[] = [...(input.scheduledTaxes ?? [])];
  const ratePath = input.ratePathAdd ?? [];
  const infeasible: InfeasibleEvent[] = [];
  const events = (input.events ?? []).map((e, i) => ({ e, i })).sort((a, b) => a.e.month - b.e.month || a.i - b.i);
  let eventSeq = 0;

  const months: MonthRecord[] = [];

  for (let m = 0; m < H; m++) {
    const flows: Record<string, Flows> = {};
    for (const id of personIds) flows[id] = emptyFlows();
    const inflow = (id: string, c: InCat, amt: KRW) => { if (amt === 0) return; flows[id].in[c] += amt; cash[id] += amt; };
    const outflow = (id: string, c: OutCat, amt: KRW) => { if (amt === 0) return; flows[id].out[c] += amt; cash[id] -= amt; };

    // 0. 가격 갱신
    for (const [id, a] of Array.from(assets.entries())) {
      if (sold.has(id)) continue;
      a.marketValue = Math.round(baseValue.get(id)! * Math.pow(1 + a.priceGrowthAnnual, m / 12));
    }

    // 1. 수익 발생
    for (const inc of input.incomesMonthly ?? []) inflow(inc.personId, 'wage', inc.amount);
    for (const [id, a] of Array.from(assets.entries())) {
      if (sold.has(id) || a.owners.length === 0) continue;
      const weights = a.owners.map(o => o.pct);
      const fam = familyPct(a) / 100;
      const y = allocateByWeights(Math.round(Math.round(a.annualCashYield / 12) * fam), weights);
      const c = allocateByWeights(Math.round(Math.round(a.annualOperatingCost / 12) * fam), weights);
      a.owners.forEach((o, k) => { inflow(o.personId, 'rent_dividend', y[k]); outflow(o.personId, 'maintenance', c[k]); });
    }
    const payoffAssets: string[] = [];
    for (const p of pending.filter(x => x.arrival === m)) {
      inflow(p.personId, 'sale_proceeds', p.gross);
      outflow(p.personId, 'fees', p.cost);
      if (!payoffAssets.includes(p.assetId)) payoffAssets.push(p.assetId);
    }
    pending = pending.filter(x => x.arrival !== m);

    // 2. 의무 지급
    for (const [id, amt] of Object.entries(input.livingCostMonthly ?? {})) outflow(id, 'living', amt);
    for (const t of taxes.filter(x => x.month === m)) outflow(t.personId, 'tax', t.amount);
    for (const assetId of payoffAssets) {
      for (const ln of loans.filter(l => l.def.collateralAssetId === assetId && l.def.repayOnCollateralSale && l.balance > 0)) {
        outflow(ln.def.borrowerId, 'principal', ln.balance);
        if (ln.def.lenderId !== null) inflow(ln.def.lenderId, 'family_in', ln.balance);
        ln.balance = 0;
      }
    }
    for (const ln of loans) {
      const { interest, principal } = monthlyServiceFor(ln, m, ratePath);
      if (ln.balance > 0 && m >= ln.firstPaymentMonth) {
        if (ln.def.lenderId === null) {
          outflow(ln.def.borrowerId, 'interest', interest);
          outflow(ln.def.borrowerId, 'principal', principal);
        } else {
          outflow(ln.def.borrowerId, 'family_out', interest + principal);
          inflow(ln.def.lenderId, 'family_in', interest + principal);
        }
        ln.balance -= principal;
        if (ln.remaining !== null) ln.remaining -= 1;
      }
    }

    const cashAfterObligations: Record<string, KRW> = { ...cash };

    // 3. 계획된 거래
    for (const { e, i } of events.filter(x => x.e.month === m)) {
      const fail = (reason: string) => infeasible.push({ month: m, eventIndex: i, type: e.type, reason });
      if (e.type === 'sell') {
        const a = assets.get(e.assetId);
        if (!a) { fail('존재하지 않는 자산입니다.'); continue; }
        if (sold.has(a.id)) { fail('이미 매각한 자산입니다(중복 매각).'); continue; }
        if (!a.sellable) { fail('매각할 수 없는 자산입니다.'); continue; }
        if (familyPct(a) <= 0) { fail('가족 소유 지분이 없는 자산입니다.'); continue; }
        const gross = Math.round((a.marketValue * familyPct(a)) / 100);
        const weights = a.owners.map(o => o.pct);
        const grossParts = allocateByWeights(gross, weights);
        const costParts = allocateByWeights(Math.round((gross * a.sellCostPct) / 100), weights);
        const arrival = m + a.sellLeadMonths;
        sold.add(a.id);
        a.owners.forEach((o, k) => pending.push({ assetId: a.id, personId: o.personId, gross: grossParts[k], cost: costParts[k], arrival }));
        if ((e.taxKRW ?? 0) > 0) {
          const parts = allocateByWeights(e.taxKRW!, weights);
          a.owners.forEach((o, k) => taxes.push({ month: arrival + (e.taxDelayMonths ?? 2), personId: o.personId, amount: parts[k], label: e.label ?? `${a.name} 매각 세금` }));
        }
      } else if (e.type === 'borrow') {
        const a = assets.get(e.collateralAssetId);
        if (!a || sold.has(a.id)) { fail('담보자산이 없거나 이미 매각했습니다.'); continue; }
        if (e.amount <= 0) { fail('차입 금액이 0 이하입니다.'); continue; }
        if (ownerPct(a, e.borrowerId) <= 0) { fail('차입자가 담보자산을 소유하지 않습니다.'); continue; }
        const used = loans.filter(l => l.def.collateralAssetId === a.id).reduce((s, l) => s + l.balance, 0);
        const cap = collateralCapacity(a, e.borrowerId, e.maxLtv);
        if (used + e.amount > cap) { fail(`담보한도 초과: 기존 ${used}원 + 신규 ${e.amount}원 > 한도 ${cap}원`); continue; }
        loans.push({
          def: {
            id: `event-loan-${eventSeq++}`, borrowerId: e.borrowerId, lenderId: null, principal: e.amount,
            annualRate: e.annualRate, rateType: e.rateType, repayment: e.repayment, remainingTermMonths: e.termMonths,
            collateralAssetId: a.id, feeKRW: e.feeKRW ?? 0, repayOnCollateralSale: true,
          },
          balance: e.amount, remaining: e.termMonths, firstPaymentMonth: m + 1,
        });
        inflow(e.borrowerId, 'borrowing', e.amount);
        outflow(e.borrowerId, 'fees', e.feeKRW ?? 0);
      } else if (e.type === 'transfer') {
        if (e.amount <= 0 || e.fromId === e.toId || !(e.fromId in cash) || !(e.toId in cash)) { fail('이전 대상 또는 금액이 올바르지 않습니다.'); continue; }
        if (cash[e.fromId] < e.amount) { fail(`제공자 현금 부족: 보유 ${cash[e.fromId]}원 < 이전 ${e.amount}원`); continue; }
        outflow(e.fromId, 'family_out', e.amount);
        inflow(e.toId, 'family_in', e.amount);
        if (e.kind === 'gift' && (e.taxKRW ?? 0) > 0) {
          taxes.push({ month: m + (e.taxDelayMonths ?? 3), personId: e.toId, amount: e.taxKRW!, label: e.label ?? '증여세' });
        }
        if (e.kind === 'loan') {
          const t = e.loanTerms ?? { annualRate: 0, repayment: 'interest_only' as Repayment, termMonths: null };
          loans.push({
            def: {
              id: `event-loan-${eventSeq++}`, borrowerId: e.toId, lenderId: e.fromId, principal: e.amount,
              annualRate: t.annualRate, rateType: t.rateType ?? 'fixed', repayment: t.repayment,
              remainingTermMonths: t.termMonths, collateralAssetId: null, feeKRW: 0, repayOnCollateralSale: false,
            },
            balance: e.amount, remaining: t.termMonths, firstPaymentMonth: m + 1,
          });
        }
      } else {
        const a = assets.get(e.assetId);
        if (!a || sold.has(a.id)) { fail('증여할 자산이 없거나 이미 매각했습니다.'); continue; }
        if (e.pct <= 0 || e.fromId === e.toId || !(e.toId in cash)) { fail('증여 대상 또는 지분이 올바르지 않습니다.'); continue; }
        if (ownerPct(a, e.fromId) + 1e-9 < e.pct) { fail(`증여자 보유 지분(${ownerPct(a, e.fromId)}%)보다 큰 지분(${e.pct}%)은 이전할 수 없습니다.`); continue; }
        const from = a.owners.find(o => o.personId === e.fromId)!;
        from.pct -= e.pct;
        const to = a.owners.find(o => o.personId === e.toId);
        if (to) to.pct += e.pct; else a.owners.push({ personId: e.toId, pct: e.pct });
        a.owners = a.owners.filter(o => o.pct > 1e-9);
        if ((e.taxKRW ?? 0) > 0) {
          taxes.push({ month: m + (e.taxDelayMonths ?? 3), personId: e.toId, amount: e.taxKRW!, label: e.label ?? `${a.name} 증여세` });
        }
      }
    }

    // 4. 잔액 확인 및 스냅샷
    const liveAssets = Array.from(assets.values()).filter(a => !sold.has(a.id));
    const receivables: Record<string, KRW> = {};
    for (const p of pending) receivables[p.personId] = (receivables[p.personId] ?? 0) + p.gross;
    const snap: BalanceInput = {
      persons: input.persons,
      assets: liveAssets,
      liabilities: loans.filter(l => l.balance > 0).map(l => ({ ...l.def, principal: l.balance })),
      cash: { ...cash },
      receivables,
    };
    const balance = consolidatedBalanceSheet(snap);
    const consolidatedFlows = emptyFlows();
    for (const id of personIds) addFlows(consolidatedFlows, flows[id]);
    const personShortfall: Record<string, KRW> = {};
    const personNetWorth: Record<string, KRW> = {};
    const consolidatedAfterObligations = personIds.reduce((sum, id) => sum + cashAfterObligations[id], 0);
    for (const id of personIds) {
      personShortfall[id] = Math.max(0, -Math.min(cash[id], cashAfterObligations[id]));
      personNetWorth[id] = personBalanceSheet(snap, id).netWorth;
    }
    months.push({
      month: m,
      label: monthLabel(input.startMonth, m),
      flows,
      consolidatedFlows,
      cash: { ...cash },
      consolidatedCash: balance.cash,
      consolidatedCashAfterObligations: consolidatedAfterObligations,
      consolidatedShortfall: Math.max(0, -Math.min(balance.cash, consolidatedAfterObligations)),
      personShortfall,
      balance,
      personNetWorth,
      loanBalance: balance.externalDebt,
      familyLoanBalance: balance.eliminatedFamilyLoans,
      ltv: ltvByAsset(snap),
    });
  }

  return finish(input, months, infeasible, taxes.filter(t => t.month >= H), warnings);
}

function finish(
  input: CashflowInput, months: MonthRecord[], infeasible: InfeasibleEvent[],
  unpaidAtHorizon: ScheduledTax[], warnings: InputIssue[],
): CashflowResult {
  const personIds = input.persons.map(p => p.id);
  let minCash = Infinity, minMonth = 0, maxShort = 0, firstShort: number | null = null, shortMonths = 0;
  let taxPaid = 0, interestPaid = 0, principalPaid = 0;
  const personMin: Record<string, KRW> = {};
  for (const id of personIds) personMin[id] = Infinity;
  let maxLtv: number | null = null;
  for (const r of months) {
    const lowest = Math.min(r.consolidatedCash, r.consolidatedCashAfterObligations);
    if (lowest < minCash) { minCash = lowest; minMonth = r.month; }
    if (r.consolidatedShortfall > maxShort) maxShort = r.consolidatedShortfall;
    if (r.consolidatedShortfall > 0) { shortMonths += 1; if (firstShort === null) firstShort = r.month; }
    taxPaid += r.consolidatedFlows.out.tax;
    interestPaid += r.consolidatedFlows.out.interest;
    principalPaid += r.consolidatedFlows.out.principal;
    for (const id of personIds) {
      const low = r.personShortfall[id] > 0 ? -r.personShortfall[id] : r.cash[id];
      personMin[id] = Math.min(personMin[id], r.cash[id], low);
    }
    for (const v of Object.values(r.ltv)) if (v !== null && (maxLtv === null || v > maxLtv)) maxLtv = v;
  }
  const annual: AnnualSummary[] = [];
  for (let s = 0; s < months.length; s += 12) {
    const chunk = months.slice(s, s + 12);
    const inflow = { wage: 0, rent_dividend: 0, sale_proceeds: 0, borrowing: 0, family_in: 0 } as Record<InCat, KRW>;
    const outflow = { living: 0, maintenance: 0, tax: 0, interest: 0, principal: 0, fees: 0, family_out: 0 } as Record<OutCat, KRW>;
    for (const r of chunk) {
      for (const c of IN_CATS) inflow[c] += r.consolidatedFlows.in[c];
      for (const c of OUT_CATS) outflow[c] += r.consolidatedFlows.out[c];
    }
    const last = chunk[chunk.length - 1];
    annual.push({
      year: s / 12 + 1, fromLabel: chunk[0].label, toLabel: last.label, inflow, outflow,
      closingCash: last.consolidatedCash,
      minCash: Math.min(...chunk.map(r => Math.min(r.consolidatedCash, r.consolidatedCashAfterObligations))),
      closingNetWorth: last.balance.netWorth,
    });
  }
  const last = months[months.length - 1];
  return {
    months, annual, infeasible, unpaidAtHorizon,
    metrics: {
      minConsolidatedCash: minCash, minConsolidatedCashMonth: minMonth,
      maxConsolidatedShortfall: maxShort, firstShortfallMonth: firstShort, shortfallMonths: shortMonths,
      anyPersonShortfall: personIds.some(id => personMin[id] < 0), personMinCash: personMin,
      finalNetWorth: last.balance.netWorth, taxPaid, interestPaid, principalPaid, maxLtv,
    },
    warnings,
    assumptions: ENGINE_ASSUMPTIONS,
  };
}

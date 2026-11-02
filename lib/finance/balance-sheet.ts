import type { BalanceInput, FinAsset, InputIssue, Liability } from './types';
import { InvalidInputError } from './types';
import type { KRW } from './units';

/**
 * 대차대조표.
 * - 개인별 장부: 소유지분 비례 자산 + 현금 + 가족 대여금 - 외부부채 - 가족 차입금
 * - 연결 장부: 가족 내부 대출은 양쪽에서 제거. 외부 자산·외부 부채만 남는다.
 * - 법인: 'unlisted_equity'는 지분가치로만 잡는다(법인 보유자산 look-through 없음 → 이중계상 없음).
 */

const EPS = 1e-9;

export function ownerPct(asset: FinAsset, personId: string): number {
  return asset.owners.filter(o => o.personId === personId).reduce((s, o) => s + o.pct, 0);
}

export function familyPct(asset: FinAsset): number {
  return asset.owners.reduce((s, o) => s + o.pct, 0);
}

export function cashConvertible(a: FinAsset): boolean {
  return a.liquid || (a.sellable && a.sellLeadMonths === 0);
}

export function validateInput(input: BalanceInput): InputIssue[] {
  const issues: InputIssue[] = [];
  const personIds = new Set(input.persons.map(p => p.id));
  const assetIds = new Set<string>();
  for (const a of input.assets) {
    if (assetIds.has(a.id)) issues.push({ severity: 'error', code: 'DUP_ASSET', message: `자산 ID 중복: ${a.name}` });
    assetIds.add(a.id);
    if (a.marketValue < 0) issues.push({ severity: 'error', code: 'NEG_VALUE', message: `${a.name}: 시장가치가 음수입니다.` });
    for (const o of a.owners) {
      if (!personIds.has(o.personId)) issues.push({ severity: 'error', code: 'UNKNOWN_OWNER', message: `${a.name}: 등록되지 않은 소유자입니다.` });
      if (o.pct < 0) issues.push({ severity: 'error', code: 'NEG_SHARE', message: `${a.name}: 지분율이 음수입니다.` });
    }
    if (familyPct(a) > 100 + EPS) {
      issues.push({ severity: 'error', code: 'SHARE_OVER_100', message: `${a.name}: 지분 합계가 100%를 넘습니다(${familyPct(a).toFixed(2)}%).` });
    }
    if (a.owners.length === 0) {
      issues.push({ severity: 'warning', code: 'NO_OWNER', message: `${a.name}: 소유자가 없어 가족 장부에 반영되지 않습니다.` });
    }
  }
  const liabIds = new Set<string>();
  for (const l of input.liabilities) {
    if (liabIds.has(l.id)) issues.push({ severity: 'error', code: 'DUP_LIAB', message: `부채 ID 중복: ${l.id}` });
    liabIds.add(l.id);
    if (!personIds.has(l.borrowerId)) issues.push({ severity: 'error', code: 'UNKNOWN_BORROWER', message: `부채 ${l.id}: 차입자를 찾을 수 없습니다.` });
    if (l.lenderId !== null && !personIds.has(l.lenderId)) issues.push({ severity: 'error', code: 'UNKNOWN_LENDER', message: `부채 ${l.id}: 대여자를 찾을 수 없습니다.` });
    if (l.lenderId !== null && l.lenderId === l.borrowerId) issues.push({ severity: 'error', code: 'SELF_LOAN', message: `부채 ${l.id}: 차입자와 대여자가 같습니다.` });
    if (l.collateralAssetId !== null && !assetIds.has(l.collateralAssetId)) {
      issues.push({ severity: 'error', code: 'UNKNOWN_COLLATERAL', message: `부채 ${l.id}: 담보자산을 찾을 수 없습니다.` });
    }
    if (l.principal < 0) issues.push({ severity: 'error', code: 'NEG_PRINCIPAL', message: `부채 ${l.id}: 잔액이 음수입니다.` });
    if (l.repayment === 'annuity' && l.remainingTermMonths === null) {
      issues.push({ severity: 'error', code: 'ANNUITY_NO_TERM', message: `부채 ${l.id}: 원리금균등은 남은 기간이 필요합니다.` });
    }
  }
  return issues;
}

export function assertValid(input: BalanceInput): InputIssue[] {
  const issues = validateInput(input);
  const errors = issues.filter(i => i.severity === 'error');
  if (errors.length > 0) throw new InvalidInputError(errors);
  return issues;
}

export interface PersonBalance {
  personId: string;
  ownedAssets: KRW;
  cash: KRW;
  receivables: KRW;
  familyReceivable: KRW;
  externalDebt: KRW;
  familyPayable: KRW;
  totalAssets: KRW;
  totalLiabilities: KRW;
  netWorth: KRW;
  /** 소유 자산 중 1개월 내 현금화가 어려운 자산의 비중(0~1). 자산이 없으면 0. */
  nonCurrentRatio: number;
}

export function personBalanceSheet(input: BalanceInput, personId: string): PersonBalance {
  let ownedAssets = 0;
  let nonCurrent = 0;
  for (const a of input.assets) {
    const v = Math.round((a.marketValue * ownerPct(a, personId)) / 100);
    ownedAssets += v;
    if (!cashConvertible(a)) nonCurrent += v;
  }
  const cash = input.cash[personId] ?? 0;
  const receivables = input.receivables?.[personId] ?? 0;
  let familyReceivable = 0, externalDebt = 0, familyPayable = 0;
  for (const l of input.liabilities) {
    if (l.lenderId === personId) familyReceivable += l.principal;
    if (l.borrowerId === personId) {
      if (l.lenderId === null) externalDebt += l.principal;
      else familyPayable += l.principal;
    }
  }
  const totalAssets = ownedAssets + cash + receivables + familyReceivable;
  const totalLiabilities = externalDebt + familyPayable;
  return {
    personId, ownedAssets, cash, receivables, familyReceivable, externalDebt, familyPayable,
    totalAssets, totalLiabilities, netWorth: totalAssets - totalLiabilities,
    nonCurrentRatio: ownedAssets > 0 ? nonCurrent / ownedAssets : 0,
  };
}

export interface ConsolidatedBalance {
  assetValue: KRW;
  cash: KRW;
  receivables: KRW;
  externalDebt: KRW;
  /** 연결 과정에서 제거한 가족 내부 대출 잔액 */
  eliminatedFamilyLoans: KRW;
  totalAssets: KRW;
  netWorth: KRW;
  /** 현금 + 현금성 자산(가족 지분) */
  availableCash: KRW;
  externalDebtToAssets: number | null;
}

export function consolidatedBalanceSheet(input: BalanceInput): ConsolidatedBalance {
  const assetValue = input.assets.reduce((s, a) => s + Math.round((a.marketValue * familyPct(a)) / 100), 0);
  const cash = input.persons.reduce((s, p) => s + (input.cash[p.id] ?? 0), 0);
  const receivables = input.persons.reduce((s, p) => s + (input.receivables?.[p.id] ?? 0), 0);
  const externalDebt = input.liabilities.filter(l => l.lenderId === null).reduce((s, l) => s + l.principal, 0);
  const eliminatedFamilyLoans = input.liabilities.filter(l => l.lenderId !== null).reduce((s, l) => s + l.principal, 0);
  const convertible = input.assets
    .filter(cashConvertible)
    .reduce((s, a) => s + Math.round((a.marketValue * familyPct(a)) / 100), 0);
  const totalAssets = assetValue + cash + receivables;
  return {
    assetValue, cash, receivables, externalDebt, eliminatedFamilyLoans, totalAssets,
    netWorth: totalAssets - externalDebt,
    availableCash: cash + convertible,
    externalDebtToAssets: totalAssets > 0 ? externalDebt / totalAssets : null,
  };
}

/** 담보 한도 계산 기준: 차입자 지분에 해당하는 담보가치 × 최대 LTV. */
export function collateralCapacity(asset: FinAsset, borrowerId: string, maxLtv: number): KRW {
  return Math.floor(((asset.marketValue * ownerPct(asset, borrowerId)) / 100) * maxLtv);
}

export function securedDebt(liabilities: Liability[], assetId: string): KRW {
  return liabilities.filter(l => l.collateralAssetId === assetId).reduce((s, l) => s + l.principal, 0);
}

/** 자산별 LTV = 담보 설정 대출 합계 / (자산가치 × 차입자 지분 합). 담보가치가 0이면 null. */
export function ltvByAsset(input: BalanceInput): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const a of input.assets) {
    const secured = input.liabilities.filter(l => l.collateralAssetId === a.id);
    if (secured.length === 0) continue;
    const borrowers = Array.from(new Set(secured.map(l => l.borrowerId)));
    const share = borrowers.reduce((s, b) => s + ownerPct(a, b), 0) / 100;
    const base = a.marketValue * share;
    out[a.id] = base > 0 ? secured.reduce((s, l) => s + l.principal, 0) / base : null;
  }
  return out;
}

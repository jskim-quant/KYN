import type { KRW } from './units';

export type AssetClass = 'real_estate' | 'land' | 'deposit' | 'financial' | 'unlisted_equity' | 'other';
export type RateType = 'fixed' | 'variable';
/** interest_only: 이자만 납부, 만기에 원금 일시상환 / annuity: 원리금균등 */
export type Repayment = 'interest_only' | 'annuity';

export interface Person {
  id: string;
  name: string;
  relation: string;
  age: number | null;
}

export interface OwnershipShare {
  personId: string;
  /** 지분율 %. 합계가 100 미만이면 나머지는 가족 외 공유자 몫이다. */
  pct: number;
}

export interface FinAsset {
  id: string;
  name: string;
  cls: AssetClass;
  marketValue: KRW;
  /** 평가 기준일 YYYY-MM-DD */
  valuationDate: string | null;
  acquisitionCost: KRW;
  owners: OwnershipShare[];
  /** 현금성 자산(예금 등) */
  liquid: boolean;
  sellable: boolean;
  /** 매각 비용(중개수수료 등) % */
  sellCostPct: number;
  /** 매각 결정 후 현금 수령까지 개월 수 */
  sellLeadMonths: number;
  /** 연 현금수익(임대료·배당 등, 공실 반영 후 총액). 명목 고정액으로 취급한다. */
  annualCashYield: KRW;
  /** 연 운영비(관리비·수선비) */
  annualOperatingCost: KRW;
  /** 연 가격 상승률(소수). 현금수익은 포함하지 않는다. */
  priceGrowthAnnual: number;
}

export interface Liability {
  id: string;
  borrowerId: string;
  /** null이면 외부 대여자, 값이 있으면 가족 구성원 간 대출 */
  lenderId: string | null;
  principal: KRW;
  annualRate: number;
  rateType: RateType;
  repayment: Repayment;
  /** 남은 납입 횟수(개월). null이면 만기 미정으로 이자만 계속 납부한다. */
  remainingTermMonths: number | null;
  collateralAssetId: string | null;
  feeKRW: KRW;
  /** 담보자산을 매각하면 대금 수령 시 이 대출을 상환한다(담보 해제 조건). */
  repayOnCollateralSale: boolean;
}

export interface BalanceInput {
  persons: Person[];
  assets: FinAsset[];
  liabilities: Liability[];
  cash: Record<string, KRW>;
  /** 매각 후 아직 수령하지 않은 대금 */
  receivables?: Record<string, KRW>;
}

export interface InputIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
}

export class InvalidInputError extends Error {
  constructor(public issues: InputIssue[]) {
    super(`입력 오류 ${issues.length}건: ${issues.map(i => i.message).join(' / ')}`);
    this.name = 'InvalidInputError';
  }
}

import type { KRW } from '../finance/units';

export interface PersonNode {
  id: string;
  name: string;
  role: 'parent' | 'spouse' | 'child';
  age: number;
}

export interface CompanyNode {
  id: string;
  name: string;
  owners: Array<{ personId: string; pct: number }>;
}

export interface FamilySnapshot {
  /** 기준일 YYYY-MM-DD */
  asOf: string;
  persons: PersonNode[];
  /** 이미 있는 법인. 없으면 빈 배열 */
  companies: CompanyNode[];
  /** 부모가 쓸 수 있는 현금 */
  parentCashKRW: KRW;
  /** 자녀에게 이전하려는 목표 금액 */
  targetTransferKRW: KRW;
  /** 자녀별 10년 내 직계존속 증여 합계 */
  priorGiftsKRW?: Record<string, KRW>;
  /** 자녀별 혼인·출산 공제 사용 가능 여부 */
  marriageOrBirthBonus?: Record<string, boolean>;
}

export type StepKind =
  | 'gift_cash'
  | 'create_company'
  | 'contribute_capital'
  | 'loan_to_company'
  | 'company_loan'
  | 'company_asset_sale'
  | 'company_dividend'
  | 'company_invest';

export interface PlanStep {
  id: string;
  offsetYears: number;
  kind: StepKind;
  description: string;
  from?: string;
  to?: string;
  amountKRW?: KRW;
  /** 근거가 확인돼 레지스트리에 등록된 규칙 */
  ruleIds: string[];
  computation: 'COMPUTED' | 'NOT_COMPUTED';
  taxKRW: KRW | null;
  notComputedReason?: string;
}

export interface AuditFlag {
  code: string;
  severity: 'info' | 'warning' | 'high';
  message: string;
  /** official=공식 자료(보도자료·판결·예규), practitioner=실무 소스, unverified_lead=미검증 단서 */
  basis: 'official' | 'practitioner' | 'unverified_lead';
  sourceRef: string;
}

export interface StrategyPlan {
  id: 'DIRECT_GIFT' | 'STAGED_GIFT' | 'CHILD_CORP_LOAN' | 'PARENT_AND_CHILD_CORP';
  label: string;
  steps: PlanStep[];
  /** COMPUTED 단계의 세액 합계. NOT_COMPUTED 단계는 포함되지 않는다. */
  computedTaxKRW: KRW;
  coverage: { computed: number; total: number };
  /** 세액 비교에 필요하지만 아직 검증되지 않은 규칙 */
  openRules: string[];
  /** openRules가 없고 모든 단계가 계산된 경우만 true — 계획 간 세액 비교 가능 */
  comparable: boolean;
  auditFlags: AuditFlag[];
  notes: string[];
}

export interface PlanOptions {
  /** 부모 → 자녀법인 대여 이자율 (소수). 기본 0 */
  loanAnnualRate?: number;
  /** 대여 기간(년). 기본 5 */
  loanYears?: number;
  /** 대여 원금. 기본 min(부모 현금, 목표 이전액) */
  loanPrincipalKRW?: KRW;
  /** 분할 증여 주기 수 (10년 간격). 기본 3 */
  stagedCycles?: number;
}

'use client';
import { useEffect, useState, useMemo } from 'react';
import { createClient } from '@/lib/supabase';
import { KynLoader } from '@/app/dashboard/components/KynLoader';
import { StrategyFlowNav } from '@/app/dashboard/components/StrategyFlowNav';
import { Asset, FamilyMember, MacroSettings, TransferPlan } from '@/types';
import {
  GIFT_DEDUCTIONS,
  calcInheritanceTax,
  calcGiftTax,
  calcCapitalGainsTax,
  calcAnnualCashflow,
  calcRentalIncomeTax,
  projectAssetValue,
  calcCorpConversionBenefit,
  calcCorporateTax,
  calcIncomeTax,
  calcOptimalStrategy,
  calcLTV,
  calcDSCR,
  calcAcquisitionTax,
  type OptimalStrategyResult,
} from '@/lib/tax';
// ── 새 순수함수 엔진 (lib/tax/*) ──
import { estimateRelatedPartySale, estimateBurdenedGiftTransfer } from '@/lib/tax/gift';
import { planFamilyLoanSplit, planGiftTaxInstallment, maxInterestFreeLoanPrincipal } from '@/lib/tax/family-loan';
import { analyzeRecovery, type RecoveryInput } from '@/lib/tax/recovery';
import {
  buildImmediateGiftScenario, evaluateMyAssignment, computeBalanceSheet, computePortfolioMetrics,
  type MyAssignmentResultResponse, type ImmediateGiftScenarioRequest,
  type BalanceSheetMetricsResponse, type BalanceSheetRequest,
  type PortfolioAllocationResultResponse, type AssetCategory,
} from '@/lib/kyn-backend';
import { isRecipientAssignmentPlan } from '@/lib/transfer-plan';
import { KOREAN_TO_ASSET_CATEGORY, KOREAN_TO_BACKEND_ASSET_TYPE, ALLOCATION_ASSUMPTIONS } from '@/lib/asset-type-map';
import {
  synthesizeScenarioSummary,
  type SynthesisRiskInput, type SynthesisLeverageInput, type SynthesisScenarioInput,
} from '@/lib/scenario-synthesis';
import type { StrategyConfidence, RelatedPartySaleInput, BurdenedGiftInput } from '@/lib/tax/types';
import {
  deleteSavedCustomScenario,
  deleteSavedRecoveryScenario,
  loadSavedCustomScenarios,
  loadSavedRecoveryScenarios,
  saveCustomScenarioItem,
  SAVED_SCENARIO_TYPES,
  updateSavedCustomScenarioType,
  updateSavedRecoveryScenarioType,
  type SavedCustomScenarioItem,
  type SavedRecoveryScenarioItem,
  type SavedScenarioType,
} from '@/lib/saved-scenario';

// ── 신뢰도 배지 ──────────────────────────────────────────────
const CONFIDENCE_LABELS: Record<StrategyConfidence, { label: string; color: string; bg: string }> = {
  law_based:      { label: '법령 기반',     color: '#059669', bg: '#ECFDF5' },
  input_estimate: { label: '입력값 추정',   color: '#1D4ED8', bg: '#EFF6FF' },
  rough_estimate: { label: '간이 추정',     color: '#D97706', bg: '#FFFBEB' },
  expert_review:  { label: '전문가 확인 필수', color: '#DC2626', bg: '#FEF2F2' },
};
function ConfidenceBadge({ c }: { c: StrategyConfidence }) {
  const { label, color, bg } = CONFIDENCE_LABELS[c];
  return (
    <span style={{ fontSize: 9, fontWeight: 700, color, background: bg, padding: '1px 5px', border: `1px solid ${color}`, whiteSpace: 'nowrap' }}>
      {label}
    </span>
  );
}

// ── Helpers ───────────────────────────────────────────────────

function fmt(n: number, d = 1): string {
  if (!isFinite(n)) return '0억';
  return (Math.round(n * Math.pow(10, d)) / Math.pow(10, d)).toLocaleString('ko-KR') + '억';
}

function fmtPct(n: number): string {
  return (Math.round(n * 10) / 10).toLocaleString('ko-KR') + '%';
}

const TIMELINE_YEARS = [0, 3, 5, 10, 15, 20];

const DEFAULT_MACRO: MacroSettings = {
  id: '', family_id: '',
  base_rate_pct: 3.5, rate_shock_pct: 1.5,
  land_growth_pct: 2.0, apt_growth_pct: 2.5,
  commercial_growth_pct: 1.5, inflation_pct: 2.0,
};

interface YearSnapshot {
  year: number;
  totalAssetValue: number;
  remainingAssetValue: number;
  cumulativeGiftTax: number;
  cumulativeHoldingTax: number;
  annualNetCashflow: number;
  inheritanceTaxIfNow: number;
  netWealthIfInheritNow: number;
  events: string[];
}

interface ScenarioCalc {
  id: string;
  label: string;
  icon: string;
  tagline: string;
  colorClass: string;
  snapshots: YearSnapshot[];
  totalGiftTax: number;
  holdingTax10yr: number;
  inheritanceTaxAt10yr: number;
  cgtTotal: number;
  totalTax10yr: number;
  annualCashflowNow: number;
  netWealth10yr: number;
  netWealth20yr: number;
  pros: string[];
  cons: string[];
  actions: string[];
  isRecommended: boolean;
  complexity: 'low' | 'medium' | 'high';
  immediateFundingNeed?: number;
  availableFunding?: number;
  category?: SavedScenarioType;
}

function getMacro(macro: MacroSettings | null): MacroSettings {
  return macro ?? DEFAULT_MACRO;
}

function futureAssetValue(assets: Asset[], years: number, macro: MacroSettings): number {
  return assets.reduce((s, a) => s + projectAssetValue(a, years, macro), 0);
}

function getAnnualHoldingCost(assets: Asset[], macro: MacroSettings): number {
  const { holdingTax } = calcAnnualCashflow(assets, macro);
  const rentalIncome = assets.reduce((s, a) => s + a.current_value * a.annual_yield_pct / 100, 0);
  const rentalTax = calcRentalIncomeTax(rentalIncome);
  return holdingTax + rentalTax;
}

function scaleAssets(assets: Asset[], ratio: number): Asset[] {
  return assets.map(a => ({ ...a, current_value: a.current_value * ratio, loan_amount: a.loan_amount * ratio }));
}

const LIQUID_ASSET_TYPES = new Set([
  '예금',
  '채권',
  '국내주식',
  '해외주식',
  '금융자산',
  '현금',
]);

const LEVERAGE_ASSET_TYPES = new Set([
  '아파트',
  '주거용부동산',
  '상업용부동산',
  '토지',
  '오피스텔',
]);

function getLiquidAvailableFunding(assets: Asset[], members: FamilyMember[]): number {
  const memberCash = members.reduce((sum, member) => sum + (member.cash_hold || 0), 0);
  const liquidAssets = assets.reduce((sum, asset) => (
    LIQUID_ASSET_TYPES.has(asset.asset_type)
      ? sum + Math.max(0, asset.current_value - (asset.loan_amount || 0))
      : sum
  ), 0);
  return memberCash + liquidAssets;
}

interface ScenarioFeasibility {
  feasible: boolean;
  immediateNeed: number;
  availableFunding: number;
  fundingGap: number;
  annualCashflow: number;
  netWealth10yr: number;
  reasons: string[];
}

function getScenarioFeasibility(
  scenario: ScenarioCalc,
  assets: Asset[],
  members: FamilyMember[],
): ScenarioFeasibility {
  const immediateNeed = scenario.immediateFundingNeed ?? scenario.totalGiftTax + scenario.cgtTotal;
  // 기본값은 실제 유동현금만 잡는다. 담보대출 여력(getBaseAvailableFunding)은 그 대출이
  // 실제로 이 시나리오의 계획에 포함된 경우에만(예: s9) scenario.availableFunding으로 명시적으로 credit한다.
  // 그렇지 않으면 대출 계획이 전혀 없는 순수 증여 시나리오까지 "대출 여력 = 가용재원"으로 착시된다.
  const availableFunding = scenario.availableFunding ?? getLiquidAvailableFunding(assets, members);
  const fundingGap = Math.max(0, immediateNeed - availableFunding);
  const reasons: string[] = [];

  if (!Number.isFinite(scenario.netWealth10yr) || scenario.netWealth10yr <= 0) {
    reasons.push('10년 후 세후 순자산이 유효하지 않습니다.');
  }
  if (scenario.annualCashflowNow < -0.01) {
    reasons.push(`연 순현금흐름이 ${fmt(scenario.annualCashflowNow)}/년 적자입니다.`);
  }
  if (fundingGap > 0.01) {
    reasons.push(`즉시 실행 재원이 ${fmt(fundingGap)} 부족합니다.`);
  }

  return {
    feasible: reasons.length === 0,
    immediateNeed,
    availableFunding,
    fundingGap,
    annualCashflow: scenario.annualCashflowNow,
    netWealth10yr: scenario.netWealth10yr,
    reasons,
  };
}

function isScenarioFeasible(
  scenario: ScenarioCalc,
  assets: Asset[],
  members: FamilyMember[],
): boolean {
  return getScenarioFeasibility(scenario, assets, members).feasible;
}

// ── 실행 가능성 별점 (1~5) ──
// 법적 가능성·자금조달·복잡도·현금흐름을 종합한 점수
function getExecutionStars(
  scenario: ScenarioCalc,
  feasibility: ScenarioFeasibility,
): number {
  let stars = 5;
  if (scenario.complexity === 'medium') stars -= 1;
  if (scenario.complexity === 'high') stars -= 2;
  if (feasibility.fundingGap > 0.01) stars -= 2;
  else if (feasibility.immediateNeed > feasibility.availableFunding * 0.7) stars -= 1;
  if (feasibility.annualCashflow < -0.01) stars -= 1;
  return Math.max(1, Math.min(5, stars));
}

function StarRating({ n }: { n: number }) {
  return (
    <span style={{ color: 'var(--gold-deep)', letterSpacing: 1, fontSize: 12 }}>
      {'★'.repeat(n)}{'☆'.repeat(5 - n)}
    </span>
  );
}

interface OptimalFeasibility {
  feasible: boolean;
  reasons: string[];
  // 하드 탈락 사유는 아니지만, 아직 확정되지 않은 전제(신규 은행대출 승인·가족 동의)에
  // 재원을 의존하는 경우의 경고. calcOptimalStrategy가 "빌릴 수 있는 한도까지만" 증여액을
  // 추천하는 구조라 giftTaxFundingGap은 설계상 거의 항상 0이 나온다 — 그래서 이 계획이
  // 실제로 실행 가능하다는 뜻이 절대 아니다. 은행 승인·가족 합의는 별도로 확인해야 한다.
  unconfirmedDependencies: string[];
}

function getOptimalStrategyFeasibility(
  result: OptimalStrategyResult,
): OptimalFeasibility {
  const reasons: string[] = [];
  const unconfirmedDependencies: string[] = [];
  const giftTaxFundingGap = Math.max(
    0,
    result.totalGiftTax - result.funding.totalGiftTaxBudget,
  );

  if (result.netSavingAfterGiftTax <= 0.01) {
    reasons.push('증여세 반영 후 순절세 효과가 없습니다.');
  }
  if (giftTaxFundingGap > 0.01) {
    reasons.push(`즉시 증여세 재원이 ${fmt(giftTaxFundingGap)} 부족합니다.`);
  }
  if (result.funding.annualRecurringCashflow < -0.01) {
    reasons.push(
      `대출 반영 후 연 순현금흐름이 ${fmt(result.funding.annualRecurringCashflow)}/년 적자입니다.`,
    );
  }
  if (result.funding.annualInstallmentGap > 0.01) {
    reasons.push(
      `연부연납 재원이 ${fmt(result.funding.annualInstallmentGap)}/년 부족합니다.`,
    );
  }
  if (result.funding.shortfallAfterOptionalLoans > 0.01) {
    reasons.push(
      `선택 대출을 반영해도 상속세 재원이 ${fmt(result.funding.shortfallAfterOptionalLoans)} 부족합니다.`,
    );
  }
  if (result.funding.bankLoanForGiftTax > 0.01) {
    unconfirmedDependencies.push(
      `증여세 재원 중 ${fmt(result.funding.bankLoanForGiftTax)}은 신규 은행 담보대출 승인을 전제로 합니다 — 은행 사전승인 전까지 확정된 재원이 아닙니다.`,
    );
  }
  if (result.funding.familyLoanForGiftTax > 0.01) {
    unconfirmedDependencies.push(
      `증여세 재원 중 ${fmt(result.funding.familyLoanForGiftTax)}은 가족간 대여 실행을 전제로 합니다 — 차용증 작성과 가족 동의 전까지 확정된 재원이 아닙니다.`,
    );
  }

  return { feasible: reasons.length === 0, reasons, unconfirmedDependencies };
}

// ── Scenario builders ─────────────────────────────────────────

function buildS1(assets: Asset[], members: FamilyMember[], macro: MacroSettings | null): ScenarioCalc {
  const m = getMacro(macro);
  const totalDebt = assets.reduce((s, a) => s + a.loan_amount, 0);
  const holdingCostAnnual = getAnnualHoldingCost(assets, m);
  const { netCashflow } = calcAnnualCashflow(assets, m);

  const snapshots: YearSnapshot[] = TIMELINE_YEARS.map(year => {
    const assetValue = futureAssetValue(assets, year, m);
    const cumulativeHolding = holdingCostAnnual * year;
    const inheritTax = calcInheritanceTax(assetValue, members, 0).tax;
    const netWealth = assetValue - totalDebt - cumulativeHolding - inheritTax;
    return {
      year, totalAssetValue: assetValue, remainingAssetValue: assetValue,
      cumulativeGiftTax: 0, cumulativeHoldingTax: cumulativeHolding,
      annualNetCashflow: netCashflow, inheritanceTaxIfNow: inheritTax,
      netWealthIfInheritNow: netWealth, events: [],
    };
  });

  const snap10 = snapshots.find(s => s.year === 10)!;
  const snap20 = snapshots.find(s => s.year === 20)!;
  const holdingTax10 = holdingCostAnnual * 10;
  const totalTax10 = holdingTax10 + snap10.inheritanceTaxIfNow;

  return {
    id: 's1', label: '현상유지', icon: '🏠', tagline: '추가 액션 없이 현 구조 유지',
    colorClass: 'bg-gray-500',
    snapshots, totalGiftTax: 0, holdingTax10yr: holdingTax10,
    inheritanceTaxAt10yr: snap10.inheritanceTaxIfNow, cgtTotal: 0,
    totalTax10yr: totalTax10, annualCashflowNow: netCashflow,
    netWealth10yr: snap10.netWealthIfInheritNow, netWealth20yr: snap20.netWealthIfInheritNow,
    pros: ['추가 비용·절차 없음', '현 자산 구조 유지', '단순·관리 쉬움'],
    cons: ['상속 시 고액 세금 위험', '절세 기회 미활용', '자산 집중 리스크'],
    actions: ['현 상태 연 1회 세금 재점검', '상속세 추정액 모니터링'],
    isRecommended: false, complexity: 'low',
  };
}

function buildS2(
  assets: Asset[], members: FamilyMember[], macro: MacroSettings | null,
): ScenarioCalc {
  const m = getMacro(macro);
  const totalValue = assets.reduce((s, a) => s + a.current_value, 0);
  const totalDebt = assets.reduce((s, a) => s + a.loan_amount, 0);
  const { netCashflow } = calcAnnualCashflow(assets, m);

  // calcOptimalStrategy(mode='optimal')로 수증자별 최적 증여액 산출
  const opt = calcOptimalStrategy(assets, members, macro, 0, 0, 10, {}, 'optimal');
  let totalGiftedAmt = opt.totalGiftAmount;
  let totalGiftTax = opt.totalGiftTax;

  // fallback: optimal이 0이면 공제한도만 사용
  if (totalGiftedAmt <= 0) {
    const recipients = members.filter(r => r.relation !== '본인');
    for (const r of recipients) {
      const taxFreeAmt = GIFT_DEDUCTIONS[r.relation] ?? 0.1;
      const giftAmt = Math.min(taxFreeAmt, totalValue / Math.max(recipients.length, 1));
      totalGiftedAmt += giftAmt;
      totalGiftTax += calcGiftTax(giftAmt, r.relation, 0, r.relation === '손자녀');
    }
    totalGiftedAmt = Math.min(totalGiftedAmt, totalValue);
  }

  const remainPct = totalValue > 0 ? 1 - totalGiftedAmt / totalValue : 1;
  const remainAssets = scaleAssets(assets, remainPct);
  const holdingCostAnnual = getAnnualHoldingCost(remainAssets, m);

  // 수증자별 추천 요약 (최대 3명)
  const planSummary = opt.giftPlans.slice(0, 3)
    .map(p => `${p.memberName} ${fmt(p.giftAmount)}`)
    .join(' · ');
  const tagline = planSummary
    ? `추천: ${planSummary} 즉시 증여`
    : `즉시 분산증여 (최적 산출액 ${fmt(totalGiftedAmt)})`;

  const snapshots: YearSnapshot[] = TIMELINE_YEARS.map(year => {
    const assetValue = futureAssetValue(assets, year, m);
    const remainValue = assetValue * remainPct;
    const cumulativeHolding = holdingCostAnnual * year;
    const priorGifts = year < 10 ? totalGiftedAmt : 0;
    const inheritTax = calcInheritanceTax(remainValue, members, priorGifts).tax;
    const netWealth = assetValue - totalDebt - totalGiftTax - cumulativeHolding - inheritTax;
    return {
      year, totalAssetValue: assetValue, remainingAssetValue: remainValue,
      cumulativeGiftTax: totalGiftTax, cumulativeHoldingTax: cumulativeHolding,
      annualNetCashflow: netCashflow * remainPct, inheritanceTaxIfNow: inheritTax,
      netWealthIfInheritNow: netWealth, events: year === 0 ? [`즉시 증여 ${fmt(totalGiftedAmt)} 실행`] : [],
    };
  });

  const snap10 = snapshots.find(s => s.year === 10)!;
  const snap20 = snapshots.find(s => s.year === 20)!;
  const holdingTax10 = holdingCostAnnual * 10;

  const actions = opt.giftPlans.length > 0
    ? opt.giftPlans.slice(0, 3).map(p => `${p.memberName}에게 ${fmt(p.giftAmount)} 증여 (증여세 ${fmt(p.giftTax)})`)
    : ['수증자별 증여 한도 계획 수립', '혼인·출산 시 추가공제 활용', '현금·금융자산 우선 증여'];

  return {
    id: 's2', label: '즉시 분산증여', icon: '🎁', tagline,
    colorClass: 'bg-blue-500',
    snapshots, totalGiftTax, holdingTax10yr: holdingTax10,
    inheritanceTaxAt10yr: snap10.inheritanceTaxIfNow, cgtTotal: 0,
    totalTax10yr: totalGiftTax + holdingTax10 + snap10.inheritanceTaxIfNow,
    annualCashflowNow: netCashflow * remainPct,
    netWealth10yr: snap10.netWealthIfInheritNow, netWealth20yr: snap20.netWealthIfInheritNow,
    pros: ['최적 절세액 자동 산출', '증여공제 한도 즉시 활용', '상속세 과표 축소', '10년 후 공제한도 재사용 가능'],
    cons: ['증여세 선납 필요', '10년 합산 규정 유의', '자산 집중 해소 시간 소요'],
    actions,
    isRecommended: false, complexity: 'medium', category: '절세형',
  };
}

function buildS3(
  assets: Asset[], members: FamilyMember[], macro: MacroSettings | null,
): ScenarioCalc {
  const m = getMacro(macro);
  const totalValue = assets.reduce((s, a) => s + a.current_value, 0);
  const totalDebt = assets.reduce((s, a) => s + a.loan_amount, 0);
  const { netCashflow } = calcAnnualCashflow(assets, m);

  const recipients = members.filter(r => r.relation !== '본인');

  // 1차 증여: optimal 엔진으로 최적액 산출
  const opt1 = calcOptimalStrategy(assets, members, macro, 0, 0, 10, {}, 'optimal');
  let totalGifted1 = opt1.totalGiftAmount;
  let totalGiftTax1 = opt1.totalGiftTax;

  // fallback: optimal이 0이면 공제한도
  if (totalGifted1 <= 0) {
    for (const r of recipients) {
      const taxFreeAmt = GIFT_DEDUCTIONS[r.relation] ?? 0.1;
      const giftAmt = Math.min(taxFreeAmt, totalValue / Math.max(recipients.length, 1));
      totalGifted1 += giftAmt;
      totalGiftTax1 += calcGiftTax(giftAmt, r.relation, 0, r.relation === '손자녀');
    }
    totalGifted1 = Math.min(totalGifted1, totalValue);
  }

  const remainPct1 = totalValue > 0 ? 1 - totalGifted1 / totalValue : 1;
  const remainAssets1 = scaleAssets(assets, remainPct1);
  const holdingCostAnnual = getAnnualHoldingCost(remainAssets1, m);

  // 2차 증여 (10년 후): 공제한도 리셋 + optimal 재산출
  const cycle2BaseValue = futureAssetValue(remainAssets1, 10, m);
  const remainAssets2 = scaleAssets(assets, remainPct1);
  const opt2 = calcOptimalStrategy(remainAssets2, members, macro, 0, 0, 10, {}, 'optimal');
  let totalGifted2 = opt2.totalGiftAmount;
  let totalGiftTax2 = opt2.totalGiftTax;

  // fallback
  if (totalGifted2 <= 0) {
    for (const r of recipients) {
      const taxFreeAmt = GIFT_DEDUCTIONS[r.relation] ?? 0.1;
      const giftAmt = Math.min(taxFreeAmt, cycle2BaseValue / Math.max(recipients.length, 1));
      totalGifted2 += giftAmt;
      totalGiftTax2 += calcGiftTax(giftAmt, r.relation, 0, r.relation === '손자녀');
    }
  }
  totalGifted2 = Math.min(totalGifted2, cycle2BaseValue);
  const remainPct2 = cycle2BaseValue > 0 ? 1 - totalGifted2 / cycle2BaseValue : 1;

  const snapshots: YearSnapshot[] = TIMELINE_YEARS.map(year => {
    const assetValue = futureAssetValue(assets, year, m);
    const cumulativeHolding = holdingCostAnnual * year;

    let remainValue: number;
    let cumulGift: number;
    let priorGifts: number;
    let events: string[];

    if (year < 10) {
      remainValue = assetValue * remainPct1;
      cumulGift = totalGiftTax1;
      priorGifts = totalGifted1;
      events = year === 0 ? ['1차 증여 실행'] : [];
    } else {
      remainValue = assetValue * remainPct1 * remainPct2;
      cumulGift = totalGiftTax1 + totalGiftTax2;
      priorGifts = 0;
      events = year === 10 ? ['10년 후 2차 증여 실행'] : [];
    }

    const inheritTax = calcInheritanceTax(remainValue, members, priorGifts).tax;
    const netWealth = assetValue - totalDebt - cumulGift - cumulativeHolding - inheritTax;
    return {
      year, totalAssetValue: assetValue, remainingAssetValue: remainValue,
      cumulativeGiftTax: cumulGift, cumulativeHoldingTax: cumulativeHolding,
      annualNetCashflow: netCashflow * remainPct1, inheritanceTaxIfNow: inheritTax,
      netWealthIfInheritNow: netWealth, events,
    };
  });

  const snap10 = snapshots.find(s => s.year === 10)!;
  const snap20 = snapshots.find(s => s.year === 20)!;
  const holdingTax10 = holdingCostAnnual * 10;
  const totalGiftTax = totalGiftTax1 + totalGiftTax2;

  const phase1Summary = opt1.giftPlans.slice(0, 2).map(p => `${p.memberName} ${fmt(p.giftAmount)}`).join(' · ');
  const taglineS3 = phase1Summary
    ? `즉시 ${phase1Summary} → 10년 후 ${fmt(totalGifted2)} 추가`
    : `1차 ${fmt(totalGifted1)} → 10년 후 ${fmt(totalGifted2)} 추가 증여`;

  const actions3 = [
    ...opt1.giftPlans.slice(0, 2).map(p => `지금: ${p.memberName}에게 ${fmt(p.giftAmount)} 증여 (증여세 ${fmt(p.giftTax)})`),
    `10년 후: 공제한도 리셋 후 추가 ${fmt(totalGifted2)} 증여`,
  ];

  return {
    id: 's3', label: '10년 분할증여', icon: '📅', tagline: taglineS3,
    colorClass: 'bg-indigo-500',
    snapshots, totalGiftTax, holdingTax10yr: holdingTax10,
    inheritanceTaxAt10yr: snap10.inheritanceTaxIfNow, cgtTotal: 0,
    totalTax10yr: totalGiftTax + holdingTax10 + snap10.inheritanceTaxIfNow,
    annualCashflowNow: netCashflow * remainPct1,
    netWealth10yr: snap10.netWealthIfInheritNow, netWealth20yr: snap20.netWealthIfInheritNow,
    pros: ['최적 증여액 자동 산출', '공제한도 10년 후 재사용', '세부담 시간 분산', '2차 증여로 상속세 추가 절감'],
    cons: ['10년 대기 필요', '자산 성장 시 2차 세부담 증가', '장기 계획 관리 필요'],
    actions: actions3,
    isRecommended: false, complexity: 'medium', category: '균형형',
  };
}

function buildS4(
  assets: Asset[], members: FamilyMember[], macro: MacroSettings | null,
  skipPct: number,
): ScenarioCalc {
  const m = getMacro(macro);
  const totalValue = assets.reduce((s, a) => s + a.current_value, 0);
  const totalDebt = assets.reduce((s, a) => s + a.loan_amount, 0);
  const { netCashflow } = calcAnnualCashflow(assets, m);

  const grandchildren = members.filter(r => r.relation === '손자녀');
  const children = members.filter(r => r.relation === '자녀');

  const skipValue = totalValue * skipPct / 100;
  const childValue = totalValue * (100 - skipPct) / 100 * 0.3;

  let skipGiftTax = 0;
  if (grandchildren.length > 0) {
    for (const _ of grandchildren) {
      skipGiftTax += calcGiftTax(skipValue / grandchildren.length, '손자녀', 0, true);
    }
  } else {
    skipGiftTax = calcGiftTax(skipValue, '손자녀', 0, true);
  }

  let childGiftTax = 0;
  if (children.length > 0) {
    for (const _ of children) {
      childGiftTax += calcGiftTax(childValue / children.length, '자녀');
    }
  }

  const totalGiftedAmt = Math.min(skipValue + childValue, totalValue);
  const totalGiftTax = skipGiftTax + childGiftTax;
  const remainPct = totalValue > 0 ? 1 - totalGiftedAmt / totalValue : 1;
  const remainAssets = scaleAssets(assets, remainPct);
  const holdingCostAnnual = getAnnualHoldingCost(remainAssets, m);

  const snapshots: YearSnapshot[] = TIMELINE_YEARS.map(year => {
    const assetValue = futureAssetValue(assets, year, m);
    const remainValue = assetValue * remainPct;
    const cumulativeHolding = holdingCostAnnual * year;
    const priorGifts = year < 10 ? totalGiftedAmt : 0;
    const inheritTax = calcInheritanceTax(remainValue, members, priorGifts).tax;
    const netWealth = assetValue - totalDebt - totalGiftTax - cumulativeHolding - inheritTax;
    return {
      year, totalAssetValue: assetValue, remainingAssetValue: remainValue,
      cumulativeGiftTax: totalGiftTax, cumulativeHoldingTax: cumulativeHolding,
      annualNetCashflow: netCashflow * remainPct, inheritanceTaxIfNow: inheritTax,
      netWealthIfInheritNow: netWealth,
      events: year === 0 ? ['세대생략 증여 실행'] : [],
    };
  });

  const snap10 = snapshots.find(s => s.year === 10)!;
  const snap20 = snapshots.find(s => s.year === 20)!;
  const holdingTax10 = holdingCostAnnual * 10;
  const noGrandchildren = grandchildren.length === 0;

  return {
    id: 's4', label: '세대생략증여', icon: '⏭️', tagline: `손자녀 직접 증여 ${skipPct}% — 중간세대 상속 1회 절약`,
    colorClass: 'bg-purple-500',
    snapshots, totalGiftTax, holdingTax10yr: holdingTax10,
    inheritanceTaxAt10yr: snap10.inheritanceTaxIfNow, cgtTotal: 0,
    totalTax10yr: totalGiftTax + holdingTax10 + snap10.inheritanceTaxIfNow,
    annualCashflowNow: netCashflow * remainPct,
    netWealth10yr: snap10.netWealthIfInheritNow, netWealth20yr: snap20.netWealthIfInheritNow,
    pros: ['중간세대 상속세 1회 절약', '손자녀 공제한도 별도 활용', '장기 절세 효과 큼'],
    cons: [
      '세대생략 30% 할증세율 적용',
      noGrandchildren ? '손자녀 없음 — 가상 계산' : '손자녀 미성년 관리 복잡',
      '증여세 선납 부담',
    ],
    actions: [
      noGrandchildren ? '손자녀 출생 후 증여 계획 수립' : '손자녀 공제한도 즉시 활용',
      '교육비·의료비 비과세 항목 병행',
      '손자녀 성년 후 추가 증여 계획',
    ],
    isRecommended: false, complexity: 'medium',
  };
}

function buildS5(
  assets: Asset[], members: FamilyMember[], macro: MacroSettings | null,
  ceoSalaryParam: number, transferPctOverride: number,
): ScenarioCalc {
  const m = getMacro(macro);
  const totalValue = assets.reduce((s, a) => s + a.current_value, 0);
  const totalDebt = assets.reduce((s, a) => s + a.loan_amount, 0);
  const rentalIncome = assets.reduce((s, a) => s + a.current_value * a.annual_yield_pct / 100, 0);
  const ceoSalary = ceoSalaryParam > 0 ? ceoSalaryParam : rentalIncome * 0.4;

  // 최적 법인전환 비율 자동 산출: 연 절세액이 최대화되는 비율 탐색
  // 사용자가 슬라이더로 직접 설정했으면 그 값 우선 사용
  let transferPct = transferPctOverride;
  if (transferPctOverride === 80) {
    // 기본값(80)인 경우에만 자동 최적화
    let bestSaving = -Infinity;
    for (let pct = 10; pct <= 100; pct += 10) {
      const rentalAssetsTmp = assets.filter(a => ['주거용부동산', '상업용부동산', '토지'].includes(a.asset_type));
      const xferTmp = scaleAssets(rentalAssetsTmp, pct / 100);
      const rentalXfer = xferTmp.reduce((s, a) => s + a.current_value * a.annual_yield_pct / 100, 0);
      const retainedRental = rentalIncome - rentalXfer;
      const saving = Math.max(0, calcIncomeTax(rentalIncome * 0.55) - (
        calcIncomeTax(retainedRental * 0.55) +
        calcCorporateTax(Math.max(0, rentalXfer - ceoSalary)) +
        calcIncomeTax(ceoSalary)
      ));
      if (saving > bestSaving) { bestSaving = saving; transferPct = pct; }
    }
  }

  const rentalAssets = assets.filter(a => ['주거용부동산', '상업용부동산', '토지'].includes(a.asset_type));
  const assetsToTransfer = scaleAssets(rentalAssets, transferPct / 100);
  const rentalIncomeTransferred = assetsToTransfer.reduce((s, a) => s + a.current_value * a.annual_yield_pct / 100, 0);
  const retainedRentalIncome = rentalIncome - rentalIncomeTransferred;

  // ── 절세효과 계산: 전체 기준 비교 (부분 전환 시 CEO급여를 전환분에만 배분) ──
  // 개인 시 전체 임대수익 소득세
  const personalTaxTotal = calcIncomeTax(rentalIncome * 0.55);
  // 전환 후: 보유분 개인과세 + 법인세 + CEO소득세
  const corpTaxableIncome = Math.max(0, rentalIncomeTransferred - ceoSalary);
  const corpTax = calcCorporateTax(corpTaxableIncome);
  const retainedPersonalTax = calcIncomeTax(retainedRentalIncome * 0.55);
  const ceoIncomeTax = calcIncomeTax(ceoSalary);
  const totalAfterTax = retainedPersonalTax + corpTax + ceoIncomeTax;
  const annualSaving = Math.max(0, personalTaxTotal - totalAfterTax);

  const corpResult = calcCorpConversionBenefit(rentalIncomeTransferred, ceoSalary, 0, assetsToTransfer);
  const setupCost = corpResult.transferTax; // 현물출자 취득세 (transferPct에 비례)

  const holdingCostAnnual = getAnnualHoldingCost(assets, m);
  const { netCashflow } = calcAnnualCashflow(assets, m);

  // 비상장주식 평가절하 효과: 법인 이전 비율만큼 30% 할인 적용
  const stockDiscountFactor = 1 - 0.30 * (transferPct / 100);

  const snapshots: YearSnapshot[] = TIMELINE_YEARS.map(year => {
    const assetValue = futureAssetValue(assets, year, m);
    const cumulativeHolding = Math.max(0, holdingCostAnnual * year - annualSaving * year);
    // 상속세: 법인 이전 부분은 비상장주식 30% 평가절하 적용 (transferPct 비례)
    const inheritTax = calcInheritanceTax(assetValue * stockDiscountFactor, members, 0).tax;
    const netWealth = assetValue - totalDebt - setupCost - cumulativeHolding - inheritTax;
    return {
      year, totalAssetValue: assetValue, remainingAssetValue: assetValue,
      cumulativeGiftTax: setupCost, cumulativeHoldingTax: cumulativeHolding,
      annualNetCashflow: netCashflow + annualSaving, inheritanceTaxIfNow: inheritTax,
      netWealthIfInheritNow: netWealth,
      events: year === 0 ? ['법인설립 + 현물출자 완료'] : [],
    };
  });

  const snap10 = snapshots.find(s => s.year === 10)!;
  const snap20 = snapshots.find(s => s.year === 20)!;

  const paybackYears = annualSaving > 0 ? Math.ceil(setupCost / annualSaving) : 999;
  const ceoTooHigh = ceoSalary > rentalIncomeTransferred;

  return {
    id: 's5', label: '법인전환', icon: '🏢',
    tagline: annualSaving > 0
      ? `임대자산 ${transferPct}% 법인 이전, 연 ${fmt(annualSaving)} 절세`
      : `임대자산 ${transferPct}% 법인 이전 (CEO급여 조정 필요)`,
    colorClass: 'bg-green-500',
    snapshots, totalGiftTax: setupCost, holdingTax10yr: holdingCostAnnual * 10,
    inheritanceTaxAt10yr: snap10.inheritanceTaxIfNow, cgtTotal: 0,
    totalTax10yr: setupCost + holdingCostAnnual * 10 + snap10.inheritanceTaxIfNow,
    annualCashflowNow: netCashflow + annualSaving,
    netWealth10yr: snap10.netWealthIfInheritNow, netWealth20yr: snap20.netWealthIfInheritNow,
    pros: [
      annualSaving > 0 ? `연 ${fmt(annualSaving)} 소득세 절세` : `CEO급여(${fmt(ceoSalary)})를 임대수익(${fmt(rentalIncomeTransferred)})이하로 낮추면 절세 가능`,
      `상속세 평가절하 효과: 주식 ${(transferPct * 0.3).toFixed(0)}% 할인 (이전분 30%×${transferPct}%)`,
      '주식 분산으로 지분증여 유연성',
      '법인세율 10~25% 적용',
    ],
    cons: [
      `현물출자 취득세 ${fmt(setupCost)} 선납 (${transferPct}% 이전 기준)`,
      paybackYears < 999 ? `투자회수기간 약 ${paybackYears}년` : '현 CEO급여로는 투자회수 어려움',
      ceoTooHigh ? `⚠ CEO급여(${fmt(ceoSalary)}) > 이전임대수익(${fmt(rentalIncomeTransferred)}) — 법인세 0, CEO소득세만 발생` : '법인 운영 행정·회계 비용',
      '배당 시 추가 소득세 14%+',
    ],
    actions: [
      '유한회사 설립 (자본금 1억)',
      '현물출자 절차: 법무사·세무사 협력',
      '배우자·자녀에게 주식 점진 증여',
    ],
    isRecommended: false, complexity: 'high', category: '법인형',
  };
}

function buildS6(assets: Asset[], members: FamilyMember[], macro: MacroSettings | null): ScenarioCalc {
  const m = getMacro(macro);
  const totalValue = assets.reduce((s, a) => s + a.current_value, 0);
  const totalDebt = assets.reduce((s, a) => s + a.loan_amount, 0);
  const totalCGT = assets.reduce((s, a) => s + calcCapitalGainsTax(a), 0);
  const cashAfterTax = Math.max(0, totalValue - totalDebt - totalCGT);

  const children = members.filter(r => r.relation !== '본인');
  let giftCashTax = 0;
  if (children.length > 0) {
    for (const _ of children) {
      giftCashTax += calcGiftTax(cashAfterTax / children.length, '자녀');
    }
  }
  const netCash = cashAfterTax - giftCashTax;
  const annualReturn = netCash * 0.03;

  const snapshots: YearSnapshot[] = TIMELINE_YEARS.map(year => {
    const assetValue = netCash + annualReturn * year;
    return {
      year, totalAssetValue: assetValue, remainingAssetValue: assetValue,
      cumulativeGiftTax: giftCashTax, cumulativeHoldingTax: 0,
      annualNetCashflow: annualReturn, inheritanceTaxIfNow: 0,
      netWealthIfInheritNow: assetValue,
      events: year === 0 ? ['전 자산 매각 + 현금 분배'] : [],
    };
  });

  const snap10 = snapshots.find(s => s.year === 10)!;
  const snap20 = snapshots.find(s => s.year === 20)!;

  return {
    id: 's6', label: '매각 후 분배', icon: '💰', tagline: '전 자산 매각 후 양도세 납부, 현금 분배',
    colorClass: 'bg-orange-500',
    snapshots, totalGiftTax: giftCashTax, holdingTax10yr: 0,
    inheritanceTaxAt10yr: 0, cgtTotal: totalCGT,
    totalTax10yr: totalCGT + giftCashTax,
    annualCashflowNow: annualReturn,
    netWealth10yr: snap10.netWealthIfInheritNow, netWealth20yr: snap20.netWealthIfInheritNow,
    pros: ['상속세 없음 (분배 후)', '자산 유동성 극대화', '관리 부담 제거'],
    cons: [
      `양도세 ${fmt(totalCGT)} + 증여세 ${fmt(giftCashTax)}`,
      '부동산 자산가 상승분 포기',
      '임대수익 소실',
    ],
    actions: [
      '다주택 규제 완화 시점 매각 검토',
      '장기보유특별공제 최대화 후 매각',
      '양도세·증여세 납부 자금 준비',
    ],
    isRecommended: false, complexity: 'low', category: '현금흐름형',
  };
}

// ── s9: 부담부증여 혼합 (담보대출 → 가족 무이자 차용 → 부담부증여 → 연부연납) ──
function buildS9_BurdenedGiftHybrid(
  assets: Asset[], members: FamilyMember[], macro: MacroSettings | null,
  loanPct: number,
): ScenarioCalc | null {
  const m = getMacro(macro);
  const REAL_ESTATE = ['주거용부동산', '상업용부동산', '토지', '오피스텔'];
  const target = [...assets]
    .filter(a => REAL_ESTATE.includes(a.asset_type))
    .sort((a, b) => b.current_value - a.current_value)[0];
  if (!target) return null;

  const totalValue = assets.reduce((s, a) => s + a.current_value, 0);
  const totalDebt = assets.reduce((s, a) => s + a.loan_amount, 0);
  const { netCashflow } = calcAnnualCashflow(assets, m);

  // 수증자: 자녀 우선
  const recipient = members.find(r => r.relation === '자녀') ?? members.find(r => r.relation !== '본인');
  if (!recipient) return null;

  // 신규 담보대출 (기존 대출 위에 추가)
  const newLoan = target.current_value * (loanPct / 100);
  const totalAssetDebt = target.loan_amount + newLoan;

  // 보유기간
  const holdingYears = target.acquisition_date
    ? Math.max(0, (Date.now() - new Date(target.acquisition_date).getTime()) / (365.25 * 24 * 3600 * 1000))
    : 10;

  // 부담부증여: 증여세(순증여분) + 양도세(채무인수분) + 취득세
  const bg = estimateBurdenedGiftTransfer({
    marketValue: target.current_value,
    assessedValue: target.assessed_value,
    acquisitionCost: target.acquisition_cost,
    totalDebt: totalAssetDebt,
    holdingYears,
    relation: recipient.relation,
    recipientAge: recipient.age ?? undefined,
    isOneHouseOneFamily: false,
    houseCount: target.house_count ?? 1,
    isRegulatedArea: false,
    isResidential: target.asset_type === '주거용부동산',
    recipientCanProveDebtRepayment: (recipient.annual_income ?? 0) > 0,
    necessaryExpenses: target.necessary_expenses ?? 0,
  });
  const giftTax = bg.giftPortion.amount;
  const transferTax = bg.transferPortion.amount;
  const acqTax = bg.acquisitionTax.amount;
  const totalTaxAll = bg.total.amount;

  // 대출금 → 가족 무이자 쪼개기 (수증자 외 가족 포함, 인별 2.17억 한도)
  const borrowers = members
    .filter(r => r.relation !== '본인')
    .map(r => ({ name: r.name, relation: r.relation, need: newLoan / Math.max(1, members.filter(x => x.relation !== '본인').length) }));
  const loanPlan = planFamilyLoanSplit(borrowers);

  // 증여세 연부연납 (최대 5년)
  const installment = planGiftTaxInstallment(giftTax);

  // 연 은행이자 (신규 대출)
  const annualBankInterest = newLoan * (m.base_rate_pct / 100);

  const netGiftValue = Math.max(0, target.current_value - totalAssetDebt);

  const snapshots: YearSnapshot[] = TIMELINE_YEARS.map(year => {
    const assetValue = futureAssetValue(assets, year, m);
    const targetFuture = projectAssetValue(target, year, m);
    const remainValue = assetValue - targetFuture; // 대상 자산은 증여로 상속재산 제외
    const holdingCost = getAnnualHoldingCost(assets.filter(a => a.id !== target.id), m) * year;
    const cumInterest = annualBankInterest * Math.min(year, 10);
    const priorGifts = year < 10 ? netGiftValue : 0;
    const inheritTax = calcInheritanceTax(remainValue, members, priorGifts).tax;
    const netWealth = assetValue - totalDebt - newLoan - totalTaxAll - installment.totalSurcharge
      - holdingCost - cumInterest - inheritTax;
    return {
      year, totalAssetValue: assetValue, remainingAssetValue: remainValue,
      cumulativeGiftTax: totalTaxAll, cumulativeHoldingTax: holdingCost + cumInterest,
      annualNetCashflow: netCashflow - annualBankInterest - (year <= installment.years ? installment.annualPrincipal : 0),
      inheritanceTaxIfNow: inheritTax, netWealthIfInheritNow: netWealth,
      events: year === 0
        ? [`담보대출 ${fmt(newLoan)} → 가족 무이자 차용 배분`, `${target.name} 부담부증여 실행`]
        : year === installment.years ? ['증여세 연부연납 완납'] : [],
    };
  });

  const snap10 = snapshots.find(s => s.year === 10)!;
  const snap20 = snapshots.find(s => s.year === 20)!;

  const interestFreeLimit = maxInterestFreeLoanPrincipal();

  return {
    id: 's9', label: '부담부증여 혼합', icon: '🏦',
    tagline: `${target.name} 담보대출 ${fmt(newLoan)} → 무이자 차용 배분 → 부담부증여 (순증여 ${fmt(netGiftValue)})`,
    colorClass: 'bg-teal-600',
    snapshots, totalGiftTax: totalTaxAll, holdingTax10yr: snapshots.find(s => s.year === 10)!.cumulativeHoldingTax,
    inheritanceTaxAt10yr: snap10.inheritanceTaxIfNow, cgtTotal: transferTax,
    totalTax10yr: totalTaxAll + installment.totalSurcharge + snap10.cumulativeHoldingTax + snap10.inheritanceTaxIfNow,
    annualCashflowNow: netCashflow - annualBankInterest - installment.annualPrincipal,
    netWealth10yr: snap10.netWealthIfInheritNow, netWealth20yr: snap20.netWealthIfInheritNow,
    pros: [
      `순증여분 ${fmt(netGiftValue)}만 증여세 과세 — 채무 ${fmt(totalAssetDebt)} 차감`,
      `양도세는 채무 비율만 안분 과세 (${holdingYears.toFixed(0)}년 보유 장기공제 적용)`,
      loanPlan.allInterestFree
        ? `가족 차용 전원 무이자 가능 (인별 한도 ${interestFreeLimit.toFixed(2)}억)`
        : '가족 차용 일부 무이자 (한도 초과분 4.6% 이자 필요)',
      `증여세 연부연납 ${installment.years}년 — 첫해 ${fmt(installment.firstPayment)}만 납부`,
    ],
    cons: [
      `취득세 ${fmt(acqTax)} + 양도세 ${fmt(transferTax)} 즉시 발생`,
      `연 은행이자 ${fmt(annualBankInterest)} 지속 부담`,
      `연부연납 가산금 총 ${fmt(installment.totalSurcharge)} (연 ${(installment.surchargeRate * 100).toFixed(1)}%)`,
      '채무 상환능력 증빙·차용증 만기 명시·자금 사용 증빙 필수',
    ],
    actions: [
      `1단계: ${target.name} 담보 신규대출 ${fmt(newLoan)} 실행 (증여 전, 현 소유자 명의)`,
      `2단계: 대출금을 가족 ${borrowers.length}인에게 무이자 차용증 작성 후 배분 (인별 ≤ ${interestFreeLimit.toFixed(2)}억)`,
      `3단계: ${recipient.name}에게 부담부증여 — 채무 ${fmt(totalAssetDebt)} 승계 조건`,
      `4단계: 증여세 ${fmt(giftTax)} 연부연납 신청 (첫해 ${fmt(installment.firstPayment)}, 이후 연 ${fmt(installment.annualPrincipal)}+가산금)`,
      '5단계: 이전 후 은행이자는 수증자가 본인 계좌에서 납부 (자금출처 정합성)',
    ],
    // 이 시나리오의 실제 재원은 "가족 보유현금" + "이 시나리오 자체가 계획한 신규대출(newLoan)"이다.
    // 다른 순수 증여 시나리오처럼 일반 LTV 대출여력을 재원으로 착시시키지 않기 위해 명시적으로 지정한다.
    immediateFundingNeed: acqTax + transferTax + installment.firstPayment,
    availableFunding: getLiquidAvailableFunding(assets, members) + newLoan,
    isRecommended: false, complexity: 'high', category: '절세형',
  };
}

function buildS7(
  assets: Asset[], members: FamilyMember[], macro: MacroSettings | null,
  giftNowPct: number, useCorp: boolean, ceoSalaryParam: number, includeGrandchildren: boolean,
  useFoundation = false, foundationDonationPct = 0, corpContributionPct = 50,
  assetLtvMap: Record<string, number> = {},
  assetInterestRateMap: Record<string, number> = {},
  rateShockPct = 0,
  category: SavedScenarioType = '균형형',
): ScenarioCalc {
  const m = getMacro(macro);
  const totalValue = assets.reduce((s, a) => s + a.current_value, 0);
  const totalDebt = assets.reduce((s, a) => s + a.loan_amount, 0);
  const { netCashflow } = calcAnnualCashflow(assets, m);
  const giftPct = Math.max(0, Math.min(100, giftNowPct)) / 100;
  const foundationPct = useFoundation
    ? Math.max(0, Math.min(100, foundationDonationPct)) / 100
    : 0;
  const corpPct = useCorp
    ? Math.max(0, Math.min(100, corpContributionPct)) / 100
    : 0;

  const giftValue = totalValue * giftPct;
  const targetMembers = includeGrandchildren
    ? members.filter(r => r.relation !== '본인')
    : members.filter(r => r.relation !== '본인' && r.relation !== '손자녀');

  let totalGiftTax = 0;
  let totalGiftedAmt = 0;
  if (targetMembers.length > 0) {
    for (const r of targetMembers) {
      const giftAmt = giftValue / targetMembers.length;
      const isSkip = r.relation === '손자녀';
      totalGiftTax += calcGiftTax(giftAmt, r.relation, 0, isSkip);
      totalGiftedAmt += giftAmt;
    }
  }
  totalGiftedAmt = Math.min(totalGiftedAmt, giftValue);

  const foundationValueNow = totalValue * (1 - giftPct) * foundationPct;
  const familyAssetRatio = 1 - (1 - giftPct) * foundationPct;
  const remainPct = (1 - giftPct) * (1 - foundationPct);
  const remainAssets = scaleAssets(assets, remainPct);

  let setupCost = 0;
  let annualSaving = 0;
  if (useCorp) {
    const rentalIncome = remainAssets.reduce((s, a) => s + a.current_value * a.annual_yield_pct / 100, 0) * corpPct;
    const ceoSalary = ceoSalaryParam > 0 ? ceoSalaryParam : rentalIncome * 0.4;
    const rentalAssets = scaleAssets(
      remainAssets.filter(a => ['주거용부동산', '상업용부동산', '토지', '오피스텔'].includes(a.asset_type)),
      corpPct,
    );
    const corpResult = calcCorpConversionBenefit(rentalIncome, ceoSalary, 0, rentalAssets);
    setupCost = corpResult.transferTax;
    annualSaving = Math.max(0, corpResult.annualSaving);
  }

  let additionalDebt = 0;
  let additionalAnnualInterest = 0;
  assets.forEach(asset => {
    const currentLtv = asset.current_value > 0
      ? (asset.loan_amount / asset.current_value) * 100
      : 0;
    const targetLtv = Math.max(currentLtv, Math.min(70, assetLtvMap[asset.id] ?? currentLtv));
    const targetDebt = asset.current_value * targetLtv / 100;
    const debtIncrease = Math.max(0, targetDebt - (asset.loan_amount || 0));
    const interestRate = Math.max(
      0,
      (assetInterestRateMap[asset.id] ?? asset.loan_rate_pct ?? m.base_rate_pct) + rateShockPct,
    );
    additionalDebt += debtIncrease;
    additionalAnnualInterest += debtIncrease * interestRate / 100;
  });

  const availableFunding = getLiquidAvailableFunding(assets, members) + additionalDebt;
  const immediateFundingNeed = totalGiftTax + setupCost;
  const holdingCostAnnual = getAnnualHoldingCost(remainAssets, m) - annualSaving;

  const snapshots: YearSnapshot[] = TIMELINE_YEARS.map(year => {
    const assetValue = futureAssetValue(assets, year, m);
    const remainValue = assetValue * remainPct;
    const familyAssetValue = assetValue * familyAssetRatio;
    const cumulativeHolding = Math.max(0, holdingCostAnnual * year);
    const priorGifts = year < 10 ? totalGiftedAmt : 0;
    const inheritTax = calcInheritanceTax(remainValue, members, priorGifts).tax;
    const netWealth = familyAssetValue - totalDebt - additionalDebt
      - totalGiftTax - setupCost - cumulativeHolding - inheritTax;
    return {
      year, totalAssetValue: familyAssetValue, remainingAssetValue: remainValue,
      cumulativeGiftTax: totalGiftTax + setupCost, cumulativeHoldingTax: cumulativeHolding,
      annualNetCashflow: netCashflow * remainPct + annualSaving - additionalAnnualInterest,
      inheritanceTaxIfNow: inheritTax,
      netWealthIfInheritNow: netWealth,
      events: year === 0 ? [
        `${giftNowPct}% 증여 실행`,
        ...(useFoundation ? [`공익재단 ${foundationDonationPct}% 출연`] : []),
        ...(useCorp ? [`법인 ${corpContributionPct}% 출자`] : []),
        ...(additionalDebt > 0 ? [`추가 대출 ${fmt(additionalDebt)}`] : []),
      ] : [],
    };
  });

  const snap10 = snapshots.find(s => s.year === 10)!;
  const snap20 = snapshots.find(s => s.year === 20)!;

  return {
    id: 's7', label: '직접 설계', icon: '⚙️',
    tagline: `${giftNowPct}% 증여${useFoundation ? ` + 공익 ${foundationDonationPct}%` : ''}${useCorp ? ` + 법인 ${corpContributionPct}%` : ''}`,
    colorClass: 'bg-teal-500',
    snapshots, totalGiftTax: totalGiftTax + setupCost, holdingTax10yr: Math.max(0, holdingCostAnnual) * 10,
    inheritanceTaxAt10yr: snap10.inheritanceTaxIfNow, cgtTotal: 0,
    totalTax10yr: totalGiftTax + setupCost + Math.max(0, holdingCostAnnual) * 10 + snap10.inheritanceTaxIfNow,
    annualCashflowNow: netCashflow * remainPct + annualSaving - additionalAnnualInterest,
    netWealth10yr: snap10.netWealthIfInheritNow, netWealth20yr: snap20.netWealthIfInheritNow,
    pros: ['유연한 맞춤 설계', '증여 + 법인 복합 절세 가능', '가족 상황에 최적화'],
    cons: ['복잡한 실행 관리 필요', '여러 세금 동시 발생', '전문가 협력 필수'],
    actions: ['세무사·법무사 종합 상담', '단계별 실행 일정 수립', '연간 모니터링 계획'],
    isRecommended: false, complexity: 'high',
    immediateFundingNeed, availableFunding, category,
  };
}

function buildS8_MyPlan(
  assets: Asset[], members: FamilyMember[], macro: MacroSettings | null,
  strategyIds: string[],
): ScenarioCalc {
  const m = getMacro(macro);
  const totalValue = assets.reduce((s, a) => s + a.current_value, 0);
  const totalDebt = assets.reduce((s, a) => s + a.loan_amount, 0);
  const { netCashflow } = calcAnnualCashflow(assets, m);
  const { tax: baseInheritanceTax } = calcInheritanceTax(totalValue, members);

  let giftedAmt = 0;
  let totalGiftTax = 0;
  let inheritanceTaxReduction = 0;
  let annualSavingDelta = 0;
  let setupCost = 0;

  const GROWTH = 0.03;
  const urgencyYears = 7;

  if (strategyIds.includes('immediate_gift_growth')) {
    const growthFactor = Math.pow(1 + GROWTH, urgencyYears) - 1;
    inheritanceTaxReduction += totalValue * growthFactor * 0.50 * 0.97;
    giftedAmt += totalValue * 0.5;
    const targetMembers = members.filter(r => r.relation !== '본인' && r.relation !== '손자녀');
    for (const r of targetMembers) {
      totalGiftTax += calcGiftTax(giftedAmt / Math.max(1, targetMembers.length), r.relation, 0, false);
    }
  }

  if (strategyIds.includes('family_loan')) {
    const maxLoan = 2.17;
    inheritanceTaxReduction += maxLoan * 0.10;
  }

  if (strategyIds.includes('charity_foundation')) {
    const charityAmt = totalValue * 0.1;
    inheritanceTaxReduction += charityAmt * 0.50 * 0.97;
  }

  if (strategyIds.includes('corp_conversion')) {
    const realEstateValue = assets.filter(a => ['주거용부동산','상업용부동산','토지'].includes(a.asset_type)).reduce((s,a) => s+a.current_value, 0);
    setupCost += realEstateValue * 0.02;
    annualSavingDelta += realEstateValue * 0.05 * 0.30;
  }

  if (strategyIds.includes('dil_5yr_lookback')) {
    const dilAmt = totalValue * 0.1;
    inheritanceTaxReduction += dilAmt * 0.30 * 0.97;
    totalGiftTax += dilAmt * 0.10;
  }

  const effectiveInheritanceTax = Math.max(0, baseInheritanceTax - inheritanceTaxReduction);
  const holdingCostAnnual = getAnnualHoldingCost(assets, m) - annualSavingDelta;

  const snapshots: YearSnapshot[] = TIMELINE_YEARS.map(year => {
    const assetValue = futureAssetValue(assets, year, m);
    const remainValue = assetValue - giftedAmt * Math.pow(1 + GROWTH, year);
    const cumulativeHolding = Math.max(0, holdingCostAnnual * year);
    const inheritTax = Math.max(0, calcInheritanceTax(Math.max(0, remainValue), members).tax - inheritanceTaxReduction * (1 - year/20));
    const netWealth = assetValue - totalDebt - totalGiftTax - setupCost - cumulativeHolding - inheritTax;
    return {
      year, totalAssetValue: assetValue, remainingAssetValue: Math.max(0, remainValue),
      cumulativeGiftTax: totalGiftTax + setupCost, cumulativeHoldingTax: cumulativeHolding,
      annualNetCashflow: netCashflow + annualSavingDelta, inheritanceTaxIfNow: inheritTax,
      netWealthIfInheritNow: netWealth,
      events: year === 0 ? strategyIds.map(id => {
        const labels: Record<string, string> = {
          immediate_gift_growth: '즉시 증여 실행',
          family_loan: '가족 차용증 실행',
          charity_foundation: '공익법인 설립',
          corp_conversion: '법인 전환',
          dil_5yr_lookback: '며느리 증여',
          installment: '연부연납 신청',
          life_insurance: '생명보험 가입',
          spouse_deduction: '배우자 공제 최적화',
        };
        return labels[id] ?? id;
      }) : [],
    };
  });

  const snap10 = snapshots.find(s => s.year === 10)!;
  const snap20 = snapshots.find(s => s.year === 20)!;
  const strategyCount = strategyIds.length;

  return {
    id: 's8', label: '내 계획', icon: '✅', tagline: `${strategyCount}가지 전략 조합 맞춤 계획`,
    colorClass: 'bg-emerald-500',
    snapshots, totalGiftTax: totalGiftTax + setupCost, holdingTax10yr: Math.max(0, holdingCostAnnual) * 10,
    inheritanceTaxAt10yr: snap10.inheritanceTaxIfNow, cgtTotal: 0,
    totalTax10yr: totalGiftTax + setupCost + Math.max(0, holdingCostAnnual) * 10 + snap10.inheritanceTaxIfNow,
    annualCashflowNow: netCashflow + annualSavingDelta,
    netWealth10yr: snap10.netWealthIfInheritNow, netWealth20yr: snap20.netWealthIfInheritNow,
    pros: strategyIds.map(id => {
      const p: Record<string, string> = {
        immediate_gift_growth: '자산 성장분 상속세 제외',
        family_loan: '세금 없이 2.17억 이전',
        charity_foundation: '출연액 만큼 과세가액 제외',
        corp_conversion: '법인세율(25%) vs 상속세율(50%) 차이 절세',
        dil_5yr_lookback: '며느리 5년 룩백 탈출',
        installment: '납부 충격 10년 분산',
        life_insurance: '부동산 강제 매각 방지',
        spouse_deduction: '배우자 공제 최대 30억',
      };
      return p[id] ?? id;
    }),
    cons: ['복합 전략 실행 관리 필요', '세무사·법무사 협력 필수', '각 전략별 의무 이행 사항 있음'],
    actions: ['세무사와 종합 전략 실행 일정 수립', '전략별 체크리스트 이행 관리', '연간 진행상황 검토'],
    isRecommended: true, complexity: 'high',
  };
}

// ── 시나리오별 실행 계획 ──────────────────────────────────────

interface ScenarioPlan {
  feasibilityPct: number;
  feasibilityNote: string;
  whenBest: string;
  whenNotGood: string;
  executionSteps: Array<{ timing: string; title: string; description: string; actor: string; estimatedCost?: string }>;
  risks: string[];
}

const SCENARIO_PLANS: Record<string, ScenarioPlan> = {
  s1: {
    feasibilityPct: 100,
    feasibilityNote: '별도 절차 없음. 하지만 아무것도 하지 않는 것 자체가 위험.',
    whenBest: '자산 소액 / 상속세 납부 능력 충분 / 자녀가 너무 어려 증여 부적절한 경우',
    whenNotGood: '상속세 > 현금 보유 / 자산이 성장 중 / 고령으로 10년 룩백 탈출 불가',
    executionSteps: [
      { timing: '매년', title: '상속세 추정액 모니터링', description: '자산가치 상승에 따른 예상 상속세 재계산. 현금 납부 능력 대비 확인', actor: '본인+세무사' },
      { timing: '5년마다', title: '자산·가족 상황 재점검', description: '가족 구성 변화(결혼·출산), 자산 가치 변화, 세법 개정 체크. 필요 시 전략 전환', actor: '세무사' },
    ],
    risks: ['자산 성장 시 상속세 급증', '갑작스러운 상속 발생 시 현금 부족', '절세 기회 소실'],
  },
  s2: {
    feasibilityPct: 85,
    feasibilityNote: '즉시 실행 가능. 증여세 선납 자금 필요.',
    whenBest: '충분한 현금 있어 증여세 납부 가능 / 수증자 다수 / 자산 성장률 높아 빨리 이전할수록 유리',
    whenNotGood: '현금 부족 / 10년 룩백 이내 상속 우려 / 증여세도 납부 불가',
    executionSteps: [
      { timing: '1주차', title: '수증자별 증여 계획 수립', description: '관계별 공제한도 확인 (배우자 6억, 자녀 5천만, 며느리 1천만). 공제 내 증여 우선, 초과분 세금 계산', actor: '세무사', estimatedCost: '상담 약 30~50만원' },
      { timing: '2주차', title: '증여 계약서 작성 + 자산 이전', description: '현금: 계좌이체 + 증여계약서. 부동산: 감정평가 → 등기이전 (취득세 3.5%)', actor: '법무사', estimatedCost: '취득세: 이전금액×3.5%' },
      { timing: '3개월 내', title: '증여세 신고·납부', description: '증여일이 속한 달 말일부터 3개월 내 신고. 신고 시 3% 세액공제 적용', actor: '세무사' },
      { timing: '10년 후', title: '2차 증여 사이클 준비', description: '공제한도 리셋 → 재계획. 혼인·출산 공제 +1억 활용 여부 확인', actor: '세무사' },
    ],
    risks: ['증여세 현금 선납 부담', '10년 합산 과세', '부동산 취득세 추가'],
  },
  s3: {
    feasibilityPct: 90,
    feasibilityNote: '10년 계획 필요. 지금 1차 실행 후 10년 후 2차 실행.',
    whenBest: '자산가치 상승 기대 / 증여세 납부 여력 있음 / 기대여명 10년 이상',
    whenNotGood: '기대여명 10년 미만 (2차 증여 실행 불확실) / 급격한 자산 성장으로 2차 세금 급증',
    executionSteps: [
      { timing: '즉시', title: '1차 증여 실행', description: '수증자별 공제한도 내 최대 증여. 현금·금융자산 우선. 증여세 신고 (3개월 내)', actor: '세무사+법무사' },
      { timing: '10년 후', title: '2차 증여 설계 및 실행', description: '공제한도 리셋 (정확히 10년 경과) 확인. 자산가치 재평가. 혼인·출산공제 추가 활용. 고액 증여 적극 검토', actor: '세무사+법무사', estimatedCost: '증여세 + 부동산 취득세' },
    ],
    risks: ['1차 증여 후 10년 내 사망 시 2차 미실행', '2차 시점 자산 상승으로 세금 증가 가능'],
  },
  s4: {
    feasibilityPct: 60,
    feasibilityNote: '손자녀 존재 시 실행 가능. 30% 할증 포함해도 장기적으로 유리한지 시뮬레이션 필수.',
    whenBest: '자산 규모 크고 손자녀 있음 / 2세대 상속세 중복 회피 필요 / 손자녀 미성년으로 관리 가능',
    whenNotGood: '손자녀 없음 / 할증 30%로 오히려 세금 더 많은 경우 / 손자녀 성년 후 통제 어려움',
    executionSteps: [
      { timing: '사전', title: '할증 효과 시뮬레이션', description: '손자녀 직접 증여 시 30% 할증 vs 자녀→손자녀 2단계 상속세 비교. 금액·세율에 따라 불리할 수도 있음', actor: '세무사' },
      { timing: '1주차', title: '손자녀 증여 계획 수립', description: '손자녀 공제한도 2천만원 확인. 미성년 수증자는 법정대리인(부모) 동의서 준비', actor: '세무사+법무사' },
      { timing: '2~3주차', title: '증여 실행 + 세금 신고', description: '현금 증여 우선. 할증 30% 포함한 증여세 신고. 미성년 계좌는 부모 관리', actor: '세무사', estimatedCost: '증여세 (30% 할증 포함)' },
    ],
    risks: ['세대생략 30% 할증세율로 세금 더 많이 낼 수 있음', '손자녀 없으면 불가', '미성년 자산 관리 복잡'],
  },
  s5: {
    feasibilityPct: 70,
    feasibilityNote: '3~6개월 소요. 전문가 협력 필수. 2027년 전 실행 시 취득세 50% 감면 적용 가능.',
    whenBest: '임대소득 연 5천만원 이상 / 법인세율 vs 개인세율 차이 클 때 / 주식 분산 증여 원할 때',
    whenNotGood: '임대소득 낮아 절세 효과 미미 / 대출 많아 현물출자 복잡 / 법인 운영 비용·행정 부담',
    executionSteps: [
      { timing: '1~2주차', title: '타당성 분석', description: '현재 임대소득세 vs 법인전환 후 세금 비교. 투자회수기간 계산. 법인 운영 의지 확인', actor: '세무사', estimatedCost: '분석 약 50~100만원' },
      { timing: '2~4주차', title: '부동산 감정평가', description: '현물출자 기준가액 결정 (시가 기준). 세무서·법원 제출용 감정평가서 취득', actor: '감정평가사', estimatedCost: '100~300만원' },
      { timing: '4~6주차', title: '법인 설립', description: '주식회사 또는 유한회사. 자본금, 정관, 임원 구성. CEO 급여 법인비용 최대화 설계', actor: '법무사', estimatedCost: '50~100만원' },
      { timing: '6~12주차', title: '현물출자 + 법원 인가', description: '현물출자 검사인 선임 → 법원 심사 → 출자 완료. 조특법§32 이월과세 신청', actor: '법무사+세무사', estimatedCost: '검사인 30~50만원' },
      { timing: '인가 후', title: '소유권 이전 + 취득세 감면', description: '부동산 법인 명의 이전. 조특법§119 취득세 50% 감면 신청 (~2027.12.31)', actor: '법무사', estimatedCost: '취득세 시가×2% (감면 후)' },
      { timing: '이후 매년', title: '법인 운영 + 급여 최적화', description: 'CEO 급여 법인비용 처리. 법인세 신고. 가족에게 주식 점진 증여 계획', actor: '세무사' },
    ],
    risks: ['취득세 선납 부담', '법인 운영 회계·행정 비용', '배당 시 추가 소득세 14%+', '2027년 후 취득세 감면 만료'],
  },
  s6: {
    feasibilityPct: 95,
    feasibilityNote: '가장 단순하나 세금 손실 최대. 임대수익 소실.',
    whenBest: '자산 관리 의지 없음 / 가족 분쟁 예방 / 상속인 다수로 분배 필요 / 해외 이주 계획',
    whenNotGood: '장기보유 부동산 (양도세 과중) / 임대수익이 주 소득원 / 부동산 가치 상승 기대',
    executionSteps: [
      { timing: '사전', title: '매각 타이밍·순서 결정', description: '장기보유특별공제 최대화 (15년+ 보유 시 30%). 1세대1주택 비과세 요건 확인. 다주택 규제 완화 시점 활용', actor: '세무사' },
      { timing: '매각 결정 후', title: '부동산 매각', description: '공인중개사 통해 시세 매각. 잔금 수령 후 양도세 예정신고', actor: '공인중개사', estimatedCost: '중개수수료 0.4~0.9%' },
      { timing: '매각 후 2개월', title: '양도세 예정신고·납부', description: '양도일 속한 달 말일부터 2개월 내. 장기보유공제·기본공제(250만) 적용', actor: '세무사' },
      { timing: '세금 납부 후', title: '현금 분배', description: '수증자별 공제한도 내 증여. 초과분 증여세 납부. 금융상품 투자로 운용', actor: '세무사' },
    ],
    risks: ['양도세+증여세 이중 부담', '임대수익 완전 소실', '인플레이션으로 현금 가치 하락'],
  },
  s7: {
    feasibilityPct: 75,
    feasibilityNote: '가장 복잡하나 효과 최대. 세무사·법무사 종합 협력 필수.',
    whenBest: '자산 규모 크고 다양한 절세 여지 / 전문가 협력 가능 / 장기 관리 의지 있음',
    whenNotGood: '자산 소액 / 전문가 비용 부담 / 가족 합의 어려움',
    executionSteps: [
      { timing: '즉시', title: '종합 세무 상담', description: '자산·가족 전체 분석. 증여+법인전환 최적 비율 설계. 세금 시뮬레이션', actor: '세무사', estimatedCost: '100~200만원' },
      { timing: '1개월 내', title: '즉시 실행 부분 증여', description: '결정된 증여 비율 즉시 이전. 수증자별 최적 공제 적용', actor: '세무사+법무사' },
      { timing: '1~3개월', title: '법인전환 절차 (해당 시)', description: '감정평가→법인설립→현물출자→등기이전. 취득세 50% 감면 신청', actor: '법무사+세무사' },
      { timing: '이후 매년', title: '통합 관리·모니터링', description: '연간 세금 최적화 검토. 법인+개인 증여 계획 조율. 세법 개정 대응', actor: '세무사' },
    ],
    risks: ['복잡한 실행 관리', '여러 세금 동시 발생', '전문가 의존도 높음'],
  },
  s8: {
    feasibilityPct: 80,
    feasibilityNote: '선택한 전략들의 조합. 각 전략의 실행 계획을 시나리오 비교와 심화 전략 페이지에서 확인하세요.',
    whenBest: '여러 전략을 직접 선택·조합한 맞춤 계획',
    whenNotGood: '전략 간 상충 가능성 — 세무사 확인 권장',
    executionSteps: [
      { timing: '즉시', title: '세무사·법무사 종합 상담', description: '선택한 전략들의 실행 우선순위와 일정 확정', actor: '세무사+법무사' },
      { timing: '이후', title: '전략별 순차 실행', description: '심화 전략 페이지의 통합 실행 타임라인을 따라 순서대로 실행', actor: '본인+전문가' },
    ],
    risks: ['복합 전략 실행 관리 필요', '세무사·법무사 협력 필수'],
  },
};

// 하드코딩된 %가 아니라 실제 자금조달 능력(즉시 필요재원 vs 가용재원)·현금흐름·복잡도로 계산
function computeFeasibilityPct(
  scenario: ScenarioCalc,
  feasibility: ScenarioFeasibility,
): number {
  const complexityPenalty = scenario.complexity === 'high' ? 15 : scenario.complexity === 'medium' ? 7 : 0;
  const cashflowPenalty = feasibility.annualCashflow < -0.01 ? 15 : 0;

  if (feasibility.immediateNeed <= 0.01) {
    return Math.max(5, Math.min(100, 95 - complexityPenalty - cashflowPenalty));
  }

  const coverage = feasibility.availableFunding / feasibility.immediateNeed;
  const basePct = Math.min(100, coverage * 100);
  return Math.max(5, Math.round(basePct - complexityPenalty - cashflowPenalty));
}

function ScenarioExecutionPanel({
  scenarioId, scenario, assets, members,
}: {
  scenarioId: string; scenario: ScenarioCalc; assets: Asset[]; members: FamilyMember[];
}) {
  const [open, setOpen] = useState(false);
  const plan = SCENARIO_PLANS[scenarioId];
  if (!plan) return null;

  const feasibility = getScenarioFeasibility(scenario, assets, members);
  const feasibilityPct = computeFeasibilityPct(scenario, feasibility);

  const feasColor = feasibilityPct >= 80
    ? 'var(--green-ink)'
    : feasibilityPct >= 60 ? 'var(--amber)'
    : 'var(--red)';

  return (
    <div className={`accrow${open ? ' open' : ''}`} style={{ marginTop: 12 }}>
      <div className="acch" onClick={() => setOpen(o => !o)}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>실현 방법 &amp; 실행 계획</span>
        <span className="pill" style={{ marginLeft: 8, color: feasColor }}>실현 가능성 {feasibilityPct}%</span>
        <span className="tri" />
      </div>

      <div className="accb">
        <p style={{ fontSize: 12, color: 'var(--ink-faint)', marginBottom: 4 }}>{plan.feasibilityNote}</p>
        {feasibility.reasons.length > 0 && (
          <div style={{ border: '1px solid var(--red)', background: 'var(--red-tint)', padding: '8px 10px', marginBottom: 12 }}>
            <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--red)', marginBottom: 4 }}>이 가족 조건에서 실제로 걸리는 문제</div>
            {feasibility.reasons.map(r => (
              <div key={r} style={{ fontSize: 12, color: 'var(--red)' }}>· {r}</div>
            ))}
            {feasibility.fundingGap > 0.01 && (
              <div style={{ fontSize: 12, color: 'var(--red)', marginTop: 4 }}>
                즉시 필요 재원 {fmt(feasibility.immediateNeed)} 중 가용재원 {fmt(feasibility.availableFunding)}만 확보 —
                부족분 {fmt(feasibility.fundingGap)}은 대출·연부연납·매각 중 하나로 반드시 메워야 합니다.
              </div>
            )}
          </div>
        )}

        {/* 유리/불리 상황 */}
        <div className="grid2" style={{ marginBottom: 16 }}>
          <div style={{ border: '1px solid var(--line)', background: 'var(--paper)', padding: '10px 12px' }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--green-ink)', marginBottom: 6 }}>이 시나리오가 유리한 상황</div>
            <div style={{ fontSize: 12, color: 'var(--ink-soft)' }}>{plan.whenBest}</div>
          </div>
          <div style={{ border: '1px solid var(--line)', background: 'var(--paper)', padding: '10px 12px' }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--red)', marginBottom: 6 }}>불리한 상황</div>
            <div style={{ fontSize: 12, color: 'var(--ink-soft)' }}>{plan.whenNotGood}</div>
          </div>
        </div>

        {/* 실행 단계 */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink-soft)', marginBottom: 10 }}>단계별 실행 계획</div>
          <div className="execsteps">
            {plan.executionSteps.map((step, i) => (
              <div key={i} className="es">
                <span className="no">{i + 1}</span>
                <span className="tg">
                  <span className="t1">{step.title}</span>
                  <span className="t2">{step.timing}</span>
                </span>
                <div className="bd">
                  <div className="bt">{step.description}</div>
                  <div className="bd2">담당: {step.actor}{step.estimatedCost ? ` · 비용: ${step.estimatedCost}` : ''}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* 리스크 */}
        <div>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--red)', marginBottom: 8 }}>주요 리스크</div>
          {plan.risks.map((r, i) => (
            <div key={i} style={{ fontSize: 12, color: 'var(--ink-soft)', paddingLeft: 10, marginBottom: 3 }}>• {r}</div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── 종합 실행 로드맵 (평가방법·거주자판정·부담부증여·현금흐름·법인타이밍·재매입) ──

const REPORT_REAL_ESTATE_TYPES = ['주거용부동산', '상업용부동산', '토지', '오피스텔'];

function pickPrimaryRealEstate(assets: Asset[]): Asset | null {
  return [...assets]
    .filter(a => REPORT_REAL_ESTATE_TYPES.includes(a.asset_type))
    .sort((a, b) => b.current_value - a.current_value)[0] ?? null;
}

function RoadmapSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 18, breakInside: 'avoid' }}>
      <div style={{
        fontSize: 12.5, fontWeight: 700, color: 'var(--ink)',
        borderBottom: '1px solid var(--line-strong)', paddingBottom: 6, marginBottom: 10,
      }}>
        {title}
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--ink-soft)', lineHeight: 1.7 }}>{children}</div>
    </div>
  );
}

function ScenarioRoadmapReport({
  scenario, assets, members, macro,
}: {
  scenario: ScenarioCalc; assets: Asset[]; members: FamilyMember[]; macro: MacroSettings | null;
}) {
  const [open, setOpen] = useState(false);
  const [studyAbroadAnnual, setStudyAbroadAnnual] = useState(0);
  const [studyAbroadYears, setStudyAbroadYears] = useState(4);
  const [reinvestPurchasePrice, setReinvestPurchasePrice] = useState(0);

  const m = macro ?? { base_rate_pct: 4.5 } as MacroSettings;
  const target = pickPrimaryRealEstate(assets);
  const feasibility = getScenarioFeasibility(scenario, assets, members);

  // 평가방법 판단
  const valuationGapNote = target && target.assessed_value !== null && target.assessed_value < target.current_value
    ? `공시가격(${fmt(target.assessed_value)})이 시가(${fmt(target.current_value)})보다 낮습니다.`
    : target ? `${target.name}의 공시가격 정보가 없거나 시가와 동일합니다.` : null;

  // 법인 설립 타이밍
  const annualRentalTotal = assets.reduce((s, a) => s + a.current_value * a.annual_yield_pct / 100, 0);
  const incomeAssetCount = assets.filter(a => a.annual_yield_pct > 0).length;
  const corpWorthReviewing = annualRentalTotal >= 0.5 && incomeAssetCount > 0;

  // 유학비 등 현금흐름 커버
  const studyAbroadTotal = studyAbroadAnnual * studyAbroadYears;
  const recipient = members.find(r => r.relation === '자녀') ?? members.find(r => r.relation !== '본인');
  const loanPlan = studyAbroadTotal > 0 && recipient
    ? planFamilyLoanSplit([{ name: recipient.name, relation: recipient.relation, need: studyAbroadTotal }])
    : null;
  const interestFreeLimit = maxInterestFreeLoanPrincipal();

  // 재매입 시뮬레이션 (신규 대출 → 오피스텔 등 매입)
  const availableLoanRoom = target ? Math.max(0, target.current_value * 0.4 - target.loan_amount) : 0;
  const purchasePrice = reinvestPurchasePrice > 0 ? reinvestPurchasePrice : availableLoanRoom;
  const reinvestAcqTax = purchasePrice > 0 ? calcAcquisitionTax(purchasePrice, '오피스텔', false, false, 'purchase') : 0;
  const reinvestAnnualInterest = purchasePrice * (m.base_rate_pct / 100);

  const today = new Date().toISOString().slice(0, 10);

  const handlePrint = () => window.print();

  return (
    <div className="accrow" style={{ marginTop: 12 }}>
      <div className="acch" onClick={() => setOpen(o => !o)}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>📋 종합 실행 로드맵</span>
        <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--ink-faint)' }}>평가방법·거주자판정·부담부증여·현금흐름·법인·재매입 한 문서로</span>
        <span className="tri" style={{ transform: open ? 'rotate(180deg)' : undefined }} />
      </div>

      {open && (
        <div className="accb" style={{ display: 'block' }}>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }} className="no-print">
            <button type="button" onClick={handlePrint} className="slp-save-btn" style={{ width: 'auto', padding: '8px 16px' }}>
              ⬇ 다운로드 (PDF로 저장)
            </button>
          </div>

          <div className="kyn-print-report" style={{ border: '1px solid var(--line)', background: 'var(--bg)', padding: 20 }}>
            <div style={{ marginBottom: 20, paddingBottom: 12, borderBottom: '2px solid var(--ink)' }}>
              <div style={{ fontSize: 11, letterSpacing: '0.14em', color: 'var(--gold-deep)' }}>KYN COMPREHENSIVE ROADMAP</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--ink)' }}>{scenario.label} — 종합 실행 로드맵</div>
              <div style={{ fontSize: 11.5, color: 'var(--ink-faint)' }}>작성일 {today} · 본 문서는 의사결정 보조 자료이며 세무사·법무사 확인 후 실행하십시오.</div>
            </div>

            <RoadmapSection title="1. 자산 평가방법 판단 (시가 vs 공시가격 vs 감정평가)">
              <p>상증세법 §60은 <strong>시가 평가가 원칙</strong>입니다. 공시가격(기준시가)은 시가 산정이 어려운 경우(유사 매매사례가액이 없는 경우)에만 보충적으로 사용할 수 있습니다.</p>
              {valuationGapNote && <p style={{ marginTop: 6 }}>{valuationGapNote}</p>}
              <ul style={{ paddingLeft: 18, marginTop: 6 }}>
                <li>고가 부동산이거나 국세청이 감정평가를 의뢰하는 경우, 공시가 신고가 추후 시가로 경정될 수 있습니다 (평가심의위원회 대상 여부 확인 필요).</li>
                <li>공시가로 신고 시 세금은 낮아지지만, <strong>2년 내 유사 매매사례가 발생하면 국세청이 시가로 재산정</strong>할 수 있습니다 — 세무사 확인 필수.</li>
                <li>감정평가를 직접 받아 신고하면 평가 비용(통상 100~300만원)은 들지만 추후 경정 리스크를 줄일 수 있습니다.</li>
              </ul>
              <p style={{ color: 'var(--red)', marginTop: 6 }}>⚠ 이 판단은 자산 종류·규모·거래 시점에 따라 달라지므로 반드시 세무사와 사전 협의하십시오. 확정된 법적 결론이 아닙니다.</p>
            </RoadmapSection>

            <RoadmapSection title="2. 거주자 / 비거주자 판정 체크리스트">
              <p>소득세법상 거주자 여부는 세율·공제·연대납세의무에 영향을 줍니다. 특히 유학 중인 자녀가 있다면 반드시 확인이 필요합니다.</p>
              <ul style={{ paddingLeft: 18, marginTop: 6 }}>
                <li>국내에 주소를 두거나 183일 이상 거소를 둔 경우 거주자로 판정 (소득세법 §1의2) — 유학 기간·체류일수 확인 필요.</li>
                <li><strong>비거주자가 증여받는 경우</strong>: 국내 소재 재산에 대해서는 동일하게 증여세 과세되나, 증여자가 연대납세의무를 지는 범위가 달라질 수 있습니다.</li>
                <li>유학 자녀가 비거주자로 분류되면 해외 계좌로의 송금이 자금출처조사 시 별도 소명 대상이 될 수 있습니다.</li>
              </ul>
              <p style={{ color: 'var(--red)', marginTop: 6 }}>⚠ KYN은 실제 체류일수·비자 종류를 알 수 없어 자동 판정하지 않습니다. 세무사에게 정확한 거주자 판정을 받으십시오.</p>
            </RoadmapSection>

            {target && (
              <RoadmapSection title="3. 부담부증여 + 근저당 구조">
                <p>{target.name} (시가 {fmt(target.current_value)}, 기존 대출 {fmt(target.loan_amount)})을 부담부증여로 이전하는 경우의 표준 절차입니다.</p>
                <ol style={{ paddingLeft: 18, marginTop: 6 }}>
                  <li>증여 전, 현 소유자 명의로 은행 담보대출 실행 (근저당 설정) — 자금 출처가 명확한 은행 대출을 우선 사용합니다.</li>
                  <li>채무 승계 조건으로 부담부증여 — 채무 비율만큼 양도세, 나머지는 증여세로 분리 과세 (소득세법 시행령 §159).</li>
                  <li>수증자가 실제 채무 상환능력(소득·재산)을 증빙할 수 있어야 채무 인수가 인정됩니다 — 증빙 없으면 전액 증여로 재구성됩니다.</li>
                  <li>가족 간 근저당(사금융)은 실질과세 원칙상 국세청이 우회 증여로 의심할 위험이 큽니다. <strong>은행 대출을 우선 사용</strong>하고, 가족 간 자금은 대출금 재배분(무이자 차용) 형태로 사용하는 것이 안전합니다.</li>
                </ol>
                <p style={{ marginTop: 6 }}>'부담부' 시나리오(부담부증여 혼합) 탭에서 이 자산 기준 구체적 세액을 계산할 수 있습니다.</p>
              </RoadmapSection>
            )}

            <RoadmapSection title="4. 향후 현금유출(유학비 등) 커버 계획">
              <div className="no-print" style={{ display: 'flex', gap: 12, marginBottom: 10, flexWrap: 'wrap' }}>
                <label style={{ fontSize: 12 }}>연간 유학비(억)
                  <input type="number" value={studyAbroadAnnual} min={0} step={0.1}
                    onChange={e => setStudyAbroadAnnual(Math.max(0, Number(e.target.value)))}
                    style={{ marginLeft: 6, width: 70, border: '1px solid var(--line-strong)', padding: '2px 6px' }} />
                </label>
                <label style={{ fontSize: 12 }}>기간(년)
                  <input type="number" value={studyAbroadYears} min={1} step={1}
                    onChange={e => setStudyAbroadYears(Math.max(1, Number(e.target.value)))}
                    style={{ marginLeft: 6, width: 60, border: '1px solid var(--line-strong)', padding: '2px 6px' }} />
                </label>
              </div>
              {studyAbroadTotal > 0 && recipient && loanPlan ? (
                <>
                  <p>총 필요 자금: <strong>{fmt(studyAbroadTotal)}</strong> ({fmt(studyAbroadAnnual)}/년 × {studyAbroadYears}년), 수증자: {recipient.name}</p>
                  <ul style={{ paddingLeft: 18, marginTop: 6 }}>
                    <li>인별 무이자 차용 한도는 약 <strong>{interestFreeLimit.toFixed(2)}억</strong>입니다 (적정이자 4.6%와 실제이자 차액이 연 1천만원 미만이면 증여로 보지 않음, 상증세법 §41의4).</li>
                    {loanPlan.allocations.map(a => (
                      <li key={a.name}>{a.name}: {fmt(a.principal)} — {a.interestFree ? '무이자 차용증 가능' : `한도 초과분 ${fmt(a.excessOverLimit)}은 연 4.6% 이자 수취 필요`}</li>
                    ))}
                  </ul>
                  <p style={{ marginTop: 6 }}>차용증에 <strong>만기·상환방법을 반드시 명시</strong>하고, 실제 유학비 송금 내역(계좌 분리·영수증)을 보관해야 국세청이 명목상 증여로 재구성하지 않습니다.</p>
                </>
              ) : (
                <p>연간 유학비와 기간을 입력하면 무이자 차용 가능 금액과 배분 계획이 계산됩니다.</p>
              )}
            </RoadmapSection>

            <RoadmapSection title="5. 법인 설립 타이밍 판단">
              {corpWorthReviewing ? (
                <>
                  <p>연 임대수익 합계가 {fmt(annualRentalTotal)}으로 법인 전환 효과를 검토할 가치가 있습니다 (수익형 자산 {incomeAssetCount}개).</p>
                  <ul style={{ paddingLeft: 18, marginTop: 6 }}>
                    <li>조특법§119에 따른 부동산 현물출자 취득세 50% 감면은 <strong>2027.12.31까지</strong> 적용 — 이후엔 감면 없이 취득세 전액 부담.</li>
                    <li>법인세율(과표 2억 이하 9%~19%대) vs 개인 종합소득세 최고세율(45%) 격차가 클수록 유리합니다.</li>
                    <li>배당 시 이중과세(법인세+배당소득세)가 발생하므로, 대표이사 급여로 비용 처리하는 구조 설계가 필요합니다.</li>
                  </ul>
                  <p style={{ marginTop: 6 }}>'법인' 탭에서 이 가족 조건 기준 구체적 절세 효과를 비교하십시오.</p>
                </>
              ) : (
                <p>현재 임대수익 규모({fmt(annualRentalTotal)}) 또는 수익형 자산 수({incomeAssetCount}개)가 법인 전환 이점을 보기엔 작습니다. 임대소득이 연 5천만원(0.5억)을 넘으면 재검토를 권장합니다.</p>
              )}
            </RoadmapSection>

            {target && (
              <RoadmapSection title="6. 건물 보유 + 대출로 추가 매입 (재투자) 시뮬레이션">
                <p>{target.name}을 매각하지 않고 보유하면서, 추가 담보대출로 오피스텔 등을 매입하는 경우의 취득세·이자 부담입니다.</p>
                <div className="no-print" style={{ marginBottom: 10 }}>
                  <label style={{ fontSize: 12 }}>추가 매입 예정가(억, 미입력 시 대출여력 자동 산정)
                    <input type="number" value={reinvestPurchasePrice || ''} min={0} step={0.5} placeholder={availableLoanRoom.toFixed(1)}
                      onChange={e => setReinvestPurchasePrice(Math.max(0, Number(e.target.value)))}
                      style={{ marginLeft: 6, width: 90, border: '1px solid var(--line-strong)', padding: '2px 6px' }} />
                  </label>
                </div>
                {purchasePrice > 0 ? (
                  <ul style={{ paddingLeft: 18 }}>
                    <li>{target.name} LTV 40% 기준 추가 대출여력: 약 <strong>{fmt(availableLoanRoom)}</strong></li>
                    <li>매입가 {fmt(purchasePrice)} 기준 취득세(오피스텔, 일반매매): <strong>{fmt(reinvestAcqTax)}</strong> (취득세+농특세+지방교육세 근사)</li>
                    <li>신규 대출 전액 조달 시 연 이자 부담: 약 <strong>{fmt(reinvestAnnualInterest)}</strong>/년 (기준금리 {m.base_rate_pct}% 가정)</li>
                    <li>기존 자산의 DSCR·LTV가 추가 대출 후에도 금융기관 심사 기준(통상 DSCR 1.0 이상)을 충족하는지 은행 사전 상담 필요.</li>
                  </ul>
                ) : (
                  <p>대상 부동산에 여유 담보 여력이 없거나 추가 매입 계획이 없습니다.</p>
                )}
              </RoadmapSection>
            )}

            <RoadmapSection title="7. 종합 리스크 및 필수 확인사항">
              <ul style={{ paddingLeft: 18 }}>
                {feasibility.reasons.map(r => <li key={r} style={{ color: 'var(--red)' }}>{r}</li>)}
                <li>모든 세액은 추정치이며 실제 신고 시 감정평가·유사매매사례·세법 개정에 따라 달라질 수 있습니다.</li>
                <li>가족 간 자금 이동은 반드시 계약서(차용증·증여계약서)와 실제 송금 기록을 남겨야 합니다.</li>
                <li>본 로드맵은 세무사·법무사의 전문 자문을 대체하지 않습니다.</li>
              </ul>
            </RoadmapSection>
          </div>
        </div>
      )}
    </div>
  );
}

// ── SVG Chart ─────────────────────────────────────────────────

const SCENARIO_COLORS: Record<string, string> = {
  s1: '#9ca3af', s2: '#3b82f6', s3: '#6366f1',
  s4: '#a855f7', s5: '#22c55e', s6: '#f97316', s7: '#14b8a6', s8: '#10b981',
  s9: '#0d9488',
};

const SAVED_SCENARIO_COLORS = [
  '#9a7a25',
  '#405170',
  '#9a5a35',
  '#5d735f',
  '#765b7c',
  '#3e716e',
  '#8a5b52',
  '#6c6575',
];

function getScenarioColor(id: string) {
  if (SCENARIO_COLORS[id]) return SCENARIO_COLORS[id];

  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) >>> 0;
  }
  return SAVED_SCENARIO_COLORS[hash % SAVED_SCENARIO_COLORS.length];
}

function buildSavedScenarioLabels(
  items: Array<{ id: string; scenarioType?: SavedScenarioType }>,
) {
  const counts = new Map<SavedScenarioType, number>();
  const seen = new Map<SavedScenarioType, number>();

  items.forEach((item) => {
    const type = item.scenarioType ?? '균형형';
    counts.set(type, (counts.get(type) ?? 0) + 1);
  });

  return new Map(
    items.map((item) => {
      const type = item.scenarioType ?? '균형형';
      const index = (seen.get(type) ?? 0) + 1;
      seen.set(type, index);
      return [item.id, (counts.get(type) ?? 0) > 1 ? `${type} ${index}` : type];
    }),
  );
}

function NetWealthChart({
  scenarios, years, selectedId,
}: {
  scenarios: ScenarioCalc[];
  years: number[];
  selectedId: string;
}) {
  const W = 600, H = 240;
  const PAD = { top: 20, right: 20, bottom: 40, left: 70 };
  const cW = W - PAD.left - PAD.right;
  const cH = H - PAD.top - PAD.bottom;

  const standardScenarios = scenarios.filter(s => s.id !== 'all');
  const allValues = standardScenarios.flatMap(s => s.snapshots.map(snap => snap.netWealthIfInheritNow));
  const maxV = Math.max(...allValues, 1);
  const minV = Math.min(0, ...allValues);
  const range = maxV - minV || 1;

  function xPos(yearIdx: number) { return PAD.left + (yearIdx / (years.length - 1)) * cW; }
  function yPos(val: number) { return PAD.top + (1 - (val - minV) / range) * cH; }

  const yTicks = 4;
  const tickStep = range / yTicks;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
      {/* Grid lines + Y labels */}
      {Array.from({ length: yTicks + 1 }).map((_, i) => {
        const val = minV + tickStep * i;
        const y = yPos(val);
        return (
          <g key={i}>
            <line x1={PAD.left} y1={y} x2={W - PAD.right} y2={y} stroke="#f3f4f6" strokeWidth={1} />
            <text x={PAD.left - 6} y={y + 4} textAnchor="end" fontSize={10} fill="#9ca3af">
              {Math.round(val)}
            </text>
          </g>
        );
      })}
      {/* Zero line */}
      {minV < 0 && (
        <line x1={PAD.left} y1={yPos(0)} x2={W - PAD.right} y2={yPos(0)} stroke="#ef4444" strokeWidth={1} strokeDasharray="4,3" />
      )}
      {/* X axis labels */}
      {years.map((yr, i) => (
        <text key={yr} x={xPos(i)} y={H - PAD.bottom + 16} textAnchor="middle" fontSize={10} fill="#9ca3af">
          {yr === 0 ? '현재' : `${yr}년`}
        </text>
      ))}
      {/* Scenario lines */}
      {standardScenarios.map(s => {
        const pts = s.snapshots.map((snap, i) => `${xPos(i)},${yPos(snap.netWealthIfInheritNow)}`).join(' ');
        const isSelected = s.id === selectedId;
        return (
          <polyline key={s.id} points={pts} fill="none"
            stroke={getScenarioColor(s.id)} strokeWidth={isSelected ? 3 : 1.5}
            strokeOpacity={isSelected ? 1 : 0.30}
          />
        );
      })}
      {/* Dots for selected scenario */}
      {standardScenarios.filter(s => s.id === selectedId).map(s =>
        s.snapshots.map((snap, i) => (
          <circle key={i} cx={xPos(i)} cy={yPos(snap.netWealthIfInheritNow)} r={4}
            fill={getScenarioColor(s.id)} />
        ))
      )}
      {/* Y axis label */}
      <text x={12} y={PAD.top + cH / 2} textAnchor="middle" fontSize={9} fill="#9ca3af"
        transform={`rotate(-90, 12, ${PAD.top + cH / 2})`}>
        억원
      </text>
    </svg>
  );
}

// ── Param Panel ───────────────────────────────────────────────

function Slider({ label, value, min, max, step = 1, onChange }: {
  label: string; value: number; min: number; max: number; step?: number;
  onChange: (v: number) => void;
}) {
  const unit = label.includes('억') ? '억' : '%';
  const displayValue = Number.isInteger(value) ? value : value.toFixed(1);
  return (
    <div className="slp-slider">
      <div className="slp-slider-head">
        <span className="slp-slider-label">{label}</span>
        <span className="slp-slider-value">
          {displayValue}<small>{unit}</small>
        </span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(Number(e.target.value))} />
      <div className="srange">
        <span>{min}{unit}</span>
        <span>{max}{unit}</span>
      </div>
    </div>
  );
}

function IntensityPicker({ value, onChange }: {
  value: 'conservative' | 'moderate' | 'aggressive';
  onChange: (v: 'conservative' | 'moderate' | 'aggressive') => void;
}) {
  const opts: Array<{ v: 'conservative' | 'moderate' | 'aggressive'; label: string; desc: string }> = [
    { v: 'conservative', label: '보수', desc: '공제한도만' },
    { v: 'moderate', label: '중간', desc: '한도+20%' },
    { v: 'aggressive', label: '적극', desc: '한도+50%' },
  ];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div className="flab">증여 강도</div>
      <div style={{ display: 'flex', gap: 4 }}>
        {opts.map(o => (
          <button key={o.v} onClick={() => onChange(o.v)}
            style={{
              flex: 1,
              padding: '8px 4px',
              fontSize: 12,
              fontWeight: 600,
              border: '1px solid var(--line-strong)',
              background: value === o.v ? 'var(--ink)' : 'var(--bg)',
              color: value === o.v ? '#F2EFE7' : 'var(--ink-soft)',
              cursor: 'pointer',
              textAlign: 'center',
            }}>
            <div>{o.label}</div>
            <div style={{ fontSize: 11, opacity: 0.7 }}>{o.desc}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

// ── 최적 전략 패널 ────────────────────────────────────────────

// ── 최적 전략 탭: 백엔드(Python) 실현가능성·세무상설명부담 점수 연결 ──
// 기존 calcOptimalStrategy()는 이 값들을 계산하지 않으므로, 이미 산출된 증여 계획을
// backend/(FastAPI)로 보내 별도 계산 후 결과만 추가로 붙인다. 백엔드가 꺼져 있으면
// 에러 메시지만 표시하고 나머지 화면은 그대로 정상 작동한다.
//
// STEP 2의 모든 시나리오는 각자 다른 재원 구성(증여비중/현금·대출비중/법인전환/
// 공익법인)을 가질 수 있으므로, 이 패널은 특정 시나리오 타입에 묶이지 않고
// 호출자가 만든 request 하나만 받는다 — "최적 전략"(계산된 OptimalStrategyResult
// 기반) 뿐 아니라 "직접 설계"(S7, 법인·공익법인·대출 슬라이더를 직접 조절)에서도
// 그대로 재사용해서, 옵션을 바꾸면 리스크 점수도 실제로 바뀌게 한다.
function BackendRiskPanel({
  request, onResult,
}: {
  request: ImmediateGiftScenarioRequest | null;
  onResult?: (r: SynthesisRiskInput | null) => void;
}) {
  const [state, setState] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle');
  const [scenario, setScenario] = useState<Awaited<ReturnType<typeof buildImmediateGiftScenario>> | null>(null);
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    if (!request || request.recipients.length === 0) { setState('idle'); onResult?.(null); return; }
    let cancelled = false;
    setState('loading');
    buildImmediateGiftScenario(request).then(s => {
      if (cancelled) return;
      setScenario(s);
      setState('ok');
      onResult?.({
        feasibilityScore: s.feasibility_score?.total_score ?? null,
        feasibilityGrade: s.feasibility_score?.grade ?? null,
        hardBlocked: s.feasibility_score?.hard_blocked ?? false,
        topConstraint: s.feasibility_score?.top_constraints?.[0] ?? s.feasibility_score?.hard_block_reasons?.[0] ?? null,
        riskScore: s.tax_review_risk?.overall_risk_score ?? null,
        riskGrade: s.tax_review_risk?.grade ?? null,
        topDriver: s.tax_review_risk?.drivers?.[0] ?? null,
      });
    }).catch(e => {
      if (cancelled) return;
      setErrorMsg(e instanceof Error ? e.message : String(e));
      setState('error');
      onResult?.(null);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  if (state === 'idle') return null;

  if (state === 'loading') {
    return (
      <div className="card-kyn" style={{ padding: '14px 24px', fontSize: 12.5, color: 'var(--ink-faint)' }}>
        실현 가능성·세무상 설명부담 계산 중...
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div style={{ border: '1px solid var(--red)', background: 'var(--red-tint)', padding: '14px 24px', fontSize: 12.5, color: 'var(--red)' }}>
        실현 가능성·세무상 설명부담 계산 실패 — 백엔드(backend/, FastAPI)가 실행 중인지 확인하세요.
        <div style={{ fontSize: 11, marginTop: 4, opacity: 0.8 }}>{errorMsg}</div>
      </div>
    );
  }

  if (!scenario) return null;
  const feas = scenario.feasibility_score;
  const risk = scenario.tax_review_risk;

  return (
    <div className="card-kyn">
      <div className="card-head">
        <div>
          <div className="crumb" style={{ marginBottom: 8 }}>RISK ENGINE</div>
          <div className="t">실현 가능성 · 세무상 설명부담
            <span className="sub">이 증여 계획을 실제 실행할 수 있는지 백엔드에서 별도 채점합니다.</span>
          </div>
        </div>
      </div>
      <div className="mini" style={{ gridTemplateColumns: '1fr 1fr' }}>
        {feas && (
          <div>
            <div className="l">실현 가능성</div>
            <div className="n" style={{ color: feas.hard_blocked ? 'var(--red)' : 'var(--ink)' }}>
              {feas.total_score.toFixed(0)}점 <span style={{ fontSize: 13, fontWeight: 500 }}>({feas.grade})</span>
            </div>
            {feas.top_constraints.slice(0, 3).map(c => (
              <div key={c} style={{ fontSize: 11.5, color: 'var(--ink-faint)', marginTop: 6, fontWeight: 400 }}>· {c}</div>
            ))}
          </div>
        )}
        {risk && (
          <div>
            <div className="l">세무상 설명부담</div>
            <div className="n">
              {risk.overall_risk_score.toFixed(0)}점 <span style={{ fontSize: 13, fontWeight: 500 }}>({risk.grade})</span>
            </div>
            {risk.drivers.slice(0, 3).map(d => (
              <div key={d} style={{ fontSize: 11.5, color: 'var(--ink-faint)', marginTop: 6, fontWeight: 400 }}>· {d}</div>
            ))}
            <div style={{ fontSize: 10, color: 'var(--ink-faint)', marginTop: 8 }}>{risk.disclaimer}</div>
          </div>
        )}
      </div>
      {scenario.rejected && (
        <div style={{ padding: '12px 24px', borderTop: '1px solid var(--line)', background: 'var(--red-tint)', color: 'var(--red)', fontSize: 12 }}>
          하드 탈락 — {scenario.rejection_reasons.join(' / ')}
        </div>
      )}
    </div>
  );
}

// S7("직접 설계")의 증여·대출 옵션을 실행하기 전/후로 가족 대차대조표(D/E·LTV·순자산)가
// 어떻게 바뀌는지 같은 balance-sheet 엔진(Phase 2)으로 계산해서 보여준다. 세금·리스크뿐
// 아니라 레버리지 구조까지 "이 옵션을 고르면" 한 번에 보이게 하는 게 목적.
// 실행계획 → 리스크 → 레버리지 → 종합리포트를 번호 매긴 하나의 흐름으로 보이게
// 세로선으로 잇는다. 항목이 시나리오마다 달라도(리스크/레버리지는 일부만 표시)
// 번호가 항상 1부터 순서대로 매겨지도록 렌더된 항목 기준으로 다시 센다.
// 세금·리스크·레버리지·자산배분을 사람이 4개 패널을 다 읽고 종합하지 않아도 되게,
// 규칙 기반으로 한 문단 요약을 생성한다 (외부 LLM 호출 없음 — 비용 0, 즉시 응답).
function ScenarioSummaryCard({
  scenario, risk, leverage,
}: {
  scenario: SynthesisScenarioInput;
  risk: SynthesisRiskInput | null;
  leverage: SynthesisLeverageInput | null;
}) {
  const sentences = synthesizeScenarioSummary(scenario, risk, leverage);
  return (
    <div className="card-kyn" style={{ borderColor: 'var(--gold)' }}>
      <div className="card-head">
        <div>
          <div className="crumb" style={{ marginBottom: 8 }}>RULE-BASED SUMMARY</div>
          <div className="t">종합 요약
            <span className="sub">위 실행계획·리스크·레버리지를 하나로 합친 요약입니다</span>
          </div>
        </div>
      </div>
      <div style={{ padding: '4px 24px 20px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {sentences.map((s, i) => (
          <p
            key={i}
            style={{
              margin: 0, fontSize: 13, lineHeight: 1.7,
              color: i === sentences.length - 1 ? 'var(--gold-deep)' : 'var(--ink-soft)',
              fontWeight: i === sentences.length - 1 ? 700 : 400,
            }}
          >
            {s}
          </p>
        ))}
      </div>
    </div>
  );
}

function FlowSteps({ items }: { items: Array<{ key: string; label: string; sub: string; node: React.ReactNode }> }) {
  return (
    <div style={{ marginTop: 16, position: 'relative' }}>
      <div style={{ position: 'absolute', left: 10, top: 20, bottom: 20, width: 1, background: 'var(--line-strong)' }} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
        {items.map((item, i) => (
          <div key={item.key} style={{ position: 'relative', paddingLeft: 32 }}>
            <div style={{
              position: 'absolute', left: 0, top: 1, width: 21, height: 21,
              border: '1px solid var(--gold)', background: 'var(--bg)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 11, fontWeight: 700, color: 'var(--gold-deep)', zIndex: 1,
            }}>
              {i + 1}
            </div>
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)' }}>{item.label}</div>
              <div style={{ fontSize: 11.5, color: 'var(--ink-faint)', marginTop: 1 }}>{item.sub}</div>
            </div>
            {item.node}
          </div>
        ))}
      </div>
    </div>
  );
}

function S7BalanceSheetImpact({
  inputs, onResult,
}: {
  inputs: { before: { assets: unknown[]; debts: unknown[] }; after: { assets: unknown[]; debts: unknown[] } } | null;
  onResult?: (r: SynthesisLeverageInput | null) => void;
}) {
  const [state, setState] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle');
  const [before, setBefore] = useState<BalanceSheetMetricsResponse | null>(null);
  const [after, setAfter] = useState<BalanceSheetMetricsResponse | null>(null);
  const [allocBefore, setAllocBefore] = useState<PortfolioAllocationResultResponse | null>(null);
  const [allocAfter, setAllocAfter] = useState<PortfolioAllocationResultResponse | null>(null);
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    if (!inputs) { setState('idle'); onResult?.(null); return; }
    let cancelled = false;
    setState('loading');
    const today = new Date().toISOString().slice(0, 10);

    function weightsFromCategories(byCategory: Record<string, string>): Partial<Record<AssetCategory, number>> {
      const total = Object.values(byCategory).reduce((s, v) => s + Number(v), 0);
      const weights: Partial<Record<AssetCategory, number>> = {};
      for (const [cat, v] of Object.entries(byCategory)) {
        weights[cat as AssetCategory] = total > 0 ? Number(v) / total : 0;
      }
      return weights;
    }

    Promise.all([
      computeBalanceSheet({ ...inputs.before, as_of: today } as BalanceSheetRequest),
      computeBalanceSheet({ ...inputs.after, as_of: today } as BalanceSheetRequest),
    ]).then(([b, a]) => {
      if (cancelled) return null;
      setBefore(b.metrics);
      setAfter(a.metrics);
      return Promise.all([
        computePortfolioMetrics({
          weights: weightsFromCategories(b.balance_sheet.assets_by_category as unknown as Record<string, string>),
          assumptions: ALLOCATION_ASSUMPTIONS as unknown as import('@/lib/kyn-backend').AssetClassAssumption[],
        }),
        computePortfolioMetrics({
          weights: weightsFromCategories(a.balance_sheet.assets_by_category as unknown as Record<string, string>),
          assumptions: ALLOCATION_ASSUMPTIONS as unknown as import('@/lib/kyn-backend').AssetClassAssumption[],
        }),
      ]).then(([ab, aa]) => ({ b: b.metrics, a: a.metrics, ab, aa }));
    }).then(res => {
      if (cancelled || !res) return;
      const { b, a, ab, aa } = res;
      setAllocBefore(ab);
      setAllocAfter(aa);
      setState('ok');
      onResult?.({
        ltvBeforePct: b.ltv ?? null, ltvAfterPct: a.ltv ?? null,
        netWorthBefore: Number(b.net_worth ?? 0), netWorthAfter: Number(a.net_worth ?? 0),
        expectedReturnBeforePct: ab.expected_total_return_pct, expectedReturnAfterPct: aa.expected_total_return_pct,
      });
    }).catch(e => {
      if (cancelled) return;
      setErrorMsg(e instanceof Error ? e.message : String(e));
      setState('error');
      onResult?.(null);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputs]);

  if (state === 'idle') return null;
  if (state === 'loading') {
    return (
      <div className="card-kyn" style={{ padding: '14px 24px', fontSize: 12.5, color: 'var(--ink-faint)' }}>
        레버리지 영향 계산 중...
      </div>
    );
  }
  if (state === 'error') {
    return (
      <div style={{ border: '1px solid var(--red)', background: 'var(--red-tint)', padding: '14px 24px', fontSize: 12.5, color: 'var(--red)' }}>
        레버리지 영향 계산 실패 — 백엔드가 실행 중인지 확인하세요.
        <div style={{ fontSize: 11, marginTop: 4, opacity: 0.8 }}>{errorMsg}</div>
      </div>
    );
  }
  if (!before || !after) return null;

  const rows: Array<{ label: string; b: string; a: string; warn: boolean }> = [
    {
      label: '순자산', b: `${fmt(Number(before.net_worth))}`, a: `${fmt(Number(after.net_worth))}`,
      warn: Number(after.net_worth) < Number(before.net_worth) * 0.9,
    },
    {
      label: 'D/E', b: before.debt_to_equity != null ? before.debt_to_equity.toFixed(2) : '—',
      a: after.debt_to_equity != null ? after.debt_to_equity.toFixed(2) : '—',
      warn: (after.debt_to_equity ?? 0) > (before.debt_to_equity ?? 0) + 0.3,
    },
    {
      label: 'LTV', b: before.ltv != null ? `${(before.ltv * 100).toFixed(0)}%` : '—',
      a: after.ltv != null ? `${(after.ltv * 100).toFixed(0)}%` : '—',
      warn: (after.ltv ?? 0) > 0.6,
    },
    {
      label: '유동자산 비율', b: `${(before.liquid_asset_ratio * 100).toFixed(0)}%`,
      a: `${(after.liquid_asset_ratio * 100).toFixed(0)}%`, warn: false,
    },
    ...(allocBefore && allocAfter ? [
      {
        label: '기대 총수익률(ASSUMED)',
        b: `${(allocBefore.expected_total_return_pct * 100).toFixed(2)}%`,
        a: `${(allocAfter.expected_total_return_pct * 100).toFixed(2)}%`,
        warn: false,
      },
      {
        label: '포트폴리오 유동성',
        b: allocBefore.liquidity_score.toFixed(2),
        a: allocAfter.liquidity_score.toFixed(2),
        warn: allocAfter.liquidity_score < allocBefore.liquidity_score - 0.15,
      },
    ] : []),
  ];

  return (
    <div className="card-kyn" style={{ marginTop: 12 }}>
      <div className="card-head">
        <div>
          <div className="crumb" style={{ marginBottom: 8 }}>LEVERAGE · ALLOCATION ENGINE</div>
          <div className="t">실행 전/후 대차대조표 · 포트폴리오
            <span className="sub">증여·대출·법인전환·공익법인을 실행하면 가족 전체 레버리지·자산배분이 이렇게 바뀝니다</span>
          </div>
        </div>
      </div>
      <div style={{ padding: '4px 24px 18px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr repeat(2, 90px)', gap: 4, fontSize: 12.5 }}>
          <div />
          <div style={{ textAlign: 'right', color: 'var(--ink-faint)', fontSize: 11 }}>지금</div>
          <div style={{ textAlign: 'right', color: 'var(--ink-faint)', fontSize: 11 }}>실행 후</div>
          {rows.map(r => (
            <div key={r.label} style={{ display: 'contents' }}>
              <div style={{ padding: '6px 0', borderTop: '1px solid var(--line)' }}>{r.label}</div>
              <div style={{ padding: '6px 0', borderTop: '1px solid var(--line)', textAlign: 'right', color: 'var(--ink-faint)' }}>{r.b}</div>
              <div style={{ padding: '6px 0', borderTop: '1px solid var(--line)', textAlign: 'right', fontWeight: 700, color: r.warn ? 'var(--red)' : 'var(--ink)' }}>{r.a}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function OptimalBackendRiskPanel({
  result, onResult,
}: {
  result: OptimalStrategyResult;
  onResult?: (r: SynthesisRiskInput | null) => void;
}) {
  const request: ImmediateGiftScenarioRequest | null = useMemo(() => {
    if (result.giftPlans.length === 0) return null;
    return {
      donor_id: 'owner',
      family_total_assets: result.totalEstateNow,
      // 순수 현금만 CASH_ON_HAND로 전달 — 대출 재원은 아래 별도 필드로 넘겨서
      // 백엔드가 재원별 확실성(현금 100% vs 대출 40~70%)을 다르게 채점하게 한다.
      available_cash: result.funding.recipientCashUsedForGiftTax,
      family_loan_amount: result.funding.familyLoanForGiftTax,
      bank_loan_amount: result.funding.bankLoanForGiftTax,
      bank_loan_annual_interest: result.funding.bankLoanAnnualInterestForGiftTax,
      recipients: result.giftPlans.map(p => ({
        person_id: p.memberId, relation: p.relation, gift_amount: p.giftAmount, is_adult: true,
      })),
      event_date: new Date().toISOString().slice(0, 10),
    };
  }, [
    result.totalEstateNow,
    result.funding.recipientCashUsedForGiftTax,
    result.funding.familyLoanForGiftTax,
    result.funding.bankLoanForGiftTax,
    result.funding.bankLoanAnnualInterestForGiftTax,
    result.giftPlans,
  ]);
  return <BackendRiskPanel request={request} onResult={onResult} />;
}

// STEP 1(이전 계획)에서 배정한 자산별 수증자를 실제 계산에 반영하는 3단계 패널.
// S1~S9는 "만약 이렇게 하면"류 일반 템플릿이고, 이 패널만 사용자가 실제로
// 지정한 배정을 그대로 세금·재원조달까지 이어서 계산한다.
function MyAssignmentPanel({
  assets, members, assignmentPlans,
}: {
  assets: Asset[];
  members: FamilyMember[];
  assignmentPlans: Array<{ asset_id: string | null; to_member_id: string | null }>;
}) {
  const [stage, setStage] = useState<1 | 2 | 3>(1);
  const [state, setState] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle');
  const [result, setResult] = useState<MyAssignmentResultResponse | null>(null);
  const [errorMsg, setErrorMsg] = useState('');

  const assignedAssets = useMemo(() => {
    return assets
      .map(a => {
        const recipientIds = assignmentPlans
          .filter(p => p.asset_id === a.id && p.to_member_id)
          .map(p => p.to_member_id as string);
        if (recipientIds.length === 0) return null;
        return {
          asset_id: a.id,
          label: a.name,
          value: a.current_value,
          category: (KOREAN_TO_ASSET_CATEGORY[a.asset_type] ?? 'OTHER') as import('@/lib/kyn-backend').AssetCategory | 'OTHER',
          growth_rate_pct: a.expected_growth_pct ?? 2,
          loan_amount: a.loan_amount ?? 0,
          max_ltv_pct: 70,
          recipient_ids: recipientIds,
          liquidity_score_1to5: a.liquidity_score ?? null,
        };
      })
      .filter((a): a is NonNullable<typeof a> => a !== null);
  }, [assets, assignmentPlans]);

  const recipientMembers = useMemo(() => {
    const ids = new Set(assignedAssets.flatMap(a => a.recipient_ids));
    return members.filter(m => ids.has(m.id));
  }, [assignedAssets, members]);

  useEffect(() => {
    if (assignedAssets.length === 0 || recipientMembers.length === 0) { setState('idle'); return; }
    let cancelled = false;
    setState('loading');
    evaluateMyAssignment({
      assets: assignedAssets,
      recipients: recipientMembers.map(m => ({
        person_id: m.id, name: m.name, relation: m.relation,
        is_adult: m.age == null || m.age >= 19,
        is_generation_skip: m.relation === '손자녀',
      })),
      as_of: new Date().toISOString().slice(0, 10),
      projection_years: [0, 5, 10],
      max_split_shift_pct: 20,
    }).then(r => {
      if (cancelled) return;
      setResult(r);
      setState('ok');
    }).catch(e => {
      if (cancelled) return;
      setErrorMsg(e instanceof Error ? e.message : String(e));
      setState('error');
    });
    return () => { cancelled = true; };
  }, [assignedAssets, recipientMembers]);

  if (state === 'idle') {
    return (
      <div className="card-kyn" style={{ padding: '14px 24px', fontSize: 12.5, color: 'var(--ink-faint)' }}>
        아직 자산별 수증자 배정이 없습니다 — 계획 설정(STEP 1)에서 먼저 배정하세요.
      </div>
    );
  }
  if (state === 'loading') {
    return (
      <div className="card-kyn" style={{ padding: '14px 24px', fontSize: 12.5, color: 'var(--ink-faint)' }}>
        내 배정대로 계산 중...
      </div>
    );
  }
  if (state === 'error') {
    return (
      <div style={{ border: '1px solid var(--red)', background: 'var(--red-tint)', padding: '14px 24px', fontSize: 12.5, color: 'var(--red)' }}>
        계산 실패 — 백엔드(backend/, FastAPI)가 실행 중인지 확인하세요.
        <div style={{ fontSize: 11, marginTop: 4, opacity: 0.8 }}>{errorMsg}</div>
      </div>
    );
  }
  if (!result) return null;

  const stageData = stage === 1 ? result.stage1 : stage === 2 ? result.stage2 : null;

  return (
    <div className="card-kyn">
      <div className="card-head">
        <div>
          <div className="crumb" style={{ marginBottom: 8 }}>MY ASSIGNMENT · 3 STAGES</div>
          <div className="t">내 배정대로
            <span className="sub">계획 설정에서 지정한 자산별 수증자를 그대로 반영한 실제 계산</span>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', borderBottom: '1px solid var(--line)' }}>
        {([
          { id: 1, label: '1. 원안 그대로' },
          { id: 2, label: '2. 지분 조정안' },
          { id: 3, label: '3. 유동성 · 미래가치' },
        ] as const).map(s => (
          <button
            key={s.id}
            onClick={() => setStage(s.id)}
            style={{
              flex: 1, padding: '10px 8px', fontSize: 12.5, fontWeight: stage === s.id ? 700 : 500,
              color: stage === s.id ? 'var(--ink)' : 'var(--ink-faint)',
              background: stage === s.id ? 'var(--gold-tint)' : 'transparent',
              borderBottom: stage === s.id ? '2px solid var(--gold)' : '2px solid transparent',
              border: 'none', cursor: 'pointer',
            }}
          >
            {s.label}
          </button>
        ))}
      </div>

      {stageData && (
        <div style={{ padding: '18px 24px' }}>
          {stage === 2 && (
            <div style={{ marginBottom: 14, fontSize: 12.5, color: result.stage2_saving_vs_stage1 > 0.001 ? 'var(--green-ink)' : 'var(--ink-faint)' }}>
              {result.stage2_saving_vs_stage1 > 0.001
                ? `같은 수증자 구성을 유지한 채 자산별 지분율만 ±20%p 안에서 조정 — 원안 대비 증여세 ${result.stage2_saving_vs_stage1.toFixed(2)}억 절감`
                : '이 배정에서는 지분율만 조정해서는 더 줄일 여지가 없습니다 (원안이 이미 균형적).'}
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10, marginBottom: 16 }}>
            {stageData.recipients.map(r => (
              <div key={r.person_id} style={{ border: '1px solid var(--line)', padding: '10px 12px' }}>
                <div style={{ fontSize: 11.5, color: 'var(--ink-faint)' }}>{r.name} ({r.relation})</div>
                <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--ink)', marginTop: 4 }}>{fmt(r.total_gift_value)}</div>
                <div style={{ fontSize: 11.5, color: 'var(--red)', marginTop: 2 }}>증여세 {fmt(r.gift_tax)}</div>
              </div>
            ))}
            <div style={{ border: '1px solid var(--line-strong)', padding: '10px 12px', background: 'var(--paper-sink)' }}>
              <div style={{ fontSize: 11.5, color: 'var(--ink-faint)' }}>합계</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--ink)', marginTop: 4 }}>{fmt(stageData.total_gift_value)}</div>
              <div style={{ fontSize: 11.5, color: 'var(--red)', marginTop: 2 }}>증여세 {fmt(stageData.total_gift_tax)}</div>
            </div>
          </div>

          <div style={{ fontSize: 11, letterSpacing: '0.08em', color: 'var(--ink-faint)', marginBottom: 6 }}>자산별 지분</div>
          <div style={{ display: 'grid', gap: 4 }}>
            {assignedAssets.map(a => (
              <div key={a.asset_id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, padding: '4px 0', borderBottom: '1px solid var(--line)' }}>
                <span>{a.label} ({fmt(a.value)})</span>
                <span style={{ color: 'var(--ink-soft)' }}>
                  {Object.entries(stageData.splits[a.asset_id] ?? {}).map(([pid, pct]) => {
                    const m = recipientMembers.find(rm => rm.id === pid);
                    return `${m?.name ?? pid} ${pct.toFixed(0)}%`;
                  }).join(' · ')}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {stage === 3 && (
        <div style={{ padding: '0 24px 20px' }}>
          <div style={{ fontSize: 11, letterSpacing: '0.08em', color: 'var(--ink-faint)', margin: '4px 0 8px' }}>
            증여세 재원 우선순위 (유동성)
          </div>
          <div style={{ display: 'grid', gap: 4, marginBottom: 18 }}>
            {result.stage3_liquidity
              .slice()
              .sort((x, y) => y.liquidity_score - x.liquidity_score)
              .map(n => (
                <div key={n.asset_id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12.5, padding: '5px 0', borderBottom: '1px solid var(--line)' }}>
                  <span>{n.label}</span>
                  <span className="pill" style={{ color: n.recommended_for_tax_funding ? 'var(--green-ink)' : 'var(--ink-faint)' }}>
                    {n.recommended_for_tax_funding ? '재원 우선 활용 가능' : '비유동 — 매각/대출 필요'}
                  </span>
                </div>
              ))}
          </div>

          <div style={{ fontSize: 11, letterSpacing: '0.08em', color: 'var(--ink-faint)', marginBottom: 8 }}>
            미래가치 상승에 따른 담보대출 여력 변화
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--line-strong)' }}>
                  <th style={{ textAlign: 'left', padding: '6px 8px', color: 'var(--ink-faint)', fontWeight: 500 }}>자산</th>
                  {[0, 5, 10].map(y => (
                    <th key={y} style={{ textAlign: 'right', padding: '6px 8px', color: 'var(--ink-faint)', fontWeight: 500 }}>{y}년 후</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {assignedAssets.map(a => {
                  const rows = result.stage3_future.filter(p => p.asset_id === a.asset_id);
                  return (
                    <tr key={a.asset_id} style={{ borderBottom: '1px solid var(--line)' }}>
                      <td style={{ padding: '6px 8px' }}>{a.label}</td>
                      {[0, 5, 10].map(y => {
                        const row = rows.find(r => r.year === y);
                        return (
                          <td key={y} style={{ textAlign: 'right', padding: '6px 8px' }}>
                            <div>{row ? fmt(row.projected_value) : '—'}</div>
                            <div style={{ fontSize: 11, color: 'var(--ink-faint)' }}>
                              대출여력 {row ? fmt(row.ltv_borrowing_capacity) : '—'}
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div style={{ marginTop: 12, fontSize: 12, color: 'var(--ink-faint)', lineHeight: 1.6 }}>
            {result.stage3_note}
          </div>
        </div>
      )}
    </div>
  );
}

function OptimalStrategyPanel({
  result, ownCash, optCashOverride, onCashChange, dbCash,
  ltvMap, onLtvChange, onRiskResult,
}: {
  result: OptimalStrategyResult;
  ownCash: number;
  optCashOverride: number | null;
  onCashChange: (v: number | null) => void;
  dbCash: number;
  ltvMap: Record<string, number>;
  onLtvChange: (assetId: string, pct: number) => void;
  onRiskResult?: (r: SynthesisRiskInput | null) => void;
}) {
  const { funding } = result;
  const [ltvOpen, setLtvOpen] = useState(false);
  const [loanRate, setLoanRate] = useState(4.5); // 적용 금리 (%)

  const riskColor = funding.riskLevel === 'safe'
    ? 'bg-green-50 border-green-200 text-green-800'
    : funding.riskLevel === 'tight'
    ? 'bg-amber-50 border-amber-200 text-amber-800'
    : 'bg-red-50 border-red-200 text-red-800';

  const riskLabel = { safe: '✅ 안전', tight: '⚠ 빠듯', danger: '🚨 위험' }[funding.riskLevel];

  const categoryIcon: Record<string, string> = {
    gift: '🎁', loan: '🤝', corp: '🏢', foundation: '🏛', tax_payment: '📋',
  };

  // ── 현금흐름 기반 계산 ──────────────────────────────────────
  const annualRentalNet   = funding.accRentalAfterTax / 10;          // 피상속인 연 임대수익(세후)
  const giftTaxNeeded     = result.totalGiftTax;
  const cashForGiftTax    = Math.min(ownCash, giftTaxNeeded);        // 현금으로 낼 수 있는 증여세
  const giftTaxShortfall  = Math.max(0, giftTaxNeeded - ownCash);   // 현금 부족분
  const phase1Feasible    = giftTaxShortfall === 0;
  const yearsToSaveGiftTax = !phase1Feasible && annualRentalNet > 0
    ? Math.ceil(giftTaxShortfall / (annualRentalNet * 0.6)) : 0;    // 임대의 60% 적립 기준

  const inheritShortfall  = Math.max(0, -funding.surplus);           // 상속세 재원 부족분
  const inheritFeasible   = funding.surplus >= 0;
  const yearsToFillInherit = !inheritFeasible && annualRentalNet > 0
    ? Math.ceil(inheritShortfall / annualRentalNet) : 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* ── 현금 설정 바 ── */}
      <div style={{ border: '1px solid var(--line)', padding: '14px 20px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px 28px' }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--ink)', letterSpacing: '0.02em' }}>피상속인 보유 현금</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            type="number" step={0.5} min={0} max={100}
            value={optCashOverride !== null ? optCashOverride : dbCash}
            onChange={e => onCashChange(Number(e.target.value))}
            style={{ width: 72, border: '1px solid var(--line-strong)', padding: '4px 8px', fontSize: 13, fontWeight: 600, color: 'var(--ink)', background: 'var(--bg)', outline: 'none', fontFamily: 'var(--sans)' }}
          />
          <span style={{ fontSize: 12, color: 'var(--ink-faint)' }}>억</span>
          {optCashOverride !== null && (
            <button onClick={() => onCashChange(null)} style={{ fontSize: 11, color: 'var(--gold-deep)', textDecoration: 'underline', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'var(--sans)' }}>
              자동({dbCash.toFixed(1)}억)
            </button>
          )}
        </div>
        <div style={{ fontSize: 11, color: 'var(--ink-faint)' }}>
          가족정보의 본인·배우자 보유현금 합산 자동 적용 (현재 {dbCash.toFixed(1)}억)
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 20, fontSize: 11, color: 'var(--ink-faint)' }}>
          <span>피상속인 임대수익: <strong style={{ color: 'var(--ink)' }}>{annualRentalNet.toFixed(2)}억/년</strong></span>
          <span>증여세 필요: <strong style={{ color: 'var(--ink)' }}>{giftTaxNeeded.toFixed(2)}억</strong></span>
        </div>
      </div>

      {/* ── 실현 가능성·세무상 설명부담 (백엔드) ── */}
      <OptimalBackendRiskPanel result={result} onResult={onRiskResult} />

      {/* ── 실행 로드맵 ── */}
      <div className="card-kyn">
        <div className="card-head">
          <div>
            <div className="crumb" style={{ marginBottom: 8 }}>EXECUTION ROADMAP</div>
            <div className="t">3단계 실행 로드맵
              <span className="sub">현금 {ownCash.toFixed(1)}억 + 임대수익 {annualRentalNet.toFixed(2)}억/년 기준</span>
            </div>
          </div>
        </div>

        {/* Step 1 */}
        <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--paper-sink)', display: 'flex', gap: 16 }}>
          <div style={{ flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0 }}>
            <div style={{ width: 28, height: 28, background: phase1Feasible ? 'var(--ink)' : 'var(--line-strong)', color: 'var(--bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700 }}>1</div>
            <div style={{ width: 1, flex: 1, background: 'var(--line)', minHeight: 20 }} />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink)' }}>지금 — 증여 실행</span>
              {phase1Feasible
                ? <span style={{ fontSize: 10, background: 'var(--ink)', color: 'var(--bg)', padding: '1px 8px', letterSpacing: 0.5 }}>실행 가능</span>
                : <span style={{ fontSize: 10, background: 'var(--line-strong)', color: 'var(--ink-soft)', padding: '1px 8px', letterSpacing: 0.5 }}>현금 부족 — {yearsToSaveGiftTax}년 후 실행</span>}
            </div>
            <div style={{ display: 'flex', gap: 24, marginBottom: 8 }}>
              <div>
                <div style={{ fontSize: 9, letterSpacing: 1.5, color: 'var(--ink-faint)', textTransform: 'uppercase', marginBottom: 2 }}>보유 현금</div>
                <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--ink)' }}>{ownCash.toFixed(1)}억</div>
              </div>
              <div>
                <div style={{ fontSize: 9, letterSpacing: 1.5, color: 'var(--ink-faint)', textTransform: 'uppercase', marginBottom: 2 }}>증여세 납부</div>
                <div style={{ fontSize: 15, fontWeight: 600, color: giftTaxShortfall > 0 ? 'var(--red)' : 'var(--ink)' }}>
                  {giftTaxNeeded.toFixed(2)}억
                  {giftTaxShortfall > 0 && <span style={{ fontSize: 11, color: 'var(--red)', marginLeft: 4 }}>({giftTaxShortfall.toFixed(2)}억 부족)</span>}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 9, letterSpacing: 1.5, color: 'var(--ink-faint)', textTransform: 'uppercase', marginBottom: 2 }}>총 증여액</div>
                <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--gold)' }}>{result.totalGiftAmount.toFixed(1)}억</div>
              </div>
              <div>
                <div style={{ fontSize: 9, letterSpacing: 1.5, color: 'var(--ink-faint)', textTransform: 'uppercase', marginBottom: 2 }}>10년 상속세 절감</div>
                <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--green-ink)' }}>
                  {(result.inheritanceTaxAt10yr - result.inheritanceTaxAt10yrOptimized).toFixed(1)}억
                </div>
              </div>
            </div>
            {/* 수증자별 요약 */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {result.giftPlans.map(p => (
                <div key={p.memberId} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 11, color: 'var(--ink-soft)' }}>
                  <span style={{ width: 2, height: 2, borderRadius: '50%', background: 'var(--gold)', display: 'inline-block', flexShrink: 0 }} />
                  <span style={{ fontWeight: 600, color: 'var(--ink)' }}>{p.memberName}</span>
                  <span style={{ color: 'var(--ink-faint)' }}>{p.relation}</span>
                  <span style={{ color: 'var(--gold)', fontWeight: 600 }}>{p.assetName} {p.equityPct.toFixed(1)}%</span>
                  <span>→ {p.giftAmount.toFixed(1)}억 증여</span>
                  {p.giftTax === 0
                    ? <span style={{ color: 'var(--green-ink)', fontSize: 10 }}>증여세 0</span>
                    : <span style={{ color: 'var(--ink-faint)', fontSize: 10 }}>증여세 {p.giftTax.toFixed(2)}억</span>}
                </div>
              ))}
            </div>
            {!phase1Feasible && (
              <div style={{ marginTop: 8, fontSize: 11, color: 'var(--ink-faint)', background: 'var(--paper-sink)', padding: '6px 10px', borderLeft: '2px solid var(--line-strong)' }}>
                임대수익 {annualRentalNet.toFixed(2)}억/년의 60% 적립 기준 약 {yearsToSaveGiftTax}년 후 실행 가능.
                현재 현금 {ownCash.toFixed(1)}억으로는 공제 한도 내 무세 증여만 먼저 실행.
              </div>
            )}
          </div>
        </div>

        {/* Step 2 — 10년 후 공제 리셋 */}
        <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--paper-sink)', display: 'flex', gap: 16 }}>
          <div style={{ flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <div style={{ width: 28, height: 28, background: 'var(--ink-soft)', color: 'var(--bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700 }}>2</div>
            <div style={{ width: 1, flex: 1, background: 'var(--line)', minHeight: 20 }} />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink)' }}>10년 후 — 공제 리셋 2차 증여</span>
              <span style={{ fontSize: 10, background: 'var(--ink-soft)', color: 'var(--bg)', padding: '1px 8px', letterSpacing: 0.5 }}>계획</span>
            </div>
            <div style={{ display: 'flex', gap: 24, marginBottom: 6 }}>
              <div>
                <div style={{ fontSize: 9, letterSpacing: 1.5, color: 'var(--ink-faint)', textTransform: 'uppercase', marginBottom: 2 }}>예상 적립 현금</div>
                <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink)' }}>{(annualRentalNet * 10).toFixed(1)}억</div>
                <div style={{ fontSize: 10, color: 'var(--ink-faint)' }}>임대수익 10년 누적</div>
              </div>
              <div>
                <div style={{ fontSize: 9, letterSpacing: 1.5, color: 'var(--ink-faint)', textTransform: 'uppercase', marginBottom: 2 }}>공제한도 재사용</div>
                <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--gold)' }}>
                  {result.giftPlans.reduce((s, p) => s + p.deductionUsed, 0).toFixed(1)}억
                </div>
                <div style={{ fontSize: 10, color: 'var(--ink-faint)' }}>전 수증자 공제 초기화</div>
              </div>
              <div>
                <div style={{ fontSize: 9, letterSpacing: 1.5, color: 'var(--ink-faint)', textTransform: 'uppercase', marginBottom: 2 }}>10년 후 상속세</div>
                <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--red)' }}>{result.inheritanceTaxAt10yr.toFixed(1)}억</div>
                <div style={{ fontSize: 10, color: 'var(--ink-faint)' }}>현상유지 시</div>
              </div>
              <div>
                <div style={{ fontSize: 9, letterSpacing: 1.5, color: 'var(--ink-faint)', textTransform: 'uppercase', marginBottom: 2 }}>전략 후 상속세</div>
                <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--green-ink)' }}>{result.inheritanceTaxAt10yrOptimized.toFixed(1)}억</div>
                <div style={{ fontSize: 10, color: 'var(--ink-faint)' }}>증여 실행 시</div>
              </div>
            </div>
            <div style={{ fontSize: 11, color: 'var(--ink-faint)' }}>
              {result.useGenSkip ? '✅ 세대생략 포함 — ' : ''}{result.genSkipReason}
            </div>
          </div>
        </div>

        {/* Step 3 — 상속세 납부 */}
        <div style={{ padding: '14px 16px', display: 'flex', gap: 16 }}>
          <div style={{ flexShrink: 0 }}>
            <div style={{ width: 28, height: 28, background: inheritFeasible ? 'var(--green-ink)' : 'var(--red)', color: 'var(--bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700 }}>3</div>
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink)' }}>상속 발생 시 — 납부 계획</span>
              {inheritFeasible
                ? <span style={{ fontSize: 10, background: 'var(--green-ink)', color: 'var(--bg)', padding: '1px 8px' }}>재원 충분</span>
                : <span style={{ fontSize: 10, background: 'var(--red)', color: 'var(--bg)', padding: '1px 8px' }}>{inheritShortfall.toFixed(1)}억 부족</span>}
            </div>
            <div style={{ display: 'flex', gap: 24, marginBottom: 8 }}>
              {[
                { label: '납부 목표', val: `${funding.inheritanceTaxTarget.toFixed(1)}억`, color: 'var(--ink)' },
                { label: '피상속인 현금', val: `${funding.ownCash.toFixed(1)}억`, color: 'var(--ink)' },
                { label: '자녀 지분 임대·대출', val: `${(funding.equityRentalCashflow10yr + funding.equityBackedChildLoans).toFixed(1)}억`, color: 'var(--ink)' },
                { label: '잔여 임대수익', val: `${funding.accRentalAfterTax.toFixed(1)}억`, color: 'var(--ink)' },
                { label: '담보대출 여력', val: `${funding.maxBankLoan.toFixed(1)}억`, color: 'var(--ink)' },
                { label: inheritFeasible ? '여유' : '부족', val: `${inheritFeasible ? '+' : ''}${funding.surplus.toFixed(1)}억`, color: inheritFeasible ? 'var(--green-ink)' : 'var(--red)' },
              ].map(item => (
                <div key={item.label}>
                  <div style={{ fontSize: 9, letterSpacing: 1.5, color: 'var(--ink-faint)', textTransform: 'uppercase', marginBottom: 2 }}>{item.label}</div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: item.color }}>{item.val}</div>
                </div>
              ))}
            </div>
            {!inheritFeasible && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ fontSize: 11, color: 'var(--ink-faint)', fontWeight: 600 }}>부족분 해결 방안</div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {[
                    { label: '연부연납', desc: `연 ${funding.installmentReserve.toFixed(2)}억 × 10년 분할`, ok: (funding.accRentalAfterTax + funding.equityRentalCashflow10yr) >= funding.inheritanceTaxTarget },
                    { label: '담보대출 추가', desc: `LTV 조정으로 최대 ${funding.maxBankLoan.toFixed(1)}억 확보`, ok: funding.maxBankLoan >= inheritShortfall },
                    { label: '임대수익 적립', desc: `현재 ${annualRentalNet.toFixed(2)}억/년, ${yearsToFillInherit > 0 ? yearsToFillInherit + '년 추가 적립' : '충분'}`, ok: yearsToFillInherit === 0 },
                  ].map(opt => (
                    <div key={opt.label} style={{ fontSize: 10, padding: '4px 10px', background: opt.ok ? 'var(--green-tint)' : 'var(--paper-sink)', border: `1px solid ${opt.ok ? 'var(--green)' : 'var(--line-strong)'}`, color: opt.ok ? 'var(--green-ink)' : 'var(--ink-soft)' }}>
                      <span style={{ fontWeight: 600 }}>{opt.label}</span> — {opt.desc}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── 증여 세부 내역 ── */}
      <div className="card-kyn">
        <div className="card-head">
          <div>
            <div className="crumb" style={{ marginBottom: 8 }}>GIFT BREAKDOWN</div>
            <div className="t">수증자별 증여 세부 내역
              <span className="sub">총 {result.totalGiftAmount.toFixed(1)}억 / 증여세 {result.totalGiftTax.toFixed(2)}억</span>
            </div>
          </div>
        </div>
        <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          {result.giftPlans.length === 0 && (
            <div style={{ fontSize: 12, color: 'var(--ink-faint)', padding: '16px 0' }}>
              수증 가능 가족이 없습니다. 가족 구성 페이지에서 자녀·손자녀·며느리를 등록하세요.
            </div>
          )}
          {result.giftPlans.map((plan, i) => {
            const bd = plan.breakdown[0];
            return (
              <div key={i} style={{ border: '1px solid var(--line-strong)', padding: 12 }}>
                {/* 헤더 */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--ink)' }}>{plan.memberName}</span>
                    <span style={{ fontSize: 10, background: 'var(--paper-sink)', color: 'var(--ink-soft)', padding: '1px 6px' }}>{plan.relation}</span>
                    {plan.isGenSkip && <span style={{ fontSize: 10, background: 'var(--legal-tint)', color: 'var(--legal)', padding: '1px 6px' }}>세대생략 ×1.3</span>}
                    {plan.giftTax === 0 && <span style={{ fontSize: 10, background: 'var(--legal-tint)', color: 'var(--legal)', padding: '1px 6px', fontWeight: 700 }}>증여세 0원 ✓</span>}
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--gold)' }}>{plan.giftAmount.toFixed(1)}억 지분 증여</div>
                    {bd && <div style={{ fontSize: 10, color: 'var(--ink-faint)' }}>
                      {bd.assetName} {bd.equityPct.toFixed(1)}% · {bd.sortKey === 'yield' ? `수익률 ${bd.yieldPct.toFixed(1)}%` : `성장률 ${bd.growthPct.toFixed(1)}%`}
                    </div>}
                  </div>
                </div>

                {/* 자산 배분 테이블 */}
                {plan.breakdown.length > 0 && (
                  <div style={{ border: '1px solid var(--line)', marginBottom: 8 }}>
                    <div style={{ background: 'var(--paper)', borderBottom: '1px solid var(--line)', padding: '4px 10px', fontSize: 10, fontWeight: 600, color: 'var(--ink-soft)' }}>
                      배정 자산 — {plan.breakdown[0].sortKey === 'yield' ? '수익률' : '성장률'} 순위 배정
                    </div>
                    <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' }}>
                      <thead>
                        <tr style={{ color: 'var(--ink-faint)', borderBottom: '1px solid var(--line)' }}>
                          <th style={{ textAlign: 'left', padding: '4px 10px', fontWeight: 400 }}>자산</th>
                          <th style={{ textAlign: 'right', padding: '4px 8px', fontWeight: 400 }}>{plan.breakdown[0].sortKey === 'yield' ? '수익률' : '성장률'}</th>
                          <th style={{ textAlign: 'right', padding: '4px 8px', fontWeight: 400 }}>증여액</th>
                          <th style={{ textAlign: 'right', padding: '4px 8px', fontWeight: 400 }}>지분</th>
                          <th style={{ textAlign: 'right', padding: '4px 10px', fontWeight: 400 }}>연임대</th>
                        </tr>
                      </thead>
                      <tbody>
                        {plan.breakdown.map((b, bi) => (
                          <tr key={bi} style={{ background: bi % 2 === 0 ? 'var(--bg)' : 'var(--paper)', borderBottom: '1px solid var(--paper-sink)' }}>
                            <td style={{ padding: '5px 10px', fontWeight: 600, color: 'var(--ink)' }}>{b.assetName}</td>
                            <td style={{ textAlign: 'right', padding: '5px 8px', fontWeight: 600, color: b.sortKey === 'yield' ? 'var(--gold)' : 'var(--legal)' }}>
                              {b.sortKey === 'yield' ? `${b.yieldPct.toFixed(1)}%` : `${b.growthPct.toFixed(1)}%`}
                            </td>
                            <td style={{ textAlign: 'right', padding: '5px 8px', fontWeight: 600, color: 'var(--gold)' }}>{b.allocAmount.toFixed(2)}억</td>
                            <td style={{ textAlign: 'right', padding: '5px 8px', fontWeight: 600, color: 'var(--ink)' }}>{b.equityPct.toFixed(1)}%</td>
                            <td style={{ textAlign: 'right', padding: '5px 10px', color: 'var(--green-ink)', fontWeight: 600 }}>
                              {b.annualRental >= 0.01 ? `${b.annualRental.toFixed(2)}억` : `${(b.annualRental * 10000).toFixed(0)}만`}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* 핵심 수치 + 수증자 현금흐름 — 하나의 flat 지표행으로 통합 */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', borderTop: '1px solid var(--line)', marginBottom: 8 }}>
                  {[
                    { label: '납부할 증여세', val: plan.giftTax === 0 ? '없음 (0원)' : `${plan.giftTax.toFixed(2)}억`, color: plan.giftTax === 0 ? 'var(--legal)' : 'var(--red)' },
                    { label: '10년 상속세 절감', val: `${plan.inheritanceTaxSaved.toFixed(1)}억`, color: 'var(--green-ink)' },
                    { label: '순편익', val: `${plan.netBenefit >= 0 ? '+' : ''}${plan.netBenefit.toFixed(1)}억`, color: plan.netBenefit >= 0 ? 'var(--green-ink)' : 'var(--amber)' },
                  ].map((col, ci) => (
                    <div key={col.label} style={{ padding: '8px 10px', borderRight: ci < 2 ? '1px solid var(--line)' : 'none' }}>
                      <div style={{ fontSize: 10, color: 'var(--ink-faint)', marginBottom: 3 }}>{col.label}</div>
                      <div style={{ fontSize: 13, fontWeight: 700, color: col.color }}>{col.val}</div>
                    </div>
                  ))}
                </div>

                {/* 수증자 현금흐름 */}
                <div style={{ borderTop: '1px solid var(--line)', paddingTop: 8, marginBottom: 8 }}>
                  <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--ink-faint)', marginBottom: 6 }}>수증자 현금흐름 (지분 활용)</div>
                  <div style={{ display: 'flex', gap: 20 }}>
                    <div>
                      <div style={{ fontSize: 9, color: 'var(--ink-faint)' }}>연 임대수익</div>
                      <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--ink)' }}>
                        {plan.annualRentalFromEquity >= 0.1 ? `${plan.annualRentalFromEquity.toFixed(2)}억/년` : `${(plan.annualRentalFromEquity * 10000).toFixed(0)}만원/년`}
                      </div>
                    </div>
                    <div>
                      <div style={{ fontSize: 9, color: 'var(--ink-faint)' }}>지분 담보대출</div>
                      <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--ink)' }}>{plan.equityBackedLoan.toFixed(2)}억</div>
                    </div>
                    <div>
                      <div style={{ fontSize: 9, color: 'var(--ink-faint)' }}>10년 기여 총액</div>
                      <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--gold-deep)' }}>{plan.childTotalFunding10yr.toFixed(2)}억</div>
                    </div>
                  </div>
                </div>

                <div style={{ fontSize: 10, color: 'var(--ink-faint)', lineHeight: 1.5 }}>{plan.rationale}</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── LTV 담보대출 여력 ── */}
      {funding.assetLoanBreakdown.length > 0 && (() => {
        const totalLoan   = funding.maxBankLoan;
        const annualInt   = totalLoan * loanRate / 100;
        const int10yr     = annualInt * 10;
        const estateSaving = totalLoan * result.marginalRate;
        const netBenefitLtv = estateSaving - int10yr;
        return (
          <div className="card-kyn">
            {/* 헤더 — 클릭으로 토글 */}
            <button
              onClick={() => setLtvOpen(o => !o)}
              style={{ width: '100%', padding: '18px 24px 16px', background: 'transparent', border: 'none', borderBottom: ltvOpen ? '1px solid var(--line)' : 'none', display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', fontFamily: 'var(--sans)' }}
            >
              <div>
                <div className="crumb" style={{ marginBottom: 8 }}>COLLATERAL CAPACITY</div>
                <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--ink)' }}>담보대출 여력
                  <span style={{ display: 'block', fontSize: 12.5, color: 'var(--ink-faint)', fontWeight: 400, marginTop: 4 }}>합계 {totalLoan.toFixed(1)}억</span>
                </div>
              </div>
              <span className="pill">{ltvOpen ? '▲ 접기' : '▼ 펼치기'}</span>
            </button>

            {ltvOpen && (
              <div style={{ padding: '12px 16px' }}>
                {/* LTV 테이블 */}
                <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse', marginBottom: 12 }}>
                  <thead>
                    <tr style={{ color: 'var(--ink-faint)', borderBottom: '1px solid var(--line)' }}>
                      <th style={{ textAlign: 'left', padding: '4px 0', fontWeight: 400 }}>자산</th>
                      <th style={{ textAlign: 'right', padding: '4px 8px', fontWeight: 400 }}>현재가치</th>
                      <th style={{ textAlign: 'right', padding: '4px 8px', fontWeight: 400 }}>현재대출</th>
                      <th style={{ textAlign: 'center', padding: '4px 8px', fontWeight: 400 }}>LTV</th>
                      <th style={{ textAlign: 'right', padding: '4px 0', fontWeight: 400 }}>추가여력</th>
                    </tr>
                  </thead>
                  <tbody>
                    {funding.assetLoanBreakdown.map((b, bi) => (
                      <tr key={b.assetId} style={{ background: bi % 2 === 0 ? 'var(--bg)' : 'var(--paper)', borderBottom: '1px solid var(--paper-sink)' }}>
                        <td style={{ padding: '5px 0', fontWeight: 600, color: 'var(--ink)' }}>{b.assetName}</td>
                        <td style={{ textAlign: 'right', padding: '5px 8px', color: 'var(--ink-soft)' }}>{b.currentValue.toFixed(1)}억</td>
                        <td style={{ textAlign: 'right', padding: '5px 8px', color: 'var(--ink-soft)' }}>{b.currentLoan.toFixed(1)}억</td>
                        <td style={{ textAlign: 'center', padding: '5px 8px' }}>
                          <input
                            type="number" min={0} max={90} step={5}
                            value={ltvMap[b.assetId] ?? 40}
                            onChange={e => onLtvChange(b.assetId, Number(e.target.value))}
                            style={{ width: 44, textAlign: 'center', border: '1px solid var(--line-strong)', padding: '2px 4px', fontSize: 11, fontWeight: 600, color: 'var(--ink)', outline: 'none' }}
                          />
                          <span style={{ color: 'var(--ink-faint)', marginLeft: 2 }}>%</span>
                        </td>
                        <td style={{ textAlign: 'right', padding: '5px 0', fontWeight: 700, color: 'var(--ink)' }}>
                          {b.additionalCapacity > 0 ? `${b.additionalCapacity.toFixed(1)}억` : '-'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr style={{ borderTop: '1px solid var(--line-strong)', background: 'var(--paper-sink)' }}>
                      <td colSpan={4} style={{ padding: '5px 0', fontWeight: 600, color: 'var(--ink)', fontSize: 11 }}>추가 가능 합계</td>
                      <td style={{ textAlign: 'right', padding: '5px 0', fontWeight: 700, color: 'var(--ink)' }}>{totalLoan.toFixed(1)}억</td>
                    </tr>
                  </tfoot>
                </table>

                {/* 대출 현금흐름 분석 */}
                <div style={{ borderTop: '1px solid var(--paper-sink)', paddingTop: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                    <span style={{ fontSize: 11, color: 'var(--ink-soft)' }}>적용 금리 가정</span>
                    <input
                      type="number" min={1} max={15} step={0.1}
                      value={loanRate}
                      onChange={e => setLoanRate(Number(e.target.value))}
                      style={{ width: 48, textAlign: 'center', border: '1px solid var(--line-strong)', padding: '2px 4px', fontSize: 11, fontWeight: 600, outline: 'none' }}
                    />
                    <span style={{ fontSize: 11, color: 'var(--ink-faint)' }}>% (실제 금리는 은행 심사 후 확정)</span>
                  </div>

                  <div style={{ border: '1px solid var(--line)' }}>
                    <div style={{ background: 'var(--paper-sink)', padding: '6px 12px', fontSize: 11, fontWeight: 600, color: 'var(--ink)' }}>
                      담보대출 {totalLoan.toFixed(1)}억 활용 시 현금흐름
                    </div>
                    {[
                      { label: '즉시 확보 현금',            val: `+${totalLoan.toFixed(1)}억`,      note: '상속세 납부 또는 증여세 지원 재원',                                                                           color: 'var(--legal)' },
                      { label: `연간 이자 비용 (${loanRate}%)`, val: annualInt >= 0.1 ? `-${annualInt.toFixed(2)}억/년` : `-${(annualInt * 10000).toFixed(0)}만원/년`, note: '임대수익으로 충당 가능 여부 확인 필요', color: 'var(--red)' },
                      { label: '10년 누적 이자',             val: `-${int10yr.toFixed(2)}억`,        note: `총 이자 비용 (${loanRate}% × 10년)`,                                                                          color: 'var(--red)' },
                      { label: '상속세 절감 효과',           val: `+${estateSaving.toFixed(2)}억`,   note: `대출 = 부채 → 상속세 과표 ${totalLoan.toFixed(1)}억 감소 × 한계세율 ${(result.marginalRate * 100).toFixed(0)}%`, color: 'var(--green-ink)' },
                    ].map(row => (
                      <div key={row.label} style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', padding: '8px 12px', borderTop: '1px solid var(--paper-sink)' }}>
                        <div>
                          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--ink)' }}>{row.label}</div>
                          <div style={{ fontSize: 10, color: 'var(--ink-faint)', marginTop: 1 }}>{row.note}</div>
                        </div>
                        <span style={{ fontSize: 12, fontWeight: 700, color: row.color, marginLeft: 12, flexShrink: 0 }}>{row.val}</span>
                      </div>
                    ))}
                    {/* 순편익 */}
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', borderTop: '1px solid var(--ink)' }}>
                      <div>
                        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--ink)' }}>순편익 (절감 − 이자)</div>
                        <div style={{ fontSize: 10, color: 'var(--ink-faint)', marginTop: 1 }}>
                          {netBenefitLtv >= 0 ? '대출 활용이 유리 — 이자보다 상속세 절감이 큼' : '이자 부담이 절감 효과보다 큼 — 규모 축소 검토'}
                        </div>
                      </div>
                      <span style={{ fontSize: 13, fontWeight: 700, color: netBenefitLtv >= 0 ? 'var(--green-ink)' : 'var(--amber)', marginLeft: 12, flexShrink: 0 }}>
                        {netBenefitLtv >= 0 ? '+' : ''}{netBenefitLtv.toFixed(2)}억
                      </span>
                    </div>
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--ink-faint)', marginTop: 6 }}>
                    ※ 실제 한도는 은행 DSR·소득 심사에 따라 다름. LTV와 금리를 조정해 시나리오를 확인하세요.
                  </div>
                </div>
              </div>
            )}
          </div>
        );
      })()}
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────

export default function ScenariosPage() {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [members, setMembers] = useState<FamilyMember[]>([]);
  const [macro, setMacro] = useState<MacroSettings | null>(null);
  const [transferPlans, setTransferPlans] = useState<TransferPlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<string>('optimal');

  // Scenario params
  const [s4SkipPct, setS4SkipPct] = useState(30);
  const [s9LoanPct, setS9LoanPct] = useState(20);
  const [s5CeoSalary, setS5CeoSalary] = useState(0.3);
  const [s5TransferPct, setS5TransferPct] = useState(80);
  const [s7GiftNowPct, setS7GiftNowPct] = useState(30);
  const [s7UseCorp, setS7UseCorp] = useState(false);
  const [s7CeoSalary, setS7CeoSalary] = useState(0.3);
  const [s7IncludeGrandchildren, setS7IncludeGrandchildren] = useState(false);
  const [s7CorpContributionPct, setS7CorpContributionPct] = useState(50);
  const [s7UseFoundation, setS7UseFoundation] = useState(false);
  const [s7FoundationDonationPct, setS7FoundationDonationPct] = useState(10);
  const [s7AssetLtvMap, setS7AssetLtvMap] = useState<Record<string, number>>({});
  const [s7AssetInterestRateMap, setS7AssetInterestRateMap] = useState<Record<string, number>>({});
  const [s7RateShockPct, setS7RateShockPct] = useState(DEFAULT_MACRO.rate_shock_pct);

  // "직접 설계"(S7)는 증여비중·법인전환·공익법인·담보대출을 사용자가 직접 조절하는
  // 유일한 자동 시나리오라서, buildS7과 같은 방식으로 재원/법인/공익법인 규모를
  // 근사 계산해 백엔드 리스크 엔진에 그대로 넘긴다 — 옵션을 바꾸면 리스크 점수도
  // 실제로 움직이게 하려는 목적 (Phase 0에서 고친 재원 확실성 구분을 그대로 재사용).
  const s7RiskRequest: ImmediateGiftScenarioRequest | null = useMemo(() => {
    if (assets.length === 0 || members.length === 0) return null;
    const m = getMacro(macro);
    const totalValue = assets.reduce((s, a) => s + a.current_value, 0);
    const giftPct = Math.max(0, Math.min(100, s7GiftNowPct)) / 100;
    if (giftPct <= 0) return null;
    const foundationPct = s7UseFoundation ? Math.max(0, Math.min(100, s7FoundationDonationPct)) / 100 : 0;
    const corpPct = s7UseCorp ? Math.max(0, Math.min(100, s7CorpContributionPct)) / 100 : 0;
    const giftValue = totalValue * giftPct;

    const targetMembers = s7IncludeGrandchildren
      ? members.filter(r => r.relation !== '본인')
      : members.filter(r => r.relation !== '본인' && r.relation !== '손자녀');
    if (targetMembers.length === 0) return null;

    let additionalDebt = 0;
    let additionalAnnualInterest = 0;
    assets.forEach(asset => {
      const currentLtv = asset.current_value > 0 ? (asset.loan_amount / asset.current_value) * 100 : 0;
      const targetLtv = Math.max(currentLtv, Math.min(70, s7AssetLtvMap[asset.id] ?? currentLtv));
      const targetDebt = asset.current_value * targetLtv / 100;
      const debtIncrease = Math.max(0, targetDebt - (asset.loan_amount || 0));
      const interestRate = Math.max(
        0,
        (s7AssetInterestRateMap[asset.id] ?? asset.loan_rate_pct ?? m.base_rate_pct) + s7RateShockPct,
      );
      additionalDebt += debtIncrease;
      additionalAnnualInterest += debtIncrease * interestRate / 100;
    });

    return {
      donor_id: 'owner',
      family_total_assets: totalValue,
      available_cash: getLiquidAvailableFunding(assets, members),
      family_loan_amount: 0, // S7은 가족간 차용을 별도로 분리하지 않음 — 전액 담보대출로 모델링
      bank_loan_amount: additionalDebt,
      bank_loan_annual_interest: additionalAnnualInterest,
      corp_conversion_amount: totalValue * (1 - giftPct) * corpPct,
      foundation_amount: totalValue * (1 - giftPct) * foundationPct,
      recipients: targetMembers.map(r => ({
        person_id: r.id, relation: r.relation,
        gift_amount: giftValue / targetMembers.length,
        is_adult: r.age == null || r.age >= 19,
      })),
      event_date: new Date().toISOString().slice(0, 10),
    };
  }, [
    assets, members, macro, s7GiftNowPct, s7UseFoundation, s7FoundationDonationPct,
    s7UseCorp, s7CorpContributionPct, s7IncludeGrandchildren, s7AssetLtvMap,
    s7AssetInterestRateMap, s7RateShockPct,
  ]);

  // S7 실행 전/후 대차대조표(D/E·LTV·순자산) 비교용 — "지금"과 "증여+대출 실행 후"를
  // 같은 balance-sheet 엔진으로 계산해서 나란히 보여준다. buildS7의 remainPct/추가대출
  // 로직과 동일한 방식으로 자산가치·부채를 조정한다.
  const s7BalanceSheetInputs = useMemo(() => {
    if (assets.length === 0) return null;
    const m = getMacro(macro);
    const totalValue = assets.reduce((s, a) => s + a.current_value, 0);
    const giftPct = Math.max(0, Math.min(100, s7GiftNowPct)) / 100;
    const foundationPct = s7UseFoundation ? Math.max(0, Math.min(100, s7FoundationDonationPct)) / 100 : 0;
    const remainPct = (1 - giftPct) * (1 - foundationPct);

    const toBackendAsset = (id: string, assetType: string, value: number, acqDate: string | null) => ({
      id, owner_id: 'family', ownership_ratio: 1,
      asset_type: KOREAN_TO_BACKEND_ASSET_TYPE[assetType] ?? 'OTHER',
      acquisition_date: acqDate ?? '2015-01-01',
      acquisition_cost: value,
      valuation: { user_estimate: value },
    });
    const toBackendDebt = (assetId: string, outstanding: number, ratePct: number) => ({
      id: `${assetId}-loan`, borrower_id: 'family', lender_type: 'BANK',
      principal: outstanding, outstanding_principal: outstanding,
      interest_rate: Math.max(0, ratePct) / 100, rate_type: 'FIXED',
      maturity_date: '2036-01-01', repayment_type: 'BULLET', purpose: 'ACQUISITION',
      // LTV는 MORTGAGE로 분류된 부채만 집계하므로 근저당 등록을 반드시 같이 넘겨야 한다
      // (안 넘기면 LTV가 항상 0으로 나옴 — balance-sheet 엔진 확인 결과).
      collateral_ids: [assetId],
      mortgage_registrations: [{ collateral_asset_id: assetId, max_claim_amount: outstanding * 1.2, priority_rank: 1, registered_date: '2015-01-01' }],
    });

    const beforeAssets = assets.map(a => toBackendAsset(a.id, a.asset_type, a.current_value, a.acquisition_date));
    const beforeDebts = assets.filter(a => a.loan_amount > 0).map(a => toBackendDebt(a.id, a.loan_amount, a.loan_rate_pct));

    const afterAssets = assets.map(a => toBackendAsset(a.id, a.asset_type, a.current_value * remainPct, a.acquisition_date));
    const afterDebts = assets
      .map(a => {
        const currentLtv = a.current_value > 0 ? (a.loan_amount / a.current_value) * 100 : 0;
        const targetLtv = Math.max(currentLtv, Math.min(70, s7AssetLtvMap[a.id] ?? currentLtv));
        const targetDebt = a.current_value * targetLtv / 100; // 대출은 증여 전 시가 기준으로 실행
        return { id: a.id, outstanding: targetDebt, rate: s7AssetInterestRateMap[a.id] ?? a.loan_rate_pct ?? m.base_rate_pct };
      })
      .filter(d => d.outstanding > 0)
      .map(d => toBackendDebt(d.id, d.outstanding, d.rate));

    return {
      before: { assets: beforeAssets, debts: beforeDebts },
      after: { assets: afterAssets, debts: afterDebts },
      totalValue,
    };
  }, [assets, macro, s7GiftNowPct, s7UseFoundation, s7FoundationDonationPct, s7AssetLtvMap, s7AssetInterestRateMap]);

  // "부담부증여 혼합"(S9)도 실제 담보대출·증여를 같이 모델링하는 자동 시나리오라서
  // buildS9_BurdenedGiftHybrid와 같은 방식으로 대상 자산·수증자·신규대출을 다시
  // 산출해 리스크 엔진에 넘긴다. 가족간 재배분 차용(무이자 차용증)은 증여세 재원이
  // 아니라 별도 목적 배분이라 family_loan_amount에는 포함하지 않는다.
  const s9RiskRequest: ImmediateGiftScenarioRequest | null = useMemo(() => {
    const REAL_ESTATE = ['주거용부동산', '상업용부동산', '토지', '오피스텔'];
    const target = [...assets]
      .filter(a => REAL_ESTATE.includes(a.asset_type))
      .sort((a, b) => b.current_value - a.current_value)[0];
    if (!target) return null;
    const recipient = members.find(r => r.relation === '자녀') ?? members.find(r => r.relation !== '본인');
    if (!recipient) return null;

    const m = getMacro(macro);
    const newLoan = target.current_value * (s9LoanPct / 100);
    const totalAssetDebt = target.loan_amount + newLoan;
    const netGiftValue = Math.max(0, target.current_value - totalAssetDebt);
    if (netGiftValue <= 0) return null;
    const annualBankInterest = newLoan * (m.base_rate_pct / 100);

    return {
      donor_id: 'owner',
      family_total_assets: assets.reduce((s, a) => s + a.current_value, 0),
      available_cash: getLiquidAvailableFunding(assets, members),
      family_loan_amount: 0,
      bank_loan_amount: newLoan,
      bank_loan_annual_interest: annualBankInterest,
      recipients: [{
        person_id: recipient.id, relation: recipient.relation,
        gift_amount: netGiftValue,
        is_adult: recipient.age == null || recipient.age >= 19,
      }],
      event_date: new Date().toISOString().slice(0, 10),
    };
  }, [assets, members, macro, s9LoanPct]);

  // S9는 대상 자산(target)을 신규대출까지 포함해 채무승계 조건으로 통째로 수증자에게
  // 넘기므로 — S7(비율로 깎이는 것)과 달리 — "실행 후" 가족 대차대조표에서는
  // target 자산과 그 부채(기존+신규 담보대출)가 완전히 빠진다.
  const s9BalanceSheetInputs = useMemo(() => {
    const REAL_ESTATE = ['주거용부동산', '상업용부동산', '토지', '오피스텔'];
    const target = [...assets]
      .filter(a => REAL_ESTATE.includes(a.asset_type))
      .sort((a, b) => b.current_value - a.current_value)[0];
    if (!target) return null;

    const toBackendAsset = (a: Asset) => ({
      id: a.id, owner_id: 'family', ownership_ratio: 1,
      asset_type: KOREAN_TO_BACKEND_ASSET_TYPE[a.asset_type] ?? 'OTHER',
      acquisition_date: a.acquisition_date ?? '2015-01-01',
      acquisition_cost: a.current_value,
      valuation: { user_estimate: a.current_value },
    });
    const toBackendDebt = (a: Asset) => ({
      id: `${a.id}-loan`, borrower_id: 'family', lender_type: 'BANK',
      principal: a.loan_amount, outstanding_principal: a.loan_amount,
      interest_rate: Math.max(0, a.loan_rate_pct) / 100, rate_type: 'FIXED',
      maturity_date: '2036-01-01', repayment_type: 'BULLET', purpose: 'ACQUISITION',
      collateral_ids: [a.id],
      mortgage_registrations: [{ collateral_asset_id: a.id, max_claim_amount: a.loan_amount * 1.2, priority_rank: 1, registered_date: '2015-01-01' }],
    });

    const beforeAssets = assets.map(toBackendAsset);
    const beforeDebts = assets.filter(a => a.loan_amount > 0).map(toBackendDebt);

    const afterAssets = assets.filter(a => a.id !== target.id).map(toBackendAsset);
    const afterDebts = assets.filter(a => a.id !== target.id && a.loan_amount > 0).map(toBackendDebt);

    return { before: { assets: beforeAssets, debts: beforeDebts }, after: { assets: afterAssets, debts: afterDebts } };
  }, [assets]);

  // S5(법인전환)는 증여가 없어 리스크 엔진(/scenario/immediate-gift)엔 안 맞지만,
  // 대차대조표 관점에선 의미가 있다 — 이전 비율만큼 REAL_ESTATE가 BUSINESS_EQUITY(법인
  // 지분)로 재분류되면서 집중도·자산배분이 바뀐다. 부채는 자산을 따라간다고 가정.
  const s5BalanceSheetInputs = useMemo(() => {
    const REAL_ESTATE_S5 = ['주거용부동산', '상업용부동산', '토지'];
    const transferRatio = Math.max(0, Math.min(100, s5TransferPct)) / 100;
    if (transferRatio <= 0) return null;

    const toBackendAsset = (id: string, assetType: string, value: number, acqDate: string | null) => ({
      id, owner_id: 'family', ownership_ratio: 1,
      asset_type: KOREAN_TO_BACKEND_ASSET_TYPE[assetType] ?? 'OTHER',
      acquisition_date: acqDate ?? '2015-01-01',
      acquisition_cost: value, valuation: { user_estimate: value },
    });
    const toBackendDebt = (assetId: string, outstanding: number, ratePct: number) => ({
      id: `${assetId}-loan`, borrower_id: 'family', lender_type: 'BANK',
      principal: outstanding, outstanding_principal: outstanding,
      interest_rate: Math.max(0, ratePct) / 100, rate_type: 'FIXED',
      maturity_date: '2036-01-01', repayment_type: 'BULLET', purpose: 'ACQUISITION',
      collateral_ids: [assetId],
      mortgage_registrations: [{ collateral_asset_id: assetId, max_claim_amount: outstanding * 1.2, priority_rank: 1, registered_date: '2015-01-01' }],
    });

    const beforeAssets = assets.map(a => toBackendAsset(a.id, a.asset_type, a.current_value, a.acquisition_date));
    const beforeDebts = assets.filter(a => a.loan_amount > 0).map(a => toBackendDebt(a.id, a.loan_amount, a.loan_rate_pct));

    // 이전 대상 자산: 잔존분은 REAL_ESTATE로 그대로, 이전분은 UNLISTED_SHARE(법인지분)
    // 신규 자산으로 추가 — 가치는 동일(가족이 법인 지분으로 계속 보유), 카테고리만 이동.
    const afterAssets = assets.flatMap(a => {
      if (!REAL_ESTATE_S5.includes(a.asset_type)) {
        return [toBackendAsset(a.id, a.asset_type, a.current_value, a.acquisition_date)];
      }
      const retained = a.current_value * (1 - transferRatio);
      const transferred = a.current_value * transferRatio;
      const out = [];
      if (retained > 0.001) out.push(toBackendAsset(a.id, a.asset_type, retained, a.acquisition_date));
      if (transferred > 0.001) out.push(toBackendAsset(`${a.id}-corp`, '비상장주식', transferred, a.acquisition_date));
      return out;
    });
    const afterDebts = assets.filter(a => a.loan_amount > 0).map(a => toBackendDebt(a.id, a.loan_amount, a.loan_rate_pct));

    return { before: { assets: beforeAssets, debts: beforeDebts }, after: { assets: afterAssets, debts: afterDebts } };
  }, [assets, s5TransferPct]);

  const [s7ScenarioType, setS7ScenarioType] = useState<SavedScenarioType>('균형형');
  const [bestResult, setBestResult] = useState<string | null>(null);
  const [myPlanStrategyIds, setMyPlanStrategyIds] = useState<string[]>([]);
  const [customScenarioItems, setCustomScenarioItems] = useState<SavedCustomScenarioItem[]>([]);
  const [recoveryScenarioItems, setRecoveryScenarioItems] = useState<SavedRecoveryScenarioItem[]>([]);
  const [optCash, setOptCash] = useState<number | null>(null); // 최적 전략 현금 오버라이드
  const [ltvMap, setLtvMap] = useState<Record<string, number>>({}); // 자산별 LTV 오버라이드

  // 리스크·레버리지 패널이 계산한 결과를 끌어올려서 "종합 요약" 한 문단으로 합친다.
  const [liftedRisk, setLiftedRisk] = useState<SynthesisRiskInput | null>(null);
  const [liftedLeverage, setLiftedLeverage] = useState<SynthesisLeverageInput | null>(null);
  useEffect(() => {
    setLiftedRisk(null);
    setLiftedLeverage(null);
  }, [activeTab]);

  const supabase = createClient();

  useEffect(() => {
    async function load() {
      const { data: p } = await supabase.from('profiles').select('family_id').single();
      if (!p?.family_id) { setLoading(false); return; }
      const [{ data: a }, { data: mem }, { data: ms }, { data: tp }] = await Promise.all([
        supabase.from('assets').select('*').eq('family_id', p.family_id),
        supabase.from('family_members').select('*').eq('family_id', p.family_id),
        supabase.from('macro_settings').select('*').eq('family_id', p.family_id).single(),
        supabase.from('transfer_plans').select('*').eq('family_id', p.family_id),
      ]);
      setAssets(a || []);
      setMembers(mem || []);
      setMacro(ms || null);
      setTransferPlans((tp || []) as TransferPlan[]);
      setS7RateShockPct((ms ?? DEFAULT_MACRO).rate_shock_pct);
      setLoading(false);
    }
    load();
  }, []);

  useEffect(() => {
    const recoveryItems = loadSavedRecoveryScenarios();
    const customItems = loadSavedCustomScenarios();
    setRecoveryScenarioItems(recoveryItems);
    setCustomScenarioItems(customItems);

    const latestRecovery = recoveryItems[recoveryItems.length - 1];
    if (latestRecovery) {
      setMyPlanStrategyIds(latestRecovery.selectedStrategyIds);
      return;
    }

    try {
      const saved = localStorage.getItem('kyn_recovery_plan');
      setMyPlanStrategyIds(JSON.parse(saved || '[]'));
    } catch {
      setMyPlanStrategyIds([]);
    }
  }, []);

  const savedScenarioLabels = useMemo(
    () => buildSavedScenarioLabels([
      ...recoveryScenarioItems.map(item => ({
        id: `recovery__${item.id}`,
        scenarioType: item.scenarioType,
      })),
      ...customScenarioItems.map(item => ({
        id: `custom__${item.id}`,
        scenarioType: item.scenarioType,
      })),
    ]),
    [customScenarioItems, recoveryScenarioItems],
  );

  const scenarios = useMemo<ScenarioCalc[]>(() => {
    if (assets.length === 0) return [];
    const s1 = buildS1(assets, members, macro);
    const s2 = buildS2(assets, members, macro);
    const s3 = buildS3(assets, members, macro);
    const s4 = buildS4(assets, members, macro, s4SkipPct);
    const s5 = buildS5(assets, members, macro, s5CeoSalary, s5TransferPct);
    const s6 = buildS6(assets, members, macro);
    const s7 = buildS7(
      assets, members, macro,
      s7GiftNowPct, s7UseCorp, s7CeoSalary, s7IncludeGrandchildren,
      s7UseFoundation, s7FoundationDonationPct, s7CorpContributionPct,
      s7AssetLtvMap, s7AssetInterestRateMap,
      s7RateShockPct,
      s7ScenarioType,
    );
    const s9 = buildS9_BurdenedGiftHybrid(assets, members, macro, s9LoanPct);
    const legacyS8 = recoveryScenarioItems.length === 0 && myPlanStrategyIds.length > 0
      ? buildS8_MyPlan(assets, members, macro, myPlanStrategyIds)
      : null;

    const savedCustomScenarios = customScenarioItems.map(item => {
      const built = buildS7(
        assets,
        members,
        macro,
        item.giftNowPct,
        item.useCorp,
        item.ceoSalary,
        item.includeGrandchildren,
        item.useFoundation,
        item.foundationDonationPct,
        item.corpContributionPct,
        item.assetLtvMap,
        item.assetInterestRateMap,
        item.rateShockPct,
        item.scenarioType,
      );
      const id = `custom__${item.id}`;
      return {
        ...built,
        id,
        label: savedScenarioLabels.get(id) ?? item.scenarioType ?? item.name,
        tagline: `즉시 증여 ${item.giftNowPct}%${item.useCorp ? ` · 법인 ${item.corpContributionPct}%` : ''}${item.useFoundation ? ` · 공익 ${item.foundationDonationPct}%` : ''}`,
      };
    });

    const savedRecoveryScenarios = recoveryScenarioItems.map(item => {
      const built = buildS8_MyPlan(assets, members, macro, item.selectedStrategyIds);
      const id = `recovery__${item.id}`;
      return {
        ...built,
        id,
        label: savedScenarioLabels.get(id) ?? item.scenarioType ?? item.name,
        tagline: `저장된 ${item.selectedStrategyIds.length}개 전략 조합`,
        category: item.scenarioType ?? '회생형',
      };
    });

    const all: ScenarioCalc[] = [
      s1, s2, s3, s4, s5, s6, s7,
      ...(s9 ? [s9] : []),
      ...savedRecoveryScenarios,
      ...savedCustomScenarios,
      ...(legacyS8 ? [legacyS8] : []),
    ];
    const recommendedPool = all.filter(s => (
      ['s2', 's3', 's5', 's6', 's9'].includes(s.id)
      || s.id.startsWith('custom__')
      || s.id.startsWith('recovery__')
    ) && isScenarioFeasible(s, assets, members));
    const maxWealth = recommendedPool.length > 0
      ? Math.max(...recommendedPool.map(s => s.netWealth10yr))
      : -Infinity;
    all.forEach(s => { s.isRecommended = recommendedPool.includes(s) && s.netWealth10yr === maxWealth; });
    return all;
  }, [
    assets, members, macro, s4SkipPct, s9LoanPct,
    s5CeoSalary, s5TransferPct, s7GiftNowPct, s7UseCorp, s7CeoSalary,
    s7IncludeGrandchildren, s7CorpContributionPct, s7UseFoundation,
    s7FoundationDonationPct, s7AssetLtvMap, s7AssetInterestRateMap, s7RateShockPct,
    s7ScenarioType, myPlanStrategyIds, customScenarioItems,
    recoveryScenarioItems, savedScenarioLabels,
  ]);

  function findBestScenario() {
    if (assets.length === 0) return;
    let best = { netWealth: -Infinity, label: '' };
    const consider = (scenario: ScenarioCalc, label: string) => {
      if (!isScenarioFeasible(scenario, assets, members)) return;
      if (scenario.netWealth10yr > best.netWealth) {
        best = { netWealth: scenario.netWealth10yr, label };
      }
    };

    consider(buildS2(assets, members, macro), '즉시 분산증여 (최적)');
    consider(buildS3(assets, members, macro), '10년 분할증여 (최적)');
    consider(buildS5(assets, members, macro, s5CeoSalary, s5TransferPct), '법인형');
    consider(buildS6(assets, members, macro), '현금흐름형');

    setBestResult(
      best.label
        ? `실현 가능한 최적 시나리오: ${best.label} → 10년 후 순자산 ${fmt(best.netWealth)}`
        : '현재 입력값에서는 즉시 실행 가능한 자동 시나리오가 없습니다. 직접 설계에서 증여 비율과 재원을 조정하세요.',
    );
  }

  const totalValue = assets.reduce((s, a) => s + a.current_value, 0);
  const totalDebt = assets.reduce((s, a) => s + a.loan_amount, 0);
  const ltv = calcLTV(assets);
  const dscr = calcDSCR(assets);
  const baseInheritTax = calcInheritanceTax(totalValue, members).tax;
  const taxBurdenPct = totalValue > 0 ? (baseInheritTax / totalValue) * 100 : 0;

  // ── 최적 전략 엔진 ──
  // 보유 현금: 본인+배우자 등 수증자(자녀/손자녀/며느리/사위) 아닌 구성원의 현금 합산
  const RECIPIENT_RELATIONS = ['자녀', '손자녀', '며느리', '사위'];
  const ownerMember = members.find(m => m.relation === '본인')
    ?? members.find(m => !RECIPIENT_RELATIONS.includes(m.relation));
  const dbCashTotal = members
    .filter(m => !RECIPIENT_RELATIONS.includes(m.relation))
    .reduce((s, m) => s + (m.cash_hold ?? 0), 0);
  const ownCash = optCash !== null ? optCash : dbCashTotal;
  const canCalc = assets.length > 0 && members.length > 0;
  const optimalResult: OptimalStrategyResult | null = canCalc
    ? calcOptimalStrategy(assets, members, macro, ownCash, 0, 10, ltvMap, 'optimal')
    : null;
  const deductionOnlyResult: OptimalStrategyResult | null = canCalc
    ? calcOptimalStrategy(assets, members, macro, ownCash, 0, 10, ltvMap, 'deduction_only')
    : null;
  const genSkipResult: OptimalStrategyResult | null = canCalc
    ? calcOptimalStrategy(assets, members, macro, ownCash, 0, 10, ltvMap, 'force_gen_skip')
    : null;
  const optimalCandidates = [optimalResult, deductionOnlyResult, genSkipResult]
    .filter((result): result is OptimalStrategyResult => result !== null);
  const executableOptimalResult = [...optimalCandidates]
    .filter(result => getOptimalStrategyFeasibility(result).feasible)
    .sort((a, b) => b.netSavingAfterGiftTax - a.netSavingAfterGiftTax)[0] ?? null;
  const optimalFailureReasons = Array.from(new Set(
    optimalCandidates.flatMap(result => getOptimalStrategyFeasibility(result).reasons),
  ));

  // "최적 전략" 탭도 S7/S9와 같은 방식으로 실행 전/후 대차대조표를 만든다. 여기선
  // 자산 단위 배정이 아니라 총액(totalGiftAmount) 기준이라, 전체 자산가치를
  // 증여 비율만큼 균등 축소하고 증여세 재원 담보대출(bankLoanForGiftTax)은
  // 최대 부동산 자산에 근저당으로 붙여 LTV에 반영한다.
  const optimalBalanceSheetInputs = useMemo(() => {
    if (!executableOptimalResult || assets.length === 0) return null;
    const REAL_ESTATE = ['주거용부동산', '상업용부동산', '토지', '오피스텔'];
    const totalValue = assets.reduce((s, a) => s + a.current_value, 0);
    if (totalValue <= 0) return null;
    const remainPct = Math.max(0, 1 - executableOptimalResult.totalGiftAmount / totalValue);
    const bankLoan = executableOptimalResult.funding.bankLoanForGiftTax;
    const target = [...assets].filter(a => REAL_ESTATE.includes(a.asset_type))
      .sort((a, b) => b.current_value - a.current_value)[0];

    const toBackendAsset = (a: Asset, value: number) => ({
      id: a.id, owner_id: 'family', ownership_ratio: 1,
      asset_type: KOREAN_TO_BACKEND_ASSET_TYPE[a.asset_type] ?? 'OTHER',
      acquisition_date: a.acquisition_date ?? '2015-01-01',
      acquisition_cost: value, valuation: { user_estimate: value },
    });
    const toBackendDebt = (assetId: string, outstanding: number, ratePct: number) => ({
      id: `${assetId}-loan`, borrower_id: 'family', lender_type: 'BANK',
      principal: outstanding, outstanding_principal: outstanding,
      interest_rate: Math.max(0, ratePct) / 100, rate_type: 'FIXED',
      maturity_date: '2036-01-01', repayment_type: 'BULLET', purpose: 'ACQUISITION',
      collateral_ids: [assetId],
      mortgage_registrations: [{ collateral_asset_id: assetId, max_claim_amount: outstanding * 1.2, priority_rank: 1, registered_date: '2015-01-01' }],
    });

    const beforeAssets = assets.map(a => toBackendAsset(a, a.current_value));
    const beforeDebts = assets.filter(a => a.loan_amount > 0).map(a => toBackendDebt(a.id, a.loan_amount, a.loan_rate_pct));

    const afterAssets = assets.map(a => toBackendAsset(a, a.current_value * remainPct));
    const afterDebts = assets
      .filter(a => a.loan_amount > 0)
      .map(a => toBackendDebt(a.id, a.loan_amount * remainPct, a.loan_rate_pct));
    if (bankLoan > 0 && target) {
      // 증여세 재원용 신규 담보대출 — target 자산에 근저당으로 걸리는 것으로 취급
      afterDebts.push({
        ...toBackendDebt(target.id, bankLoan, macro?.base_rate_pct ?? 4.5),
        id: `${target.id}-gifttax-loan`,
      });
    }

    return { before: { assets: beforeAssets, debts: beforeDebts }, after: { assets: afterAssets, debts: afterDebts } };
  }, [executableOptimalResult, assets, macro]);

  if (loading) {
    return <KynLoader />;
  }

  if (assets.length === 0) {
    return (
      <div className="main">
        <StrategyFlowNav active="/dashboard/scenarios" />
        <div className="crumb">STEP 2 · SCENARIO ENGINE</div>
        <div className="pagehead"><div><h1>시나리오 비교</h1></div></div>
        <div className="rule" />
        <div className="card" style={{ textAlign: 'center', padding: '64px 40px' }}>
          <p style={{ color: 'var(--ink-faint)', fontSize: 13 }}>자산과 가족 구성원을 먼저 등록해주세요</p>
        </div>
      </div>
    );
  }


  const selectedScenario = scenarios.find(s => s.id === activeTab);
  const directScenario = scenarios.find(s => s.id === 's7');
  const directFeasibility = directScenario
    ? getScenarioFeasibility(directScenario, assets, members)
    : null;
  const baselineAnnualCashflow = calcAnnualCashflow(assets, macro ?? DEFAULT_MACRO).netCashflow;
  const liquidFunding = getLiquidAvailableFunding(assets, members);
  const hasLiquidityStress = baselineAnnualCashflow < 0
    || baseInheritTax > liquidFunding + 0.01
    || dscr < 1.5;
  const incomeBearingAssetCount = assets.filter(asset => asset.annual_yield_pct > 0).length;

  // ── 법인전환 자동 추천 조건 ──
  const annualRentalTotal = assets.reduce((s, a) => s + a.current_value * a.annual_yield_pct / 100, 0);
  const s5Scenario = scenarios.find(s => s.id === 's5');
  const s2Scenario = scenarios.find(s => s.id === 's2');
  const corpBetterThanGift = s5Scenario && s2Scenario && s5Scenario.netWealth10yr > s2Scenario.netWealth10yr;
  const shouldRecommendCorp = annualRentalTotal >= 0.5 && corpBetterThanGift && incomeBearingAssetCount > 0;
  const hasRealEstate = assets.some(a => ['주거용부동산', '상업용부동산', '토지', '아파트', '오피스텔'].includes(a.asset_type));
  const automaticScenarioIds = [
    's2',
    's3',
    ...(hasRealEstate ? ['s9'] : []),
    ...(hasLiquidityStress ? ['s6'] : []),
    ...(incomeBearingAssetCount > 0 ? ['s5'] : []),
  ].filter((id, index, ids) => {
    if (ids.indexOf(id) !== index) return false;
    const scenario = scenarios.find(item => item.id === id);
    return scenario && isScenarioFeasible(scenario, assets, members);
  }).slice(0, 4);
  const automaticVisibleIds = new Set(automaticScenarioIds);
  const comparisonScenarios = scenarios.filter(s => {
    const isSavedScenario = s.id.startsWith('custom__') || s.id.startsWith('recovery__');
    const isAutomaticScenario = automaticVisibleIds.has(s.id);

    // Saved drafts remain visible so users can reopen and improve them.
    return isSavedScenario || (
      isAutomaticScenario
      && isScenarioFeasible(s, assets, members)
    );
  });
  const visibleScenarioIds = new Set(comparisonScenarios.map(s => s.id));
  const chartScenarios = selectedScenario && !visibleScenarioIds.has(selectedScenario.id)
    ? [...comparisonScenarios, selectedScenario]
    : comparisonScenarios;
  const isAllTab = activeTab === 'all';
  const isOptimalTab = activeTab === 'optimal';
  const activeCustomItem = activeTab.startsWith('custom__')
    ? customScenarioItems.find(item => `custom__${item.id}` === activeTab)
    : undefined;
  const activeRecoveryItem = activeTab.startsWith('recovery__')
    ? recoveryScenarioItems.find(item => `recovery__${item.id}` === activeTab)
    : undefined;
  const activeSavedItem = activeCustomItem ?? activeRecoveryItem;

  function refreshSavedScenarios() {
    setCustomScenarioItems(loadSavedCustomScenarios());
    setRecoveryScenarioItems(loadSavedRecoveryScenarios());
  }

  function updateActiveSavedScenarioType(nextType: SavedScenarioType) {
    if (activeCustomItem) {
      updateSavedCustomScenarioType(activeCustomItem.id, nextType);
    } else if (activeRecoveryItem) {
      updateSavedRecoveryScenarioType(activeRecoveryItem.id, nextType);
    }
    refreshSavedScenarios();
  }

  function removeActiveSavedScenario() {
    if (activeCustomItem) {
      deleteSavedCustomScenario(activeCustomItem.id);
    } else if (activeRecoveryItem) {
      deleteSavedRecoveryScenario(activeRecoveryItem.id);
    }
    refreshSavedScenarios();
    setActiveTab('s7');
  }

  function saveDirectScenario() {
    const directScenario = buildS7(
      assets,
      members,
      macro,
      s7GiftNowPct,
      s7UseCorp,
      s7CeoSalary,
      s7IncludeGrandchildren,
      s7UseFoundation,
      s7FoundationDonationPct,
      s7CorpContributionPct,
      s7AssetLtvMap,
      s7AssetInterestRateMap,
      s7RateShockPct,
      s7ScenarioType,
    );

    const feasibility = getScenarioFeasibility(directScenario, assets, members);

    const saved = saveCustomScenarioItem({
      giftNowPct: s7GiftNowPct,
      useCorp: s7UseCorp,
      ceoSalary: s7CeoSalary,
      includeGrandchildren: s7IncludeGrandchildren,
      useFoundation: s7UseFoundation,
      foundationDonationPct: s7FoundationDonationPct,
      corpContributionPct: s7CorpContributionPct,
      loanLtvPct: 0,
      assetLtvMap: s7AssetLtvMap,
      assetInterestRateMap: s7AssetInterestRateMap,
      rateShockPct: s7RateShockPct,
      scenarioType: s7ScenarioType,
    });
    refreshSavedScenarios();
    setActiveTab(`custom__${saved.id}`);
    setBestResult(feasibility.feasible
      ? `${s7ScenarioType} 시나리오를 저장했습니다.`
      : `${s7ScenarioType} 시나리오를 검토 초안으로 저장했습니다. 보완 필요: ${feasibility.reasons.join(' ')}`);
  }

  const savedTabs = [
    ...recoveryScenarioItems.map(item => {
      const id = `recovery__${item.id}`;
      return {
        id,
        label: savedScenarioLabels.get(id) ?? item.scenarioType ?? item.name,
        color: 'border-slate-500 text-slate-700',
      };
    }),
    ...customScenarioItems.map(item => {
      const id = `custom__${item.id}`;
      return {
        id,
        label: savedScenarioLabels.get(id) ?? item.scenarioType ?? item.name,
        color: 'border-stone-500 text-stone-700',
      };
    }),
  ].filter(tab => visibleScenarioIds.has(tab.id));

  const automaticTabs = [
    { id: 's6', label: '현금흐름', color: 'border-emerald-700 text-emerald-800' },
    { id: 's2', label: '절세', color: 'border-blue-600 text-blue-700' },
    { id: 's3', label: '균형', color: 'border-violet-600 text-violet-700' },
    { id: 's5', label: '법인', color: 'border-green-600 text-green-700' },
    { id: 's9', label: '부담부', color: 'border-teal-600 text-teal-700' },
  ].filter(tab => visibleScenarioIds.has(tab.id));

  const automaticScenarioMeta: Record<string, {
    reason: string;
    settings: string[];
  }> = {
    s2: {
      reason: `현재 추정 상속세 ${fmt(baseInheritTax)}에서 성장분을 먼저 분리할 절세 여력이 있어 기본 후보로 생성했습니다.`,
      settings: [
        '최적 증여액 자동 산출 (한계세율 분석 기반)',
        '현재 공제 한도 및 수증자 재원 반영',
        `선택 수증자 ${members.filter(member => member.relation !== '본인').length}명 기준`,
      ],
    },
    s3: {
      reason: '한 번에 과도하게 이전하지 않고 10년 뒤 공제 한도를 다시 쓰는 분산안이 실행 가능해 기본 후보로 생성했습니다.',
      settings: [
        '1차: 지금 최적 증여액 자동 산출',
        '2차: 10년 후 공제한도 리셋 후 재산출',
        '2차 실행 전 자산가치·수증자 재원 재검증',
      ],
    },
    s6: {
      reason: `상속세 재원 또는 현금흐름 부담이 감지되어 현금 확보를 우선하는 후보를 추가했습니다.`,
      settings: [
        `현재 연 순현금흐름 ${fmt(baselineAnnualCashflow)}`,
        `확인 유동재원 ${fmt(liquidFunding)}`,
        '매각·분배 후 세후 재투자 가정',
      ],
    },
    s5: {
      reason: `연 수익이 발생하는 자산 ${incomeBearingAssetCount}개가 있어 법인 운용 효과를 비교할 가치가 있어 후보로 생성했습니다.`,
      settings: [
        `현물출자 비율 ${s5TransferPct}%`,
        `대표이사 급여 ${fmt(s5CeoSalary)}/년`,
        '취득세·법인세·배당 과세를 함께 반영',
      ],
    },
    s9: {
      reason: '부동산이 있어 담보대출 → 가족 무이자 차용 → 부담부증여 → 연부연납을 결합한 혼합 구조를 비교할 수 있습니다.',
      settings: [
        `신규 담보대출 비율 ${s9LoanPct}% (최대 자산 기준)`,
        `가족 무이자 차용 인별 한도 약 ${maxInterestFreeLoanPrincipal().toFixed(2)}억 (상증세법 §41의4)`,
        '증여세 연부연납 5년 + 가산금 반영',
      ],
    },
  };
  const activeAutomaticMeta = automaticScenarioMeta[activeTab];

  const assignmentPlans = transferPlans.filter(isRecipientAssignmentPlan);
  const hasMyAssignment = assignmentPlans.some(p => p.asset_id);

  const TABS = [
    { id: 'optimal', label: '🎯 최적 전략', color: 'border-amber-500 text-amber-700' },
    ...(hasMyAssignment
      ? [{ id: 'my-assignment', label: '📋 내 배정대로', color: 'border-rose-500 text-rose-700' }]
      : []),
    ...automaticTabs,
    { id: 's7', label: '직접 설계', color: 'border-teal-500 text-teal-700' },
    ...(comparisonScenarios.length > 1
      ? [{ id: 'all', label: '★ 선택안 비교', color: 'border-gray-700 text-gray-800' }]
      : []),
  ];

  const TAB_ACTIVE_BG: Record<string, string> = {
    optimal: 'bg-amber-500', 'my-assignment': 'bg-rose-500',
    s1: 'bg-gray-500', s2: 'bg-blue-500', s3: 'bg-indigo-500',
    s4: 'bg-purple-500', s5: 'bg-green-500', s6: 'bg-orange-500',
    s7: 'bg-teal-500', s8: 'bg-emerald-500', s9: 'bg-teal-600', all: 'bg-gray-700',
  };

  // For comparison table rows
  const compRows: Array<{ label: string; key: keyof ScenarioCalc; format: (v: number) => string }> = [
    { label: '10년 후 순자산', key: 'netWealth10yr', format: fmt },
    { label: '20년 후 순자산', key: 'netWealth20yr', format: fmt },
    { label: '총 증여세', key: 'totalGiftTax', format: fmt },
    { label: '10년 보유세', key: 'holdingTax10yr', format: fmt },
    { label: '10년 후 상속세', key: 'inheritanceTaxAt10yr', format: fmt },
    { label: '양도소득세', key: 'cgtTotal', format: fmt },
    { label: '10년 총 세부담', key: 'totalTax10yr', format: fmt },
    { label: '연 순현금흐름', key: 'annualCashflowNow', format: fmt },
  ];

  const higherIsBetter: Record<string, boolean> = {
    netWealth10yr: true, netWealth20yr: true, annualCashflowNow: true,
    totalGiftTax: false, holdingTax10yr: false, inheritanceTaxAt10yr: false,
    cgtTotal: false, totalTax10yr: false,
  };

  return (
    <div className="main p-6 max-w-screen-xl min-h-screen" style={{ background: 'var(--bg)' }}>
      <StrategyFlowNav active="/dashboard/scenarios" />
      {/* Header */}
      <div className="page-header">
        <div>
          <div className="section-label">STEP 2 · SCENARIO ENGINE</div>
          <h1 className="page-title">시나리오 비교</h1>
          <p className="page-sub">현재 자산에서 실행 가능한 자동 후보만 추려 비교합니다. 최종 선택은 최적 전략 탭에서 확인하세요.</p>
        </div>
      </div>

      {/* KPI Header */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        {[
          { label: '총 자산', value: fmt(totalValue), sub: `부채 ${fmt(totalDebt)}` },
          { label: '추정 상속세 (현재)', value: fmt(baseInheritTax), sub: '현 자산 기준', valueClass: 'text-red-600' },
          { label: 'LTV', value: fmtPct(ltv), sub: ltv > 60 ? '⚠️ 높음' : '양호', valueClass: ltv > 60 ? 'text-orange-600' : 'text-green-600' },
          { label: 'DSCR', value: (Math.round(dscr * 100) / 100).toLocaleString('ko-KR'), sub: dscr < 1.2 ? '⚠️ 유의' : '양호', valueClass: dscr < 1.2 ? 'text-orange-600' : 'text-green-600' },
        ].map(({ label, value, sub, valueClass }) => (
          <div key={label} className="bg-white rounded-2xl shadow-sm p-4">
            <div className="text-xs text-gray-400 mb-1">{label}</div>
            <div className={`text-xl font-bold ${valueClass ?? 'text-gray-900'}`}>{value}</div>
            <div className="text-xs text-gray-400 mt-0.5">{sub}</div>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div className="flex flex-wrap gap-1 mb-6">
        {TABS.map(tab => {
          const isActive = activeTab === tab.id;
          const sc = scenarios.find(s => s.id === tab.id);
          return (
            <button key={tab.id} onClick={() => setActiveTab(tab.id)}
              className={`px-3 py-2 rounded-xl text-xs font-semibold border-2 transition-all ${
                isActive
                  ? `${TAB_ACTIVE_BG[tab.id] ?? 'bg-stone-800'} text-white border-transparent`
                  : `bg-white ${tab.color} hover:bg-gray-50`
              }`}>
              {tab.label}
              {sc?.isRecommended && !isActive && (
                <span className="ml-1 text-yellow-500">★</span>
              )}
            </button>
          );
        })}
        {savedTabs.length > 0 && (
          <select
            aria-label="저장한 시나리오 열기"
            value={activeSavedItem ? activeTab : ''}
            onChange={event => {
              if (event.target.value) setActiveTab(event.target.value);
            }}
            className="px-3 py-2 rounded-xl text-xs font-semibold border-2 border-stone-400 bg-white text-stone-700"
          >
            <option value="">저장한 설계안 ({savedTabs.length})</option>
            {savedTabs.map(tab => (
              <option key={tab.id} value={tab.id}>{tab.label}</option>
            ))}
          </select>
        )}
        <button onClick={findBestScenario}
          className="ml-auto px-3 py-2 rounded-xl text-xs font-semibold bg-yellow-50 text-yellow-700 border-2 border-yellow-300 hover:bg-yellow-100 transition-all">
          최적 시나리오 탐색
        </button>
      </div>

      <div className="mb-6 border border-stone-200 bg-white p-4">
        <div className="flex items-start justify-between gap-4 mb-3">
          <div>
            <div className="text-sm font-semibold text-stone-800">처음 표시되는 자동 유형</div>
            <p className="text-xs text-stone-500 mt-1 leading-5">
              절세형과 균형형을 먼저 검토하고, 재원 부족이 있으면 현금흐름형을,
              수익자산 운용 여지가 있으면 법인형을 추가합니다. 실행 불가 유형은 숨기며 최대 3개만 표시합니다.
            </p>
          </div>
          <span className="text-xs text-stone-500 whitespace-nowrap">{automaticTabs.length}개 후보</span>
        </div>
        <div className="grid gap-2 md:grid-cols-3">
          {automaticTabs.map(tab => {
            const meta = automaticScenarioMeta[tab.id];
            return (
              <button
                type="button"
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className="text-left border border-stone-200 p-3 hover:border-amber-500 transition-colors"
              >
                <div className="text-sm font-semibold text-stone-900">{tab.label}형</div>
                <div className="text-xs text-stone-500 mt-1 leading-5">{meta.reason}</div>
                <div className="mt-2 flex flex-wrap gap-1">
                  {meta.settings.map(setting => (
                    <span key={setting} className="text-[11px] bg-stone-100 text-stone-600 px-2 py-1">
                      {setting}
                    </span>
                  ))}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {bestResult && (
        <div className="mb-4 p-3 bg-yellow-50 rounded-xl border border-yellow-200 text-sm text-yellow-800 font-medium">
          {bestResult}
        </div>
      )}

      {/* All comparison tab */}
      {isAllTab && (
        <div className="bg-white rounded-2xl shadow-sm overflow-x-auto">
          <div className="p-4 border-b border-gray-100">
            <div className="text-sm font-semibold text-gray-700">전체 시나리오 비교</div>
          </div>
          <table className="w-full text-sm min-w-[700px]">
            <thead>
              <tr className="border-b border-gray-100">
                <th className="text-left text-xs text-gray-400 font-medium py-3 px-4">지표</th>
                {comparisonScenarios.map(s => (
                  <th key={s.id} className="text-center text-xs font-semibold py-3 px-2"
                    style={{ color: getScenarioColor(s.id) }}>
                    {s.label}
                    {s.isRecommended && <span className="ml-1">★</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {compRows.map(row => {
                const vals = comparisonScenarios.map(s => s[row.key] as number);
                const best = higherIsBetter[row.key]
                  ? Math.max(...vals)
                  : Math.min(...vals);
                return (
                  <tr key={row.label} className="hover:bg-gray-50">
                    <td className="py-2.5 px-4 text-xs text-gray-500 whitespace-nowrap">{row.label}</td>
                    {comparisonScenarios.map((s, i) => {
                      const val = s[row.key] as number;
                      const isBest = val === best;
                      return (
                        <td key={s.id} className={`py-2.5 px-2 text-center text-xs font-medium rounded ${
                          isBest ? 'bg-green-50 text-green-700 font-bold' : 'text-gray-700'
                        } ${val < 0 ? 'text-red-600' : ''}`}>
                          {row.format(val)}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
              <tr className="border-t border-gray-200">
                <td className="py-2.5 px-4 text-xs text-gray-500">복잡도</td>
                {comparisonScenarios.map(s => (
                  <td key={s.id} className="py-2.5 px-2 text-center">
                    <span className={`text-xs px-1.5 py-0.5 rounded-full ${
                      s.complexity === 'low' ? 'bg-green-100 text-green-700'
                      : s.complexity === 'medium' ? 'bg-yellow-100 text-yellow-700'
                      : 'bg-red-100 text-red-700'
                    }`}>
                      {s.complexity === 'low' ? '낮음' : s.complexity === 'medium' ? '중간' : '높음'}
                    </span>
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {/* ── TOP 3 추천 + 비추천 전략 ── */}
      {isAllTab && (() => {
        const ranked = scenarios
          .filter(s => s.id !== 's1')
          .map(s => ({ s, f: getScenarioFeasibility(s, assets, members) }))
          .map(({ s, f }) => ({ s, f, stars: getExecutionStars(s, f) }));
        const top3 = ranked
          .filter(r => r.f.feasible)
          .sort((a, b) => (b.s.netWealth10yr - a.s.netWealth10yr) || (b.stars - a.stars))
          .slice(0, 3);
        const notRecommended = ranked
          .filter(r => !r.f.feasible)
          .slice(0, 3);
        const baseline = scenarios.find(s => s.id === 's1');
        if (top3.length === 0 && notRecommended.length === 0) return null;
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 16 }}>
            {top3.length > 0 && (
              <div style={{ border: '1px solid var(--line)', background: 'var(--bg)' }}>
                <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--line)' }}>
                  <div style={{ fontSize: 11, letterSpacing: '0.14em', color: 'var(--gold-deep)', marginBottom: 2 }}>FINAL RECOMMENDATION</div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--ink)' }}>최종 추천 TOP {top3.length}</div>
                </div>
                {top3.map(({ s, f, stars }, i) => (
                  <div key={s.id} style={{ padding: '14px 16px', borderBottom: i < top3.length - 1 ? '1px solid var(--line)' : 'none' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                      <span style={{
                        width: 22, height: 22, background: 'var(--ink)', color: '#F2EFE7',
                        fontSize: 12, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                      }}>{i + 1}</span>
                      <span style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--ink)' }}>{s.icon} {s.label}</span>
                      <StarRating n={stars} />
                      <button onClick={() => setActiveTab(s.id)} style={{
                        marginLeft: 'auto', border: '1px solid var(--line-strong)', background: 'var(--bg)',
                        color: 'var(--ink-soft)', padding: '4px 10px', fontSize: 11, fontWeight: 600, cursor: 'pointer',
                      }}>상세 →</button>
                    </div>
                    <div style={{ fontSize: 12.5, color: 'var(--ink-soft)', lineHeight: 1.6, paddingLeft: 32 }}>
                      {s.tagline}
                      {baseline && (
                        <> · 단순 상속 대비 10년 순자산 <strong style={{ color: 'var(--green-ink)' }}>
                          {s.netWealth10yr >= baseline.netWealth10yr ? '+' : ''}{fmt(s.netWealth10yr - baseline.netWealth10yr)}
                        </strong></>
                      )}
                      {' '}· 총세금 {fmt(s.totalTax10yr)} · 연 현금흐름 {fmt(f.annualCashflow)}
                    </div>
                  </div>
                ))}
              </div>
            )}
            {notRecommended.length > 0 && (
              <div style={{ border: '1px solid var(--line)', background: 'var(--paper-sink)' }}>
                <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--line)' }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink-soft)' }}>추천하지 않는 전략</div>
                </div>
                {notRecommended.map(({ s, f }) => (
                  <div key={s.id} style={{ padding: '10px 16px', display: 'flex', flexDirection: 'column', gap: 3 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--ink-soft)' }}>{s.icon} {s.label}</div>
                    {f.reasons.map(r => (
                      <div key={r} style={{ fontSize: 12, color: 'var(--red)', paddingLeft: 8 }}>· {r}</div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })()}

      {/* ── 🎯 최적 전략 탭 ── */}
      {isOptimalTab && executableOptimalResult && (() => {
        const { unconfirmedDependencies } = getOptimalStrategyFeasibility(executableOptimalResult);
        return unconfirmedDependencies.length > 0 ? (
          <div style={{ border: '1px solid var(--red)', background: 'var(--red-tint)', padding: '12px 16px', marginBottom: 4 }}>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--red)', marginBottom: 6 }}>
              ⚠ 이 계획은 아직 확정되지 않은 전제에 의존합니다 — &ldquo;실행 가능&rdquo;은 이 조건들이 충족된다는 가정입니다
            </div>
            {unconfirmedDependencies.map(dep => (
              <div key={dep} style={{ fontSize: 12, color: 'var(--red)' }}>· {dep}</div>
            ))}
          </div>
        ) : null;
      })()}
      {isOptimalTab && executableOptimalResult && (
        <OptimalStrategyPanel
          result={executableOptimalResult}
          ownCash={ownCash}
          optCashOverride={optCash}
          onCashChange={setOptCash}
          dbCash={dbCashTotal}
          ltvMap={ltvMap}
          onLtvChange={(assetId, pct) => setLtvMap(prev => ({ ...prev, [assetId]: pct }))}
          onRiskResult={setLiftedRisk}
        />
      )}
      {isOptimalTab && executableOptimalResult && (
        <S7BalanceSheetImpact inputs={optimalBalanceSheetInputs} onResult={setLiftedLeverage} />
      )}
      {isOptimalTab && executableOptimalResult && (
        <ScenarioSummaryCard
          scenario={{
            label: '최적 전략',
            netWealth10yr: executableOptimalResult.estateAfterGifts10yr - executableOptimalResult.inheritanceTaxAt10yrOptimized,
            totalTax10yr: executableOptimalResult.totalGiftTax + executableOptimalResult.inheritanceTaxAt10yrOptimized,
          }}
          risk={liftedRisk}
          leverage={liftedLeverage}
        />
      )}
      {isOptimalTab && !executableOptimalResult && optimalCandidates.length > 0 && (
        <div style={{
          border: '1px solid var(--amber)',
          padding: 24,
          background: 'var(--paper)',
        }}>
          <div style={{
            fontSize: 11,
            letterSpacing: '0.14em',
            color: 'var(--gold-deep)',
            marginBottom: 8,
          }}>
            EXECUTABLE PLAN REQUIRED
          </div>
          <h2 style={{ fontSize: 20, fontWeight: 700, color: 'var(--ink)', marginBottom: 8 }}>
            현재 조건에서 자동 추천 가능한 실행안이 없습니다
          </h2>
          <p style={{ fontSize: 13, lineHeight: 1.7, color: 'var(--ink-muted)', marginBottom: 12 }}>
            절세액만 큰 안은 추천하지 않습니다. 즉시 납부 재원, 대출 이자 반영 후 현금흐름,
            향후 상속세 재원을 모두 통과한 안만 최적 전략으로 표시합니다.
          </p>
          <div style={{ display: 'grid', gap: 6, marginBottom: 16 }}>
            {optimalFailureReasons.map(reason => (
              <div key={reason} style={{ fontSize: 12.5, color: 'var(--red)' }}>· {reason}</div>
            ))}
          </div>
          <button type="button" onClick={() => setActiveTab('s7')} className="slp-save-btn">
            직접 설계에서 실행안 만들기
          </button>
        </div>
      )}

      {activeTab === 'my-assignment' && (
        <MyAssignmentPanel assets={assets} members={members} assignmentPlans={assignmentPlans} />
      )}

      {/* Individual scenario view */}
      {!isAllTab && !isOptimalTab && selectedScenario && (
        <>
        <div className="scen-detail">
          {/* Left: Param panel */}
          <div className="scen-left">
            <div className="slp">
              <div className="slp-head">
                <div className="slp-icon-row">
                  <span className="slp-icon">{selectedScenario.icon}</span>
                  <div>
                    <div className="slp-name">{selectedScenario.label}</div>
                    <div className="slp-tag">{selectedScenario.tagline}</div>
                  </div>
                  {selectedScenario.isRecommended && (
                    <span className="slp-rec">★ 추천</span>
                  )}
                </div>
                <span className={`slp-cx ${selectedScenario.complexity}`}>
                  복잡도 {selectedScenario.complexity === 'low' ? '낮음' : selectedScenario.complexity === 'medium' ? '중간' : '높음'}
                </span>
              </div>
              <div className="slp-body">

              {activeAutomaticMeta && (
                <div className="slp-saved">
                  <div className="sl-lbl" style={{ fontWeight: 700, color: 'var(--ink-soft)' }}>
                    이 유형이 생성된 이유
                  </div>
                  <div className="slp-note" style={{ marginBottom: 10 }}>
                    {activeAutomaticMeta.reason}
                  </div>
                  <div className="sl-lbl">현재 적용값</div>
                  <div style={{ display: 'grid', gap: 6 }}>
                    {activeAutomaticMeta.settings.map(setting => (
                      <div key={setting} className="slp-note">· {setting}</div>
                    ))}
                  </div>
                </div>
              )}

              {activeSavedItem && (
                <div className="slp-saved">
                  <div className="sl-lbl" style={{ fontWeight: 700, color: 'var(--ink-soft)' }}>저장된 시나리오 관리</div>
                  <label className="sl-lbl">시나리오 유형</label>
                  <select
                    value={activeSavedItem.scenarioType ?? '균형형'}
                    onChange={event => updateActiveSavedScenarioType(event.target.value as SavedScenarioType)}
                  >
                    {SAVED_SCENARIO_TYPES.map(type => (
                      <option key={type} value={type}>{type}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={removeActiveSavedScenario}
                    className="del-btn"
                  >
                    이 시나리오 삭제
                  </button>
                </div>
              )}

              {/* Params by scenario */}
              {activeTab === 's1' && (
                <div className="slp-note">현재 데이터 기반 예측. 파라미터 없음.</div>
              )}
              {activeTab === 's2' && (
                <div>
                  {executableOptimalResult && executableOptimalResult.giftPlans.length > 0 ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <div className="flab">최적 추천 증여액</div>
                      {executableOptimalResult.giftPlans.map(p => (
                        <div key={p.memberId} style={{
                          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                          padding: '8px 10px', border: '1px solid var(--line)', background: 'var(--paper)',
                          fontSize: 12,
                        }}>
                          <span style={{ fontWeight: 600 }}>{p.memberName} ({p.relation})</span>
                          <span style={{ color: 'var(--gold-deep)', fontWeight: 700 }}>{fmt(p.giftAmount)}</span>
                        </div>
                      ))}
                      <div className="slp-note">증여세 합계 {fmt(executableOptimalResult.totalGiftTax)} · 순절세 {fmt(executableOptimalResult.netSavingAfterGiftTax)}</div>
                    </div>
                  ) : (
                    <div className="slp-note">최적 증여액 자동 산출 — 자산·가족 데이터 기반</div>
                  )}
                </div>
              )}
              {activeTab === 's3' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {executableOptimalResult && executableOptimalResult.giftPlans.length > 0 ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <div className="flab">1차 증여 (즉시)</div>
                      {executableOptimalResult.giftPlans.map(p => (
                        <div key={p.memberId} style={{
                          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                          padding: '8px 10px', border: '1px solid var(--line)', background: 'var(--paper)',
                          fontSize: 12,
                        }}>
                          <span style={{ fontWeight: 600 }}>{p.memberName}</span>
                          <span style={{ color: 'var(--gold-deep)', fontWeight: 700 }}>{fmt(p.giftAmount)}</span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  <div className="slp-note">2차 증여: 10년 후 공제한도 리셋 후 자동 재산출</div>
                </div>
              )}
              {activeTab === 's4' && (
                <div className="space-y-3">
                  <Slider label="손자녀 증여 비율 (%)" value={s4SkipPct} min={0} max={100} step={5} onChange={setS4SkipPct} />
                  {members.filter(m => m.relation === '손자녀').length === 0 && (
                    <div className="slp-note">손자녀가 없습니다. 가상 계산 표시.</div>
                  )}
                  <div className="slp-note">세대생략 30% 할증세율 자동 적용</div>
                </div>
              )}
              {activeTab === 's5' && (
                <div className="space-y-3">
                  <div className="space-y-1">
                    <div style={{ fontSize: 12, color: 'var(--ink-faint)', marginBottom: 4 }}>대표이사 급여 (억/년)</div>
                    <input type="number" step={0.1} min={0} max={10} value={s5CeoSalary}
                      onChange={e => setS5CeoSalary(Number(e.target.value))} />
                  </div>
                  <Slider label="현물출자 비율 (%)" value={s5TransferPct} min={10} max={100} step={10} onChange={setS5TransferPct} />
                </div>
              )}
              {activeTab === 's6' && (
                <div className="slp-note">전 자산 매각 후 분배. 파라미터 없음.</div>
              )}
              {activeTab === 's9' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <Slider label="신규 담보대출 비율 (%)" value={s9LoanPct} min={5} max={50} step={5} onChange={setS9LoanPct} />
                  <div className="slp-note">
                    가장 큰 부동산 시가 대비 신규 대출 비율.
                    대출금은 가족에게 인별 {maxInterestFreeLoanPrincipal().toFixed(2)}억까지 무이자 차용 배분 가능 (상증세법 §41의4).
                  </div>
                  <div className="slp-note" style={{ color: 'var(--red)' }}>
                    ⚠ 채무 인수 인정에는 수증자의 상환능력 증빙 필수. 차용증에 만기·상환방법 명시. 세무사 확인 필수.
                  </div>
                </div>
              )}
              {(activeTab === 's8' || activeRecoveryItem) && (
                <div className="space-y-2">
                  <div className="slp-note" style={{ color: 'var(--green-ink)', fontWeight: 600 }}>
                    전략 페이지에서 선택한 {(activeRecoveryItem?.selectedStrategyIds ?? myPlanStrategyIds).length}가지 전략의 복합 효과를 시뮬레이션합니다.
                  </div>
                  <div className="slp-checklist">
                    {(activeRecoveryItem?.selectedStrategyIds ?? myPlanStrategyIds).map(id => {
                      const labels: Record<string, string> = {
                        immediate_gift_growth: '즉시 증여 — 자산 성장분 상속세 제외',
                        family_loan: '가족 차용증',
                        charity_foundation: '공익법인(재단) 출연',
                        corp_conversion: '법인 전환',
                        dil_5yr_lookback: '며느리·사위 즉시 증여',
                        installment: '연부연납 10년',
                        life_insurance: '생명보험',
                        spouse_deduction: '배우자 공제 최대화',
                      };
                      return (
                        <div key={id} className="sc-item">
                          <span className="mark">✓</span>
                          {labels[id] ?? id}
                        </div>
                      );
                    })}
                  </div>
                  <a href="/dashboard/strategy" className="slp-link">
                    전략 페이지에서 수정 →
                  </a>
                </div>
              )}
              {activeTab === 's7' && (
                <div className="space-y-3">
                  <Slider label="지금 증여 비율 (%)" value={s7GiftNowPct} min={0} max={100} step={1} onChange={setS7GiftNowPct} />
                  <Slider
                    label="금리 스트레스 (+%p)"
                    value={s7RateShockPct}
                    min={0}
                    max={8}
                    step={0.1}
                    onChange={setS7RateShockPct}
                  />
                  <div>
                    <label style={{ fontSize: 12, color: 'var(--ink-faint)', display: 'block', marginBottom: 4 }}>저장 유형</label>
                    <select
                      value={s7ScenarioType}
                      onChange={event => setS7ScenarioType(event.target.value as SavedScenarioType)}
                    >
                      {SAVED_SCENARIO_TYPES.map(type => (
                        <option key={type} value={type}>{type}</option>
                      ))}
                    </select>
                  </div>
                  <div className="slp-toggle-row">
                    <span className="tl">법인 전환 포함</span>
                    <button onClick={() => setS7UseCorp(!s7UseCorp)} className={`slp-toggle${s7UseCorp ? ' on' : ''}`}>
                      <div className="tog-dot" />
                    </button>
                  </div>
                  {s7UseCorp && (
                    <>
                      <Slider
                        label="법인 출자 비율 (%)"
                        value={s7CorpContributionPct}
                        min={0}
                        max={100}
                        step={1}
                        onChange={setS7CorpContributionPct}
                      />
                      <div>
                        <div style={{ fontSize: 12, color: 'var(--ink-faint)', marginBottom: 4 }}>대표이사 급여 (억/년)</div>
                        <input type="number" step={0.1} min={0} max={10} value={s7CeoSalary}
                          onChange={e => setS7CeoSalary(Number(e.target.value))} />
                      </div>
                    </>
                  )}
                  <div className="slp-toggle-row">
                    <span className="tl">손자녀 포함</span>
                    <button onClick={() => setS7IncludeGrandchildren(!s7IncludeGrandchildren)} className={`slp-toggle${s7IncludeGrandchildren ? ' on' : ''}`}>
                      <div className="tog-dot" />
                    </button>
                  </div>
                  <div className="slp-toggle-row">
                    <span className="tl">공익재단 출연 포함</span>
                    <button onClick={() => setS7UseFoundation(!s7UseFoundation)} className={`slp-toggle${s7UseFoundation ? ' on' : ''}`}>
                      <div className="tog-dot" />
                    </button>
                  </div>
                  {s7UseFoundation && (
                    <Slider
                      label="공익재단 출연 비율 (%)"
                      value={s7FoundationDonationPct}
                      min={0}
                      max={100}
                      step={1}
                      onChange={setS7FoundationDonationPct}
                    />
                  )}
                  <div style={{ borderTop: '1px solid var(--line)', paddingTop: 14, marginTop: 4 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--ink)', marginBottom: 6 }}>자산별 대출 설정</div>
                    <div style={{ fontSize: 11.5, color: 'var(--ink-faint)', marginBottom: 10, lineHeight: 1.6 }}>
                      신규 대출은 증여세·취득세 재원을 먼저 충당하고, 남는 금액만 자산 운용 재원으로 반영합니다.
                    </div>
                    <div className="space-y-3">
                      {assets.filter(asset => LEVERAGE_ASSET_TYPES.has(asset.asset_type)).map(asset => {
                        const currentLtv = asset.current_value > 0
                          ? Math.round(((asset.loan_amount || 0) / asset.current_value) * 100)
                          : 0;
                        const targetLtv = s7AssetLtvMap[asset.id] ?? currentLtv;
                        const interestRate = s7AssetInterestRateMap[asset.id]
                          ?? asset.loan_rate_pct
                          ?? getMacro(macro).base_rate_pct;
                        return (
                          <div key={asset.id} style={{ border: '1px solid var(--line)', padding: '10px 12px', background: 'var(--paper)' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8, gap: 8 }}>
                              <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--ink)' }}>{asset.name}</span>
                              <span style={{ fontSize: 11, color: 'var(--ink-faint)', whiteSpace: 'nowrap' }}>
                                현재 LTV {currentLtv}% · 대출 {fmt(asset.loan_amount || 0)}
                              </span>
                            </div>
                            <Slider
                              label="목표 LTV (%)"
                              value={targetLtv}
                              min={0}
                              max={70}
                              step={1}
                              onChange={value => setS7AssetLtvMap(prev => ({ ...prev, [asset.id]: value }))}
                            />
                            <div style={{ marginTop: 8 }}>
                              <div style={{ fontSize: 11.5, color: 'var(--ink-faint)', marginBottom: 4 }}>기준 금리 (%)</div>
                              <input
                                type="number"
                                min={0}
                                max={30}
                                step={0.1}
                                value={interestRate}
                                onChange={e => setS7AssetInterestRateMap(prev => ({
                                  ...prev,
                                  [asset.id]: Number(e.target.value),
                                }))}
                              />
                              <div style={{ fontSize: 11, color: 'var(--ink-faint)', marginTop: 5 }}>
                                스트레스 반영 적용 금리 {(interestRate + s7RateShockPct).toFixed(1)}%
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                  {directFeasibility && (
                    <div className={`slp-feasibility ${directFeasibility.feasible ? 'is-pass' : 'is-review'}`}>
                      <div className="slp-feasibility-head">
                        <div>
                          <div className="slp-feasibility-eyebrow">EXECUTION CHECK</div>
                          <div className="slp-feasibility-title">실행 가능성 진단</div>
                        </div>
                        <span className="slp-feasibility-status">
                          {directFeasibility.feasible ? '실행 가능' : '검토 필요'}
                        </span>
                      </div>
                      <p className="slp-feasibility-desc">
                        아래 세 조건을 모두 충족하면 실행 가능으로 판정합니다. 판정 결과와 관계없이 시나리오는 검토 초안으로 저장할 수 있습니다.
                      </p>
                      <div className="slp-feasibility-grid">
                        <div className={`slp-feasibility-check ${directFeasibility.fundingGap <= 0.01 ? 'pass' : 'fail'}`}>
                          <span className="check-mark">{directFeasibility.fundingGap <= 0.01 ? '✓' : '!'}</span>
                          <div>
                            <strong>즉시 재원</strong>
                            <span>필요 {fmt(directFeasibility.immediateNeed)} · 확인 {fmt(directFeasibility.availableFunding)}</span>
                            <small>부족액 {fmt(directFeasibility.fundingGap)} 이하일 때 충족</small>
                          </div>
                        </div>
                        <div className={`slp-feasibility-check ${directFeasibility.annualCashflow >= -0.01 ? 'pass' : 'fail'}`}>
                          <span className="check-mark">{directFeasibility.annualCashflow >= -0.01 ? '✓' : '!'}</span>
                          <div>
                            <strong>연간 현금흐름</strong>
                            <span>{fmt(directFeasibility.annualCashflow)}/년</span>
                            <small>연 적자가 0.01억을 넘지 않을 때 충족</small>
                          </div>
                        </div>
                        <div className={`slp-feasibility-check ${Number.isFinite(directFeasibility.netWealth10yr) && directFeasibility.netWealth10yr > 0 ? 'pass' : 'fail'}`}>
                          <span className="check-mark">{Number.isFinite(directFeasibility.netWealth10yr) && directFeasibility.netWealth10yr > 0 ? '✓' : '!'}</span>
                          <div>
                            <strong>10년 세후 순자산</strong>
                            <span>{fmt(directFeasibility.netWealth10yr)}</span>
                            <small>0보다 크고 계산 가능한 값일 때 충족</small>
                          </div>
                        </div>
                      </div>
                      {!directFeasibility.feasible && directFeasibility.reasons.map(reason => (
                        <div key={reason} className="slp-feasibility-reason">
                          {reason}
                        </div>
                      ))}
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={saveDirectScenario}
                    className="slp-save-btn"
                  >
                    {directFeasibility?.feasible
                      ? '이 설계를 시나리오로 저장'
                      : '검토 시나리오로 저장'}
                  </button>
                </div>
              )}
            </div>
            </div>

            {/* Pros / Cons */}
            <div className="slp-pc">
              <div className="pc-title">장단점</div>
              {selectedScenario.pros.map((p, i) => (
                <div key={i} className="pc-row">
                  <span className="mk pro">✓</span>
                  <span>{p}</span>
                </div>
              ))}
              <hr className="pc-sep" />
              {selectedScenario.cons.map((c, i) => (
                <div key={i} className="pc-row">
                  <span className="mk con">✗</span>
                  <span>{c}</span>
                </div>
              ))}
            </div>

            {/* Actions */}
            <div className="slp-act">
              <div className="act-title">핵심 액션</div>
              {selectedScenario.actions.map((a, i) => (
                <div key={i} className="act-row">
                  <div className="act-num">{i + 1}</div>
                  <span className="act-txt">{a}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Right: Charts + tables */}
          <div className="scen-right">

            {/* 법인전환 자동 추천 배너 */}
            {shouldRecommendCorp && (
              <div style={{
                border: '1px solid var(--gold)',
                background: 'var(--gold-tint)',
                padding: '12px 16px',
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 15 }}>🏢</span>
                  <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--gold-deep)' }}>법인전환 추천</span>
                </div>
                <div style={{ fontSize: 12, color: 'var(--ink)', lineHeight: 1.6 }}>
                  연 임대수익 {fmt(annualRentalTotal)}이 발생하고 있습니다.
                  법인전환 시 10년 순자산이 즉시 분산증여보다{' '}
                  <strong>{fmt((s5Scenario?.netWealth10yr ?? 0) - (s2Scenario?.netWealth10yr ?? 0))} 더 유리</strong>합니다.
                  <br />
                  증여세 · 상속세 · 양도세를 종합 고려한 결과 — 법인설립 후 주식 점진 증여 + 재투자 구조를 검토하세요.
                </div>
                <button
                  onClick={() => setActiveTab('s5')}
                  style={{
                    alignSelf: 'flex-start',
                    border: '1px solid var(--gold-deep)',
                    background: 'var(--ink)',
                    color: '#F2EFE7',
                    padding: '6px 14px',
                    fontSize: 11.5,
                    fontWeight: 700,
                    cursor: 'pointer',
                  }}
                >
                  법인전환 시나리오 보기 →
                </button>
              </div>
            )}

            {/* Net wealth chart */}
            <div style={{ border: '1px solid var(--line)', background: 'var(--bg)', padding: '14px 16px' }}>
              <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--ink)', marginBottom: 2 }}>순자산 추이 비교 (상속 시점 가정)</div>
              <div style={{ fontSize: 12, color: 'var(--ink-faint)', marginBottom: 12 }}>선택 시나리오 강조 표시 | 단위: 억원</div>
              {/* Legend */}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 14px', marginBottom: 12 }}>
                {chartScenarios.map(s => (
                  <button key={s.id} onClick={() => setActiveTab(s.id)}
                    style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                    <div style={{ width: 10, height: 10, backgroundColor: getScenarioColor(s.id), opacity: s.id === activeTab ? 1 : 0.35, flexShrink: 0 }} />
                    <span style={{ color: s.id === activeTab ? 'var(--ink)' : 'var(--ink-faint)', fontWeight: s.id === activeTab ? 700 : 400 }}>{s.label}</span>
                  </button>
                ))}
              </div>
              <NetWealthChart scenarios={chartScenarios} years={TIMELINE_YEARS} selectedId={activeTab} />
            </div>

            {/* Timeline table */}
            <div style={{ border: '1px solid var(--line)', background: 'var(--bg)', overflowX: 'auto' }}>
              <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--line)' }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)' }}>연도별 타임라인</div>
              </div>
              <table style={{ width: '100%', fontSize: 12, minWidth: 560, borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--line)' }}>
                    <th style={{ textAlign: 'left', color: 'var(--ink-faint)', fontWeight: 600, padding: '8px 16px' }}>지표</th>
                    {[0, 3, 5, 10, 20].map(yr => (
                      <th key={yr} style={{ textAlign: 'right', color: 'var(--ink-soft)', fontWeight: 600, padding: '8px 12px' }}>
                        {yr === 0 ? '지금' : `${yr}년`}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[
                    { label: '총 자산가치', key: 'totalAssetValue' as keyof YearSnapshot, positive: true },
                    { label: '잔여 자산', key: 'remainingAssetValue' as keyof YearSnapshot, positive: true },
                    { label: '누적 증여세', key: 'cumulativeGiftTax' as keyof YearSnapshot, positive: false },
                    { label: '누적 보유세', key: 'cumulativeHoldingTax' as keyof YearSnapshot, positive: false },
                    { label: '추정 상속세', key: 'inheritanceTaxIfNow' as keyof YearSnapshot, positive: false },
                    { label: '순자산', key: 'netWealthIfInheritNow' as keyof YearSnapshot, positive: true },
                    { label: '연 순현금흐름', key: 'annualNetCashflow' as keyof YearSnapshot, positive: true },
                  ].map(row => (
                    <tr key={row.label} style={{ borderTop: '1px solid var(--line)', background: row.label === '순자산' ? 'var(--paper)' : 'transparent' }}>
                      <td style={{ padding: '8px 16px', color: 'var(--ink-soft)', whiteSpace: 'nowrap', fontWeight: row.label === '순자산' ? 700 : 400 }}>{row.label}</td>
                      {[0, 3, 5, 10, 20].map(yr => {
                        const snap = selectedScenario.snapshots.find(s => s.year === yr);
                        const val = snap ? (snap[row.key] as number) : 0;
                        return (
                          <td key={yr} style={{ padding: '8px 12px', textAlign: 'right', color: val < 0 ? 'var(--red)' : row.positive ? 'var(--ink)' : 'var(--ink-soft)', fontWeight: row.label === '순자산' ? 700 : 400 }}>
                            {fmt(val)}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                  {/* Events row */}
                  <tr style={{ borderTop: '1px solid var(--line)' }}>
                    <td style={{ padding: '8px 16px', color: 'var(--ink-soft)' }}>주요 이벤트</td>
                    {[0, 3, 5, 10, 20].map(yr => {
                      const snap = selectedScenario.snapshots.find(s => s.year === yr);
                      return (
                        <td key={yr} style={{ padding: '8px 12px', textAlign: 'right', color: 'var(--gold-deep)' }}>
                          {snap?.events.join(', ') || '—'}
                        </td>
                      );
                    })}
                  </tr>
                </tbody>
              </table>
            </div>

            {/* Tax breakdown */}
            <div style={{ border: '1px solid var(--line)', background: 'var(--bg)', padding: '14px 16px' }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)', marginBottom: 12 }}>세금 내역 (10년 기준)</div>
              {(() => {
                const bars = [
                  { label: '증여세', value: selectedScenario.totalGiftTax, barColor: 'var(--ink-soft)' },
                  { label: '양도세', value: selectedScenario.cgtTotal, barColor: 'var(--amber)' },
                  { label: '10년 보유세', value: selectedScenario.holdingTax10yr, barColor: 'var(--gold)' },
                  { label: '상속세 (10년 후)', value: selectedScenario.inheritanceTaxAt10yr, barColor: 'var(--red)' },
                ];
                const total = bars.reduce((s, b) => s + b.value, 0) || 1;
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {bars.map(b => (
                      <div key={b.label} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <div style={{ width: 76, fontSize: 11.5, color: 'var(--ink-faint)', textAlign: 'right', flexShrink: 0 }}>{b.label}</div>
                        <div style={{ flex: 1, height: 12, background: 'var(--paper-sink)', overflow: 'hidden' }}>
                          <div style={{ width: `${Math.min(100, (b.value / total) * 100)}%`, height: '100%', background: b.barColor, transition: 'width 0.3s' }} />
                        </div>
                        <div style={{ width: 60, fontSize: 12, fontWeight: 600, color: 'var(--ink)', textAlign: 'right' }}>{fmt(b.value)}</div>
                      </div>
                    ))}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingTop: 8, borderTop: '1px solid var(--line)' }}>
                      <div style={{ width: 76, fontSize: 12, fontWeight: 700, color: 'var(--ink)', textAlign: 'right' }}>합계</div>
                      <div style={{ flex: 1 }} />
                      <div style={{ width: 60, fontSize: 13, fontWeight: 700, color: 'var(--ink)', textAlign: 'right' }}>{fmt(selectedScenario.totalTax10yr)}</div>
                    </div>
                  </div>
                );
              })()}
            </div>
          </div>
        </div>

        {/* 실행계획·리스크·레버리지·종합 리포트 — 280px 좁은 사이드바에 밀어넣지 않고
            전체 폭으로 따로 뺐다 (예전엔 이 무거운 콘텐츠가 .scen-left 안에 눌려있었음).
            번호가 매겨진 하나의 흐름으로 이어 보이게, 세로선으로 연결한다. */}
        <FlowSteps
          items={[
            {
              key: 'exec', label: '실행 계획', sub: '이 시나리오를 실제로 진행하는 순서',
              node: (
                <ScenarioExecutionPanel
                  scenarioId={activeCustomItem ? 's7' : activeRecoveryItem ? 's8' : activeTab}
                  scenario={selectedScenario}
                  assets={assets}
                  members={members}
                />
              ),
            },
            ...(activeTab === 's7' || activeTab === 's9' ? [{
              key: 'risk', label: '실현 가능성 · 세무상 설명부담', sub: '백엔드 리스크 엔진이 이 옵션 조합을 다시 채점',
              node: (
                <BackendRiskPanel
                  request={activeTab === 's7' ? s7RiskRequest : s9RiskRequest}
                  onResult={setLiftedRisk}
                />
              ),
            }] : []),
            ...(activeTab === 's7' || activeTab === 's9' || activeTab === 's5' ? [{
              key: 'leverage', label: '레버리지 · 자산배분 영향', sub: '실행 전/후 가족 대차대조표 비교',
              node: (
                <>
                  {activeTab === 's7' && <S7BalanceSheetImpact inputs={s7BalanceSheetInputs} onResult={setLiftedLeverage} />}
                  {activeTab === 's9' && <S7BalanceSheetImpact inputs={s9BalanceSheetInputs} onResult={setLiftedLeverage} />}
                  {activeTab === 's5' && <S7BalanceSheetImpact inputs={s5BalanceSheetInputs} onResult={setLiftedLeverage} />}
                </>
              ),
            }] : []),
            ...(selectedScenario ? [{
              key: 'summary', label: '종합 요약', sub: '위 항목들을 하나로 합친 요약 — 규칙 기반, 실제 실행 전 세무사 확인 필수',
              node: (
                <ScenarioSummaryCard
                  scenario={{
                    label: selectedScenario.label,
                    netWealth10yr: selectedScenario.netWealth10yr,
                    totalTax10yr: selectedScenario.totalTax10yr,
                  }}
                  risk={liftedRisk}
                  leverage={liftedLeverage}
                />
              ),
            }] : []),
            {
              key: 'report', label: '종합 실행 로드맵', sub: '평가방법·거주자판정·현금흐름까지 한 문서로 (다운로드 가능)',
              node: (
                <ScenarioRoadmapReport
                  scenario={selectedScenario}
                  assets={assets}
                  members={members}
                  macro={macro}
                />
              ),
            },
          ]}
        />
        </>
      )}

      <div className="callout is-legal" style={{ marginTop: 24 }}>
        <strong>법률 주의.</strong> 시나리오는 현재 자산·가족 데이터 기반 추정치입니다. 실제 절세 전략 실행 전 세무사 상담을 권장합니다. · 세부담률 {fmtPct(taxBurdenPct)} (상속세/총자산)
      </div>
    </div>
  );
}

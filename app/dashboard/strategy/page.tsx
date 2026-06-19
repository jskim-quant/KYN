'use client';
import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase';
import { Asset, FamilyMember, MacroSettings, TransferPlan } from '@/types';
import {
  calcDonorUrgency, calcEstateBracketAnalysis,
  generatePhasedGiftPlan,
  calcRecoveryPlan, calcRecoveryStrategies, calcInheritanceTax,
  PhasedGiftPlan, GiftPhase, PhaseRecipient,
  RecoveryPlanAnalysis, RecoveryStrategy, ExecutionStep,
  PublicFoundationScenario, CorpConversionScenarioResult,
  CustomScenarioConfig, CustomScenarioResult, CustomAssetTransfer,
  calcPublicFoundationScenario, calcCorpConversionScenario, calcCustomScenario,
  calcGiftTax, calcAdjustedTaxFromStrategies, AdjustedTaxResult,
  getAssetGrowthRate, calcAcquisitionTax,
} from '@/lib/tax';
import { KynLoader } from '@/app/dashboard/components/KynLoader';
import { TransferPlanSummaryCard } from '@/app/dashboard/components/TransferPlanSummary';
import {
  clearSavedRecoveryScenario,
  loadSavedRecoveryScenario,
  loadSavedRecoveryScenarios,
  saveRecoveryScenarioItem,
} from '@/lib/saved-scenario';

// ── 포매터 ─────────────────────────────────────────────────────
const LOAN_RATE = 0.055; // 5.5% 주담대 평균
const RECIPIENT_CASH_UTILIZATION_RATIO = 0.8;

function fmt(n: number, d = 1) {
  if (n === 0) return '0억';
  return (Math.round(n * Math.pow(10, d)) / Math.pow(10, d)).toLocaleString('ko-KR') + '억';
}
// 단위 없이 숫자만 (urgency band 등 <span class="u"> 별도 표기용)
function fmtN(n: number, d = 1) {
  if (n === 0) return '0';
  return (Math.round(n * Math.pow(10, d)) / Math.pow(10, d)).toLocaleString('ko-KR');
}
function fmtM(n: number) {
  // n is 억 → display in 만원 if < 1억
  const w = Math.round(n * 10000);
  if (w === 0) return '없음';
  if (w >= 10000) return `${(w / 10000).toFixed(1)}억`;
  return `${w.toLocaleString()}만원`;
}

type RecipientGiftEstimate = {
  memberId: string;
  name: string;
  relation: string;
  giftAmount: number;
  giftTax: number;
  acquisitionTax: number;
  totalTaxCost: number;
  availableCash: number;
  shortfall: number;
};

type GiftSelectionEstimate = {
  giftAmount: number;
  giftTax: number;
  acquisitionTax: number;
  totalTaxCost: number;
  recipientCashAvailable: number;
  recipientCashShortfall: number;
  estateAfterLongTermGift: number;
  inheritanceTaxAfterLongTermGift: number;
  inheritanceTaxReduction: number;
  recipients: RecipientGiftEstimate[];
};

const ACQUISITION_TAXABLE_ASSET_TYPES: Asset['asset_type'][] = [
  '주거용부동산',
  '상업용부동산',
  '토지',
  '농지',
  '임야',
  '오피스텔',
];

function estimateGiftAcquisitionTax(assets: Asset[], giftPct: number) {
  const ratio = Math.max(0, giftPct / 100);
  return assets.reduce((sum, asset) => {
    if (!ACQUISITION_TAXABLE_ASSET_TYPES.includes(asset.asset_type)) return sum;
    const isMultiHouse = Number(asset.house_count ?? 1) >= 2 || asset.is_regulated_area === true;
    return sum + calcAcquisitionTax(
      Math.max(0, asset.current_value * ratio),
      asset.asset_type,
      false,
      isMultiHouse,
      'gift',
    );
  }, 0);
}

function estimateSelectedGift({
  totalEstate,
  giftPct,
  assets,
  recipients,
  members,
  priorGiftsMap,
  inheritanceTaxNow,
}: {
  totalEstate: number;
  giftPct: number;
  assets: Asset[];
  recipients: FamilyMember[];
  members: FamilyMember[];
  priorGiftsMap: Record<string, number>;
  inheritanceTaxNow: number;
}): GiftSelectionEstimate {
  const giftAmount = Math.min(totalEstate, Math.max(0, totalEstate * (giftPct / 100)));
  const amountPerRecipient = recipients.length > 0 ? giftAmount / recipients.length : 0;
  const acquisitionTax = estimateGiftAcquisitionTax(assets, giftPct);
  const acquisitionTaxPerRecipient = recipients.length > 0 ? acquisitionTax / recipients.length : 0;
  const recipientEstimates = recipients.map(member => {
    const giftTax = calcGiftTax(
      amountPerRecipient,
      member.relation,
      priorGiftsMap[member.id] ?? 0,
      member.relation === '손자녀',
      false,
      member.age,
    );
    const availableCash = (member.cash_hold ?? 0) * RECIPIENT_CASH_UTILIZATION_RATIO;
    const totalTaxCost = giftTax + acquisitionTaxPerRecipient;
    return {
      memberId: member.id,
      name: member.name,
      relation: member.relation,
      giftAmount: amountPerRecipient,
      giftTax,
      acquisitionTax: acquisitionTaxPerRecipient,
      totalTaxCost,
      availableCash,
      shortfall: Math.max(0, totalTaxCost - availableCash),
    };
  });
  const giftTax = recipientEstimates.reduce((sum, recipient) => sum + recipient.giftTax, 0);
  const totalTaxCost = giftTax + acquisitionTax;
  const recipientCashAvailable = recipientEstimates.reduce((sum, recipient) => sum + recipient.availableCash, 0);
  const estateAfterLongTermGift = Math.max(0, totalEstate - giftAmount);
  const inheritanceTaxAfterLongTermGift = calcInheritanceTax(estateAfterLongTermGift, members, 0).tax;

  return {
    giftAmount,
    giftTax,
    acquisitionTax,
    totalTaxCost,
    recipientCashAvailable,
    recipientCashShortfall: recipientEstimates.reduce((sum, recipient) => sum + recipient.shortfall, 0),
    estateAfterLongTermGift,
    inheritanceTaxAfterLongTermGift,
    inheritanceTaxReduction: Math.max(0, inheritanceTaxNow - inheritanceTaxAfterLongTermGift),
    recipients: recipientEstimates,
  };
}

// ── 긴급도 색상 ─────────────────────────────────────────────────
const URGENCY_BADGE: Record<string, string> = {
  low:      'bg-stone-100 text-stone-600',        // 낮음 — 차분한 톤
  medium:   'bg-amber-50 text-amber-800',          // 중간 — 황동 계열
  high:     'bg-amber-100 text-amber-900',         // 높음 — 진한 황동
  critical: 'bg-red-50 text-red-700',              // 위급 — 절제된 레드
};

// ── 상속세 구간 분석 아코디언 ──────────────────────────────────
function EstateBracketAccordion({
  donor,
  totalEstate,
  allMembers,
  priorGifts10yr,
  growthRate,
}: {
  donor: FamilyMember;
  totalEstate: number;
  allMembers: FamilyMember[];
  priorGifts10yr: number;
  growthRate: number;
}) {
  const bracket = calcEstateBracketAnalysis(totalEstate, allMembers, donor.age, priorGifts10yr, growthRate);
  const currentRate = Math.round(bracket.currentMarginalRate * 100);
  const taxBase = Math.max(0, bracket.currentTaxableBase);

  return (
    <div className="panel">
      <div className="taxline">
        <span className="chip">자산 {fmt(totalEstate)}</span>
        <span className="to">→</span>
        <span className="chip">과세표준 {fmt(taxBase)}</span>
        <span className="to">→</span>
        <span className="chip">한계세율 {currentRate}%</span>
      </div>

      <div className="brackets" aria-label={`현재 한계세율 ${currentRate}%`}>
        {[
          { rate: 10, range: '~1억' },
          { rate: 20, range: '~5억' },
          { rate: 30, range: '~10억' },
          { rate: 40, range: '~30억' },
          { rate: 50, range: '30억 초과 · 과표 도달' },
        ].map(({ rate, range }) => (
          <div key={rate} className={`brk${currentRate >= rate ? ' on' : ''}${rate === 50 && currentRate >= 50 ? ' top' : ''}`}>
            <div className="bbar" />
            <div className="brate">{rate}%</div>
            <div className="brange">{range}</div>
          </div>
        ))}
      </div>

      <div className="q1stats">
        <div className="qc">
          <div className="ql">현재 기준 상속세</div>
          <div className="qv neg num">{fmt(bracket.currentInheritanceTax)}</div>
        </div>
        <div className="qc">
          <div className="ql">10년 후 추정</div>
          <div className="qv neg num">{fmt(bracket.projectedInheritanceTax10yr)}</div>
        </div>
        <div className="qc">
          <div className="ql">한계세율</div>
          <div className="qv num">{currentRate}<span className="u">%</span></div>
        </div>
      </div>

    </div>
  );
}

// ── 페이즈 카드 ────────────────────────────────────────────────
const PHASE_STYLES = [
  { border: 'border-stone-400',  header: 'bg-stone-700',  light: 'bg-stone-50'  },   // 1단계 — 차콜
  { border: 'border-amber-500',  header: 'bg-amber-700',  light: 'bg-amber-50'  },   // 2단계 — 황동
  { border: 'border-stone-500',  header: 'bg-stone-800',  light: 'bg-stone-100' },   // 3단계 — 진차콜
];

/** "지금 대출받아 즉시 실행하면?" 비교 패널 */
function BorrowNowPanel({
  phase,
  recipientMap,
  growthRate,
}: {
  phase: GiftPhase;
  recipientMap: Record<string, FamilyMember>;
  growthRate: number;
}) {
  const [open, setOpen] = useState(false);
  const yrs = phase.yearOffset || 7;

  type RowData = {
    r: PhaseRecipient;
    loan: number;
    totalInterest: number;
    addlTaxIfWait: number;
    netAdvantage: number;
  };

  // 대출 필요한 수증자만 분석
  const rows: RowData[] = phase.recipients
    .map((r): RowData | null => {
      const m        = recipientMap[r.memberId];
      const cashHold = m?.cash_hold ?? 0;
      const loan     = Math.max(0, r.giftTax - cashHold);
      if (loan <= 0.001) return null;

      // 지금 대출 실행 시 총 이자 (yearOffset 년간)
      const totalInterest = loan * LOAN_RATE * yrs;

      // 기다릴 경우 추가 세금 추정
      // 자산이 연 3% 성장하면 증여액·세금도 같은 비율로 증가 (단순 추정)
      const growthFactor   = Math.pow(1 + growthRate, yrs) - 1;
      const addlTaxIfWait  = r.giftTax * growthFactor;

      // 즉시 실행의 순편익 = 기다릴 때 추가세금 - 대출이자 합계
      const netAdvantage   = addlTaxIfWait - totalInterest;

      return { r, loan, totalInterest, addlTaxIfWait, netAdvantage };
    })
    .filter((x): x is RowData => x !== null);

  if (rows.length === 0) return null;

  const totalAdv = rows.reduce((s: number, x: RowData) => s + x.netAdvantage, 0);

  return (
    <>
      <button className="borrow-btn" onClick={() => setOpen(o => !o)} type="button">
        <div className="bb-left">
          <span>🏦 지금 대출받아 즉시 실행하면?</span>
          <span className={`bb-tag${totalAdv <= 0 ? ' neg' : ''}`}>
            {totalAdv > 0 ? `약 ${fmtM(totalAdv)} 유리` : `약 ${fmtM(Math.abs(totalAdv))} 불리`}
          </span>
        </div>
        <span>{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div className="borrow-panel">
          <div className="borrow-meta">
            성장률 연 {(growthRate * 100).toFixed(1)}% · 대출이자 {(LOAN_RATE * 100).toFixed(1)}% · {yrs}년 기준
          </div>
          <table className="borrow-tbl">
            <thead>
              <tr>
                <th>수증자</th>
                <th>필요 대출</th>
                <th>대출 이자 ({yrs}년)</th>
                <th>기다릴 때 추가세금</th>
                <th>즉시 실행 우위</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ r, loan, totalInterest, addlTaxIfWait, netAdvantage }: RowData) => (
                <tr key={r.memberId}>
                  <td>{r.memberName}</td>
                  <td className="val-warn">{fmtM(loan)}</td>
                  <td className="val-neg">{fmtM(totalInterest)}</td>
                  <td className="val-warn">{fmtM(addlTaxIfWait)}</td>
                  <td className={netAdvantage > 0 ? '' : 'val-neg'}>
                    {netAdvantage > 0 ? '+' : ''}{fmtM(netAdvantage)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className={`borrow-concl${totalAdv > 0 ? ' pos' : ' neg'}`}>
            {totalAdv > 0 ? (
              <><strong>즉시 대출 실행이 유리합니다.</strong>{' '}
              {yrs}년 기다리면 증여세가 약 {fmtM(rows.reduce((s: number, x: RowData) => s + x.addlTaxIfWait, 0))} 더 늘어나는데,
              대출이자(약 {fmtM(rows.reduce((s: number, x: RowData) => s + x.totalInterest, 0))})를 내고도 약 {fmtM(totalAdv)} 절세됩니다.</>
            ) : (
              <>대출 이자 부담이 절세 효과보다 큽니다. 현재 계획({yrs}년 저축 후 실행)이 더 유리합니다.</>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function PhaseCard({
  phase,
  idx,
  recipientMap,
  growthRate,
}: {
  phase: GiftPhase;
  idx: number;
  recipientMap: Record<string, FamilyMember>;
  growthRate: number;
}) {
  const hdClass = idx === 0 ? 'phase-hd' : idx === 1 ? 'phase-hd alt' : 'phase-hd alt2';

  const loanCount = phase.recipients.filter(r => {
    const m = recipientMap[r.memberId];
    const loanNeeded = Math.max(0, r.giftTax - (m?.cash_hold ?? 0));
    return loanNeeded > 0.001;
  }).length;

  return (
    <div className="phase-card">
      <div className={hdClass}>
        <div className="ph-left">
          <div className="ph-label">{phase.label}</div>
          <div className="ph-trigger">{phase.trigger}</div>
          {idx > 0 && <div className="ph-when">📅 {phase.yearOffset}년 후 실행</div>}
        </div>
        <div className="ph-right">
          <div className="ph-rl">이전 금액</div>
          <div className="ph-rv">{fmt(phase.totalAmount)}</div>
          <div className="ph-rs">증여세 {fmt(phase.totalTax)}</div>
          {loanCount > 0 && <div className="ph-loan">🏦 대출 {loanCount}명</div>}
        </div>
      </div>

      {phase.recipients.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table className="phase-tbl">
            <thead>
              <tr>
                <th>수증자</th>
                <th>증여액</th>
                <th>증여세</th>
                <th>현금보유</th>
                <th>필요대출</th>
                <th>연 이자</th>
              </tr>
            </thead>
            <tbody>
              {phase.recipients.map(r => {
                const member = recipientMap[r.memberId];
                const cashHold   = member?.cash_hold ?? 0;
                const loanNeeded = Math.max(0, r.giftTax - cashHold);
                const annualInt  = loanNeeded * LOAN_RATE;
                const hasLoan    = loanNeeded > 0.001;
                return (
                  <tr key={r.memberId}>
                    <td>
                      <span className="ph-name">{r.memberName}</span>
                      <span className="ph-rel">({r.relation})</span>
                      {r.canAffordNow && !hasLoan && <span className="ph-badge">납부 가능</span>}
                      {hasLoan && <span className="ph-badge warn">대출 필요</span>}
                      {r.yearsToSave > 0 && <span className="ph-rel"> {r.yearsToSave}년 후</span>}
                    </td>
                    <td>{fmt(r.actualAmount)}</td>
                    <td className={r.giftTax > 0 ? 'val-neg' : 'val-muted'}>
                      {r.giftTax > 0 ? fmtM(r.giftTax) : '없음'}
                    </td>
                    <td>{fmtM(cashHold)}</td>
                    <td className={hasLoan ? 'val-warn' : 'val-muted'}>{hasLoan ? fmtM(loanNeeded) : '—'}</td>
                    <td className={hasLoan ? 'val-warn' : 'val-muted'}>{hasLoan ? fmtM(annualInt) : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {loanCount > 0 && (
        <div className="phase-loan-note">
          🏦 대출이자율 {(LOAN_RATE * 100).toFixed(1)}% 기준. 대출이자 vs 상속세 절감 효과 비교 후 결정하세요.
        </div>
      )}

      {idx > 0 && <BorrowNowPanel phase={phase} recipientMap={recipientMap} growthRate={growthRate} />}

      {phase.blocked.length > 0 && (
        <div className="phase-block">
          <div className="pb-title">⏳ 이 단계 대기 — 다음 단계로 이연</div>
          {phase.blocked.map(r => (
            <div key={r.memberId} className="pb-row">
              <span className="pb-name">{r.memberName}</span>
              <span>·</span>
              <span>{r.blockReason ?? '공제 한도 소진'}</span>
              {r.deferredToPhase && <span className="pb-tag">→ {r.deferredToPhase}단계</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── 단계별 증여 계획 섹션 ──────────────────────────────────────
function PhasedPlanSection({
  totalValue,
  selectedRecipients,
  priorGiftsMap,
  allMembers,
  macro,
  growthRate,
}: {
  totalValue: number;
  selectedRecipients: FamilyMember[];
  priorGiftsMap: Record<string, number>;
  allMembers: FamilyMember[];
  macro: MacroSettings | null;
  growthRate: number;
}) {
  if (selectedRecipients.length === 0) return null;

  const plan: PhasedGiftPlan = generatePhasedGiftPlan(
    totalValue,
    selectedRecipients,
    priorGiftsMap,
    allMembers,
    macro,
  );

  // 수증자 맵 (id → FamilyMember)
  const recipientMap: Record<string, FamilyMember> = {};
  for (const m of selectedRecipients) recipientMap[m.id] = m;

  const totalTransferred = totalValue - plan.unallocated;

  return (
    <div className="phs-wrap">
      <div className="phs-divider">
        <hr />
        <h2>단계별 유동성 기반 증여 계획</h2>
        <hr />
      </div>

      <div className="info-note">
        수증자의 <strong>현금 보유액·연소득</strong> 기준으로, 실제 납부 가능한 증여세 범위 내에서 즉시 증여하고
        — 나머지는 저축이 모이거나 10년 공제 사이클이 리셋될 때 단계적으로 이전합니다.
        현금 부족 시 <strong>은행 대출</strong>로 증여세를 납부하는 방법도 각 단계별로 함께 표시합니다.
      </div>

      {plan.phases.length > 0 && (
        <div className="phs-timeline">
          {plan.phases.map((phase, idx) => (
            <div key={phase.phaseNum} style={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
              {idx > 0 && (
                <div className="phs-connector">
                  <hr /><span className="yr">{phase.yearOffset}년 후</span><hr />
                </div>
              )}
              <div className="phs-node">
                <div className={`pn-num${idx > 0 ? ' alt' : ''}`}>{phase.phaseNum}</div>
                <div className="pn-amt">{fmt(phase.totalAmount)}</div>
              </div>
            </div>
          ))}
          {plan.unallocated > 0.01 && (
            <div style={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
              <div className="phs-connector"><hr /></div>
              <div className="phs-node">
                <div className="pn-num alt" style={{ fontSize: 11 }}>상속</div>
                <div className="pn-amt">{fmt(plan.unallocated)}</div>
              </div>
            </div>
          )}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {plan.phases.map((phase, idx) => (
          <PhaseCard
            key={phase.phaseNum}
            phase={phase}
            idx={idx}
            recipientMap={recipientMap}
            growthRate={growthRate}
          />
        ))}

        {plan.unallocated > 0.01 && (
          <div className="phs-fallback">
            <div className="pf-head">
              <div className="pf-l">
                <div className="pf-t">잔여분 — 상속으로 처리</div>
                <div className="pf-sub">3단계 후에도 배분되지 않은 금액은 상속세 과세</div>
              </div>
              <div className="pf-r">
                <div className="pf-rl">잔여</div>
                <div className="pf-rv">{fmt(plan.unallocated)}</div>
                <div className="pf-rl">예상 상속세 {fmt(plan.inheritanceFallback)}</div>
              </div>
            </div>
          </div>
        )}
      </div>

      {plan.keyInsights.length > 0 && (
        <div className="key-insights">
          <div className="ki-title">핵심 인사이트</div>
          <ul>
            {plan.keyInsights.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="phs-summary">
        <div className="ps">
          <div className="pl">총 이전 금액</div>
          <div className="pv">{fmt(totalTransferred)}</div>
        </div>
        <div className="ps">
          <div className="pl">총 증여세 합계</div>
          <div className="pv neg">{fmt(plan.totalGiftTax)}</div>
        </div>
        <div className="ps">
          <div className="pl">상속 잔여세</div>
          <div className="pv amb">{plan.unallocated > 0.01 ? fmt(plan.inheritanceFallback) : '없음'}</div>
        </div>
      </div>
    </div>
  );
}

// ── 회생방안 전략 섹션 ─────────────────────────────────────────

const CATEGORY_COLORS: Record<string, string> = {
  '즉시': 'bg-red-100 text-red-700',
  '단기': 'bg-orange-100 text-amber-800',
  '중기': 'bg-yellow-100 text-yellow-700',
  '장기': 'bg-gray-100 text-gray-600',
};
const FEASIBILITY_LABELS: Record<string, string> = {
  high: '실행 쉬움', medium: '실행 가능', low: '어려움',
};
const FEASIBILITY_COLORS: Record<string, string> = {
  high: 'text-stone-700 bg-stone-50', medium: 'text-amber-800 bg-orange-50', low: 'text-gray-500 bg-gray-100',
};
const RISK_COLORS: Record<string, string> = {
  low: 'text-green-600', medium: 'text-orange-500', high: 'text-red-600',
};

function ExecutionRoadmap({ steps, totalWeeks }: { steps: ExecutionStep[]; totalWeeks: number }) {
  return (
    <div className="exec-map">
      <div className="em-head">실행 로드맵 <span>· 총 약 {totalWeeks}주 소요</span></div>
      {steps.map((step, i) => (
        <div key={i} className="em-step">
          <div className="em-left">
            <div className="em-num">{i + 1}</div>
            {i < steps.length - 1 && <div className="em-line" />}
          </div>
          <div className="em-body">
            <div className="em-tags">
              <span className="em-timing">{step.timing}</span>
              <span className="em-title">{step.title}</span>
              {step.actor && <span className="em-actor">[{step.actor}]</span>}
            </div>
            <p className="em-desc">{step.description}</p>
            {step.estimatedCost && <div className="em-cost">{step.estimatedCost}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

function StrategyCard({
  s,
  isSelected,
  onToggle,
  estimateOverride,
}: {
  s: RecoveryStrategy;
  isSelected: boolean;
  onToggle: () => void;
  estimateOverride?: Pick<RecoveryStrategy, 'taxSavingEstimate' | 'costEstimate' | 'netBenefit'>;
}) {
  const [open, setOpen] = useState(false);
  const taxSavingEstimate = estimateOverride?.taxSavingEstimate ?? s.taxSavingEstimate;
  const costEstimate = estimateOverride?.costEstimate ?? s.costEstimate;
  const netBenefit = estimateOverride?.netBenefit ?? s.netBenefit;

  return (
    <div
      className="strat"
      data-selected={isSelected ? 'true' : 'false'}
      data-disabled={!s.isApplicable ? 'true' : 'false'}
    >
      {/* 카드 헤더 */}
        {/* 체크박스 */}
        <div>
          <input
            type="checkbox"
            checked={isSelected}
            onChange={onToggle}
            disabled={!s.isApplicable}
          />
        </div>

        <button
          onClick={() => setOpen(o => !o)}
          style={{ minWidth: 0, textAlign: 'left' }}
          type="button"
        >
          <div className="stags">
            <span className="timing">
              {s.category}
            </span>
            <span className={`diff ${s.feasibility === 'high' ? 'easy' : s.feasibility === 'medium' ? 'mid' : 'hard'}`}>
              {FEASIBILITY_LABELS[s.feasibility]}
            </span>
            {!s.isApplicable && (
              <span style={{ border: '1px solid var(--line)', color: 'var(--ink-faint)', fontSize: 11, padding: '2px 8px' }}>
                해당 없음
              </span>
            )}
            {isSelected && (
              <span style={{ border: '1px solid var(--line-strong)', color: 'var(--ink)', fontSize: 11, fontWeight: 600, padding: '2px 8px' }}>
                선택됨
              </span>
            )}
          </div>
          <div className="stitle">{s.title}</div>
          <div className="slaw">{s.legalBasis}</div>
        </button>

        <button onClick={() => setOpen(o => !o)} className="simp" type="button">
          {netBenefit > 0 ? (
            <div>
              <div className="il">예상 절세</div>
              <div className="iv num">+{fmtM(netBenefit)}</div>
            </div>
          ) : (
            <div className="iv muted">유동성 확보</div>
          )}
          <div style={{ fontSize: 11, color: 'var(--ink-faint)', marginTop: 4 }}>{open ? '▲' : '▼'}</div>
        </button>

      {open && (
        <div className="sexpand">
          {!s.isApplicable && s.notApplicableReason && (
            <div style={{ border: '1px solid var(--line)', padding: '10px 14px', fontSize: 12, background: 'var(--paper)', color: 'var(--ink-faint)' }}>
              {s.notApplicableReason}
            </div>
          )}

          <p style={{ fontSize: 12, color: 'var(--ink-soft)', lineHeight: 1.6, margin: 0 }}>{s.description}</p>

          {(taxSavingEstimate > 0 || costEstimate > 0) && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', border: '1px solid var(--line)' }}>
              <div style={{ padding: '12px 14px', textAlign: 'center', borderRight: '1px solid var(--line)' }}>
                <div style={{ fontSize: 11, color: 'var(--ink-faint)', marginBottom: 4 }}>예상 절세</div>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--green-ink)' }}>{taxSavingEstimate > 0 ? `+${fmtM(taxSavingEstimate)}` : '—'}</div>
              </div>
              <div style={{ padding: '12px 14px', textAlign: 'center', borderRight: '1px solid var(--line)', background: 'var(--paper)' }}>
                <div style={{ fontSize: 11, color: 'var(--ink-faint)', marginBottom: 4 }}>비용·세금</div>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--amber)' }}>{costEstimate > 0 ? `-${fmtM(costEstimate)}` : '없음'}</div>
              </div>
              <div style={{ padding: '12px 14px', textAlign: 'center' }}>
                <div style={{ fontSize: 11, color: 'var(--ink-faint)', marginBottom: 4 }}>순편익</div>
                <div style={{ fontSize: 13, fontWeight: 600, color: netBenefit > 0 ? 'var(--gold-deep)' : 'var(--ink-faint)' }}>
                  {netBenefit > 0 ? `+${fmtM(netBenefit)}` : '—'}
                </div>
              </div>
            </div>
          )}

          {s.executionSteps && s.executionSteps.length > 0 && (
            <ExecutionRoadmap steps={s.executionSteps} totalWeeks={s.executionWeeks} />
          )}

          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--ink-soft)', marginBottom: 8 }}>실행 체크리스트</div>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {s.actionItems.map((item, i) => (
                <li key={i} style={{ display: 'flex', gap: 8, fontSize: 12, color: 'var(--ink-soft)' }}>
                  <span style={{ width: 8, height: 8, background: 'var(--gold)', flexShrink: 0, marginTop: 4 }} />
                  {item}
                </li>
              ))}
            </ul>
          </div>

          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--ink-soft)', marginBottom: 8 }}>
              주요 리스크
              <span style={{ marginLeft: 8, fontWeight: 400, color: s.riskLevel === 'low' ? 'var(--green-ink)' : s.riskLevel === 'medium' ? 'var(--amber)' : 'var(--red)' }}>
                {s.riskLevel === 'low' ? '낮음' : s.riskLevel === 'medium' ? '보통' : '높음'}
              </span>
            </div>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {s.risks.map((r, i) => (
                <li key={i} style={{ display: 'flex', gap: 6, fontSize: 12, color: 'var(--ink-faint)' }}>
                  <span style={{ flexShrink: 0 }}>·</span>{r}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

function SelectedPlanSummary({
  selected,
  allStrategies,
  inheritanceTax,
}: {
  selected: Set<string>;
  allStrategies: RecoveryStrategy[];
  inheritanceTax: number;
}) {
  if (selected.size === 0) return null;

  const selectedList = allStrategies.filter(s => selected.has(s.id) && s.isApplicable);
  const totalSaving = selectedList.reduce((s, r) => s + r.netBenefit, 0);
  const effectiveTax = Math.max(0, inheritanceTax - totalSaving);

  const immediateActions = selectedList.filter(s => s.category === '즉시').flatMap(s => s.actionItems.slice(0, 2));
  const shortActions = selectedList.filter(s => s.category === '단기').flatMap(s => s.actionItems.slice(0, 2));

  return (
    <div className="sel-summary">
      <div className="ss-head">
        <div className="ss-l">
          <div className="ss-t">내 회생 계획 — {selectedList.length}가지 전략 선택</div>
          <div className="ss-sub">시나리오 분석에 자동 반영됩니다</div>
        </div>
        <div className="ss-r">
          <div className="ss-rl">예상 절세 합계</div>
          <div className="ss-rv">+{fmtM(totalSaving)}</div>
        </div>
      </div>
      <div className="ss-body">
        <div className="ss-grid">
          <div className="sg-cell">
            <div className="sl">현재 상속세</div>
            <div className="sv neg">{fmtM(inheritanceTax)}</div>
          </div>
          <div className="sg-arrow">→</div>
          <div className="sg-cell">
            <div className="sl">전략 후 예상세</div>
            <div className="sv">{fmtM(effectiveTax)}</div>
          </div>
        </div>

        {immediateActions.length > 0 && (
          <div>
            <div className="ss-act-title imm">지금 당장 할 일</div>
            <ul className="ss-act-list">
              {immediateActions.map((a, i) => (
                <li key={i} className="ss-act-item">
                  <span className="chk" />
                  {a}
                </li>
              ))}
            </ul>
          </div>
        )}

        {shortActions.length > 0 && (
          <div>
            <div className="ss-act-title">단기 실행 (1~3개월)</div>
            <ul className="ss-act-list">
              {shortActions.map((a, i) => (
                <li key={i} className="ss-act-item">
                  <span className="chk" />
                  {a}
                </li>
              ))}
            </ul>
          </div>
        )}

        <a href="/dashboard/scenarios" className="ss-cta">
          시나리오 분석에서 비교 보기 →
        </a>
      </div>
    </div>
  );
}

function RecoveryStrategiesSection({
  strategies,
  totalTaxSaving,
  selectedIds,
  onToggle,
}: {
  strategies: RecoveryStrategy[];
  totalTaxSaving: number;
  selectedIds: Set<string>;
  onToggle: (id: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const applicable = strategies.filter(s => s.isApplicable);
  const notApplicable = strategies.filter(s => !s.isApplicable);

  return (
    <div className="rounded-2xl border border-gray-200 overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-5 py-4 bg-gradient-to-r from-blue-50 to-indigo-50 hover:from-blue-100 hover:to-indigo-100 transition-colors text-left"
      >
        <div className="flex items-center gap-3">
          <span className="text-base">🛡️</span>
          <span className="font-bold text-gray-800 text-sm">회생방안 — 실행 가능한 전략 {applicable.length}가지</span>
          {selectedIds.size > 0 && (
            <span className="text-xs bg-stone-100 text-stone-700 px-2 py-0.5 rounded-full font-semibold">
              {selectedIds.size}개 선택됨
            </span>
          )}
        </div>
        <div className="flex items-center gap-4">
          <div className="hidden sm:block text-xs text-gray-500">
            전략 실행 시 최대 절세 <strong className="text-stone-700">{fmtM(totalTaxSaving)}</strong>
          </div>
          <span className="text-gray-400">{open ? '▲' : '▼'}</span>
        </div>
      </button>

      {open && (
        <div className="bg-gray-50 border-t border-gray-100 px-5 py-4 space-y-3">
          {/* 해당 전략 */}
          {applicable.map(s => (
            <StrategyCard
              key={s.id}
              s={s}
              isSelected={selectedIds.has(s.id)}
              onToggle={() => onToggle(s.id)}
            />
          ))}

          {/* 해당 없는 전략 */}
          {notApplicable.length > 0 && (
            <>
              <div className="text-xs text-gray-400 pt-1">— 현재 가족 구성상 해당 없는 전략 —</div>
              {notApplicable.map(s => (
                <StrategyCard
                  key={s.id}
                  s={s}
                  isSelected={selectedIds.has(s.id)}
                  onToggle={() => onToggle(s.id)}
                />
              ))}
            </>
          )}

          <div className="text-xs text-gray-400 pt-1">
            * 절세 추정액은 단순화된 계산 기준입니다. 실제 집행 전 세무사·법무사 확인이 필수입니다.
          </div>
        </div>
      )}
    </div>
  );
}

// ── 현금흐름 & 납부 재원 분석 섹션 ────────────────────────────
const METHOD_LABELS: Record<string, string> = {
  immediate:    '즉시 납부',
  installment10:'연부연납 10년',
  installment5: '연부연납 5년',
  physical:     '물납',
  sell:         '자산 매각 후 납부',
};
const METHOD_COLORS: Record<string, string> = {
  immediate:    'bg-stone-100 text-stone-800 border-stone-300',
  installment10:'bg-amber-50 text-amber-900 border-amber-300',
  installment5: 'bg-stone-100 text-stone-700 border-stone-300',
  physical:     'bg-orange-100 text-orange-800 border-orange-300',
  sell:         'bg-red-100 text-red-800 border-red-300',
};

function RecoveryCashflowSection({
  plan,
}: {
  plan: RecoveryPlanAnalysis;
}) {
  const [open, setOpen] = useState(true);

  const methodColor = METHOD_COLORS[plan.recommendedMethod] ?? 'bg-gray-100 text-gray-800 border-gray-300';

  function cfColor(n: number) {
    return n > 0 ? 'text-amber-800' : n < 0 ? 'text-red-600' : 'text-gray-500';
  }

  return (
    <div>
      <div className="card-head" style={{ padding: '26px 0 14px' }}>
        <span className="t">현금흐름 &amp; 상속세 납부 재원 분석</span>
        <span className="muted" style={{ fontSize: 12.5 }}>
          순현금흐름 <b style={{ color: 'var(--ink)' }}>{fmtM(plan.totalNetCashflow)}/년</b>
          {' · '}LTV <b style={{ color: 'var(--ink)' }}>{plan.overallLTV.toFixed(0)}%</b>
          {' · '}DSCR <b style={{ color: 'var(--ink)' }}>{plan.overallDSCR === 99 ? '∞' : `${plan.overallDSCR.toFixed(1)}x`}</b>
        </span>
      </div>
      <table className="table kt">
        <thead>
          <tr>
            <th style={{ paddingLeft: 18 }}>자산</th>
            <th className="r">현재가치</th>
            <th className="r">연 수익</th>
            <th className="r">대출 이자</th>
            <th className="r">보유세</th>
            <th className="r">임대소득세</th>
            <th className="r">순현금흐름</th>
            <th className="r">LTV</th>
            <th className="r" style={{ paddingRight: 18 }}>DSCR</th>
          </tr>
        </thead>
        <tbody>
          {plan.assetDetails.map((d) => (
            <tr key={d.assetId}>
              <td className="name" style={{ paddingLeft: 18 }}>
                {d.assetName}
                <small style={{ display: 'block', color: 'var(--ink-faint)', fontWeight: 400 }}>{d.assetType}</small>
              </td>
              <td className="r num">{fmt(d.currentValue)}</td>
              <td className={`r num${d.annualRevenue > 0 ? ' pos' : ' zero'}`}>{d.annualRevenue > 0 ? fmtM(d.annualRevenue) : '없음'}</td>
              <td className={`r${d.annualInterest > 0 ? ' num' : ' zero'}`}>
                {d.annualInterest > 0 ? `-${fmtM(d.annualInterest)}${d.isLoanVariable ? ' 변동' : ''}` : '—'}
              </td>
              <td className={`r${d.annualHoldingTax > 0 ? ' num' : ' zero'}`}>
                {d.annualHoldingTax > 0 ? `-${fmtM(d.annualHoldingTax)}` : '—'}
              </td>
              <td className={`r${d.annualRentalTax > 0.001 ? ' num' : ' zero'}`}>
                {d.annualRentalTax > 0.001 ? `-${fmtM(d.annualRentalTax)}` : '—'}
              </td>
              <td className={`r num${d.netCashflow > 0 ? ' pos' : d.netCashflow < 0 ? ' neg' : ' zero'}`}>{fmtM(d.netCashflow)}</td>
              <td className={`r${d.loanAmount > 0 ? ' num' : ' zero'}`}>{d.loanAmount > 0 ? `${d.ltv.toFixed(0)}%` : '—'}</td>
              <td className={`r${d.annualInterest > 0 ? ' num' : ' zero'}`} style={{ paddingRight: 18 }}>
                {d.annualInterest > 0 ? `${d.dscr.toFixed(1)}x` : '—'}
              </td>
            </tr>
          ))}
          <tr style={{ borderTop: '1px solid var(--line-strong)' }}>
            <td className="name" style={{ paddingLeft: 18, fontWeight: 700 }}>합계</td>
            <td className="r num" style={{ fontWeight: 700 }}>{fmt(plan.totalValue)}</td>
            <td className={`r num${plan.totalRevenue > 0 ? ' pos' : ' zero'}`}>{plan.totalRevenue > 0 ? fmtM(plan.totalRevenue) : '—'}</td>
            <td className={`r${plan.totalInterest > 0 ? ' num' : ' zero'}`}>{plan.totalInterest > 0 ? `-${fmtM(plan.totalInterest)}` : '—'}</td>
            <td className={`r${plan.totalHoldingTax > 0 ? ' num' : ' zero'}`}>{plan.totalHoldingTax > 0 ? `-${fmtM(plan.totalHoldingTax)}` : '—'}</td>
            <td className={`r${plan.totalRentalTax > 0.001 ? ' num' : ' zero'}`}>{plan.totalRentalTax > 0.001 ? `-${fmtM(plan.totalRentalTax)}` : '—'}</td>
            <td className={`r num${plan.totalNetCashflow > 0 ? ' pos' : plan.totalNetCashflow < 0 ? '' : ' zero'}`} style={{ fontWeight: 700 }}>{fmtM(plan.totalNetCashflow)}</td>
            <td className="r num">{plan.overallLTV.toFixed(0)}%</td>
            <td className="r num" style={{ paddingRight: 18 }}>{plan.overallDSCR === 99 ? '∞' : `${plan.overallDSCR.toFixed(1)}x`}</td>
          </tr>
        </tbody>
      </table>

      {/* 상속세 납부 방법 비교 */}
      <div className="card-head" style={{ padding: '26px 0 14px' }}><span className="t">상속세 납부 방법 비교</span></div>
      <div className="paycmp">
        <div className="pc">
          <div className="pcl">즉시 일시 납부</div>
          <div className="pcv num">{fmt(plan.inheritanceTax)}</div>
          <div className="pcs">신고 후 6개월 내 납부</div>
          <div className={`pcflag${plan.totalNetCashflow * 6 >= plan.inheritanceTax ? ' ok' : ' no'}`}>
            <span className="mk">{plan.totalNetCashflow * 6 >= plan.inheritanceTax ? '✓' : '✕'}</span>
            {plan.totalNetCashflow * 6 >= plan.inheritanceTax ? '현금흐름으로 가능' : '유동성 부족'}
          </div>
        </div>
        <div className="pc">
          <div className="pcl">연부연납 10년 분할</div>
          <div className="pcv num">{fmtM(plan.installment10yr)}<span className="u">/년</span></div>
          <div className="pcs">세무서 허가 필요 · 이자 가산</div>
          <div className={`pcflag${plan.canPayBy10yr ? ' ok' : ' no'}`}>
            <span className="mk">{plan.canPayBy10yr ? '✓' : '✕'}</span>
            {plan.canPayBy10yr ? `연 ${fmtM(plan.surplusAfter10yr)} 여유` : `연 ${fmtM(Math.abs(plan.surplusAfter10yr))} 부족`}
          </div>
        </div>
        <div className={`pc${plan.recommendedMethod === 'physical' ? ' rec' : ''}`}>
          <div className="pcl">부동산 물납</div>
          <div className="pcv" style={{ fontSize: 21 }}>부동산으로 납부</div>
          <div className="pcs">부동산 비율 {plan.realEstateRatio.toFixed(0)}%</div>
          <div className={`pcflag${plan.physicalPaymentPossible ? ' ok' : ' no'}`}>
            <span className="mk">{plan.physicalPaymentPossible ? '✓' : '✕'}</span>
            {plan.physicalPaymentPossible ? '물납 요건 충족' : '부동산 50% 미달'}
          </div>
        </div>
      </div>
      <div className="callout is-warn reco-callout">
        <strong>권장: {METHOD_LABELS[plan.recommendedMethod]}.</strong> {plan.recommendedReason}
      </div>

      <div className="ratiorow">
        <div className="rr">
          <div className="rrl">전체 LTV</div>
          <div className="rrv num">{plan.overallLTV.toFixed(1)}%</div>
          <div className="rrf">안전 기준 40% 이하</div>
        </div>
        <div className="rr">
          <div className="rrl">전체 DSCR</div>
          <div className="rrv num">{plan.overallDSCR === 99 ? '∞' : `${plan.overallDSCR.toFixed(2)}x`}</div>
          <div className="rrf">안전 기준 1.5× 이상</div>
        </div>
        <div className="rr">
          <div className="rrl">납부 소요 기간</div>
          <div className="rrv num">{plan.yearsToPayOff >= 999 ? '불가' : `${plan.yearsToPayOff}년`}</div>
          <div className="rrf">순현금흐름 기준</div>
        </div>
      </div>
      <div className="rnote2" style={{ marginTop: 16 }}>
        * LTV: 총대출/총자산가치 · DSCR: 연수익/연이자 · 임대소득세는 전체 임대수익 합산 후 안분 계산
      </div>
    </div>
  );
}

// ── 고급 시나리오 분석 섹션 ────────────────────────────────────

// 공익법인 출연 카드
function PublicFoundationCard({
  assets,
  members,
  totalEstate,
  inheritanceTax,
  selectedAssetId: controlledAssetId,
  donationPct: controlledPct,
  onAssetChange,
  onPctChange,
}: {
  assets: Asset[];
  members: FamilyMember[];
  totalEstate: number;
  inheritanceTax: number;
  selectedAssetId?: string;
  donationPct?: number;
  onAssetChange?: (id: string) => void;
  onPctChange?: (pct: number) => void;
}) {
  const eligibleAssets = assets.filter(a =>
    ['상업용부동산', '주거용부동산', '토지', '비상장주식'].includes(a.asset_type)
  );
  // 제어 컴포넌트 모드 지원: 외부 state가 있으면 그걸 쓰고, 없으면 로컬 state
  const [localAssetId, setLocalAssetId] = useState<string>(eligibleAssets[0]?.id ?? '');
  const [localPct, setLocalPct] = useState<number>(30);
  const [expanded, setExpanded] = useState(false);

  const selectedAssetId = controlledAssetId !== undefined ? (controlledAssetId || eligibleAssets[0]?.id || '') : localAssetId;
  const donationPct = controlledPct !== undefined ? controlledPct : localPct;

  function handleAssetChange(id: string) {
    if (onAssetChange) onAssetChange(id);
    else setLocalAssetId(id);
  }
  function handlePctChange(pct: number) {
    if (onPctChange) onPctChange(pct);
    else setLocalPct(pct);
  }

  const selectedAsset = assets.find(a => a.id === selectedAssetId);
  const scenario: PublicFoundationScenario | null = selectedAsset
    ? calcPublicFoundationScenario(selectedAsset, donationPct, totalEstate, members)
    : null;
  const isStock = selectedAsset?.asset_type === '비상장주식';

  return (
    <div className="scen-card">
      <div className="sc-head">
        <div className="sc-row">
          <div className="sc-title">
            <span className="sc-name">공익법인 출연 시나리오</span>
            {scenario && scenario.taxSaving > 0 && (
              <span className="sc-badge">
                증여세 절감 +{fmt(scenario.giftTaxSaved)} / 상속세 ↓{fmt(scenario.inheritanceTaxReduction)}
              </span>
            )}
          </div>
          <button onClick={() => setExpanded(e => !e)} className="sc-toggle">
            {expanded ? '접기 ▲' : '더보기 ▼'}
          </button>
        </div>
        <div className="sc-ctrl">
          <label>출연 대상 자산</label>
          <select
            value={selectedAssetId}
            onChange={e => handleAssetChange(e.target.value)}
            className="kyn"
            style={{ fontSize: 12 }}
          >
            {eligibleAssets.map(a => (
              <option key={a.id} value={a.id}>{a.name} ({fmt(a.current_value)})</option>
            ))}
          </select>
          <label style={{ marginLeft: 8 }}>출연 비율: <strong>{donationPct}%</strong></label>
          <input
            type="range"
            min={10} max={100} step={1}
            value={donationPct}
            onChange={e => handlePctChange(Number(e.target.value))}
            style={{ width: 140 }}
          />
        </div>
      </div>

      {expanded && scenario && selectedAsset && (
        <div className="sc-body">
          <div className="sc-grid3">
            {[
              { label: '과세가액 불산입', val: fmt(scenario.nonTaxableAmount) },
              { label: '증여세 절감', val: fmt(scenario.giftTaxSaved) },
              { label: '상속세 감소', val: fmt(scenario.inheritanceTaxReduction) },
            ].map(c => (
              <div key={c.label} className="sc-cell">
                <div className="sl">{c.label}</div>
                <div className="sv">{c.val}</div>
              </div>
            ))}
          </div>

          <div className="sc-net">
            <div className="sl">순편익 (절세액 - 통제권 상실)</div>
            <div className={`sv${scenario.netBenefit > 0 ? ' pos' : ' neg'}`}>
              {scenario.netBenefit > 0 ? '+' : ''}{fmt(scenario.netBenefit)}
            </div>
          </div>

          <div>
            <div className="sc-cmp-title">세금 효과 비교</div>
            {[
              { label: '출연 전 상속세', val: scenario.originalTax, cls: 'r' },
              { label: '출연 후 상속세', val: scenario.newTax, cls: '' },
              { label: '증여세 절감', val: scenario.giftTaxSaved, cls: '' },
            ].map(row => {
              const barMax = Math.max(scenario.originalTax, scenario.giftTaxSaved, 0.001);
              const pct = (row.val / barMax) * 100;
              return (
                <div key={row.label} className="sc-bar-row">
                  <span className="sc-bar-label">{row.label}</span>
                  <div className="sc-bar-track">
                    <div className={`sc-bar-fill${row.cls ? ` ${row.cls}` : ''}`} style={{ width: `${pct}%` }} />
                  </div>
                  <span className="sc-bar-val">{fmt(row.val)}</span>
                </div>
              );
            })}
          </div>

          {isStock && (
            <div className="warn-note">
              비상장주식 출연 시 <strong>5% 초과분은 과세가액 불산입 불가</strong> (상증법§16②). 불산입액이 출연액보다 적을 수 있습니다.
            </div>
          )}

          <ExecutionRoadmap steps={scenario.executionSteps} totalWeeks={20} />

          <div className="warn-note">
            <strong>상속세 신고기한(6개월) 내 출연 완료 필수</strong> — 기한 초과 시 불산입 혜택 소멸 (상증법§16④)
          </div>
        </div>
      )}
    </div>
  );
}

// 법인전환 시나리오 카드
function CorpConversionCard({
  assets,
  members,
}: {
  assets: Asset[];
  members: FamilyMember[];
}) {
  const [ceoSalary, setCeoSalary] = useState<number>(1.2);
  const [expanded, setExpanded] = useState(false);

  const scenario: CorpConversionScenarioResult = calcCorpConversionScenario(assets, ceoSalary, members);

  return (
    <div className="scen-card">
      <div className="sc-head">
        <div className="sc-row">
          <div className="sc-title">
            <span className="sc-name">법인전환 시나리오</span>
            {scenario.annualTaxSaving > 0 && (
              <span className="sc-badge">연간 절세 +{fmt(scenario.annualTaxSaving)}</span>
            )}
          </div>
          <button onClick={() => setExpanded(e => !e)} className="sc-toggle">
            {expanded ? '접기 ▲' : '더보기 ▼'}
          </button>
        </div>
        <div className="sc-ctrl">
          <label style={{ whiteSpace: 'nowrap' }}>대표이사 연봉 (억)</label>
          <input
            type="number"
            min={0} max={10} step={0.1}
            value={ceoSalary}
            onChange={e => setCeoSalary(Number(e.target.value))}
            className="kyn"
            style={{ width: 80, fontSize: 12 }}
          />
        </div>
      </div>

      {expanded && (
        <div className="sc-body">
          <div className="sc-grid4">
            {[
              { label: '이전 부동산', val: fmt(scenario.realEstateValue) },
              { label: '취득세 절감', val: fmt(scenario.acquisitionTaxSaving) },
              { label: '연간 절세', val: fmt(scenario.annualTaxSaving) },
              { label: '10년 누적 편익', val: fmt(scenario.tenYearBenefit) },
            ].map(c => (
              <div key={c.label} className="sc-cell">
                <div className="sl">{c.label}</div>
                <div className="sv">{c.val}</div>
              </div>
            ))}
          </div>

          <div>
            <div className="sc-cmp-title">세금 부담 비교 (연간)</div>
            <table className="sc-tbl">
              <thead>
                <tr>
                  <th>구분</th>
                  <th>금액 (억/년)</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>개인 임대소득세 (현재)</td>
                  <td style={{ color: 'var(--red)', fontWeight: 600 }}>{fmt(scenario.annualPersonalTax)}</td>
                </tr>
                <tr>
                  <td>법인세 + CEO 소득세 (전환 후)</td>
                  <td style={{ color: 'var(--amber)', fontWeight: 600 }}>{fmt(scenario.annualCorpTax)}</td>
                </tr>
                <tr>
                  <td style={{ fontWeight: 700 }}>연간 절세 효과</td>
                  <td style={{ fontWeight: 700 }}>+{fmt(scenario.annualTaxSaving)}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div className="sc-payback">
            <div className="sb-l">설립 비용 회수 기간</div>
            <div className="sb-v">
              {scenario.paybackYears >= 99 ? '해당 없음 (절세 효과 미미)' : `약 ${scenario.paybackYears.toFixed(1)}년`}
            </div>
          </div>

          <ExecutionRoadmap steps={scenario.executionSteps} totalWeeks={10} />

          <div className="warn-note">
            <strong>현물출자 지방세 감면은 자동 적용하지 않습니다.</strong> 자산 유형, 사업 실체, 실행 시점에 따른 적용 요건을 세무사에게 확인하세요.
          </div>
        </div>
      )}
    </div>
  );
}

// 시나리오 비교 테이블
function AdvancedScenarioComparisonTable({
  assets,
  members,
  totalEstate,
  inheritanceTax,
  strategies,
  selectedStrategyIds,
}: {
  assets: Asset[];
  members: FamilyMember[];
  totalEstate: number;
  inheritanceTax: number;
  strategies: RecoveryStrategy[];
  selectedStrategyIds: Set<string>;
}) {
  const strategyOptimalSaving = strategies
    .filter(s => s.isApplicable && selectedStrategyIds.has(s.id))
    .reduce((s, r) => s + r.netBenefit, 0);

  const foundationAsset = assets.find(a =>
    ['상업용부동산', '주거용부동산', '토지', '비상장주식'].includes(a.asset_type)
  );
  const foundationScenario = foundationAsset
    ? calcPublicFoundationScenario(foundationAsset, 30, totalEstate, members)
    : null;

  const corpScenario = calcCorpConversionScenario(assets, 1.2, members);

  type ScenarioRow = {
    name: string;
    inheritanceTax: number;
    tenYearSaving: number;
    annualCashImpact: number;
    complexity: string;
    suitability: string;
  };

  const rows: ScenarioRow[] = [
    {
      name: '현황 유지',
      inheritanceTax,
      tenYearSaving: 0,
      annualCashImpact: 0,
      complexity: '없음',
      suitability: '기준선',
    },
    {
      name: '회생방안 최적',
      inheritanceTax: Math.max(0, inheritanceTax - strategyOptimalSaving),
      tenYearSaving: strategyOptimalSaving,
      annualCashImpact: strategyOptimalSaving / 10,
      complexity: '중',
      suitability: selectedStrategyIds.size > 0 ? '선택됨' : '미선택',
    },
    {
      name: '공익법인 출연',
      inheritanceTax: foundationScenario?.newTax ?? inheritanceTax,
      tenYearSaving: foundationScenario?.taxSaving ?? 0,
      annualCashImpact: -(foundationScenario?.controlLossValue ?? 0) / 10,
      complexity: '높음',
      suitability: (foundationScenario?.netBenefit ?? 0) > 0 ? '권장' : '비권장',
    },
    {
      name: '법인전환',
      inheritanceTax,
      tenYearSaving: corpScenario.tenYearBenefit,
      annualCashImpact: corpScenario.annualTaxSaving,
      complexity: '중',
      suitability: corpScenario.annualTaxSaving > 0 ? '권장' : '비권장',
    },
  ];

  const minTax = Math.min(...rows.map(r => r.inheritanceTax));
  const maxTenYrSaving = Math.max(...rows.map(r => r.tenYearSaving));

  return (
    <div className="scen-cmp">
      <table>
        <thead>
          <tr>
            {['시나리오', '예상 상속세', '10년 절세 누적', '연간 현금흐름 영향', '복잡도', '적합도'].map(h => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const isBestTax = row.inheritanceTax === minTax;
            const isBestSaving = row.tenYearSaving === maxTenYrSaving && row.tenYearSaving > 0;
            return (
              <tr key={i}>
                <td style={{ fontWeight: 600 }}>{row.name}</td>
                <td className={isBestTax ? 'cmp-best' : 'cmp-neg'}>
                  {fmt(row.inheritanceTax)}
                  {isBestTax && <span className="cmp-best-tag">최저</span>}
                </td>
                <td className={isBestSaving ? 'cmp-best' : ''}>
                  {row.tenYearSaving > 0 ? `+${fmt(row.tenYearSaving)}` : '—'}
                  {isBestSaving && <span className="cmp-best-tag">최고</span>}
                </td>
                <td style={{ color: row.annualCashImpact > 0 ? 'var(--amber)' : row.annualCashImpact < 0 ? 'var(--red)' : 'var(--ink-faint)', fontWeight: 600 }}>
                  {row.annualCashImpact > 0 ? `+${fmtM(row.annualCashImpact)}` : row.annualCashImpact < 0 ? fmtM(row.annualCashImpact) : '—'}
                </td>
                <td className="cmp-nm">{row.complexity}</td>
                <td className={row.suitability === '권장' || row.suitability === '선택됨' ? 'cmp-rec' : row.suitability === '비권장' ? 'cmp-neg' : 'cmp-nm'}>
                  {row.suitability}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// 커스텀 시나리오 빌더
function CustomScenarioBuilder({
  assets,
  members,
  totalEstate,
  inheritanceTax,
  strategies,
}: {
  assets: Asset[];
  members: FamilyMember[];
  totalEstate: number;
  inheritanceTax: number;
  strategies: RecoveryStrategy[];
}) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [transfers, setTransfers] = useState<CustomAssetTransfer[]>([]);
  const [selectedStrategyIds, setSelectedStrategyIds] = useState<string[]>([]);
  const [savedMsg, setSavedMsg] = useState(false);

  const nonOwnerMembers = members.filter(m => m.relation !== '본인');

  function getTransfer(assetId: string): CustomAssetTransfer | undefined {
    return transfers.find(t => t.assetId === assetId);
  }

  function updateTransfer(assetId: string, patch: Partial<CustomAssetTransfer>) {
    setTransfers(prev => {
      const existing = prev.find(t => t.assetId === assetId);
      if (existing) {
        return prev.map(t => t.assetId === assetId ? { ...t, ...patch } : t);
      }
      return [...prev, { assetId, transferType: 'gift', transferPct: 50, ...patch }];
    });
  }

  function removeTransfer(assetId: string) {
    setTransfers(prev => prev.filter(t => t.assetId !== assetId));
  }

  const config: CustomScenarioConfig = {
    assetTransfers: transfers,
    selectedStrategyIds,
    foundationDonationPct: 30,
    corpConversionEnabled: transfers.some(t => t.transferType === 'corp'),
    ceoSalary: 1.2,
  };

  const result: CustomScenarioResult = calcCustomScenario(
    config, assets, members, totalEstate, inheritanceTax, strategies
  );

  function saveScenario() {
    try {
      localStorage.setItem('kyn_custom_scenario', JSON.stringify(config));
      setSavedMsg(true);
      setTimeout(() => setSavedMsg(false), 2000);
    } catch { /* ignore */ }
  }

  return (
    <div>
      <div className="csb-tabs">
        {([1, 2, 3] as const).map(s => (
          <button
            key={s}
            onClick={() => setStep(s)}
            className={`csb-tab${step === s ? ' on' : ''}`}
          >
            {s === 1 ? '1. 자산 이전 설계' : s === 2 ? '2. 전략 선택' : '3. 결과 요약'}
          </button>
        ))}
      </div>

      {step === 1 && (
        <div>
          <div className="csb-hint">각 자산을 포함할지 선택하고, 이전 방법과 비율을 설정하세요.</div>
          {assets.map(asset => {
            const t = getTransfer(asset.id);
            const included = !!t;
            const giftTaxForAsset = t && t.transferType === 'gift' && t.recipientMemberId
              ? (() => {
                  const recipient = members.find(m => m.id === t.recipientMemberId);
                  return recipient ? calcGiftTax(asset.current_value * (t.transferPct / 100), recipient.relation) : 0;
                })()
              : 0;

            return (
              <div key={asset.id} className={`csb-asset${included ? ' on' : ''}`}>
                <div className="ca-hd">
                  <input
                    type="checkbox"
                    checked={included}
                    onChange={e => {
                      if (e.target.checked) {
                        updateTransfer(asset.id, { assetId: asset.id, transferType: 'gift', transferPct: 50 });
                      } else {
                        removeTransfer(asset.id);
                      }
                    }}
                    style={{ marginTop: 2, accentColor: 'var(--gold-deep)' }}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <span className="ca-name">{asset.name}</span>
                    <span className="ca-type">{asset.asset_type}</span>
                    <span className="ca-val">{fmt(asset.current_value)}</span>
                  </div>
                </div>

                {included && t && (
                  <div className="ca-ctrls">
                    <div className="ca-row">
                      <label>이전 방법</label>
                      <select
                        value={t.transferType}
                        onChange={e => updateTransfer(asset.id, { transferType: e.target.value as CustomAssetTransfer['transferType'] })}
                        className="kyn"
                        style={{ fontSize: 12 }}
                      >
                        <option value="gift">증여</option>
                        <option value="foundation">공익법인 출연</option>
                        <option value="corp">법인전환</option>
                        <option value="sell">매각</option>
                      </select>

                      {t.transferType === 'gift' && (
                        <>
                          <label>수증자</label>
                          <select
                            value={t.recipientMemberId ?? ''}
                            onChange={e => updateTransfer(asset.id, { recipientMemberId: e.target.value })}
                            className="kyn"
                            style={{ fontSize: 12 }}
                          >
                            <option value="">선택</option>
                            {nonOwnerMembers.map(m => (
                              <option key={m.id} value={m.id}>{m.name} ({m.relation})</option>
                            ))}
                          </select>
                        </>
                      )}
                    </div>

                    <div className="ca-row">
                      <label style={{ whiteSpace: 'nowrap' }}>이전 비율: <strong>{t.transferPct}%</strong></label>
                      <input
                        type="range"
                        min={1} max={100} step={1}
                        value={t.transferPct}
                        onChange={e => updateTransfer(asset.id, { transferPct: Number(e.target.value) })}
                        style={{ flex: 1 }}
                      />
                      <span style={{ fontSize: 12, color: 'var(--ink-faint)', whiteSpace: 'nowrap' }}>{fmt(asset.current_value * t.transferPct / 100)}</span>
                    </div>

                    {t.transferType === 'gift' && t.recipientMemberId && (
                      <div className="ca-tax">예상 증여세: {fmtM(giftTaxForAsset)}</div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          <button onClick={() => setStep(2)} className="csb-btn">다음: 전략 선택 →</button>
        </div>
      )}

      {step === 2 && (
        <div>
          <div className="csb-hint">적용할 회생방안 전략을 선택하세요.</div>
          {strategies.filter(s => s.isApplicable).map(s => (
            <label key={s.id} className="csb-strat-item">
              <input
                type="checkbox"
                checked={selectedStrategyIds.includes(s.id)}
                onChange={e => {
                  if (e.target.checked) {
                    setSelectedStrategyIds(prev => [...prev, s.id]);
                  } else {
                    setSelectedStrategyIds(prev => prev.filter(id => id !== s.id));
                  }
                }}
                style={{ marginTop: 2, accentColor: 'var(--gold-deep)', flexShrink: 0 }}
              />
              <div style={{ flex: 1 }}>
                <span className="si-title">{s.title}</span>
                <span className="si-cat">{s.category}</span>
                {s.netBenefit > 0 && <div className="si-net">순편익 +{fmtM(s.netBenefit)}</div>}
              </div>
            </label>
          ))}
          <div className="csb-btn-row">
            <button onClick={() => setStep(1)} className="csb-btn sec">← 이전</button>
            <button onClick={() => setStep(3)} className="csb-btn">다음: 결과 보기 →</button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div>
          <div className="csb-res-grid">
            {[
              { label: '이전 자산 합계', val: fmt(result.totalTransferredValue), cls: '' },
              { label: '납부 세금 합계', val: fmt(result.totalTaxBurden), cls: 'neg' },
              { label: '기존 상속세', val: fmt(result.originalInheritanceTax), cls: 'neg' },
              { label: '새 상속세', val: fmt(result.newInheritanceTax), cls: '' },
              { label: '총 절세액', val: `+${fmt(result.totalTaxSaving)}`, cls: 'pos' },
              { label: '세후 순자산', val: fmt(result.netWealthAfter), cls: '' },
            ].map(c => (
              <div key={c.label} className="rg-cell">
                <div className="rl">{c.label}</div>
                <div className={`rv${c.cls ? ` ${c.cls}` : ''}`}>{c.val}</div>
              </div>
            ))}
          </div>
          <div className="csb-btn-row">
            <button onClick={() => setStep(2)} className="csb-btn sec">← 이전</button>
            <button
              onClick={saveScenario}
              className="csb-btn"
              style={savedMsg ? { background: 'var(--gold-deep)' } : {}}
            >
              {savedMsg ? '✓ 저장됨' : '이 시나리오 저장'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── SituationBanner ───────────────────────────────────────────
function SituationBanner({
  inheritanceTax,
  totalCash,
  totalEstate,
  urgencyLevel,
  donorAge,
  selectedSaving,
  urgencyLabel,
  remaining10yrCycles,
}: {
  inheritanceTax: number;
  totalCash: number;
  totalEstate: number;
  urgencyLevel: string;
  donorAge: number;
  selectedSaving: number;
  urgencyLabel: string;
  remaining10yrCycles: number;
}) {
  const shortage = Math.max(0, inheritanceTax - totalCash);
  const metrics = [
    { label: '예상 상속세', value: fmt(inheritanceTax) },
    { label: '현금 보유', value: fmt(totalCash) },
    { label: '부족분', value: shortage > 0 ? fmt(shortage) : '여유 있음' },
  ];

  return (
    <div className="urgency">
      <div className="utop">
        <div className="ustats">
          <div className="uc">
            <div className="ul">예상 상속세</div>
            <div className="uv num">{fmtN(inheritanceTax)}<span className="u">억</span></div>
          </div>
          <div className="uc">
            <div className="ul">현금 보유</div>
            <div className="uv num">{fmtN(totalCash)}<span className="u">억</span></div>
          </div>
          <div className={`uc ${shortage > 0 ? 'alert' : ''}`}>
            <div className="ul">부족분</div>
            <div className="uv num">{shortage > 0 ? fmtN(shortage) : '여유 있음'}{shortage > 0 && <span className="u">억</span>}</div>
          </div>
        </div>
        <div className="usave">
          <div className="usl">선택한 전략 절세</div>
          <div className="usv num">+{fmtN(selectedSaving)}<span className="u">억</span></div>
          <div className="usf">아래 Q2에서 선택한 카드 합계</div>
        </div>
      </div>
      <div className="urow">
        <span className={`badge ${urgencyLevel === 'critical' || urgencyLevel === 'high' ? 'is-stop' : 'is-watch'}`}>
          <span className="dot" />긴급도 {urgencyLabel}
        </span>
        <span>증여자 {donorAge}세</span><span className="sep">·</span>
        <span>남은 10년 사이클 {remaining10yrCycles}회</span><span className="sep">·</span>
        <span>총자산 {fmt(totalEstate)}</span>
      </div>
    </div>
  );
}

// ── StepSection ───────────────────────────────────────────────
const STEP_LABELS = ['01', '02', '03', '04', '05'];

function StepSection({
  stepNum,
  question,
  subtitle,
  children,
  defaultOpen = true,
}: {
  stepNum: number;
  question: string;
  subtitle: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const stepLabel = STEP_LABELS[stepNum - 1] ?? `단계 ${stepNum}`;

  return (
    <section className="qsec block" data-open={open ? 'true' : 'false'}>
      <button
        onClick={() => setOpen(o => !o)}
        className="qhead"
        type="button"
        aria-expanded={open}
      >
        <span className="qn">{stepLabel}</span>
        <div className="qcopy">
          <h3>{question}</h3>
          <span className="qd">{subtitle}</span>
        </div>
        <span className="chev" aria-hidden="true" />
      </button>
      {open && (
        <div className="qbody">
          {children}
        </div>
      )}
    </section>
  );
}

// ── UnifiedOptionSelector (Step 2 내부) ──────────────────────
type UnifiedTab = 'immediate' | 'structural';

function UnifiedOptionSelector({
  strategies,
  selectedIds,
  onToggle,
  assets,
  members,
  totalEstate,
  inheritanceTax,
  adjustedTaxResult,
  giftEstimate,
  foundationAssetId,
  foundationDonationPct,
  onFoundationAssetChange,
  onFoundationPctChange,
}: {
  strategies: RecoveryStrategy[];
  selectedIds: Set<string>;
  onToggle: (id: string) => void;
  assets: Asset[];
  members: FamilyMember[];
  totalEstate: number;
  inheritanceTax: number;
  adjustedTaxResult: AdjustedTaxResult | null;
  giftEstimate: GiftSelectionEstimate;
  foundationAssetId: string;
  foundationDonationPct: number;
  onFoundationAssetChange: (id: string) => void;
  onFoundationPctChange: (pct: number) => void;
}) {
  const [tab, setTab] = useState<UnifiedTab>('immediate');

  const immediateStrategies = strategies.filter(s => s.category === '즉시');
  const structuralStrategies = strategies.filter(s => s.category !== '즉시');

  const selectedList = strategies.filter(s => selectedIds.has(s.id) && s.isApplicable);
  const afterStrategies = adjustedTaxResult?.adjustedTax ?? inheritanceTax;
  const longTermTaxBurden = giftEstimate.totalTaxCost + afterStrategies;
  const totalSaving = adjustedTaxResult
    ? Math.max(0, inheritanceTax - longTermTaxBurden)
    : selectedList.reduce((sum, s) => sum + s.netBenefit, 0);
  const adjustedEstate = adjustedTaxResult?.adjustedEstate ?? totalEstate;
  const immediateGiftOverride = {
    taxSavingEstimate: giftEstimate.inheritanceTaxReduction,
    costEstimate: giftEstimate.totalTaxCost,
    netBenefit: Math.max(0, giftEstimate.inheritanceTaxReduction - giftEstimate.totalTaxCost),
  };

  const tabs: { key: UnifiedTab; label: string }[] = [
    { key: 'immediate', label: `즉시 실행 (${immediateStrategies.length}개)` },
    { key: 'structural', label: `단기·구조적 (${structuralStrategies.length}개)` },
  ];

  return (
    <div>
      {/* Sub-tabs */}
      <div className="ttabs">
        {tabs.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className="ttab"
            type="button"
            aria-selected={tab === t.key}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {tab === 'immediate' && (
        <div className="strats">
          {immediateStrategies.length === 0 && (
            <div style={{ padding: '24px', textAlign: 'center', fontSize: 12, color: 'var(--ink-faint)' }}>즉시 실행 가능한 전략이 없습니다.</div>
          )}
          {immediateStrategies.map(s => (
            <StrategyCard
              key={s.id}
              s={s}
              isSelected={selectedIds.has(s.id)}
              onToggle={() => onToggle(s.id)}
              estimateOverride={s.id === 'immediate_gift_growth' ? immediateGiftOverride : undefined}
            />
          ))}
        </div>
      )}

      {tab === 'structural' && (
        <div className="strats">
          {structuralStrategies.length === 0 && (
            <div style={{ padding: '24px', textAlign: 'center', fontSize: 12, color: 'var(--ink-faint)' }}>단기·구조적 전략이 없습니다.</div>
          )}
          {structuralStrategies.map(s => (
            <StrategyCard key={s.id} s={s} isSelected={selectedIds.has(s.id)} onToggle={() => onToggle(s.id)} />
          ))}
          {selectedIds.has('corp_conversion') && (
            <div style={{ borderTop: '1px solid var(--line)', padding: '20px', background: 'var(--paper)' }}>
              <div style={{ marginBottom: 10, fontSize: 12, fontWeight: 700, color: 'var(--ink-faint)' }}>선택한 법인전환 상세 검토</div>
              <CorpConversionCard assets={assets} members={members} />
            </div>
          )}
          {selectedIds.has('charity_foundation') && (
            <div style={{ borderTop: '1px solid var(--line)', padding: '20px', background: 'var(--paper)' }}>
              <div style={{ marginBottom: 10, fontSize: 12, fontWeight: 700, color: 'var(--ink-faint)' }}>선택한 공익법인 출연 상세 조정</div>
              <PublicFoundationCard
                assets={assets}
                members={members}
                totalEstate={totalEstate}
                inheritanceTax={inheritanceTax}
                selectedAssetId={foundationAssetId}
                donationPct={foundationDonationPct}
                onAssetChange={onFoundationAssetChange}
                onPctChange={onFoundationPctChange}
              />
            </div>
          )}
        </div>
      )}

      <div className="stratfoot">
        <span className="sf">선택한 전략 <b>{selectedList.length}가지</b></span>
        <span className="sf">절세 합계 <b style={{ color: 'var(--green-ink)' }}>+{fmt(totalSaving)}</b></span>
        <span className="sf danger">장기 세부담 <b>{fmt(longTermTaxBurden)}</b></span>
        {adjustedTaxResult && adjustedTaxResult.adjustedEstate < totalEstate && (
          <span className="sf">과세자산 <b style={{ color: 'var(--amber)' }}>{fmt(totalEstate)}</b> → <b>{fmt(adjustedEstate)}</b></span>
        )}
        <span className="sf spush">Step 3에서 납부방법 확인</span>
      </div>
    </div>
  );
}

// ── PaymentPlanSection (Step 3 내부) ─────────────────────────
type PayMethod = 'installment' | 'loan' | 'physical' | 'combo';

function PaymentPlanSection({
  plan,
  inheritanceTax,
  adjustedTax,
  totalCash,
  assets,
  giftEstimate,
}: {
  plan: RecoveryPlanAnalysis;
  inheritanceTax: number;
  adjustedTax: number;
  totalCash: number;
  assets: Asset[];
  giftEstimate: GiftSelectionEstimate;
}) {
  const [selected, setSelected] = useState<PayMethod>('combo');
  const [physicalAssetId, setPhysicalAssetId] = useState<string>('');

  const remainingTax = Math.max(0, adjustedTax);
  const taxReduction = Math.max(0, inheritanceTax - remainingTax);
  const cashShortfall = Math.max(0, remainingTax - totalCash);
  const annualNetCashflow = plan.totalNetCashflow;
  const hasImmediateGift = giftEstimate.giftAmount > 0;
  const immediateTaxShortfall = giftEstimate.recipientCashShortfall;

  // 물납 대상 자산 목록 (부동산, 대출 없는 것 우선)
  const reAssets = assets.filter(a =>
    ['상업용부동산', '주거용부동산', '토지'].includes(a.asset_type)
  );
  const noLoanRE = reAssets.filter(a => a.loan_amount === 0);
  const withLoanRE = reAssets.filter(a => a.loan_amount > 0);
  const physicalOptions = [...noLoanRE, ...withLoanRE]; // 대출 없는 것 먼저

  // 초기 물납 자산 설정
  const defaultPhysicalId = physicalOptions[0]?.id ?? '';
  const effectivePhysicalId = physicalAssetId || defaultPhysicalId;
  const physicalAsset = assets.find(a => a.id === effectivePhysicalId);

  // 물납 계산
  const publicRatio = physicalAsset ? (physicalAsset.public_price_ratio || 70) / 100 : 0.7;
  const physicalValue = physicalAsset ? physicalAsset.current_value : 0; // 시가
  const physicalPublicValue = physicalValue * publicRatio;               // 공시가 (납부 인정액)
  const physicalSikaLoss = physicalValue - physicalPublicValue;           // 시가 손해
  const remainAfterPhysical = Math.max(0, remainingTax - physicalPublicValue);
  const hasLoan = physicalAsset ? physicalAsset.loan_amount > 0 : false;

  const methods: Array<{ id: PayMethod; icon: string; label: string; tag?: string; tagColor?: string }> = [
    { id: 'combo',       icon: '⭐', label: '조합 전략',   tag: '권장',  tagColor: 'bg-stone-100 text-stone-700' },
    { id: 'installment', icon: '📅', label: '연부연납 10년', tag: '안전', tagColor: 'bg-amber-50 text-amber-800' },
    { id: 'physical',    icon: '🏠', label: '부동산 물납',  tag: '가능', tagColor: 'bg-orange-100 text-amber-800' },
    { id: 'loan',        icon: '🏦', label: '담보대출', tag: '마지막 수단', tagColor: 'bg-stone-100 text-stone-700' },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      {/* 즉시 증여세 납부안 */}
      <div className="payrecip">
        <div className="pr-head">
          <span className="ph-t">지금 실행할 증여세 납부안</span>
          <span>즉시 증여액 <b>{fmt(giftEstimate.giftAmount)}</b></span>
          <span>예상 증여세 <b>{fmt(giftEstimate.giftTax)}</b></span>
          <span>수증자별 확인 재원 합계 <b>{fmt(giftEstimate.recipientCashAvailable)}</b></span>
          <span>수증자별 부족액 합계 <b className={immediateTaxShortfall > 0 ? 'due' : ''}>{immediateTaxShortfall > 0 ? fmt(immediateTaxShortfall) : '없음'}</b></span>
        </div>
        {!hasImmediateGift ? (
          <div className="pr-note">Step 2에서 증여 비율을 선택하면 수증자별 증여세와 즉시 필요한 재원을 계산합니다.</div>
        ) : (
          <>
            <div className="pr-cols">
              {giftEstimate.recipients.map(recipient => (
                <div key={recipient.memberId} className="prc">
                  <div className="pn">{recipient.name}<span className="rl">{recipient.relation}</span></div>
                  <div className="pm">증여 {fmt(recipient.giftAmount)} · 세금 {fmt(recipient.giftTax)} · 취득세 {fmt(recipient.acquisitionTax)} · 재원 {fmt(recipient.availableCash)}</div>
                  <div className={`short ${recipient.shortfall <= 0 ? 'ok' : ''}`}>
                    {recipient.shortfall > 0 ? `부족 ${fmt(recipient.shortfall)}` : '부족 없음'}
                  </div>
                </div>
              ))}
            </div>
            <div className="pr-note">
              {immediateTaxShortfall > 0
                ? '현재 수증자 재원만으로는 부족합니다. 증여 비율 축소·분할, 수증자 금융자산 확보, 실제 상환 가능한 가족간 차용 순서로 검토하세요. 증여자가 세금을 대신 내면 추가 증여로 볼 수 있습니다.'
                : '수증자 보유현금의 80% 이내에서 즉시 납부 가능한 안입니다. 생활·비상자금 유보액과 실제 자금 출처를 확인하세요.'}
            </div>
          </>
        )}
      </div>

      {/* 향후 상속 납부안 */}
      <div className="panel" style={{ marginBottom: 20 }}>
        <div className="payhead" style={{ marginBottom: 12 }}>
          <b style={{ fontSize: 14.5 }}>향후 상속 발생 시 납부안</b>
          <span className="muted" style={{ fontSize: 12 }}>선택 증여가 10년 합산에서 제외된다는 가정</span>
        </div>
        <div className="payhead">
          <span>상속세 <b>{fmt(remainingTax)}</b></span>
          <span>전략 절감 <b>-{fmt(taxReduction)}</b></span>
          <span>현금 보유 <b>{fmt(totalCash)}</b></span>
          <span>부족분 <b style={{ color: cashShortfall > 0 ? 'var(--red)' : 'var(--green-ink)' }}>{cashShortfall > 0 ? fmt(cashShortfall) : '없음'}</b></span>
          <span>임대수익 <b>{fmt(annualNetCashflow)}/년</b></span>
        </div>
        <div className="callout" style={{ marginTop: 14 }}>등록된 재원 기준 검토 순서: 현금·금융자산 → 연부연납과 현금흐름 → 일부 매각·물납 → 상환 가능한 범위의 대출</div>
      </div>

      {/* 납부 방법 카드 */}
      <div className="methods">
        {methods.map(m => (
          <div
            key={m.id}
            onClick={() => setSelected(m.id)}
            className={`method${selected === m.id ? ' rec' : ''}`}
          >
            <div className="mlab">
              {m.id === 'combo' ? 'RECOMMENDED' : m.id === 'installment' ? 'OPTION A' : m.id === 'physical' ? 'OPTION B' : 'OPTION C'}
            </div>
            <div className="mt">{m.label}</div>
            {m.tag && (
              <div className={`mtag${m.id === 'installment' ? ' go' : m.id === 'physical' ? ' watch' : m.id === 'loan' ? ' last' : ' rec'}`}>
                {m.tag}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* 선택된 납부 방법 상세 */}
      <div className="steps">

        {/* ① 조합 전략 */}
        {selected === 'combo' && (
          <>
            <div className="stp hl">
              <div className="sct">STEP 1 — 선택한 증여 규모의 즉시 재원 확인</div>
              <ul>
                <li>증여액 <b>{fmt(giftEstimate.giftAmount)}</b> · 예상 증여세 <b>{fmt(giftEstimate.giftTax)}</b> · 취득세 <b>{fmt(giftEstimate.acquisitionTax)}</b></li>
                <li>수증자별 확인 재원 합계 <b>{fmt(giftEstimate.recipientCashAvailable)}</b> · 부족액 합계 <b>{immediateTaxShortfall > 0 ? fmt(immediateTaxShortfall) : '없음'}</b></li>
                <li>부족하면 증여액을 낮추거나 여러 시점으로 분할해 다시 비교</li>
              </ul>
            </div>
            <div className="stp">
              <div className="sct">STEP 2 — 연부연납 10년 (납부 분산)</div>
              <ul>
                <li>남은 세금 <b>{fmt(remainingTax)}</b> → 연 <b>{fmt(remainingTax / 10)}</b>씩 10년 분할</li>
                <li>임대수익 {fmt(annualNetCashflow)}/년으로 납부 {annualNetCashflow >= remainingTax / 10 ? <span style={{ color: 'var(--green-ink)', fontWeight: 600 }}>✓ 가능</span> : <span className="neg">△ 부족 {fmt(remainingTax / 10 - annualNetCashflow)}/년</span>}</li>
                <li>가산금률 연 3.5% 기준 · 실제 신청 시점의 고시율 재확인</li>
              </ul>
            </div>
            {annualNetCashflow < remainingTax / 10 && (
              <div className="stp">
                <div className="sct">STEP 3 — 부족분 재원 순서대로 검토</div>
                <ul>
                  <li>연 부족분 {fmt(remainingTax / 10 - annualNetCashflow)} → 금융자산, 일부 매각·물납을 먼저 비교</li>
                  <li>담보대출은 원리금 상환 가능성이 확인되는 범위에서 마지막으로 검토</li>
                </ul>
              </div>
            )}
            <div className="stp">
              <div className="sct">STEP 4 — 10년 후 2차 이전</div>
              <ul>
                <li>기존 증여의 합산 기간 종료 여부를 확인하고 잔여 자산을 다시 비교</li>
                <li>전부 이전을 자동 전제하지 않고 당시 재원·건강·자산가치를 재평가</li>
              </ul>
            </div>
            <div className="callout is-legal">실제 실행 전에는 수증자별 자금 출처, 상속 시점, 연부연납 요건과 담보 여력을 전문가와 확인해야 합니다.</div>
          </>
        )}

        {/* ② 연부연납 */}
        {selected === 'installment' && (
          <>
            <div className="stp hl">
              <div className="sct">연부연납 10년 — 납부 충격 분산</div>
              <ul>
                <li>연간 납부액: <b>{fmt(remainingTax / 10)}</b> · 가산금률 연 3.5% · 가산금 단순 추정 <b>{fmt(remainingTax * 0.035 * 5)}</b></li>
                <li>임대수익 {fmt(annualNetCashflow)}/년 기준 →{' '}
                  {annualNetCashflow >= remainingTax / 10
                    ? <span style={{ color: 'var(--green-ink)', fontWeight: 600 }}>✓ 등록 현금흐름 기준 커버 가능</span>
                    : <span className="neg">연 {fmt(remainingTax / 10 - annualNetCashflow)} 부족 → 담보대출 또는 물납 보완 필요</span>}
                </li>
              </ul>
            </div>
            <div className="stp">
              <div className="sct">실행 방법</div>
              <ul>
                <li>상속 신고 시 연부연납 신청서 동시 제출</li>
                <li>담보 제공 (부동산·유가증권): 담보가액 ≥ 연부연납 세액</li>
                <li>담보 설정 부동산 처분 시 즉시 전액 납부 의무 주의</li>
              </ul>
            </div>
          </>
        )}

        {/* ③ 담보대출 */}
        {selected === 'loan' && (
          <>
            <div className="stp hl">
              <div className="sct">부동산 담보대출 → 즉시 납부</div>
              <ul>
                <li>필요 대출액: <b>{fmt(cashShortfall > 0 ? cashShortfall : remainingTax)}</b> · 연 이자(4%): <b>{fmt((cashShortfall > 0 ? cashShortfall : remainingTax) * 0.04)}</b></li>
                <li>임대수익 대비: <b>{annualNetCashflow > 0 ? (((cashShortfall > 0 ? cashShortfall : remainingTax) * 0.04 / annualNetCashflow) * 100).toFixed(0) : '—'}%</b></li>
              </ul>
            </div>
            <div className="stp">
              <div className="sct">실행 방법</div>
              <ul>
                <li>대출 한도: 부동산 감정가의 50~70% (은행별 상이)</li>
                <li>상속 후 6개월 내 납부 완료 → 신고세액공제 3% 유지</li>
                <li>대출 이자는 부동산 임대수익으로 상환 (수익률 대비 확인)</li>
                <li>변동금리 주의 — 고정금리 대출 권장</li>
              </ul>
            </div>
          </>
        )}

        {/* ④ 물납 */}
        {selected === 'physical' && (
          <>
            {physicalOptions.length > 0 ? (
              <>
                <div className="stp hl">
                  <div className="sct">부동산 물납 — 자산으로 직접 납부</div>
                  <ul>
                    <li>
                      물납 대상 자산:{' '}
                      <select
                        value={effectivePhysicalId}
                        onChange={e => setPhysicalAssetId(e.target.value)}
                        style={{ fontSize: 13, border: '1px solid var(--line)', padding: '2px 8px', background: 'var(--bg)' }}
                      >
                        {physicalOptions.map(a => (
                          <option key={a.id} value={a.id}>
                            {a.name} ({fmt(a.current_value)}) {a.loan_amount > 0 ? '⚠ 대출있음' : '✓대출없음'}
                          </option>
                        ))}
                      </select>
                    </li>
                    {physicalAsset && (
                      <>
                        <li>시가(실제 가치): <b>{fmt(physicalValue)}</b> · 공시가(납부 인정액): <b>{fmt(physicalPublicValue)}</b> · 시가 손해액: <b>{fmt(physicalSikaLoss)}</b></li>
                        <li>물납 후 잔여 세금: <b>{fmt(remainAfterPhysical)}</b></li>
                        {hasLoan && <li className="neg">이 자산에 대출({fmt(physicalAsset.loan_amount)})이 있어 물납 허가가 어려울 수 있습니다. 대출 없는 자산 선택 권장.</li>}
                        {remainAfterPhysical > 0 && <li>물납 후 잔여 {fmt(remainAfterPhysical)} → 연부연납 {fmt(remainAfterPhysical / 10)}/년 또는 담보대출로 보완 권장</li>}
                      </>
                    )}
                  </ul>
                </div>
                <div className="stp">
                  <div className="sct">실행 절차 (상증법 §73)</div>
                  <ul>
                    <li>상속세 신고 시 물납 신청서 제출 (납부 기한 내)</li>
                    <li>세무서 물납 허가 심사 (약 2~4주)</li>
                    <li>허가 후 부동산 소유권 이전 등기</li>
                    <li>잔여 세금은 현금 납부 또는 연부연납 처리</li>
                  </ul>
                </div>
              </>
            ) : (
              <div className="stp">
                <div className="sct">물납 가능한 부동산이 없습니다.</div>
              </div>
            )}
          </>
        )}
      </div>

      {/* 자산 보전 현황 */}
      <div className="card-head" style={{ padding: '26px 0 14px' }}><span className="t">자산 보전 현황</span></div>
      <div className="mini" style={{ border: '1px solid var(--line)' }}>
        <div><div className="l">총 자산</div><div className="n num">{fmt(plan.totalValue)}</div></div>
        <div><div className="l">연 임대수익</div><div className="n num">{fmt(plan.totalRevenue)}</div></div>
        <div>
          <div className="l">연 순현금흐름</div>
          <div className="n num" style={plan.totalNetCashflow > 0 ? { color: 'var(--green-ink)' } : { color: 'var(--red)' }}>
            {fmt(plan.totalNetCashflow)}
          </div>
        </div>
        <div><div className="l">권장 납부방식</div><div className="n">{METHOD_LABELS[plan.recommendedMethod]}</div></div>
      </div>

      <RecoveryCashflowSection plan={plan} />
    </div>
  );
}

// ── UnifiedActionTimeline (Step 4 내부) ──────────────────────
type TimingGroup = {
  label: string;
  match: (timing: string) => boolean;
  color: string;
  dot: string;
};

const TIMING_GROUPS: TimingGroup[] = [
  {
    label: '즉시 (지금 당장)',
    match: (t) => /즉시|1주차/.test(t),
    color: 'bg-red-50 border-red-200',
    dot: 'bg-red-500',
  },
  {
    label: '1개월 내',
    match: (t) => /1~2주|2~4주|1개월/.test(t),
    color: 'bg-orange-50 border-orange-200',
    dot: 'bg-orange-500',
  },
  {
    label: '3개월 내',
    match: (t) => /3~8주|2~3개월/.test(t),
    color: 'bg-yellow-50 border-yellow-200',
    dot: 'bg-yellow-500',
  },
  {
    label: '상속 발생 시',
    match: (t) => /사망|신고/.test(t),
    color: 'bg-stone-50 border-stone-300',
    dot: 'bg-stone-50',
  },
  {
    label: '지속적으로',
    match: (t) => /매년|이후/.test(t),
    color: 'bg-amber-50 border-amber-200',
    dot: 'bg-amber-500',
  },
];

function UnifiedActionTimeline({ selectedStrategies }: { selectedStrategies: RecoveryStrategy[] }) {
  if (selectedStrategies.length === 0) {
    return (
      <div className="empty">
        ↑ 전략을 선택하면 통합 실행 계획이 여기에 표시됩니다
      </div>
    );
  }

  type TaggedStep = ExecutionStep & { strategyTitle: string; strategyCategory: string };
  const allSteps: TaggedStep[] = selectedStrategies.flatMap(s =>
    (s.executionSteps ?? []).map(step => ({
      ...step,
      strategyTitle: s.title,
      strategyCategory: s.category,
    }))
  );

  return (
    <div className="actplan">
      <div className="ap-band">
        <span className="badge is-stop"><span className="dot" />즉시 (지금 당장)</span>
        지금 바로 시작할 액션
        <span className="ct">{allSteps.length}개 액션</span>
      </div>
      {allSteps.map((step, i) => (
        <div key={i} className="ap-row">
          <span className="no">{i + 1}</span>
          <div>
            <div className="at">
              <span className="pill gold">{step.strategyTitle}</span>
              <span className="nm">{step.title}</span>
              {step.actor && <span className="role">{step.actor}</span>}
            </div>
            <div className="ad">{step.description}{step.estimatedCost && ` · 비용: ${step.estimatedCost}`}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

// AdvancedScenariosSection 래퍼
function AdvancedScenariosSection({
  assets,
  members,
  totalEstate,
  inheritanceTax,
  strategies,
  selectedStrategyIds,
  foundationAssetId,
  foundationDonationPct,
  onFoundationAssetChange,
  onFoundationPctChange,
}: {
  assets: Asset[];
  members: FamilyMember[];
  totalEstate: number;
  inheritanceTax: number;
  strategies: RecoveryStrategy[];
  selectedStrategyIds: Set<string>;
  foundationAssetId: string;
  foundationDonationPct: number;
  onFoundationAssetChange: (id: string) => void;
  onFoundationPctChange: (pct: number) => void;
}) {
  const [activeTab, setActiveTab] = useState<'foundation' | 'corp' | 'compare' | 'custom'>('foundation');

  const tabs: { key: typeof activeTab; label: string }[] = [
    { key: 'foundation', label: '공익법인' },
    { key: 'corp', label: '법인전환' },
    { key: 'compare', label: '시나리오 비교' },
    { key: 'custom', label: '커스텀 설계' },
  ];

  return (
    <div className="adv-wrap">
      <div className="adv-div">
        <hr />
        <div className="adv-title">
          <h2>고급 시나리오 분석</h2>
          <p>공익법인 출연·법인전환·커스텀 시나리오 비교</p>
        </div>
        <hr />
      </div>

      <div className="adv-tabs">
        {tabs.map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className="adv-tab"
            aria-selected={activeTab === tab.key}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* 탭 콘텐츠 */}
      {activeTab === 'foundation' && (
        <PublicFoundationCard
          assets={assets}
          members={members}
          totalEstate={totalEstate}
          inheritanceTax={inheritanceTax}
          selectedAssetId={foundationAssetId}
          donationPct={foundationDonationPct}
          onAssetChange={onFoundationAssetChange}
          onPctChange={onFoundationPctChange}
        />
      )}
      {activeTab === 'corp' && (
        <CorpConversionCard
          assets={assets}
          members={members}
        />
      )}
      {activeTab === 'compare' && (
        <AdvancedScenarioComparisonTable
          assets={assets}
          members={members}
          totalEstate={totalEstate}
          inheritanceTax={inheritanceTax}
          strategies={strategies}
          selectedStrategyIds={selectedStrategyIds}
        />
      )}
      {activeTab === 'custom' && (
        <CustomScenarioBuilder
          assets={assets}
          members={members}
          totalEstate={totalEstate}
          inheritanceTax={inheritanceTax}
          strategies={strategies}
        />
      )}
    </div>
  );
}

// ── 메인 페이지 ───────────────────────────────────────────────
export default function StrategyPage() {
  const [assets,  setAssets]  = useState<Asset[]>([]);
  const [members, setMembers] = useState<FamilyMember[]>([]);
  const [macro,   setMacro]   = useState<MacroSettings | null>(null);
  const [plans,   setPlans]   = useState<TransferPlan[]>([]);
  const [loading, setLoading] = useState(true);
  const supabase = createClient();

  const [donorId,       setDonorId]       = useState<string>('');
  const [recipientIds,  setRecipientIds]  = useState<Set<string>>(new Set());
  const [priorGifts10yr, setPriorGifts10yr] = useState<number>(0);
  const [priorGiftsMap,  setPriorGiftsMap]  = useState<Record<string, number>>({});
  const [selectedStrategyIds, setSelectedStrategyIds] = useState<Set<string>>(() => {
    return new Set(loadSavedRecoveryScenario().selectedStrategyIds);
  });

  // 공익법인 출연 — 페이지 레벨 상태 (슬라이더 값이 메인 계산에 반영되도록)
  const [foundationAssetId, setFoundationAssetId] = useState<string>(() => loadSavedRecoveryScenario().foundationAssetId);
  const [foundationDonationPct, setFoundationDonationPct] = useState<number>(() => loadSavedRecoveryScenario().foundationDonationPct);
  const [giftNowPct, setGiftNowPct] = useState<number>(() => loadSavedRecoveryScenario().giftNowPct);
  const [savedAt, setSavedAt] = useState<string>(() => loadSavedRecoveryScenario().savedAt);
  const [scenarioLabel, setScenarioLabel] = useState('');

  function toggleStrategy(id: string) {
    if (id === 'immediate_gift_growth') {
      setGiftNowPct(prev => prev > 0 ? 0 : 10);
      return;
    }
    setSelectedStrategyIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  useEffect(() => { load(); }, []);

  async function load() {
    const tid = setTimeout(() => setLoading(false), 15000);
    try {
      const { data: p } = await supabase.from('profiles').select('family_id').single();
      if (!p?.family_id) return;
      const [{ data: a }, { data: m }, { data: ms }, { data: pl }] = await Promise.all([
        supabase.from('assets').select('*').eq('family_id', p.family_id),
        supabase.from('family_members').select('*').eq('family_id', p.family_id),
        supabase.from('macro_settings').select('*').eq('family_id', p.family_id).single(),
        supabase.from('transfer_plans').select('*').eq('family_id', p.family_id).order('year_offset'),
      ]);
      const memberList: FamilyMember[] = m || [];
      setAssets(a || []);
      setMembers(memberList);
      setMacro(ms || null);
      setPlans((pl as TransferPlan[]) || []);

      const self = memberList.find(m => m.relation === '본인') ?? memberList[0];
      if (self) setDonorId(self.id);
      const others = memberList.filter(m => m.id !== self?.id);
      setRecipientIds(new Set(others.map(m => m.id)));
    } catch {
      // 에러 시 로딩 종료
    } finally {
      clearTimeout(tid);
      setLoading(false);
    }
  }

  if (loading) {
    return <KynLoader />;
  }
  if (assets.length === 0) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', color: 'var(--ink-faint)' }}>
        자산을 먼저 등록해주세요
      </div>
    );
  }

  const donor             = members.find(m => m.id === donorId);
  const totalEstate       = assets.reduce((s, a) => s + a.current_value, 0);
  const portfolioGrowthRate = totalEstate > 0
    ? assets.reduce((sum, asset) => sum + getAssetGrowthRate(asset, macro) * asset.current_value, 0) / totalEstate
    : 0;
  const selectedRecipients = members.filter(m => recipientIds.has(m.id));
  const nonDonorMembers   = members.filter(m => m.id !== donorId);

  // 요약 수치 (donor 있을 때만)
  const bracket = donor
    ? calcEstateBracketAnalysis(totalEstate, members, donor.age, priorGifts10yr, portfolioGrowthRate)
    : null;
  const urgency = donor ? calcDonorUrgency(donor.age) : null;

  // 현금흐름 & 납부 재원 분석
  const inheritanceTaxNow = bracket?.currentInheritanceTax ?? 0;

  // 회생방안 전략 분석
  const recoveryStrategies = donor
    ? calcRecoveryStrategies(totalEstate, members, assets, inheritanceTaxNow, donor.age, priorGifts10yr)
    : [];
  const totalStrategySaving = recoveryStrategies
    .filter(s => s.isApplicable)
    .reduce((s, r) => s + r.netBenefit, 0);

  function toggleRecipient(id: string) {
    setRecipientIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  // Derived values for new layout
  const totalCash = members.reduce((s, m) => s + (m.cash_hold ?? 0), 0);
  const effectiveSelectedStrategyIds = new Set(selectedStrategyIds);
  if (giftNowPct > 0) effectiveSelectedStrategyIds.add('immediate_gift_growth');
  else effectiveSelectedStrategyIds.delete('immediate_gift_growth');
  const selectedStrategiesList = recoveryStrategies.filter(s => effectiveSelectedStrategyIds.has(s.id) && s.isApplicable);
  const taxableBase = bracket ? Math.max(0, bracket.currentTaxableBase) : 0;
  const marginalRate = bracket ? (bracket.currentMarginalRate * 100).toFixed(0) : '0';

  // 공익법인 출연 — 슬라이더 값을 메인 계산에 반영
  const eligibleFoundationAssets = assets.filter(a =>
    ['상업용부동산', '주거용부동산', '토지', '비상장주식'].includes(a.asset_type)
  );
  const resolvedFoundationAssetId = foundationAssetId || eligibleFoundationAssets[0]?.id || '';
  const foundationAsset = assets.find(a => a.id === resolvedFoundationAssetId);
  const foundationDonationAmt = effectiveSelectedStrategyIds.has('charity_foundation') && foundationAsset
    ? foundationAsset.current_value * (foundationDonationPct / 100)
    : 0;

  const giftEstimate = estimateSelectedGift({
    totalEstate,
    giftPct: giftNowPct,
    assets,
    recipients: selectedRecipients,
    members,
    priorGiftsMap,
    inheritanceTaxNow,
  });
  const giftNetEffect = giftEstimate.inheritanceTaxReduction - giftEstimate.totalTaxCost;
  const giftNetEffectLabel = `${giftNetEffect >= 0 ? '+' : '-'}${fmt(Math.abs(giftNetEffect))}`;
  const giftNetEffectTone = giftNetEffect >= 0 ? 'var(--green-ink)' : 'var(--red)';
  const giftEffectNote = giftNowPct > 0
    ? `증여 비중이 높아지면 장래 상속세는 줄지만, 지금 내는 증여세와 부동산 취득세도 같이 커집니다. 현재 선택은 상속세 ${fmt(giftEstimate.inheritanceTaxReduction)} 감소, 즉시 이전비용 ${fmt(giftEstimate.totalTaxCost)}(증여세 ${fmt(giftEstimate.giftTax)} + 취득세 ${fmt(giftEstimate.acquisitionTax)})로 순효과 ${giftNetEffectLabel}입니다.`
    : '증여 비율을 올리면 장래 상속세 감소분과 지금 발생하는 증여세·취득세를 나눠서 비교합니다.';
  const selectedSaving = selectedStrategiesList.reduce((sum, strategy) => {
    if (strategy.id !== 'immediate_gift_growth') return sum + strategy.netBenefit;
    return sum + Math.max(0, giftEstimate.inheritanceTaxReduction - giftEstimate.totalTaxCost);
  }, 0);
  const selectedIdsForAdjustedTax = Array.from(effectiveSelectedStrategyIds)
    .filter(id => id !== 'immediate_gift_growth');

  // 선택 증여는 직접 반영하고, 나머지 전략과 공익법인 출연을 추가 반영한다.
  const adjustedTaxResult: AdjustedTaxResult | null = (giftNowPct > 0 || recoveryStrategies.length > 0 || foundationDonationAmt > 0)
    ? calcAdjustedTaxFromStrategies(
        giftEstimate.estateAfterLongTermGift,
        members,
        0,
        recoveryStrategies,
        selectedIdsForAdjustedTax,
        foundationDonationAmt,
      )
    : null;
  const adjustedTaxNow = adjustedTaxResult?.adjustedTax ?? giftEstimate.inheritanceTaxAfterLongTermGift;
  const recoveryPlan = calcRecoveryPlan(assets, adjustedTaxNow);

  function saveScenarioForComparison() {
    const list = loadSavedRecoveryScenarios();
    const fallbackName = `회생안 ${list.length + 1}`;
    const saved = saveRecoveryScenarioItem({
      selectedStrategyIds: Array.from(effectiveSelectedStrategyIds),
      giftNowPct,
      foundationAssetId: resolvedFoundationAssetId,
      foundationDonationPct,
    }, scenarioLabel.trim() || fallbackName);
    setSavedAt(saved.savedAt);
    setScenarioLabel('');
  }

  function clearScenarioForComparison() {
    clearSavedRecoveryScenario();
    setSelectedStrategyIds(new Set());
    setGiftNowPct(0);
    setFoundationAssetId('');
    setFoundationDonationPct(30);
    setSavedAt('');
  }

  return (
    <div className="main kyn-strategy">
      <div className="crumb">Strategy Analysis</div>
      <div className="pagehead">
        <div>
          <h1>증여·상속 전략 분석</h1>
          <p className="desc">
            현재 구조를 진단하고 — 세금을 줄이고 — 납부 재원을 설계합니다
          </p>
        </div>
        <Link href="/dashboard/scenarios" className="hero-cta">
          시나리오 비교 →
        </Link>
      </div>
      <div className="rule" />

      <div className="stepbar block">
        <div>
          <b>실행 전략 조합</b>
          <span>이전 계획의 배분안을 기준으로 현재 리스크와 실행 가능한 회생 카드를 조합합니다.</span>
        </div>
        <Link href="/dashboard/plan" className="link" style={{ whiteSpace: 'nowrap' }}>
          자산별 배분 수정 →
        </Link>
      </div>

      <TransferPlanSummaryCard plans={plans} assets={assets} members={members} macro={macro} />

      {/* ── 컨트롤 패널 ── */}
      <section className="card block">
        <div className="card-head">
          <div className="t">
            분석 기준
            <span className="sub">증여자·수증자·기수증액을 정하면 아래 리스크와 절세 카드가 다시 계산됩니다.</span>
          </div>
        </div>

        <div className="setbody">
          <div className="fgrid">
            <div className="fgroup">
              <div className="flab">증여자</div>
              <select
                value={donorId}
                onChange={e => {
                  const nid = e.target.value;
                  setDonorId(nid);
                  setRecipientIds(prev => { const n = new Set(prev); n.delete(nid); return n; });
                }}
                className="kyn"
              >
                {members.map(m => (
                  <option key={m.id} value={m.id}>{m.name} ({m.relation}, {m.age}세)</option>
                ))}
              </select>
            </div>
            <div className="fgroup">
              <div className="flab">10년 내 사전증여 합계 (억)</div>
              <input
                type="number" min={0} step={0.1}
                value={priorGifts10yr}
                onChange={e => setPriorGifts10yr(Number(e.target.value))}
                className="kyn"
              />
            </div>
          </div>

          <div className="fgroup">
            <div className="flab">수증자</div>
            <div className="checks">
              {nonDonorMembers.map(m => (
                <label key={m.id} className="chk">
                  <input
                    type="checkbox"
                    checked={recipientIds.has(m.id)}
                    onChange={() => toggleRecipient(m.id)}
                  />
                  <span>{m.name} <span className="muted">({m.relation})</span></span>
                </label>
              ))}
            </div>
          </div>

          {selectedRecipients.length > 0 && (
            <div className="fgroup">
              <div className="flab">수증자별 기수증액 (억)</div>
              <div className="small-grid">
                {selectedRecipients.map(m => (
                  <div key={m.id} className="sg">
                    <div className="sl">{m.name}</div>
                    <input
                      type="number" min={0} step={0.1}
                      value={priorGiftsMap[m.id] ?? 0}
                      onChange={e => setPriorGiftsMap(prev => ({ ...prev, [m.id]: Number(e.target.value) }))}
                      className="kyn"
                    />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </section>

      {/* ── SituationBanner ── */}
      {bracket && urgency && donor && (
        <SituationBanner
          inheritanceTax={inheritanceTaxNow}
          totalCash={totalCash}
          totalEstate={totalEstate}
          urgencyLevel={urgency.urgencyLevel}
          donorAge={donor.age}
          selectedSaving={selectedSaving}
          urgencyLabel={urgency.urgencyLabel}
          remaining10yrCycles={urgency.remaining10yrCycles}
        />
      )}

      {/* ── Step 1: 왜 이만큼 내야 하나요? ── */}
      {donor && (
        <StepSection
          stepNum={1}
          question="왜 이만큼 내야 하나요?"
          subtitle={`현재 ${fmt(totalEstate)} 자산 → 과표 ${fmt(taxableBase)} → 세율 ${marginalRate}%`}
          defaultOpen={true}
        >
          <EstateBracketAccordion
            donor={donor}
            totalEstate={totalEstate}
            allMembers={members}
            priorGifts10yr={priorGifts10yr}
            growthRate={portfolioGrowthRate}
          />
        </StepSection>
      )}

      {/* ── Step 2: 어떻게 줄일 수 있나요? ── */}
      {recoveryStrategies.length > 0 && donor && assets.length > 0 && (
        <StepSection
          stepNum={2}
          question="어떻게 줄일 수 있나요?"
          subtitle={`실행 가능한 전략 ${recoveryStrategies.filter(s => s.isApplicable).length}가지 · 최대 절세 ${fmt(totalStrategySaving)}`}
          defaultOpen={true}
        >
          <div className="reducer">
            <div className="rh">
              <div>
                <div className="section-label">증여 비중 테스트</div>
                <div className="rt">먼저, 지금 얼마나 증여할지 정하세요</div>
                <p className="rd">
                  선택한 수증자에게 균등 배분하는 1차 추정입니다. 비율을 바꾸면 상속세 감소, 증여세·취득세 선납, 납부 재원이 함께 바뀝니다.
                </p>
              </div>
              <div className="rpct">
                <div className="rl">즉시 증여 비율</div>
                <div className="rv num">
                  {giftNowPct}<span className="pct-unit">%</span>
                </div>
              </div>
            </div>
            <input
              aria-label="즉시 증여 비율"
              type="range"
              min={0}
              max={100}
              step={1}
              value={giftNowPct}
              onChange={event => setGiftNowPct(Number(event.target.value))}
              className="slider"
            />
            <div className="presets">
              {[0, 10, 20, 30, 50].map(pct => (
                <button
                  key={pct}
                  aria-label={`즉시 증여 ${pct}%`}
                  aria-pressed={giftNowPct === pct}
                  onClick={() => setGiftNowPct(pct)}
                  className="preset"
                >
                  {pct}%
                </button>
              ))}
            </div>
            <div className="rmini">
              {[
                { label: '즉시 이전액', value: fmt(giftEstimate.giftAmount), tone: 'var(--ink)' },
                { label: '상속세 감소', value: `-${fmt(giftEstimate.inheritanceTaxReduction)}`, tone: 'var(--green-ink)' },
                { label: '예상 증여세', value: fmt(giftEstimate.giftTax), tone: 'var(--red)' },
                { label: '예상 취득세', value: fmt(giftEstimate.acquisitionTax), tone: 'var(--red)' },
                { label: '증여 순효과', value: giftNetEffectLabel, tone: giftNetEffectTone },
                { label: '장기 예상 상속세', value: fmt(giftEstimate.inheritanceTaxAfterLongTermGift), tone: 'var(--ink)' },
              ].map(item => (
                <div key={item.label} className="rc">
                  <div className="rcl">{item.label}</div>
                  <div className="rcv num" style={{ color: item.tone }}>{item.value}</div>
                </div>
              ))}
            </div>
          </div>
          <UnifiedOptionSelector
            strategies={recoveryStrategies}
            selectedIds={effectiveSelectedStrategyIds}
            onToggle={toggleStrategy}
            assets={assets}
            members={members}
            totalEstate={totalEstate}
            inheritanceTax={inheritanceTaxNow}
            adjustedTaxResult={adjustedTaxResult}
            giftEstimate={giftEstimate}
            foundationAssetId={resolvedFoundationAssetId}
            foundationDonationPct={foundationDonationPct}
            onFoundationAssetChange={setFoundationAssetId}
            onFoundationPctChange={setFoundationDonationPct}
          />
        </StepSection>
      )}

      <div className="saveplan">
        <div className="sp-tag">저장할 실행안</div>
        <div className="sp-top">
          <div>
            <div className="sp-h">선택한 회생 카드를 하나의 현실 비교안으로 저장</div>
            <div className="sp-d">시나리오 분석에서는 이 저장안과 현상유지, 실행 가능한 자동 추천안만 비교합니다.</div>
            <div className="sp-chips">
              {selectedStrategiesList.length > 0 ? selectedStrategiesList.map(strategy => (
                <span key={strategy.id} className="pill gold">{strategy.title}</span>
              )) : (
                <span className="pill none">위에서 회생 카드를 선택하세요.</span>
              )}
            </div>
          </div>
          <div className="sp-mini">
            <div className="sml">
              <span className="k">저장할 즉시 증여</span>
              <span className="v num">{giftNowPct}% · {fmt(giftEstimate.giftAmount)}</span>
            </div>
            <div className="smn">위 증여 규모와 선택한 회생 카드를 함께 저장합니다.</div>
          </div>
        </div>
        <div className="sp-foot">
          <span className="ts">
            {savedAt ? `마지막 저장: ${new Date(savedAt).toLocaleString('ko-KR')}` : '아직 저장한 비교안이 없습니다.'}
          </span>
          <span className="spush">
            {(savedAt || selectedStrategiesList.length > 0) && (
              <button onClick={clearScenarioForComparison} className="btn btn-ghost sm">
                저장안 초기화
              </button>
            )}
            <button
              onClick={saveScenarioForComparison}
              disabled={selectedStrategiesList.length === 0}
              className="btn btn-primary sm"
            >
              선택 전략 저장
            </button>
            <Link href="/dashboard/scenarios" className="btn btn-ghost sm">
              시나리오 비교 →
            </Link>
          </span>
        </div>
      </div>

      {/* ── Step 3: 어떻게 낼 건가요? ── */}
      <StepSection
        stepNum={3}
        question="어떻게 낼 건가요?"
        subtitle={`즉시 이전비용 ${fmt(giftEstimate.totalTaxCost)} · 수증자 부족액 ${fmt(giftEstimate.recipientCashShortfall)} · 장기 예상 상속세 ${fmt(adjustedTaxNow)}`}
        defaultOpen={true}
      >
        <PaymentPlanSection
          plan={recoveryPlan}
          inheritanceTax={inheritanceTaxNow}
          adjustedTax={adjustedTaxNow}
          totalCash={totalCash}
          assets={assets}
          giftEstimate={giftEstimate}
        />
      </StepSection>

      {/* ── Step 4: 지금 당장 뭘 해야 하나요? ── */}
      <StepSection
        stepNum={4}
        question="지금 당장 뭘 해야 하나요?"
        subtitle={selectedStrategiesList.length > 0 ? `${selectedStrategiesList.length}개 전략의 통합 실행 계획` : '전략을 선택하면 실행 계획이 표시됩니다'}
        defaultOpen={true}
      >
        <UnifiedActionTimeline selectedStrategies={selectedStrategiesList} />
      </StepSection>

      {/* ── Step 5: 자산별 배분 계획 ── */}
      <StepSection
        stepNum={5}
        question="어떤 자산을 누구에게 줄 건가요?"
        subtitle="자산별 받을 가족 구성원을 복수 선택합니다"
        defaultOpen={false}
      >
        <div className="panel" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 20, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 13.5, color: 'var(--ink-soft)', lineHeight: 1.6 }}>
            <strong>이전 계획</strong>에서는 자산별 수증자 후보만 지정합니다. 이전 방식·시점·최종 비율과 납부 재원은 전략 분석과 시나리오에서 최적화합니다.
          </div>
          <Link href="/dashboard/plan" className="btn btn-ghost" style={{ padding: '12px 20px', fontSize: 14 }}>
            이전 계획 열기 <span className="arrow">→</span>
          </Link>
        </div>
      </StepSection>

      <div className="callout is-legal" style={{ marginTop: 28 }}>
        <strong>법률 주의.</strong> 세금 계산은 단순화된 추정치이며 세무·법률 자문이 아닙니다. 실제 집행 전 세무사·변호사의 확인이 필요합니다. · 대출이자율 {(LOAN_RATE * 100).toFixed(1)}% 기준
      </div>
    </div>
  );
}

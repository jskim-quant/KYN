'use client';
import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase';
import { Asset, FamilyMember, MacroSettings, TransferPlan } from '@/types';
import {
  calcAnnualCashflow, calcLTV, calcDSCR,
  calcInheritanceTax, calcGiftTax, calcCapitalGainsTax,
  projectAssetValue,
} from '@/lib/tax';
import { analyzeRecovery } from '@/lib/tax/recovery';
import { summarizeTransferPlans } from '@/lib/transfer-plan';
import Link from 'next/link';
import { KynLoader } from '@/app/dashboard/components/KynLoader';

function fmt(n: number, d = 1) {
  return (Math.round(n * Math.pow(10, d)) / Math.pow(10, d)).toLocaleString('ko-KR') + '억';
}

export default function DashboardPage() {
  const [assets, setAssets]     = useState<Asset[]>([]);
  const [members, setMembers]   = useState<FamilyMember[]>([]);
  const [macro, setMacro]       = useState<MacroSettings | null>(null);
  const [plans, setPlans]       = useState<TransferPlan[]>([]);
  const [loading, setLoading]   = useState(true);
  const [familyName, setFamilyName] = useState('');
  const supabase = createClient();

  useEffect(() => {
    async function load() {
      const { data: profile } = await supabase.from('profiles').select('family_id').single();
      if (!profile?.family_id) { setLoading(false); return; }
      const [{ data: fam }, { data: a }, { data: m }, { data: ms }, { data: pl }] = await Promise.all([
        supabase.from('families').select('name').eq('id', profile.family_id).single(),
        supabase.from('assets').select('*').eq('family_id', profile.family_id),
        supabase.from('family_members').select('*').eq('family_id', profile.family_id),
        supabase.from('macro_settings').select('*').eq('family_id', profile.family_id).single(),
        supabase.from('transfer_plans').select('*').eq('family_id', profile.family_id).order('year_offset'),
      ]);
      setFamilyName(fam?.name || '');
      setAssets(a || []);
      setMembers(m || []);
      setMacro(ms || null);
      setPlans((pl as TransferPlan[]) || []);
      setLoading(false);
    }
    load();
  }, []);

  const hasData = assets.length > 0;
  const totalValue  = assets.reduce((s, a) => s + a.current_value, 0);
  const totalDebt   = assets.reduce((s, a) => s + a.loan_amount, 0);
  const netWorth    = totalValue - totalDebt;
  const { netCashflow } = macro ? calcAnnualCashflow(assets, macro) : { netCashflow: 0 };
  const { tax: inheritTax } = calcInheritanceTax(totalValue, members);
  const totalCGT    = assets.reduce((s, a) => s + calcCapitalGainsTax(a), 0);
  const ltv         = calcLTV(assets);
  const dscr        = calcDSCR(assets);
  const futureValue10yr = assets.reduce((s, asset) => s + projectAssetValue(asset, 10, macro), 0);
  const transferSummary = summarizeTransferPlans(plans, assets, members, macro);

  const liquidAssetTypes = new Set(['예금', '예금채권', '금융자산', '채권', '보험', '국내주식', '해외주식']);
  const realEstateTypes = new Set(['주거용부동산', '상업용부동산', '토지', '농지', '임야', '오피스텔']);
  const ownerCash = members
    .filter(member => ['본인', '배우자'].includes(member.relation))
    .reduce((sum, member) => sum + Number(member.cash_hold ?? 0), 0);
  const liquidFinancialAssets = assets
    .filter(asset => liquidAssetTypes.has(asset.asset_type))
    .reduce((sum, asset) => sum + asset.current_value, 0);
  const availableLiquid = ownerCash + liquidFinancialAssets;
  const annualFinancialIncome = assets
    .filter(asset => liquidAssetTypes.has(asset.asset_type))
    .reduce((sum, asset) => sum + asset.current_value * Number(asset.dividend_yield_pct ?? asset.annual_yield_pct ?? 0) / 100, 0);
  const loanCapacity = assets
    .filter(asset => realEstateTypes.has(asset.asset_type) && asset.collateral_available !== false)
    .reduce((sum, asset) => sum + Math.max(0, asset.current_value * 0.40 - asset.loan_amount), 0);
  const realEstateValue = assets
    .filter(asset => realEstateTypes.has(asset.asset_type))
    .reduce((sum, asset) => sum + asset.current_value, 0);
  const recovery = analyzeRecovery({
    inheritanceTax: inheritTax,
    ownCash: ownerCash,
    liquidFinancialAssets,
    loanCapacity,
    annualRentalAfterTax: Math.max(0, netCashflow),
    annualFinancialIncome,
    annualLoanInterest: assets.reduce((sum, asset) => sum + asset.loan_amount * asset.loan_rate_pct / 100, 0),
    loanPrincipal: assets.reduce((sum, asset) => sum + asset.loan_amount, 0),
    installmentYears: 10,
    forcedSaleAssetTotal: realEstateValue,
  });

  const cashflowOk = netCashflow >= 0;
  const ltvOk = ltv <= 40;
  const inheritanceCashGap = Math.max(0, inheritTax - availableLiquid);
  const unassignedCount = assets.filter(a => !a.owner_member_id).length;

  if (loading) return <KynLoader />;

  if (!hasData) return (
    <div className="main">
      <div className="crumb">OVERVIEW</div>
      <div className="pagehead">
        <div>
          <h1>안녕하세요</h1>
          <p className="desc">{familyName || 'KYN'} 가족 자산 플래너에 오신 것을 환영합니다.</p>
        </div>
      </div>
      <div className="rule" />
      <div className="grid3">
        {[
          { href: '/dashboard/members', step: '01', title: '가족 구성원 추가', desc: '나이, 소득, 가족 관계를 입력하세요' },
          { href: '/dashboard/assets',  step: '02', title: '자산 등록',        desc: '부동산·금융자산을 모두 등록하세요' },
          { href: '/dashboard/plan',    step: '03', title: '이전 계획 설정',   desc: '누가 무엇을 받을지 설계하세요' },
        ].map(step => (
          <Link key={step.href} href={step.href} style={{
            display: 'block',
            border: '1px solid var(--line)',
            padding: '28px 24px',
            textDecoration: 'none',
            background: 'transparent',
          }}>
            <div style={{ fontSize: 11, letterSpacing: '0.2em', color: 'var(--gold-bright)', marginBottom: 14 }}>{step.step}</div>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink)', marginBottom: 8 }}>{step.title}</div>
            <div style={{ fontSize: 13, color: 'var(--ink-faint)', lineHeight: 1.7 }}>{step.desc}</div>
            <div style={{ marginTop: 16, fontSize: 12, color: 'var(--gold-deep)' }}>시작 →</div>
          </Link>
        ))}
      </div>
    </div>
  );

  return (
    <div className="main">
      <div className="crumb">OVERVIEW</div>
      <div className="pagehead">
        <div>
          <h1>자산 현황 개요</h1>
          <div className="desc">{familyName} 가족 · 전체 자산 요약</div>
        </div>
        <Link href="/dashboard/scenarios" className="btn btn-primary" style={{ padding: '14px 22px', fontSize: 14 }}>
          시나리오 분석 <span className="arrow">→</span>
        </Link>
      </div>
      <div className="rule" />

      {/* KPI strip */}
      <div className="kpis">
        <div className="kpi">
          <div className="label">총 자산가치</div>
          <div className="v ink num">{(Math.round(totalValue * 10) / 10).toLocaleString('ko-KR')}<span className="u">억</span></div>
          <div className="foot">순자산 {fmt(netWorth)} · 10년 후 {fmt(futureValue10yr)}</div>
        </div>
        <div className="kpi">
          <div className="label">연 순현금흐름</div>
          <div className={`v num ${netCashflow >= 0 ? 'pos' : 'neg'}`}>{(Math.round(netCashflow * 10) / 10).toLocaleString('ko-KR')}<span className="u">억</span></div>
          <div className="foot">임대 − 세금 − 이자</div>
        </div>
        <div className="kpi">
          <div className="label">상속세 추정</div>
          <div className="v neg num">{(Math.round(inheritTax * 10) / 10).toLocaleString('ko-KR')}<span className="u">억</span></div>
          <div className="foot">현재 자산 기준</div>
        </div>
        <div className="kpi">
          <div className="label">미실현 양도세</div>
          <div className="v neg num">{(Math.round(totalCGT * 10) / 10).toLocaleString('ko-KR')}<span className="u">억</span></div>
          <div className="foot">전체 매각 시 추정</div>
        </div>
      </div>

      {/* Saved transfer plans summary */}
      <div className="block card">
        <div className="card-head">
          <span className="t">저장된 이전 계획<span className="sub">자산별 보유자 → 수증자 지정안을 미래가치 기준으로 연결합니다.</span></span>
          <Link href="/dashboard/plan" className="link">계획 관리 →</Link>
        </div>
        <div className="mini">
          <div><div className="l">계획</div><div className="n num">{plans.length}건</div></div>
          <div><div className="l">현재 이전가액</div><div className="n num">{fmt(transferSummary.totalCurrentTransferValue)}</div></div>
          <div><div className="l">실행시점 예상가액</div><div className="n num">{fmt(transferSummary.totalFutureTransferValue)}</div></div>
          <div><div className="l">예상 세금</div><div className="n num">{fmt(transferSummary.totalEstimatedTax)}</div></div>
        </div>
      </div>

      {/* Ratio cards */}
      <div className="ratios">
        <div className="ratio">
          <div className="l">담보인정비율 <b>(LTV)</b></div>
          <div className="row"><span className="big num">{ltv.toFixed(1)}%</span></div>
          <div className="foot">안전 기준 40% 이하</div>
        </div>
        <div className="ratio">
          <div className="l">이자 커버리지 <b>(DSCR)</b></div>
          <div className="row"><span className="big num">{dscr > 90 ? '∞' : dscr.toFixed(2) + '×'}</span></div>
          <div className="foot">안전 기준 1.5× 이상</div>
        </div>
      </div>

      {/* Asset table */}
      <div className="block card">
        <div className="card-head">
          <span className="t">자산 목록</span>
          <Link href="/dashboard/assets" className="link">관리 →</Link>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th style={{ paddingLeft: 24 }}>자산명</th>
              <th>소유자</th>
              <th className="r">현재가</th>
              <th className="r">10년 후</th>
              <th className="r">연수익</th>
              <th className="r" style={{ paddingRight: 24 }}>보유세</th>
            </tr>
          </thead>
          <tbody>
            {assets.map(a => {
              const owner = members.find(member => member.id === a.owner_member_id);
              return (
                <tr key={a.id}>
                  <td className="name" style={{ paddingLeft: 24 }}>{a.name}</td>
                  <td className={owner ? 'soft' : 'muted'}>{owner?.name ?? '미지정'}</td>
                  <td className="r num">{fmt(a.current_value)}</td>
                  <td className="r pos num">{fmt(projectAssetValue(a, 10, macro))}</td>
                  <td className="r num">{fmt(a.current_value * a.annual_yield_pct / 100)}</td>
                  <td className="r zero num" style={{ paddingRight: 24 }}>{fmt(a.annual_tax)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Summary footer */}
      <div className="summary">
        <div className={`s ${cashflowOk && ltvOk ? 'ok' : 'warn'}`}>
          <span className="dot" />
          <span>현금흐름 <b>{cashflowOk ? '안전' : '적자'}</b> · LTV·DSCR 기준 {ltvOk ? '충족' : '초과'}</span>
        </div>
        <div className={`s ${inheritanceCashGap > 0 ? 'warn' : 'ok'}`}>
          <span className="dot" />
          <span>상속세 재원 {inheritanceCashGap > 0 ? <b>{fmt(inheritanceCashGap)} 부족</b> : <b>충분</b>} · 이전 계획 검토 필요</span>
        </div>
        <div className="s">
          <span className="dot" style={{ background: 'var(--gold)' }} />
          <span>미지정 자산 <b>{unassignedCount}건</b> · {unassignedCount > 0 ? '수증자 지정 권장' : '모두 지정됨'}</span>
        </div>
      </div>
    </div>
  );
}

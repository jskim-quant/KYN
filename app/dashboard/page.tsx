'use client';
import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase';
import { Asset, FamilyMember, MacroSettings } from '@/types';
import {
  calcAnnualCashflow, calcLTV, calcDSCR,
  calcInheritanceTax, calcCapitalGainsTax, calcComprehensiveRealEstateTax
} from '@/lib/tax';
import Link from 'next/link';

function fmt(n: number, d = 1) {
  return (Math.round(n * Math.pow(10, d)) / Math.pow(10, d)).toLocaleString('ko-KR') + '억';
}

export default function DashboardPage() {
  const [assets, setAssets]   = useState<Asset[]>([]);
  const [members, setMembers] = useState<FamilyMember[]>([]);
  const [macro, setMacro]     = useState<MacroSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [familyName, setFamilyName] = useState('');
  const supabase = createClient();

  useEffect(() => {
    async function load() {
      const { data: profile } = await supabase.from('profiles').select('family_id').single();
      if (!profile?.family_id) { setLoading(false); return; }

      const [{ data: fam }, { data: a }, { data: m }, { data: ms }] = await Promise.all([
        supabase.from('families').select('name').eq('id', profile.family_id).single(),
        supabase.from('assets').select('*').eq('family_id', profile.family_id),
        supabase.from('family_members').select('*').eq('family_id', profile.family_id),
        supabase.from('macro_settings').select('*').eq('family_id', profile.family_id).single(),
      ]);

      setFamilyName(fam?.name || '');
      setAssets(a || []);
      setMembers(m || []);
      setMacro(ms || null);
      setLoading(false);
    }
    load();
  }, []);

  const hasData = assets.length > 0;
  const totalValue = assets.reduce((s, a) => s + a.current_value, 0);
  const totalDebt  = assets.reduce((s, a) => s + a.loan_amount, 0);
  const netWorth   = totalValue - totalDebt;
  const { netCashflow } = macro
    ? calcAnnualCashflow(assets, macro)
    : { netCashflow: 0 };
  const { tax: inheritTax } = calcInheritanceTax(totalValue, members);
  const totalCGT = assets.reduce((s, a) => s + calcCapitalGainsTax(a), 0);
  const ltv  = calcLTV(assets);
  const dscr = calcDSCR(assets);

  if (loading) return (
    <div className="p-8 flex items-center justify-center h-96">
      <div className="text-gray-400 text-sm">로딩 중...</div>
    </div>
  );

  // 데이터 없을 때 온보딩 화면
  if (!hasData) return (
    <div className="p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">안녕하세요 👋</h1>
        <p className="text-gray-500 text-sm mt-1">
          {familyName}의 자산 플래너에 오신 것을 환영합니다.
        </p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {[
          { href: '/dashboard/members', icon: '👥', title: '1단계: 가족 구성원 추가', desc: '나이, 소득, 관계를 입력하세요' },
          { href: '/dashboard/assets',  icon: '🏠', title: '2단계: 자산 등록', desc: '부동산, 금융자산을 모두 입력하세요' },
          { href: '/dashboard/plan',    icon: '📋', title: '3단계: 이전 계획 설정', desc: '누가 무엇을 받을지 설계하세요' },
        ].map(step => (
          <Link key={step.href} href={step.href}
            className="card hover:border-blue-300 hover:shadow-md transition-all cursor-pointer">
            <div className="text-3xl mb-3">{step.icon}</div>
            <div className="font-semibold text-gray-900 mb-1">{step.title}</div>
            <div className="text-sm text-gray-500">{step.desc}</div>
          </Link>
        ))}
      </div>
    </div>
  );

  return (
    <div className="p-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">자산 현황 개요</h1>
          <p className="text-sm text-gray-500 mt-1">{familyName} · 전체 자산 요약</p>
        </div>
        <Link href="/dashboard/scenarios" className="btn-primary text-sm">
          시나리오 분석 →
        </Link>
      </div>

      {/* Key metrics */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        {[
          { label: '총 자산가치',   value: fmt(totalValue), sub: `순자산 ${fmt(netWorth)}`,   color: 'text-blue-700' },
          { label: '연 순현금흐름', value: fmt(netCashflow), sub: '임대-세금-이자',             color: netCashflow < 0 ? 'text-red-600' : 'text-green-700' },
          { label: '상속세 추정',   value: fmt(inheritTax),  sub: '현재 자산 기준',             color: 'text-red-600' },
          { label: '미실현 양도세', value: fmt(totalCGT),    sub: '전체 매각 시',               color: 'text-amber-600' },
        ].map(m => (
          <div key={m.label} className="metric-card">
            <div className="text-xs text-gray-500 mb-1">{m.label}</div>
            <div className={`text-2xl font-bold ${m.color}`}>{m.value}</div>
            <div className="text-xs text-gray-400 mt-1">{m.sub}</div>
          </div>
        ))}
      </div>

      {/* Alerts */}
      {netCashflow < 0 && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 mb-6 flex items-start gap-3">
          <span className="text-red-500 text-lg">⚠️</span>
          <div>
            <div className="text-sm font-semibold text-red-800">현금흐름 적자 경고</div>
            <div className="text-sm text-red-700 mt-0.5">
              연간 {fmt(Math.abs(netCashflow))} 적자. 임대수익이 보유세·이자를 커버하지 못합니다.
            </div>
          </div>
        </div>
      )}

      {/* LTV/DSCR */}
      <div className="grid grid-cols-2 gap-4 mb-6">
        <div className="metric-card">
          <div className="text-xs text-gray-500 mb-1">LTV (담보인정비율)</div>
          <div className={`text-2xl font-bold ${ltv > 60 ? 'text-red-600' : ltv > 40 ? 'text-amber-600' : 'text-green-700'}`}>
            {ltv.toFixed(1)}%
          </div>
          <div className="text-xs text-gray-400 mt-1">안전 기준: 40% 이하</div>
        </div>
        <div className="metric-card">
          <div className="text-xs text-gray-500 mb-1">DSCR (이자 커버리지)</div>
          <div className={`text-2xl font-bold ${dscr < 1.2 ? 'text-red-600' : dscr < 1.5 ? 'text-amber-600' : 'text-green-700'}`}>
            {dscr > 90 ? '∞' : dscr.toFixed(2)}x
          </div>
          <div className="text-xs text-gray-400 mt-1">안전 기준: 1.5x 이상</div>
        </div>
      </div>

      {/* Asset table */}
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-gray-700">자산 목록</h2>
          <Link href="/dashboard/assets" className="text-xs text-blue-600 hover:underline">
            관리 →
          </Link>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100">
              {['자산명', '종류', '현재가', '차익', '연수익', '보유세'].map(h => (
                <th key={h} className={`text-xs text-gray-400 font-medium pb-2 ${h !== '자산명' && h !== '종류' ? 'text-right' : 'text-left'}`}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {assets.map(a => {
              const gain = a.current_value - a.acquisition_cost;
              return (
                <tr key={a.id} className="border-b border-gray-50 last:border-0">
                  <td className="py-2.5 font-medium">{a.name}</td>
                  <td className="py-2.5 text-gray-500 text-xs">{a.asset_type}</td>
                  <td className="py-2.5 text-right">{fmt(a.current_value)}</td>
                  <td className={`py-2.5 text-right ${gain >= 0 ? 'text-green-700' : 'text-red-600'}`}>
                    {gain >= 0 ? '+' : ''}{fmt(gain)}
                  </td>
                  <td className="py-2.5 text-right">
                    {fmt(a.current_value * a.annual_yield_pct / 100)}
                  </td>
                  <td className="py-2.5 text-right text-red-600">{fmt(a.annual_tax)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

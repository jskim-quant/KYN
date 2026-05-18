'use client';
import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase';
import { Asset, FamilyMember, MacroSettings, ScenarioResult } from '@/types';
import {
  calcInheritanceTax, calcGiftTax, calcCapitalGainsTax,
  calcCorporateTax, calcIncomeTax, calcAnnualCashflow,
  calcComprehensiveRealEstateTax, projectAssetValue,
  calcCorpConversionBenefit,
} from '@/lib/tax';

function fmt(n: number, d = 1) {
  if (!n || isNaN(n)) return '0';
  return (Math.round(n * Math.pow(10, d)) / Math.pow(10, d)).toLocaleString('ko-KR') + '억';
}
function badge(level: 'low' | 'medium' | 'high') {
  return level === 'low'
    ? 'bg-green-100 text-green-700'
    : level === 'medium'
    ? 'bg-yellow-100 text-yellow-700'
    : 'bg-red-100 text-red-700';
}
function badgeLabel(level: 'low' | 'medium' | 'high') {
  return level === 'low' ? '낮음' : level === 'medium' ? '중간' : '높음';
}

function buildScenarios(
  assets: Asset[],
  members: FamilyMember[],
  macro: MacroSettings | null,
): ScenarioResult[] {
  const totalValue = assets.reduce((s, a) => s + a.current_value, 0);
  const totalDebt  = assets.reduce((s, a) => s + a.loan_amount, 0);
  const rentalIncome = assets.reduce((s, a) => s + a.current_value * a.annual_yield_pct / 100, 0);
  const { netCashflow } = macro
    ? calcAnnualCashflow(assets, macro)
    : { netCashflow: rentalIncome * 0.6 };

  const children = members.filter(m => m.relation === '자녀');
  const grandChildren = members.filter(m => m.relation === '손자녀');

  // 10년 후 자산가치 추정
  function futureValue(yrs: number) {
    return assets.reduce((s, a) => s + projectAssetValue(a, yrs, macro || {
      id: '', family_id: '',
      base_rate_pct: 3.5, rate_shock_pct: 1.5,
      land_growth_pct: 2, apt_growth_pct: 2.5,
      commercial_growth_pct: 1.5, inflation_pct: 2,
    }), 0);
  }

  // ── 시나리오 1: 현상유지 ────────────────────────────────
  const s1_inherit10 = calcInheritanceTax(futureValue(10), members).tax;
  const s1: ScenarioResult = {
    id: 's1', label: '현상유지',
    strategy: '현재 구조 유지, 추가 세금 전략 없음',
    yr5NetWealth:  futureValue(5)  - totalDebt - calcInheritanceTax(futureValue(5), members).tax,
    yr10NetWealth: futureValue(10) - totalDebt - s1_inherit10,
    yr20NetWealth: futureValue(20) - totalDebt - calcInheritanceTax(futureValue(20), members).tax,
    totalTax10yr:  s1_inherit10 + calcComprehensiveRealEstateTax(assets) * 10,
    annualCashflow: netCashflow,
    inheritanceTax: s1_inherit10,
    liquidityRisk: netCashflow < 0 ? 'high' : netCashflow < totalValue * 0.01 ? 'medium' : 'low',
    taxRisk: s1_inherit10 > totalValue * 0.3 ? 'high' : s1_inherit10 > totalValue * 0.15 ? 'medium' : 'low',
    complexity: 'low',
    pros: ['추가 비용·절차 없음', '현 자산 구조 유지'],
    cons: ['상속 시 고액 세금 발생 위험', '절세 기회 활용 못함', '자산 집중 리스크'],
    actions: ['현 상태 모니터링', '최소 연 1회 세금 추정 재검토'],
    isRecommended: false,
  };

  // ── 시나리오 2: 분산 증여 (자녀별 순차 증여) ────────────
  const giftPerChild = children.length > 0 ? totalValue * 0.3 / children.length : 0;
  const giftTaxTotal = children.reduce((s, _) => s + calcGiftTax(giftPerChild, '자녀'), 0);
  const remainValue  = totalValue * 0.7;
  const s2_inherit   = calcInheritanceTax(remainValue, members).tax;
  const s2: ScenarioResult = {
    id: 's2', label: '분산 증여',
    strategy: `자녀 ${children.length}명에게 자산 30% 점진 증여 후 상속세 절감`,
    yr5NetWealth:  futureValue(5) - totalDebt - giftTaxTotal,
    yr10NetWealth: futureValue(10) - totalDebt - giftTaxTotal - s2_inherit,
    yr20NetWealth: futureValue(20) - totalDebt - s2_inherit,
    totalTax10yr:  giftTaxTotal + s2_inherit + calcComprehensiveRealEstateTax(assets) * 10,
    annualCashflow: netCashflow,
    inheritanceTax: s2_inherit,
    liquidityRisk: 'medium',
    taxRisk: 'medium',
    complexity: 'medium',
    pros: [
      `자녀 1인당 5천만원 증여공제 활용`,
      '10년 단위 반복 증여로 세부담 분산',
      '상속세 과세표준 축소',
    ],
    cons: [
      '증여세 선납 필요 (자금 유동성 감소)',
      '10년 합산 규정 유의 (증여 타이밍 관리)',
      '자산가 상승 시 효과 제한',
    ],
    actions: [
      '자녀별 증여 한도(5천만원) 활용 계획 수립',
      '혼인·출산 시 +1억 추가 공제 활용',
      '현금·금융자산부터 우선 증여 권장',
    ],
    isRecommended: children.length > 0,
  };

  // ── 시나리오 3: 세대생략증여 ────────────────────────────
  const skipAmt    = grandChildren.length > 0 ? totalValue * 0.2 : 0;
  const skipTax    = grandChildren.reduce((s, _) => s + calcGiftTax(skipAmt / Math.max(grandChildren.length, 1), '손자녀', 0, true), 0);
  const s3_inherit = calcInheritanceTax(totalValue * 0.8, members).tax;
  const s3: ScenarioResult = {
    id: 's3', label: '세대생략증여',
    strategy: '손자녀에게 직접 증여 — 중간 세대 상속세 1회 절약',
    yr5NetWealth:  futureValue(5) - totalDebt - skipTax,
    yr10NetWealth: futureValue(10) - totalDebt - skipTax - s3_inherit,
    yr20NetWealth: futureValue(20) - totalDebt - s3_inherit,
    totalTax10yr:  skipTax + s3_inherit + calcComprehensiveRealEstateTax(assets) * 10,
    annualCashflow: netCashflow,
    inheritanceTax: s3_inherit,
    liquidityRisk: 'medium',
    taxRisk: grandChildren.length > 0 ? 'medium' : 'high',
    complexity: 'medium',
    pros: [
      '중간세대 상속세 1회 절약 (장기 절세 효과 큼)',
      '손자녀 공제한도(2천만원) 별도 활용',
      '자산의 세대간 이전 속도 가속화',
    ],
    cons: [
      '세대생략 30% 할증세율 적용',
      '손자녀 미성년 시 관리 복잡성',
      grandChildren.length === 0 ? '손자녀 없음 — 해당 없음' : '증여세 선납 부담',
    ],
    actions: [
      '손자녀 출생 시점에 맞춰 증여 계획 수립',
      '손자녀 1인당 2천만원 공제 한도 연 활용',
      '교육비·의료비 등 비과세 항목과 병행',
    ],
    isRecommended: grandChildren.length > 0,
  };

  // ── 시나리오 4: 법인전환 ────────────────────────────────
  const corpResult = calcCorpConversionBenefit(rentalIncome, rentalIncome * 0.6, 0, assets);
  const s4: ScenarioResult = {
    id: 's4', label: '법인전환',
    strategy: '임대자산을 법인으로 이전, 법인세+급여 구조로 절세',
    yr5NetWealth:  futureValue(5) - totalDebt - corpResult.transferTax - corpResult.totalCorpBurden * 5,
    yr10NetWealth: futureValue(10) - totalDebt - corpResult.transferTax - corpResult.totalCorpBurden * 10,
    yr20NetWealth: futureValue(20) - totalDebt - corpResult.totalCorpBurden * 20,
    totalTax10yr:  corpResult.transferTax + corpResult.totalCorpBurden * 10,
    annualCashflow: netCashflow + corpResult.annualSaving,
    inheritanceTax: calcInheritanceTax(totalValue * 0.5, members).tax, // 주식 평가 절하 가정
    liquidityRisk: 'medium',
    taxRisk: 'low',
    complexity: 'high',
    pros: [
      `연 ${fmt(corpResult.annualSaving)} 절세효과 (법인세율 10~25%)`,
      '주식 분산으로 지분증여 유연성 확보',
      '대표이사 급여 손금처리로 이중 절세',
      '법인 자산은 상속세 과표 분산 가능',
    ],
    cons: [
      `현물출자 취득세 ${fmt(corpResult.transferTax)} 선납`,
      `회수 기간 약 ${corpResult.paybackYears}년`,
      '법인 운영 행정·회계 비용 발생',
      '배당 시 추가 소득세 (14%~)',
      '양도소득세 이월과세 — 5년 내 매각 주의',
    ],
    actions: [
      '유한회사 설립 (자본금 1억, 비용 최소화)',
      '현물출자 절차: 법무사·세무사 협력 필요',
      '배우자·자녀에게 주식 점진 증여로 지분 분산',
    ],
    isRecommended: corpResult.annualSaving > 0.1,
  };

  // ── 시나리오 5: 매각 후 현금 분배 ──────────────────────
  const totalCGT    = assets.reduce((s, a) => s + calcCapitalGainsTax(a), 0);
  const cashAfterTax = totalValue - totalDebt - totalCGT;
  const giftCashTax  = children.reduce((s, _) => s + calcGiftTax(cashAfterTax / Math.max(children.length, 1), '자녀'), 0);
  const s5: ScenarioResult = {
    id: 's5', label: '매각 후 분배',
    strategy: '자산 전부 매각 후 양도세 납부, 현금으로 자녀 분배',
    yr5NetWealth:  cashAfterTax - giftCashTax,
    yr10NetWealth: cashAfterTax - giftCashTax,
    yr20NetWealth: cashAfterTax - giftCashTax,
    totalTax10yr:  totalCGT + giftCashTax,
    annualCashflow: (cashAfterTax - giftCashTax) * 0.03, // 현금 운용 가정
    inheritanceTax: 0,
    liquidityRisk: 'low',
    taxRisk: 'high',
    complexity: 'low',
    pros: [
      '상속세 없음 (현금 분배 후)',
      '자산 유동성 극대화',
      '관리 부담 제거',
    ],
    cons: [
      `양도세 ${fmt(totalCGT)} + 증여세 ${fmt(giftCashTax)} 동시 발생`,
      '부동산 자산가 상승분 포기',
      '임대수익 소실',
    ],
    actions: [
      '다주택 규제 완화 시점 매각 타이밍 검토',
      '장기보유특별공제 최대화 후 매각',
      '양도세와 증여세 납부 자금 준비',
    ],
    isRecommended: false,
  };

  return [s1, s2, s3, s4, s5];
}

export default function ScenariosPage() {
  const [assets, setAssets]   = useState<Asset[]>([]);
  const [members, setMembers] = useState<FamilyMember[]>([]);
  const [macro, setMacro]     = useState<MacroSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string>('s1');
  const supabase = createClient();

  useEffect(() => {
    async function load() {
      const { data: p } = await supabase.from('profiles').select('family_id').single();
      if (!p?.family_id) { setLoading(false); return; }
      const [{ data: a }, { data: m }, { data: ms }] = await Promise.all([
        supabase.from('assets').select('*').eq('family_id', p.family_id),
        supabase.from('family_members').select('*').eq('family_id', p.family_id),
        supabase.from('macro_settings').select('*').eq('family_id', p.family_id).single(),
      ]);
      setAssets(a || []);
      setMembers(m || []);
      setMacro(ms || null);
      setLoading(false);
    }
    load();
  }, []);

  if (loading) return <div className="p-8 text-sm text-gray-400">로딩 중...</div>;

  if (assets.length === 0) return (
    <div className="p-8">
      <h1 className="text-2xl font-bold text-gray-900 mb-2">시나리오 비교</h1>
      <div className="card text-center py-16 text-gray-400">
        자산과 가족 구성원을 먼저 등록해주세요
      </div>
    </div>
  );

  const scenarios = buildScenarios(assets, members, macro);
  const detail = scenarios.find(s => s.id === selected)!;

  return (
    <div className="p-8 max-w-6xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">시나리오 비교</h1>
        <p className="text-sm text-gray-500 mt-1">5가지 이전 전략의 세후 순자산·세부담 비교</p>
      </div>

      {/* 시나리오 카드 선택 */}
      <div className="grid grid-cols-1 md:grid-cols-5 gap-3 mb-6">
        {scenarios.map(s => (
          <button key={s.id} onClick={() => setSelected(s.id)}
            className={`rounded-xl border-2 p-3 text-left transition-all ${
              selected === s.id
                ? 'border-blue-500 bg-blue-50'
                : 'border-gray-200 bg-white hover:border-blue-200'
            }`}>
            <div className="flex items-start justify-between mb-2">
              <div className="text-sm font-semibold text-gray-900">{s.label}</div>
              {s.isRecommended && (
                <span className="text-xs bg-blue-600 text-white px-1.5 py-0.5 rounded-full">추천</span>
              )}
            </div>
            <div className="text-xs text-gray-500 mb-2 leading-relaxed">{s.strategy}</div>
            <div className="text-xs">
              <div className="text-gray-400">10년 후 순자산</div>
              <div className="font-bold text-gray-900">{fmt(s.yr10NetWealth)}</div>
            </div>
          </button>
        ))}
      </div>

      {/* 비교 테이블 */}
      <div className="card mb-6 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100">
              <th className="text-left text-xs text-gray-400 font-medium pb-2 pr-4">지표</th>
              {scenarios.map(s => (
                <th key={s.id} className={`text-right text-xs font-medium pb-2 px-2 ${
                  s.id === selected ? 'text-blue-600' : 'text-gray-400'
                }`}>{s.label}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {[
              { label: '5년 후 순자산',    key: 'yr5NetWealth' as const },
              { label: '10년 후 순자산',   key: 'yr10NetWealth' as const },
              { label: '20년 후 순자산',   key: 'yr20NetWealth' as const },
              { label: '10년 누적 세부담', key: 'totalTax10yr' as const },
              { label: '상속세 추정',      key: 'inheritanceTax' as const },
              { label: '연 순현금흐름',    key: 'annualCashflow' as const },
            ].map(row => (
              <tr key={row.label}>
                <td className="py-2.5 pr-4 text-xs text-gray-500">{row.label}</td>
                {scenarios.map(s => (
                  <td key={s.id} className={`py-2.5 px-2 text-right text-xs font-medium ${
                    s.id === selected ? 'text-blue-700 bg-blue-50' : 'text-gray-700'
                  }`}>
                    {fmt(s[row.key])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 선택 시나리오 상세 */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* 리스크 */}
        <div className="card">
          <div className="text-sm font-semibold text-gray-700 mb-3">{detail.label} — 리스크 평가</div>
          <div className="space-y-2">
            {[
              ['유동성 위험', detail.liquidityRisk],
              ['세금 위험', detail.taxRisk],
              ['복잡도', detail.complexity],
            ].map(([label, level]) => (
              <div key={label} className="flex items-center justify-between">
                <span className="text-xs text-gray-500">{label}</span>
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${badge(level as 'low' | 'medium' | 'high')}`}>
                  {badgeLabel(level as 'low' | 'medium' | 'high')}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* 장단점 */}
        <div className="card">
          <div className="text-sm font-semibold text-gray-700 mb-3">장단점</div>
          <div className="space-y-1 mb-3">
            {detail.pros.map((p, i) => (
              <div key={i} className="flex gap-2 text-xs">
                <span className="text-green-500">✓</span>
                <span className="text-gray-700">{p}</span>
              </div>
            ))}
          </div>
          <div className="space-y-1">
            {detail.cons.map((c, i) => (
              <div key={i} className="flex gap-2 text-xs">
                <span className="text-red-400">✗</span>
                <span className="text-gray-500">{c}</span>
              </div>
            ))}
          </div>
        </div>

        {/* 실행 액션 */}
        <div className="card md:col-span-2">
          <div className="text-sm font-semibold text-gray-700 mb-3">권장 실행 단계</div>
          <div className="space-y-2">
            {detail.actions.map((a, i) => (
              <div key={i} className="flex gap-3 text-xs">
                <div className="w-5 h-5 bg-blue-600 text-white rounded-full flex items-center justify-center shrink-0 text-xs font-bold">
                  {i + 1}
                </div>
                <span className="text-gray-700 leading-relaxed">{a}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-4 text-xs text-gray-400 text-center">
        * 시나리오는 현재 자산·가족 데이터 기반 추정치입니다. 실제 절세 전략 실행 전 세무사 상담을 권장합니다.
      </div>
    </div>
  );
}

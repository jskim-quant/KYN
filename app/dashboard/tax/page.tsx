'use client';
import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase';
import { Asset, FamilyMember, MacroSettings } from '@/types';
import {
  calcCapitalGainsTax, calcComprehensiveRealEstateTax,
  calcInheritanceTax, calcRentalIncomeTax, calcAnnualCashflow,
  calcGiftTax, calcFamilyLoanAnalysis, calcCorpConversionBenefit,
  calcPCI,
} from '@/lib/tax';

function fmt(n: number, d = 2) {
  if (!n || isNaN(n)) return '0';
  return (Math.round(n * Math.pow(10, d)) / Math.pow(10, d)).toLocaleString('ko-KR');
}
function fmtB(n: number) { return fmt(n, 1) + '억'; }

type Tab = 'overview' | 'asset' | 'loan' | 'corp' | 'pci';

export default function TaxPage() {
  const [assets, setAssets]   = useState<Asset[]>([]);
  const [members, setMembers] = useState<FamilyMember[]>([]);
  const [macro, setMacro]     = useState<MacroSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab]         = useState<Tab>('overview');
  const supabase = createClient();

  // 가족간 차용증 입력
  const [loanPrincipal, setLoanPrincipal] = useState(2);
  const [loanRate, setLoanRate]           = useState(0);
  const [loanRelation, setLoanRelation]   = useState('자녀');
  const [loanPrior, setLoanPrior]         = useState(0);

  // 법인전환 입력
  const [corpRental, setCorpRental]   = useState(1);
  const [corpSalary, setCorpSalary]   = useState(0.8);
  const [corpOther, setCorpOther]     = useState(0.5);

  // PCI 입력
  const [pciIncrease, setPciIncrease]   = useState(5);
  const [pciConsume, setPciConsume]     = useState(1);
  const [pciIncome, setPciIncome]       = useState(3);

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

  const totalValue = assets.reduce((s, a) => s + a.current_value, 0);
  const totalCGT   = assets.reduce((s, a) => s + calcCapitalGainsTax(a), 0);
  const totalCRET  = calcComprehensiveRealEstateTax(assets);
  const { tax: inheritTax, deductions } = calcInheritanceTax(totalValue, members);
  const rentalIncome = assets.reduce((s, a) => s + a.current_value * a.annual_yield_pct / 100, 0);
  const rentalTax  = calcRentalIncomeTax(rentalIncome);
  const { netCashflow } = macro ? calcAnnualCashflow(assets, macro) : { netCashflow: 0 };

  const totalTaxBurden = totalCGT + totalCRET + inheritTax + rentalTax;

  // 차용증 결과
  const loanResult = calcFamilyLoanAnalysis(loanPrincipal, loanRate, loanRelation, loanPrior);

  // 법인전환 결과
  const corpResult = calcCorpConversionBenefit(corpRental, corpSalary, corpOther, assets);

  // PCI 결과
  const pciResult = calcPCI(pciIncrease, pciConsume, pciIncome);

  const TABS: { id: Tab; label: string }[] = [
    { id: 'overview', label: '세금 개요' },
    { id: 'asset',    label: '자산별 세금' },
    { id: 'loan',     label: '차용증 분석' },
    { id: 'corp',     label: '법인전환' },
    { id: 'pci',      label: 'PCI 역산' },
  ];

  const RELATIONS = ['배우자','자녀','며느리','사위','손자녀','부모','조부모','형제','삼촌','고모','기타'];

  return (
    <div className="p-8 max-w-5xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">세금 분석</h1>
        <p className="text-sm text-gray-500 mt-1">자산 기반 세금 추정 및 절세 시뮬레이터</p>
      </div>

      {/* 탭 */}
      <div className="flex gap-1 mb-6 bg-gray-100 rounded-xl p-1">
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors ${
              tab === t.id ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}>
            {t.label}
          </button>
        ))}
      </div>

      {/* ── 세금 개요 ── */}
      {tab === 'overview' && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[
              { label: '상속세 추정',   value: fmtB(inheritTax),  color: 'text-red-600',    sub: `자산 ${fmtB(totalValue)} 기준` },
              { label: '미실현 양도세', value: fmtB(totalCGT),    color: 'text-amber-600',  sub: '전액 매각 시' },
              { label: '종합부동산세',  value: fmtB(totalCRET),   color: 'text-orange-600', sub: '연간 추정' },
              { label: '임대소득세',    value: fmtB(rentalTax),   color: 'text-purple-600', sub: `연 임대 ${fmtB(rentalIncome)}` },
            ].map(m => (
              <div key={m.label} className="metric-card">
                <div className="text-xs text-gray-500 mb-1">{m.label}</div>
                <div className={`text-2xl font-bold ${m.color}`}>{m.value}</div>
                <div className="text-xs text-gray-400 mt-1">{m.sub}</div>
              </div>
            ))}
          </div>

          {/* 상속세 공제 내역 */}
          <div className="card">
            <h2 className="text-sm font-semibold text-gray-700 mb-3">상속세 공제 내역</h2>
            <div className="space-y-2">
              {Object.entries(deductions).map(([k, v]) => v > 0 && (
                <div key={k} className="flex justify-between text-sm">
                  <span className="text-gray-600">{k}</span>
                  <span className="font-medium text-green-700">− {fmtB(v)}</span>
                </div>
              ))}
              <div className="border-t border-gray-100 pt-2 flex justify-between text-sm font-semibold">
                <span>과세표준 후 상속세</span>
                <span className="text-red-600">{fmtB(inheritTax)}</span>
              </div>
            </div>
          </div>

          {/* 현금흐름 */}
          {macro && (
            <div className={`card border ${netCashflow < 0 ? 'border-red-200 bg-red-50' : 'border-green-200 bg-green-50'}`}>
              <div className="text-sm font-semibold mb-1 text-gray-700">연 순현금흐름</div>
              <div className={`text-3xl font-bold ${netCashflow < 0 ? 'text-red-600' : 'text-green-700'}`}>
                {netCashflow >= 0 ? '+' : ''}{fmtB(netCashflow)}
              </div>
              <div className="text-xs text-gray-500 mt-1">임대수익 − 보유세 − 대출이자 − 임대소득세</div>
            </div>
          )}

          {/* 총 세부담 요약 */}
          <div className="card bg-gray-900 text-white">
            <div className="text-xs text-gray-400 mb-1">전체 잠재 세부담 합계</div>
            <div className="text-3xl font-bold">{fmtB(totalTaxBurden)}</div>
            <div className="text-xs text-gray-400 mt-1">상속세 + 양도세 + 종부세(연) + 임대소득세(연)</div>
          </div>
        </div>
      )}

      {/* ── 자산별 세금 ── */}
      {tab === 'asset' && (
        <div className="space-y-3">
          {assets.length === 0 ? (
            <div className="card text-center py-12 text-gray-400">자산을 먼저 등록해주세요</div>
          ) : assets.map(a => {
            const cgt  = calcCapitalGainsTax(a);
            const gain = a.current_value - a.acquisition_cost;
            const acqYear = a.acquisition_date ? new Date(a.acquisition_date).getFullYear() : null;
            const years = acqYear ? new Date().getFullYear() - acqYear : 0;
            const rentalInc = a.current_value * a.annual_yield_pct / 100;
            const rentalT = calcRentalIncomeTax(rentalInc);
            return (
              <div key={a.id} className="card">
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <div className="font-semibold text-sm">{a.name}</div>
                    <div className="text-xs text-gray-400">{a.asset_type} · {years}년 보유</div>
                  </div>
                  <div className="text-right">
                    <div className="text-sm font-bold text-blue-700">{fmtB(a.current_value)}</div>
                    <div className={`text-xs ${gain >= 0 ? 'text-green-600' : 'text-red-500'}`}>
                      차익 {gain >= 0 ? '+' : ''}{fmtB(gain)}
                    </div>
                  </div>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                  <div className="bg-amber-50 rounded-lg p-2">
                    <div className="text-gray-500 mb-0.5">양도세 (전액매각)</div>
                    <div className="font-semibold text-amber-700">{fmtB(cgt)}</div>
                  </div>
                  <div className="bg-orange-50 rounded-lg p-2">
                    <div className="text-gray-500 mb-0.5">보유세 (연)</div>
                    <div className="font-semibold text-orange-700">{fmtB(a.annual_tax)}</div>
                  </div>
                  <div className="bg-purple-50 rounded-lg p-2">
                    <div className="text-gray-500 mb-0.5">임대소득세 (연)</div>
                    <div className="font-semibold text-purple-700">{fmtB(rentalT)}</div>
                  </div>
                  <div className="bg-blue-50 rounded-lg p-2">
                    <div className="text-gray-500 mb-0.5">대출이자 (연)</div>
                    <div className="font-semibold text-blue-700">{fmtB(a.loan_amount * a.loan_rate_pct / 100)}</div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── 차용증 분석 ── */}
      {tab === 'loan' && (
        <div className="space-y-4">
          <div className="card bg-blue-50 border-blue-200">
            <div className="text-sm font-semibold text-blue-800 mb-1">가족간 차용증 (금전소비대차)</div>
            <div className="text-xs text-blue-700">
              적정이자율 <b>4.6%</b> (당좌대출이자율) 기준. 이자 차액이 연 <b>1천만원 미만</b>이면 증여세 비과세.<br/>
              무이자 한도 ≈ <b>2억 1,700만원</b> (상증법 §41의4)
            </div>
          </div>

          <div className="card">
            <div className="text-sm font-semibold text-gray-700 mb-4">시뮬레이터</div>
            <div className="grid grid-cols-2 gap-3 mb-4">
              <div>
                <label className="label">대출 원금 (억원)</label>
                <input type="number" step="0.1" className="input" value={loanPrincipal}
                  onChange={e => setLoanPrincipal(+e.target.value)} />
              </div>
              <div>
                <label className="label">실제 이자율 (%)</label>
                <input type="number" step="0.1" className="input" placeholder="0 = 무이자" value={loanRate}
                  onChange={e => setLoanRate(+e.target.value)} />
              </div>
              <div>
                <label className="label">수령인 관계</label>
                <select className="select" value={loanRelation} onChange={e => setLoanRelation(e.target.value)}>
                  {RELATIONS.map(r => <option key={r}>{r}</option>)}
                </select>
              </div>
              <div>
                <label className="label">10년 내 기증여액 (억원)</label>
                <input type="number" step="0.1" className="input" value={loanPrior}
                  onChange={e => setLoanPrior(+e.target.value)} />
              </div>
            </div>

            {/* 결과 */}
            <div className={`rounded-xl p-4 ${
              loanResult.riskLevel === 'safe' ? 'bg-green-50 border border-green-200' :
              loanResult.riskLevel === 'caution' ? 'bg-yellow-50 border border-yellow-200' :
              'bg-red-50 border border-red-200'
            }`}>
              <div className={`text-sm font-semibold mb-3 ${
                loanResult.riskLevel === 'safe' ? 'text-green-800' :
                loanResult.riskLevel === 'caution' ? 'text-yellow-800' : 'text-red-800'
              }`}>
                {loanResult.riskLevel === 'safe' ? '✅ 안전' :
                 loanResult.riskLevel === 'caution' ? '⚠️ 주의' : '🚨 위험'}
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs mb-3">
                {[
                  ['적정이자 (연)', fmtB(loanResult.fairInterest)],
                  ['실제이자 (연)', fmtB(loanResult.actualInterest)],
                  ['이자 차액', fmtB(loanResult.interestGap)],
                  ['연 증여세', loanResult.isGiftTaxable ? fmtB(loanResult.annualGiftTax) : '비과세'],
                ].map(([label, val]) => (
                  <div key={label} className="bg-white rounded-lg p-2">
                    <div className="text-gray-500 mb-0.5">{label}</div>
                    <div className="font-semibold">{val}</div>
                  </div>
                ))}
              </div>
              <div className="text-xs text-gray-700 bg-white rounded-lg p-3">
                💡 {loanResult.recommendation}
              </div>
            </div>

            <div className="mt-3 text-xs text-gray-400 space-y-1">
              <div>• 원금 상환이 실질적으로 이뤄져야 차용 인정 (형식적 차용 시 전액 증여 의제)</div>
              <div>• 차용증 공증 권장, 계좌 이체로 원금·이자 상환 기록 보존 필수</div>
              <div>• 동일인으로부터 10년간 수령액 합산하여 증여재산 공제 적용</div>
            </div>
          </div>

          {/* 법인과의 차용 */}
          <div className="card border-orange-200 bg-orange-50">
            <div className="text-sm font-semibold text-orange-800 mb-1">⚠️ 법인과의 차용 시 주의</div>
            <div className="text-xs text-orange-700 space-y-1">
              <div>• 법인이 특수관계인에게 저리 대출 시 <b>인정이자</b> 과세 (법인세법 §88)</div>
              <div>• 인정이자 = 원금 × (4.6% − 실제이자율) → 법인 익금산입 + 수령인 상여·배당 소득세</div>
              <div>• 법인의 자금을 대주주·가족이 무이자 차용 시 세무조사 빈발 영역</div>
            </div>
          </div>
        </div>
      )}

      {/* ── 법인전환 ── */}
      {tab === 'corp' && (
        <div className="space-y-4">
          <div className="card bg-blue-50 border-blue-200">
            <div className="text-sm font-semibold text-blue-800 mb-1">법인전환 절세효과 분석</div>
            <div className="text-xs text-blue-700">
              임대·사업소득을 법인으로 전환 시 개인 종합소득세 vs 법인세+대표이사 소득세 비교.<br/>
              현물출자 시 취득세 50% 경감 (~2027.12.31), 양도소득세 이월과세 가능 (조특법 §32)
            </div>
          </div>

          <div className="card">
            <div className="text-sm font-semibold text-gray-700 mb-4">시뮬레이터</div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
              <div>
                <label className="label">연 임대·사업소득 (억원)</label>
                <input type="number" step="0.1" className="input" value={corpRental}
                  onChange={e => setCorpRental(+e.target.value)} />
              </div>
              <div>
                <label className="label">대표이사 급여 설계 (억원)</label>
                <input type="number" step="0.1" className="input" value={corpSalary}
                  onChange={e => setCorpSalary(+e.target.value)} />
              </div>
              <div>
                <label className="label">기타 개인소득 (억원)</label>
                <input type="number" step="0.1" className="input" value={corpOther}
                  onChange={e => setCorpOther(+e.target.value)} />
              </div>
            </div>

            {/* 비교 결과 */}
            <div className="grid grid-cols-2 gap-4 mb-4">
              <div className="bg-gray-50 rounded-xl p-4">
                <div className="text-xs text-gray-500 mb-2 font-semibold">현행 (개인)</div>
                <div className="text-2xl font-bold text-red-600">{fmtB(corpResult.personalTax)}</div>
                <div className="text-xs text-gray-400 mt-1">종합소득세 (임대분)</div>
              </div>
              <div className="bg-blue-50 rounded-xl p-4">
                <div className="text-xs text-blue-600 mb-2 font-semibold">법인 전환 후</div>
                <div className="text-2xl font-bold text-blue-700">{fmtB(corpResult.totalCorpBurden)}</div>
                <div className="text-xs text-gray-400 mt-1">법인세 {fmtB(corpResult.corpTax)} + 대표 소득세 {fmtB(corpResult.ceoIncomeTax)}</div>
              </div>
            </div>

            <div className={`rounded-xl p-4 ${corpResult.annualSaving > 0 ? 'bg-green-50 border border-green-200' : 'bg-red-50 border border-red-200'}`}>
              <div className="flex justify-between items-center mb-2">
                <span className="text-sm font-semibold text-gray-700">연간 절세효과</span>
                <span className={`text-xl font-bold ${corpResult.annualSaving > 0 ? 'text-green-700' : 'text-red-600'}`}>
                  {corpResult.annualSaving > 0 ? '+' : ''}{fmtB(corpResult.annualSaving)}
                </span>
              </div>
              <div className="flex justify-between text-xs text-gray-500">
                <span>현물출자 취득세 (50% 경감)</span>
                <span className="font-medium">{fmtB(corpResult.transferTax)}</span>
              </div>
              <div className="flex justify-between text-xs text-gray-500 mt-1">
                <span>전환비용 회수 기간</span>
                <span className="font-medium">{corpResult.paybackYears === 999 ? '법인 불리' : `약 ${corpResult.paybackYears}년`}</span>
              </div>
            </div>
          </div>

          <div className="card">
            <div className="text-sm font-semibold text-gray-700 mb-3">주요 고려사항</div>
            <div className="space-y-2">
              {corpResult.notes.map((n, i) => (
                <div key={i} className="flex gap-2 text-xs text-gray-600">
                  <span className="text-blue-500 shrink-0">•</span>
                  <span>{n}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── PCI 역산 ── */}
      {tab === 'pci' && (
        <div className="space-y-4">
          <div className="card bg-orange-50 border-orange-200">
            <div className="text-sm font-semibold text-orange-800 mb-1">PCI (재산취득자금 조회) 역산</div>
            <div className="text-xs text-orange-700">
              재산 증가액 + 소비지출 − 신고소득 = 출처불명 자금 추정액.<br/>
              이 금액이 클수록 세무조사 선정 가능성이 높아집니다.
            </div>
          </div>

          <div className="card">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
              <div>
                <label className="label">재산 증가액 (억원)</label>
                <input type="number" step="0.1" className="input" value={pciIncrease}
                  onChange={e => setPciIncrease(+e.target.value)} />
              </div>
              <div>
                <label className="label">소비지출 추정 (억원)</label>
                <input type="number" step="0.1" className="input" value={pciConsume}
                  onChange={e => setPciConsume(+e.target.value)} />
              </div>
              <div>
                <label className="label">신고 소득합계 (억원)</label>
                <input type="number" step="0.1" className="input" value={pciIncome}
                  onChange={e => setPciIncome(+e.target.value)} />
              </div>
            </div>

            <div className={`rounded-xl p-5 text-center ${
              pciResult.riskLevel === 'safe' ? 'bg-green-50 border border-green-200' :
              pciResult.riskLevel === 'caution' ? 'bg-yellow-50 border border-yellow-200' :
              'bg-red-50 border border-red-200'
            }`}>
              <div className="text-xs text-gray-500 mb-1">출처불명 추정액</div>
              <div className={`text-4xl font-bold mb-2 ${
                pciResult.riskLevel === 'safe' ? 'text-green-700' :
                pciResult.riskLevel === 'caution' ? 'text-yellow-700' : 'text-red-600'
              }`}>{fmtB(pciResult.suspectedAmount)}</div>
              <div className="text-sm font-semibold">
                {pciResult.riskLevel === 'safe' ? '✅ 안전 구간' :
                 pciResult.riskLevel === 'caution' ? '⚠️ 주의 구간 (1억~5억)' :
                 '🚨 위험 구간 (5억 이상) — 세무조사 가능성 높음'}
              </div>
            </div>

            <div className="mt-3 text-xs text-gray-400 space-y-1">
              <div>• 출처불명 자금은 증여로 추정되어 증여세가 부과될 수 있습니다</div>
              <div>• 자금출처 소명이 80% 미만이면 미소명액 전액 증여로 의제</div>
              <div>• 대출, 퇴직금, 보험금, 상속, 이전 증여 등은 소명 자료 미리 준비</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

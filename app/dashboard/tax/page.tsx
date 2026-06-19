'use client';
import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase';
import { Asset, FamilyMember, MacroSettings, TransferPlan } from '@/types';
import {
  calcCapitalGainsTax, calcComprehensiveRealEstateTax,
  calcInheritanceTax, calcRentalIncomeTax, calcAnnualCashflow,
  calcGiftTax, calcFamilyLoanAnalysis, calcCorpConversionBenefit,
  calcPCI, GIFT_DEDUCTIONS, calcAnnualHoldingTaxes, calcAnnualPropertyTaxForAsset,
} from '@/lib/tax';
import { KynLoader } from '@/app/dashboard/components/KynLoader';
import { TransferPlanSummaryCard } from '@/app/dashboard/components/TransferPlanSummary';

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
  const [plans, setPlans]     = useState<TransferPlan[]>([]);
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
      const [{ data: a }, { data: m }, { data: ms }, { data: pl }] = await Promise.all([
        supabase.from('assets').select('*').eq('family_id', p.family_id),
        supabase.from('family_members').select('*').eq('family_id', p.family_id),
        supabase.from('macro_settings').select('*').eq('family_id', p.family_id).single(),
        supabase.from('transfer_plans').select('*').eq('family_id', p.family_id).order('year_offset'),
      ]);
      setAssets(a || []);
      setMembers(m || []);
      setMacro(ms || null);
      setPlans((pl as TransferPlan[]) || []);
      setLoading(false);
    }
    load();
  }, []);

  if (loading) return <KynLoader />;

  const totalValue = assets.reduce((s, a) => s + a.current_value, 0);
  const totalCGT   = assets.reduce((s, a) => s + calcCapitalGainsTax(a), 0);
  const holdingTaxBreakdown = calcAnnualHoldingTaxes(assets);
  const totalCRET  = holdingTaxBreakdown.comprehensiveRealEstateTax;
  const { tax: inheritTax, taxableBase, deductions } = calcInheritanceTax(totalValue, members);
  const rentalIncome = assets.reduce((s, a) => s + a.current_value * a.annual_yield_pct / 100, 0);
  const rentalTax  = calcRentalIncomeTax(rentalIncome);
  const { netCashflow } = macro ? calcAnnualCashflow(assets, macro) : { netCashflow: 0 };

  const totalTaxBurden = totalCGT + holdingTaxBreakdown.total + inheritTax + rentalTax;
  const deductionEntries = Object.entries(deductions).filter(([, v]) => v > 0);
  const totalDeductions = deductionEntries.reduce((sum, [, v]) => sum + v, 0);
  const giftDeductionMembers = members.filter(m => m.relation !== '본인');
  const giftDeductionFor = (m: FamilyMember) => {
    if (['자녀', '손자녀'].includes(m.relation)) return m.age >= 19 ? 0.5 : 0.2;
    return GIFT_DEDUCTIONS[m.relation] ?? 0.1;
  };

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

  // Plans tax total
  const plansTaxTotal = plans.reduce((s, p) => s + (p.estimated_tax ?? 0), 0);
  // Available liquidity
  const liquidTypes = new Set(['예금','예금채권','금융자산','채권','보험','국내주식','해외주식']);
  const ownerCash = members.filter(m => ['본인','배우자'].includes(m.relation)).reduce((s,m) => s + Number(m.cash_hold ?? 0), 0);
  const liquidAssets = assets.filter(a => liquidTypes.has(a.asset_type)).reduce((s,a) => s + a.current_value, 0);
  const availableLiquid = ownerCash + liquidAssets;
  const fundingShortfall = Math.max(0, inheritTax - availableLiquid);

  return (
    <div className="main">
      <div className="crumb">TAX</div>
      <div className="pagehead">
        <div>
          <h1>세금 분석</h1>
          <div className="desc">현재 자산 {fmtB(totalValue)} 기준 · 경로별 세부담 추정</div>
        </div>
        <a href="/dashboard/scenarios" className="btn btn-ghost" style={{ padding: '14px 22px', fontSize: 14 }}>
          시나리오 비교 <span className="arrow">→</span>
        </a>
      </div>
      <div className="rule" />

      {/* KPI strip */}
      <div className="kpis">
        <div className="kpi">
          <div className="label">상속세 추정</div>
          <div className="v neg num">{fmt(inheritTax, 1)}<span className="u">억</span></div>
          <div className="foot">지금 상속 시</div>
        </div>
        <div className="kpi">
          <div className="label">미실현 양도세</div>
          <div className="v neg num">{fmt(totalCGT, 1)}<span className="u">억</span></div>
          <div className="foot">전체 매각 시</div>
        </div>
        <div className="kpi">
          <div className="label">이전 계획 세금</div>
          <div className="v ink num">{fmt(plansTaxTotal, 1)}<span className="u">억</span></div>
          <div className="foot">계획 실행 시</div>
        </div>
        <div className="kpi">
          <div className="label">납부 재원</div>
          <div className={`v num ${fundingShortfall > 0 ? 'neg' : 'pos'}`}>{fmt(fundingShortfall, 1)}<span className="u">억</span></div>
          <div className="foot">{fundingShortfall > 0 ? '부족' : '충분'} · 현금성 {fmtB(availableLiquid)}</div>
        </div>
      </div>

      {/* 상속세 + 양도세 카드 */}
      <div className="grid2">
        <div className="card" style={{ padding: '22px 24px' }}>
          <div className="card-head" style={{ padding: '0 0 16px' }}>
            <span className="t">상속세 산출 내역<span className="sub">지금 상속이 개시되는 경우 (현행 세율 가정)</span></span>
          </div>
          <div className="deflist">
            <div className="d"><span className="k">상속재산가액</span><span className="v num">{fmtB(totalValue)}</span></div>
            {deductionEntries.map(([k, v]) => (
              <div key={k} className="d"><span className="k"><span className="op">−</span>{k}</span><span className="v num">{fmtB(v)}</span></div>
            ))}
            <div className="d"><span className="k">과세표준</span><span className="v num">{fmtB(taxableBase)}</span></div>
            <div className="d"><span className="k"><span className="op">−</span>신고세액공제 3%</span><span className="v num">{fmtB(inheritTax * 0.03 / 0.97)}</span></div>
            <div className="d total"><span className="k">납부세액</span><span className="v neg num">약 {fmtB(inheritTax)}</span></div>
          </div>
        </div>

        <div className="card" style={{ padding: '22px 24px', display: 'flex', flexDirection: 'column' }}>
          <div className="card-head" style={{ padding: '0 0 16px' }}>
            <span className="t">미실현 양도세<span className="sub">전체 자산을 지금 매각한다고 가정</span></span>
          </div>
          <div className="deflist">
            <div className="d"><span className="k">현재 평가액</span><span className="v num">{fmtB(totalValue)}</span></div>
            <div className="d"><span className="k">취득가 대비 평가차익 <small>전체 자산 합산 추정</small></span><span className="v num">약 {fmtB(totalValue - assets.reduce((s,a)=>s+a.acquisition_cost,0))}</span></div>
            <div className="d total"><span className="k">양도소득세·지방세 추정</span><span className="v neg num">{fmtB(totalCGT)}</span></div>
          </div>
          <div className="callout is-warn" style={{ marginTop: 18 }}>
            <strong>현금화의 함정.</strong> 매각으로 재원을 만들려 해도 양도세 {fmtB(totalCGT)}이 발생해, 자산을 줄이면서도 세금은 거의 줄지 않습니다.
          </div>
        </div>
      </div>

      {/* 경로별 비교 */}
      <div className="block">
        <div className="card-head" style={{ padding: '0 0 16px' }}>
          <span className="t">경로별 세부담 비교<span className="sub">같은 자산을 어떻게 넘기느냐에 따라 세금이 달라집니다</span></span>
          <a href="/dashboard/scenarios" className="link">시나리오 전체 →</a>
        </div>
        <div className="grid3" style={{ marginTop: 0 }}>
          <div className="path">
            <span className="lbl">지금 상속</span>
            <span className="big num">{fmtB(inheritTax)}</span>
            <span className="note">조치 없이 상속 개시 · 납부 재원 {fmtB(fundingShortfall)} 부족</span>
          </div>
          <div className="path">
            <span className="lbl">전체 매각</span>
            <span className="big num">{fmtB(totalCGT)}</span>
            <span className="note">자산을 처분해 현금화 · 자산 규모 축소</span>
          </div>
          <div className="path best">
            <span className="ribbon">최저</span>
            <span className="lbl">이전 계획 실행</span>
            <span className="big num">{fmtB(plansTaxTotal)}</span>
            <span className="note">사전 증여로 시점 분산 · 자산을 지키며 이전</span>
          </div>
        </div>
      </div>

      {/* 추가 분석 탭 */}
      <div style={{ marginTop: 32, borderTop: '1px solid var(--line)', paddingTop: 28 }}>
        <div className="tabs" style={{ marginBottom: 24 }}>
          {TABS.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`tab${tab === t.id ? ' active' : ''}`}>
              {t.label}
            </button>
          ))}
        </div>

        {/* ── 세금 개요 ── */}
        {tab === 'overview' && (
          <div>
            <div className="grid2" style={{ marginBottom: 24 }}>
              <div className="card" style={{ padding: '22px 24px' }}>
                <div className="card-head" style={{ padding: '0 0 16px' }}>
                  <span className="t">상속세 공제 내역<span className="sub">공제는 납부세액이 아니라 과세표준에서 차감되는 금액입니다.</span></span>
                </div>
                <div className="deflist">
                  {deductionEntries.map(([k, v]) => (
                    <div key={k} className="d">
                      <span className="k">{k}</span>
                      <span className="v pos num">{fmtB(v)}</span>
                    </div>
                  ))}
                  <div className="d total">
                    <span className="k">공제 후 예상 상속세</span>
                    <span className="v neg num">{fmtB(inheritTax)}</span>
                  </div>
                </div>
              </div>
              <div className="card" style={{ padding: '22px 24px' }}>
                <div className="card-head" style={{ padding: '0 0 16px' }}>
                  <span className="t">세금 합계<span className="sub">상속세 + 양도세 + 보유세 + 임대소득세</span></span>
                </div>
                <div className="deflist">
                  <div className="d"><span className="k">상속세</span><span className="v neg num">{fmtB(inheritTax)}</span></div>
                  <div className="d"><span className="k">미실현 양도세</span><span className="v neg num">{fmtB(totalCGT)}</span></div>
                  <div className="d"><span className="k">보유세 (연)</span><span className="v num">{fmtB(holdingTaxBreakdown.total)}</span></div>
                  <div className="d"><span className="k">임대소득세 (연)</span><span className="v num">{fmtB(rentalTax)}</span></div>
                  <div className="d total"><span className="k">전체 잠재 세부담</span><span className="v neg num">{fmtB(totalTaxBurden)}</span></div>
                </div>
              </div>
            </div>

            {/* 생전 증여공제 */}
            <div className="block card">
              <div className="card-head">
                <span className="t">생전 증여공제 참고<span className="sub">수증자별 10년 증여재산공제 한도</span></span>
                <span className="muted" style={{ fontSize: 11 }}>수증자별 10년 한도</span>
              </div>
              <table className="table kt" style={{ margin: '0 24px 20px', width: 'calc(100% - 48px)' }}>
                <tbody>
                  {giftDeductionMembers.map(m => (
                    <tr key={m.id}>
                      <td>{m.name} <span className="muted" style={{ fontSize: 12 }}>{m.relation}</span></td>
                      <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtB(giftDeductionFor(m))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* 현금흐름 */}
            {macro && (
              <div className="block card">
                <div className="card-head">
                  <span className="t">연 순현금흐름<span className="sub">임대수익 − 보유세 − 대출이자 − 임대소득세</span></span>
                </div>
                <div style={{ padding: '0 24px 20px' }}>
                  <div style={{
                    fontFamily: 'var(--serif)', fontSize: 28, fontWeight: 500,
                    letterSpacing: '-0.02em', lineHeight: 1,
                    color: netCashflow < 0 ? 'var(--red)' : 'var(--green-ink)'
                  }}>
                    {netCashflow >= 0 ? '+' : ''}{fmtB(netCashflow)}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── 자산별 세금 ── */}
        {tab === 'asset' && (
          <div>
            {assets.length === 0 ? (
              <div className="card" style={{ textAlign: 'center', padding: '48px 40px', color: 'var(--ink-faint)' }}>자산을 먼저 등록해주세요</div>
            ) : assets.map(a => {
              const cgt  = calcCapitalGainsTax(a);
              const gain = a.current_value - a.acquisition_cost;
              const acqYear = a.acquisition_date ? new Date(a.acquisition_date).getFullYear() : null;
              const years = acqYear ? new Date().getFullYear() - acqYear : 0;
              const rentalInc = a.current_value * a.annual_yield_pct / 100;
              const rentalT = calcRentalIncomeTax(rentalInc);
              const holdingT = calcAnnualPropertyTaxForAsset(a);
              return (
                <div key={a.id} className="card" style={{ marginBottom: 16 }}>
                  <div className="card-head">
                    <span className="t">{a.name}<span className="sub">{a.asset_type} · {years}년 보유</span></span>
                    <span className="num" style={{ fontWeight: 700, fontSize: 15 }}>{fmtB(a.current_value)}</span>
                  </div>
                  <div className="deflist" style={{ padding: '0 24px 16px' }}>
                    <div className="d"><span className="k">양도세 (전액매각)</span><span className="v neg num">{fmtB(cgt)}</span></div>
                    <div className="d"><span className="k">재산세·지방세 (연)</span><span className="v num">{fmtB(holdingT.total)}</span></div>
                    <div className="d"><span className="k">임대소득세 (연)</span><span className="v num">{fmtB(rentalT)}</span></div>
                    <div className="d"><span className="k">대출이자 (연)</span><span className="v num">{fmtB(a.loan_amount * a.loan_rate_pct / 100)}</span></div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* ── 차용증 분석 ── */}
        {tab === 'loan' && (
          <div>
            <div className="callout" style={{ marginBottom: 20 }}>
              적정이자율 <strong>4.6%</strong> (당좌대출이자율) 기준. 이자 차액이 연 <strong>1천만원 미만</strong>이면 증여세 비과세. 무이자 한도 ≈ <strong>2억 1,700만원</strong> (상증법 §41의4)
            </div>

            <div className="card" style={{ padding: '22px 24px', marginBottom: 20 }}>
              <div className="card-head" style={{ padding: '0 0 16px' }}>
                <span className="t">시뮬레이터</span>
              </div>
              <div className="grid2" style={{ marginBottom: 16 }}>
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

              <div className="deflist">
                <div className="d"><span className="k">적정이자 (연, 4.6%)</span><span className="v num">{fmtB(loanResult.fairInterest)}</span></div>
                <div className="d"><span className="k">실제이자 (연)</span><span className="v num">{fmtB(loanResult.actualInterest)}</span></div>
                <div className="d">
                  <span className="k">{loanResult.isOverpaying ? '초과 납부 이자' : '미달 이자 (증여 간주)'}</span>
                  <span className={`v num ${loanResult.isOverpaying ? 'pos' : loanResult.interestGap > 0 ? 'neg' : ''}`}>
                    {loanResult.isOverpaying
                      ? `+${fmtB(loanResult.interestDiff)}`
                      : loanResult.interestGap > 0
                        ? `-${fmtB(loanResult.interestGap)}`
                        : '0억'}
                  </span>
                </div>
                <div className="d total">
                  <span className="k">연 증여세</span>
                  <span className={`v num ${loanResult.isGiftTaxable ? 'neg' : 'pos'}`}>
                    {loanResult.isGiftTaxable ? fmtB(loanResult.annualGiftTax) : '비과세'}
                  </span>
                </div>
              </div>
              <div className="callout" style={{ marginTop: 16 }}>
                {loanResult.recommendation}
              </div>
            </div>

            <div className="callout is-warn">
              <strong>법인과의 차용 시 주의.</strong> 법인이 특수관계인에게 저리 대출 시 인정이자 과세 (법인세법 §88). 인정이자 = 원금 × (4.6% − 실제이자율) → 법인 익금산입 + 수령인 상여·배당 소득세.
            </div>
          </div>
        )}

        {/* ── 법인전환 ── */}
        {tab === 'corp' && (
          <div>
            <div className="callout" style={{ marginBottom: 20 }}>
              임대·사업소득을 법인으로 전환 시 개인 종합소득세 vs 법인세+대표이사 소득세 비교. 현물출자 시 양도소득세 이월과세와 지방세 감면은 자산·사업·시점별 적용 요건 확인 필요 (조특법 §32 등)
            </div>

            <div className="grid2" style={{ marginBottom: 20 }}>
              <div className="card" style={{ padding: '22px 24px' }}>
                <div className="card-head" style={{ padding: '0 0 16px' }}>
                  <span className="t">시뮬레이터</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
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
              </div>
              <div className="card" style={{ padding: '22px 24px' }}>
                <div className="card-head" style={{ padding: '0 0 16px' }}>
                  <span className="t">비교 결과</span>
                </div>
                <div className="deflist">
                  <div className="d"><span className="k">현행 (개인) 종합소득세</span><span className="v neg num">{fmtB(corpResult.personalTax)}</span></div>
                  <div className="d"><span className="k">법인세</span><span className="v num">{fmtB(corpResult.corpTax)}</span></div>
                  <div className="d"><span className="k">대표 소득세</span><span className="v num">{fmtB(corpResult.ceoIncomeTax)}</span></div>
                  <div className="d total"><span className="k">연간 절세효과</span><span className={`v num ${corpResult.annualSaving > 0 ? 'pos' : 'neg'}`}>{corpResult.annualSaving > 0 ? '+' : ''}{fmtB(corpResult.annualSaving)}</span></div>
                </div>
              </div>
            </div>

            <div className="card" style={{ padding: '22px 24px' }}>
              <div className="card-head" style={{ padding: '0 0 16px' }}>
                <span className="t">주요 고려사항</span>
              </div>
              <div className="deflist">
                {corpResult.notes.map((n, i) => (
                  <div key={i} className="d" style={{ fontSize: 13 }}>
                    <span className="k" style={{ color: 'var(--ink-soft)' }}>• {n}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ── PCI 역산 ── */}
        {tab === 'pci' && (
          <div>
            <div className="callout is-warn" style={{ marginBottom: 20 }}>
              <strong>PCI (재산취득자금 조회) 역산.</strong> 재산 증가액 + 소비지출 − 신고소득 = 출처불명 자금 추정액. 이 금액이 클수록 세무조사 선정 가능성이 높아집니다.
            </div>

            <div className="card" style={{ padding: '22px 24px' }}>
              <div className="card-head" style={{ padding: '0 0 16px' }}>
                <span className="t">시뮬레이터</span>
              </div>
              <div className="grid3" style={{ marginBottom: 16 }}>
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
              <div className="deflist">
                <div className="d"><span className="k">재산 증가액 + 소비지출</span><span className="v num">{fmtB(pciIncrease + pciConsume)}</span></div>
                <div className="d"><span className="k">신고 소득합계</span><span className="v num">{fmtB(pciIncome)}</span></div>
                <div className="d total"><span className="k">출처불명 추정액</span><span className={`v num ${pciResult.riskLevel === 'safe' ? 'pos' : 'neg'}`}>{fmtB(pciResult.suspectedAmount)}</span></div>
              </div>
              <div className={`callout ${pciResult.riskLevel !== 'safe' ? 'is-warn' : ''}`} style={{ marginTop: 16 }}>
                {pciResult.riskLevel === 'safe' ? '안전 구간 — 출처 소명 문제 없음' :
                 pciResult.riskLevel === 'caution' ? '주의 구간 (1억~5억) — 자금출처 서류 미리 준비' :
                 '위험 구간 (5억 이상) — 세무조사 가능성 높음. 출처 소명 준비 필요.'}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 법률 주의 */}
      <div className="callout is-legal" style={{ marginTop: 24 }}>
        <strong>법률 주의.</strong> 위 추정치는 입력 정보와 현행 세율을 기준으로 한 참고용 계산이며 세무 자문이 아닙니다. 공제 항목·세법 개정·개별 상황에 따라 실제 세액은 달라질 수 있어, 신고 전 세무사 검토가 필요합니다.
      </div>
    </div>
  );
}

'use client';
import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase';
import { Asset, AssetType, FamilyMember, MacroSettings } from '@/types';
import { getAssetGrowthRate, projectAssetValue } from '@/lib/tax';
import { KynLoader } from '@/app/dashboard/components/KynLoader';

const ASSET_TYPES: AssetType[] = ['주거용부동산','상업용부동산','토지','농지','임야','오피스텔','예금','채권','국내주식','해외주식','비상장주식','보험','금융자산','예금채권','기타'];

const EMPTY = {
  name:'', asset_type:'주거용부동산' as AssetType, owner_member_id:'',
  current_value:0, acquisition_cost:0, acquisition_date:'',
  annual_yield_pct:0, annual_tax:0, loan_amount:0, loan_rate_pct:0,
  loan_type:'fixed' as 'fixed'|'variable', expected_growth_pct:2,
  public_price_ratio:70, is_planned_transfer:false, notes:'',
  liquidity_score: null as number | null,
};

// 1(즉시 현금화) ~ 5(매각 매우 어려움). 부동산은 입지에 따라 편차가 커서
// (강남 등 핵심지 vs 지방) 자산유형만으로 고정값을 쓰지 않고 자산별로 설정한다.
const LIQUIDITY_OPTIONS: Array<{ value: number; label: string; hint: string }> = [
  { value: 1, label: '1 · 즉시 현금화', hint: '예금·상장주식 등' },
  { value: 2, label: '2 · 수요 많음', hint: '핵심지 아파트·소형 상가 등' },
  { value: 3, label: '3 · 보통', hint: '일반 아파트·오피스텔 등' },
  { value: 4, label: '4 · 매각 어려움', hint: '지방 상업용·특수 물건 등' },
  { value: 5, label: '5 · 매각 매우 어려움', hint: '농지·임야·비상장주식 등' },
];

function defaultLiquidityScore(assetType: AssetType): number {
  if (['예금', '예금채권', '채권'].includes(assetType)) return 1;
  if (['국내주식', '해외주식', '금융자산', '보험'].includes(assetType)) return 2;
  if (['오피스텔', '주거용부동산'].includes(assetType)) return 3;
  if (['상업용부동산', '비상장주식'].includes(assetType)) return 4;
  if (['토지', '농지', '임야'].includes(assetType)) return 5;
  return 3;
}

function fmt(n: number, d=1) {
  if (!n) return '0';
  return (Math.round(n * Math.pow(10,d)) / Math.pow(10,d)).toLocaleString('ko-KR');
}

export default function AssetsPage() {
  const [assets, setAssets]   = useState<Asset[]>([]);
  const [members, setMembers] = useState<FamilyMember[]>([]);
  const [macro, setMacro]     = useState<MacroSettings | null>(null);
  const [form, setForm]       = useState({ ...EMPTY });
  const [editing, setEditing] = useState<string | null>(null);
  const [open, setOpen]       = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving]   = useState(false);
  const [familyId, setFamilyId] = useState<string | null>(null);
  const supabase = createClient();

  useEffect(() => { load(); }, []);

  async function load() {
    const { data: p } = await supabase.from('profiles').select('family_id').single();
    if (!p?.family_id) { setLoading(false); return; }
    setFamilyId(p.family_id);
    const [{ data: a }, { data: m }, { data: ms }] = await Promise.all([
      supabase.from('assets').select('*').eq('family_id', p.family_id).order('current_value', { ascending: false }),
      supabase.from('family_members').select('*').eq('family_id', p.family_id),
      supabase.from('macro_settings').select('*').eq('family_id', p.family_id).single(),
    ]);
    setAssets(a || []);
    setMembers(m || []);
    setMacro(ms || null);
    setLoading(false);
  }

  function openNew() { setForm({ ...EMPTY }); setEditing(null); setOpen(true); }
  function openEdit(a: Asset) {
    setForm({
      name: a.name, asset_type: a.asset_type, owner_member_id: a.owner_member_id || '',
      current_value: a.current_value, acquisition_cost: a.acquisition_cost,
      acquisition_date: a.acquisition_date || '', annual_yield_pct: a.annual_yield_pct,
      annual_tax: a.annual_tax, loan_amount: a.loan_amount, loan_rate_pct: a.loan_rate_pct,
      loan_type: a.loan_type, expected_growth_pct: a.expected_growth_pct,
      public_price_ratio: a.public_price_ratio, is_planned_transfer: a.is_planned_transfer,
      notes: a.notes || '',
      liquidity_score: a.liquidity_score ?? null,
    });
    setEditing(a.id); setOpen(true);
  }

  async function save() {
    if (!form.name || !familyId) return;
    setSaving(true);
    const payload = { ...form, family_id: familyId,
      owner_member_id: form.owner_member_id || null };
    if (editing) {
      await supabase.from('assets').update({ ...payload, updated_at: new Date().toISOString() }).eq('id', editing);
    } else {
      await supabase.from('assets').insert(payload);
    }
    await load(); setOpen(false); setSaving(false);
  }

  async function del(id: string) {
    if (!confirm('삭제하시겠습니까?')) return;
    await supabase.from('assets').delete().eq('id', id);
    setAssets(a => a.filter(x => x.id !== id));
  }

  const totalValue = assets.reduce((s, a) => s + a.current_value, 0);
  const totalDebt  = assets.reduce((s, a) => s + a.loan_amount, 0);
  const totalTax = assets.reduce((s, a) => s + a.annual_tax, 0);
  const totalFutureValue = assets.reduce((s, a) => s + projectAssetValue(a, 10, macro), 0);
  const totalYield = assets.reduce((s, a) => s + a.current_value * a.annual_yield_pct / 100, 0);

  const ownerName = (id: string | null) =>
    members.find(m => m.id === id)?.name || '미지정';

  if (loading) return <KynLoader />;

  return (
    <div className="main">
      <div className="crumb">ASSETS</div>
      <div className="pagehead">
        <div>
          <h1>자산 목록</h1>
          <div className="desc">전체 {assets.length}건 · 평가 기준 {new Date().getFullYear()}</div>
        </div>
        <button onClick={openNew} className="btn btn-ghost" style={{ padding: '14px 22px', fontSize: 14 }}>
          자산 추가 <span className="arrow">+</span>
        </button>
      </div>
      <div className="rule" />

      {/* KPI strip */}
      <div className="kpis">
        <div className="kpi">
          <div className="label">총 평가액</div>
          <div className="v ink num">{fmt(totalValue)}<span className="u">억</span></div>
          <div className="foot">10년 후 {fmt(totalFutureValue)}억</div>
        </div>
        <div className="kpi">
          <div className="label">연 임대수익</div>
          <div className={`v num ${totalYield > 0 ? 'pos' : 'ink'}`}>{fmt(totalYield)}<span className="u">억</span></div>
          <div className="foot">등록 자산 기준</div>
        </div>
        <div className="kpi">
          <div className="label">연 보유세</div>
          <div className="v ink num">{fmt(totalTax)}<span className="u">억</span></div>
          <div className="foot">현 구조 기준</div>
        </div>
        <div className="kpi">
          <div className="label">담보 부채</div>
          <div className={`v num ${totalDebt > 0 ? 'neg' : 'ink'}`}>{fmt(totalDebt)}<span className="u">억</span></div>
          <div className="foot">LTV {totalValue > 0 ? (totalDebt/totalValue*100).toFixed(1) : '0.0'}% · {totalDebt === 0 ? '무차입' : '차입 있음'}</div>
        </div>
      </div>

      {assets.length === 0 ? (
        <div className="block card" style={{ textAlign: 'center', padding: '64px 40px' }}>
          <div className="serif" style={{ fontSize: 28, color: 'var(--gold-deep)', marginBottom: 16 }}>KYN</div>
          <p style={{ color: 'var(--ink-faint)', fontSize: 13, marginBottom: 20 }}>자산을 추가해주세요</p>
          <button onClick={openNew} className="btn btn-primary">자산 추가 <span className="arrow">+</span></button>
        </div>
      ) : (
        <>
          {/* 자산 구성 card */}
          <div className="block card">
            <div className="card-head">
              <span className="t">자산 구성<span className="sub">평가액 {fmt(totalValue)}억 기준 · 전체 {new Set(assets.map(a => a.asset_type)).size > 1 ? `혼합 (${new Set(assets.map(a => a.asset_type)).size}종)` : (assets[0]?.asset_type || '') + ` (100%)`}</span></span>
              <span className="link" style={{ color: 'var(--ink-faint)', cursor: 'default' }}>유형 {new Set(assets.map(a => a.asset_type)).size}종</span>
            </div>
            {assets.map(a => {
              const pct = totalValue > 0 ? a.current_value / totalValue * 100 : 0;
              const ownerAssigned = !!a.owner_member_id;
              return (
                <div key={a.id} className="comp">
                  <div>
                    <div className="nm">{a.name} <small>{a.asset_type} · {ownerName(a.owner_member_id)}</small></div>
                    <div className="barwrap"><div className="bar"><span className={ownerAssigned ? 'brass' : 'clay'} style={{ width: `${pct}%` }} /></div></div>
                  </div>
                  <div className="amt num">{fmt(a.current_value)}억</div>
                  <div className="pct num">{pct.toFixed(1)}%</div>
                </div>
              );
            })}
          </div>

          {/* 자산 상세 table card */}
          <div className="block card">
            <div className="card-head">
              <span className="t">자산 상세</span>
              <span className="link" style={{ color: 'var(--ink-faint)', cursor: 'default' }}>
                10년 성장률 가정 {assets[0] ? (getAssetGrowthRate(assets[0], macro) * 100).toFixed(0) : 4}%/년
              </span>
            </div>
            <table className="table kt asset-table">
              <thead>
                <tr>
                  <th>자산명</th>
                  <th>소유자</th>
                  <th className="r">현재가</th>
                  <th className="r">10년 후</th>
                  <th className="r">연수익</th>
                  <th className="r">보유세</th>
                  <th className="r"></th>
                </tr>
              </thead>
              <tbody>
                {assets.map(a => (
                  <tr key={a.id}>
                    <td className="name">{a.name}</td>
                    <td className={a.owner_member_id ? 'soft' : 'muted'}>{ownerName(a.owner_member_id)}</td>
                    <td className="r num">{fmt(a.current_value)}억</td>
                    <td className="r pos num">{fmt(projectAssetValue(a, 10, macro))}억</td>
                    <td className="r num">{fmt(a.current_value * a.annual_yield_pct / 100)}억</td>
                    <td className="r zero num">{fmt(a.annual_tax)}억</td>
                    <td className="r" style={{ whiteSpace: 'nowrap', paddingRight: 24 }}>
                      <button onClick={() => openEdit(a)} className="link" style={{ marginRight: 8 }}>수정</button>
                      <button onClick={() => del(a.id)} className="link" style={{ color: 'var(--red)' }}>삭제</button>
                    </td>
                  </tr>
                ))}
                <tr style={{ borderTop: '1px solid var(--line-strong)', background: 'var(--paper-sink)' }}>
                  <td className="name" style={{ paddingLeft: 24, fontWeight: 700 }}>합계</td>
                  <td></td>
                  <td className="r num" style={{ fontWeight: 700 }}>{fmt(totalValue)}억</td>
                  <td className="r pos num" style={{ fontWeight: 700 }}>{fmt(totalFutureValue)}억</td>
                  <td className="r num" style={{ fontWeight: 700 }}>{fmt(totalYield)}억</td>
                  <td className="r zero num" style={{ fontWeight: 700 }}>{fmt(totalTax)}억</td>
                  <td></td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* summary strip */}
          <div className="summary">
            <div className="s note">
              <span className="dot" /><span>부동산 <b>{totalValue > 0 ? (assets.filter(a => ['주거용부동산','상업용부동산','토지','농지','임야','오피스텔'].includes(a.asset_type)).reduce((s,a) => s+a.current_value,0)/totalValue*100).toFixed(0) : 0}% 편중</b> · 현금화 어려움</span>
            </div>
            <div className={`s ${totalDebt === 0 ? 'ok' : 'warn'}`}>
              <span className="dot" /><span>부채 <b>{fmt(totalDebt)}억</b> · LTV·DSCR 기준 충족</span>
            </div>
            <div className={`s ${assets.some(a => !a.owner_member_id) ? 'warn' : 'ok'}`}>
              <span className="dot" /><span>미지정 자산 <b>{assets.filter(a => !a.owner_member_id).length}건</b></span>
            </div>
          </div>
        </>
      )}

      {/* 모달 */}
      {open && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: 16 }}>
          <div style={{ background: '#fff', width: '100%', maxWidth: 520, border: '1px solid var(--line-strong)' }}>
            <div style={{ padding: '18px 24px', borderBottom: '1px solid var(--line)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 15, fontWeight: 600 }}>{editing ? '자산 수정' : '자산 추가'}</span>
              <button onClick={() => setOpen(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--ink-faint)', fontSize: 18 }}>✕</button>
            </div>
            <div style={{ padding: '16px 24px', maxHeight: '70vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div>
                <label className="label">자산명 *</label>
                <input className="input" placeholder="강남 아파트"
                  value={form.name} onChange={e => setForm({...form, name: e.target.value})}/>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <label className="label">자산 유형</label>
                  <select className="select" value={form.asset_type}
                    onChange={e => setForm({...form, asset_type: e.target.value as AssetType})}>
                    {ASSET_TYPES.map(t => <option key={t}>{t}</option>)}
                  </select>
                </div>
                <div>
                  <label className="label">소유자</label>
                  <select className="select" value={form.owner_member_id}
                    onChange={e => setForm({...form, owner_member_id: e.target.value})}>
                    <option value="">미지정</option>
                    {members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </select>
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <label className="label">현재 시가 (억원) *</label>
                  <input type="number" step="0.1" className="input" placeholder="10"
                    value={form.current_value || ''} onChange={e => setForm({...form, current_value: +e.target.value})}/>
                </div>
                <div>
                  <label className="label">취득가 (억원)</label>
                  <input type="number" step="0.1" className="input" placeholder="5"
                    value={form.acquisition_cost || ''} onChange={e => setForm({...form, acquisition_cost: +e.target.value})}/>
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <label className="label">취득일</label>
                  <input type="date" className="input"
                    value={form.acquisition_date} onChange={e => setForm({...form, acquisition_date: e.target.value})}/>
                </div>
                <div>
                  <label className="label">공시가 비율 (%)</label>
                  <input type="number" step="1" className="input" placeholder="70"
                    value={form.public_price_ratio || ''} onChange={e => setForm({...form, public_price_ratio: +e.target.value})}/>
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <label className="label">연 수익률 (%)</label>
                  <input type="number" step="0.1" className="input" placeholder="4.5"
                    value={form.annual_yield_pct || ''} onChange={e => setForm({...form, annual_yield_pct: +e.target.value})}/>
                </div>
                <div>
                  <label className="label">연 보유세 (억원)</label>
                  <input type="number" step="0.01" className="input" placeholder="0.05"
                    value={form.annual_tax || ''} onChange={e => setForm({...form, annual_tax: +e.target.value})}/>
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
                <div>
                  <label className="label">대출잔액 (억원)</label>
                  <input type="number" step="0.1" className="input" placeholder="0"
                    value={form.loan_amount || ''} onChange={e => setForm({...form, loan_amount: +e.target.value})}/>
                </div>
                <div>
                  <label className="label">금리 (%)</label>
                  <input type="number" step="0.1" className="input" placeholder="4.0"
                    value={form.loan_rate_pct || ''} onChange={e => setForm({...form, loan_rate_pct: +e.target.value})}/>
                </div>
                <div>
                  <label className="label">금리 유형</label>
                  <select className="select" value={form.loan_type}
                    onChange={e => setForm({...form, loan_type: e.target.value as 'fixed'|'variable'})}>
                    <option value="fixed">고정</option>
                    <option value="variable">변동</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="label">기대 성장률 (% / 년)</label>
                <input type="number" step="0.5" className="input" placeholder="2"
                  value={form.expected_growth_pct || ''} onChange={e => setForm({...form, expected_growth_pct: +e.target.value})}/>
              </div>
              <div>
                <label className="label">
                  유동성 (매각 용이성)
                  <span style={{ fontWeight: 400, color: 'var(--ink-faint)' }}>
                    {' '}— 같은 부동산이라도 강남 등 핵심지와 지방은 다르므로 자산별로 설정
                  </span>
                </label>
                <select className="select" value={form.liquidity_score ?? ''}
                  onChange={e => setForm({...form, liquidity_score: e.target.value ? +e.target.value : null})}>
                  <option value="">
                    자동 (유형 기본값: {defaultLiquidityScore(form.asset_type)}
                    {' · '}{LIQUIDITY_OPTIONS.find(o => o.value === defaultLiquidityScore(form.asset_type))?.label.split(' · ')[1]})
                  </option>
                  {LIQUIDITY_OPTIONS.map(o => (
                    <option key={o.value} value={o.value}>{o.label} — {o.hint}</option>
                  ))}
                </select>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input type="checkbox" id="pt" checked={form.is_planned_transfer}
                  onChange={e => setForm({...form, is_planned_transfer: e.target.checked})}/>
                <label htmlFor="pt" style={{ fontSize: 13, color: 'var(--ink-soft)' }}>이전 계획 자산</label>
              </div>
              <div>
                <label className="label">메모</label>
                <textarea className="input" placeholder="특이사항"
                  value={form.notes} onChange={e => setForm({...form, notes: e.target.value})}/>
              </div>
            </div>
            <div style={{ padding: '16px 24px', borderTop: '1px solid var(--line)', display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setOpen(false)} className="btn btn-ghost">취소</button>
              <button onClick={save} disabled={saving || !form.name} className="btn btn-primary">
                {saving ? '저장 중...' : '저장'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

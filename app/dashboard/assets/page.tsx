'use client';
import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase';
import { Asset, AssetType, FamilyMember } from '@/types';
import { calcCapitalGainsTax, calcAcquisitionTax } from '@/lib/tax';

const ASSET_TYPES: AssetType[] = ['주거용부동산','상업용부동산','토지','금융자산','비상장주식','예금채권','기타'];
const TYPE_ICONS: Record<string, string> = {
  '주거용부동산':'🏠','상업용부동산':'🏢','토지':'🌾',
  '금융자산':'📈','비상장주식':'📋','예금채권':'💰','기타':'📦'
};

const EMPTY = {
  name:'', asset_type:'주거용부동산' as AssetType, owner_member_id:'',
  current_value:0, acquisition_cost:0, acquisition_date:'',
  annual_yield_pct:0, annual_tax:0, loan_amount:0, loan_rate_pct:0,
  loan_type:'fixed' as 'fixed'|'variable', expected_growth_pct:2,
  public_price_ratio:70, is_planned_transfer:false, notes:''
};

function fmt(n: number, d=1) {
  if (!n) return '0';
  return (Math.round(n * Math.pow(10,d)) / Math.pow(10,d)).toLocaleString('ko-KR');
}

export default function AssetsPage() {
  const [assets, setAssets]   = useState<Asset[]>([]);
  const [members, setMembers] = useState<FamilyMember[]>([]);
  const [form, setForm]       = useState({ ...EMPTY });
  const [editing, setEditing] = useState<string | null>(null);
  const [open, setOpen]       = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving]   = useState(false);
  const [familyId, setFamilyId] = useState<string | null>(null);
  const [filter, setFilter]   = useState<string>('전체');
  const supabase = createClient();

  useEffect(() => { load(); }, []);

  async function load() {
    const { data: p } = await supabase.from('profiles').select('family_id').single();
    if (!p?.family_id) { setLoading(false); return; }
    setFamilyId(p.family_id);
    const [{ data: a }, { data: m }] = await Promise.all([
      supabase.from('assets').select('*').eq('family_id', p.family_id).order('current_value', { ascending: false }),
      supabase.from('family_members').select('*').eq('family_id', p.family_id),
    ]);
    setAssets(a || []);
    setMembers(m || []);
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
      notes: a.notes || ''
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

  const filtered = filter === '전체' ? assets : assets.filter(a => a.asset_type === filter);
  const totalValue = assets.reduce((s, a) => s + a.current_value, 0);
  const totalDebt  = assets.reduce((s, a) => s + a.loan_amount, 0);
  const totalIncome = assets.reduce((s, a) => s + a.current_value * a.annual_yield_pct / 100, 0);

  const ownerName = (id: string | null) =>
    members.find(m => m.id === id)?.name || '미지정';

  if (loading) return <div className="p-8 text-sm text-gray-400">로딩 중...</div>;

  return (
    <div className="p-8 max-w-5xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">자산 목록</h1>
          <p className="text-sm text-gray-500 mt-1">취득가·취득일 기반 정확한 세금 계산</p>
        </div>
        <button onClick={openNew} className="btn-primary">+ 자산 추가</button>
      </div>

      {/* 요약 */}
      {assets.length > 0 && (
        <div className="grid grid-cols-3 gap-4 mb-6">
          {[
            ['총 자산가치', `${fmt(totalValue)}억`, '파란색'],
            ['총 대출잔액', `${fmt(totalDebt)}억`, '빨간색'],
            ['연 임대수익', `${fmt(totalIncome)}억`, '초록색'],
          ].map(([label, val, color]) => (
            <div key={label} className="metric-card">
              <div className="text-xs text-gray-500 mb-1">{label}</div>
              <div className={`text-xl font-bold ${
                color === '파란색' ? 'text-blue-700' :
                color === '빨간색' ? 'text-red-600' : 'text-green-700'
              }`}>{val}</div>
            </div>
          ))}
        </div>
      )}

      {/* 필터 */}
      {assets.length > 0 && (
        <div className="flex gap-2 mb-4 flex-wrap">
          {['전체', ...ASSET_TYPES].map(t => (
            <button key={t} onClick={() => setFilter(t)}
              className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                filter === t ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}>{t}</button>
          ))}
        </div>
      )}

      {/* 목록 */}
      {filtered.length === 0 ? (
        <div className="card text-center py-16">
          <div className="text-4xl mb-4">🏠</div>
          <p className="text-gray-500 text-sm mb-4">자산을 추가해주세요</p>
          <button onClick={openNew} className="btn-primary">첫 번째 자산 추가</button>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map(a => {
            const gain = a.current_value - a.acquisition_cost;
            const cgt  = calcCapitalGainsTax(a);
            const ltv  = a.current_value > 0 ? (a.loan_amount / a.current_value * 100) : 0;
            return (
              <div key={a.id} className="card hover:border-blue-200 transition-all">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div className="text-2xl">{TYPE_ICONS[a.asset_type]}</div>
                    <div>
                      <div className="font-semibold text-gray-900 text-sm">{a.name}</div>
                      <div className="text-xs text-gray-400 mt-0.5">
                        {a.asset_type} · 소유자: {ownerName(a.owner_member_id)}
                        {a.acquisition_date && ` · 취득 ${a.acquisition_date.slice(0,7)}`}
                      </div>
                    </div>
                  </div>
                  <div className="flex gap-2 items-center">
                    {a.is_planned_transfer && (
                      <span className="badge-blue">이전예정</span>
                    )}
                    <button onClick={() => openEdit(a)} className="text-xs text-blue-600 hover:underline">수정</button>
                    <button onClick={() => del(a.id)} className="text-xs text-red-400 hover:underline">삭제</button>
                  </div>
                </div>

                <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mt-3 text-xs">
                  <div className="bg-gray-50 rounded-lg p-2">
                    <div className="text-gray-400 mb-0.5">현재가</div>
                    <div className="font-semibold text-blue-700">{fmt(a.current_value)}억</div>
                  </div>
                  <div className="bg-gray-50 rounded-lg p-2">
                    <div className="text-gray-400 mb-0.5">취득가 대비 차익</div>
                    <div className={`font-semibold ${gain >= 0 ? 'text-green-700' : 'text-red-600'}`}>
                      {gain >= 0 ? '+':''}{fmt(gain)}억
                    </div>
                  </div>
                  <div className="bg-gray-50 rounded-lg p-2">
                    <div className="text-gray-400 mb-0.5">LTV</div>
                    <div className={`font-semibold ${ltv > 60 ? 'text-red-600' : ltv > 40 ? 'text-amber-600' : 'text-gray-700'}`}>
                      {ltv.toFixed(1)}%
                    </div>
                  </div>
                  <div className="bg-gray-50 rounded-lg p-2">
                    <div className="text-gray-400 mb-0.5">양도세 추정</div>
                    <div className="font-semibold text-amber-700">{fmt(cgt)}억</div>
                  </div>
                </div>

                {/* 대출 정보 */}
                {a.loan_amount > 0 && (
                  <div className="mt-2 text-xs text-gray-500 flex gap-3">
                    <span>대출 {fmt(a.loan_amount)}억</span>
                    <span>금리 {a.loan_rate_pct}%</span>
                    <span className="text-red-500">연이자 {fmt(a.loan_amount * a.loan_rate_pct / 100)}억</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* 모달 */}
      {open && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl w-full max-w-lg shadow-xl">
            <div className="p-5 border-b border-gray-100">
              <h2 className="font-semibold text-gray-900">
                {editing ? '자산 수정' : '자산 추가'}
              </h2>
            </div>
            <div className="p-5 space-y-3 max-h-[70vh] overflow-y-auto">
              {/* 기본 정보 */}
              <div>
                <label className="label">자산명 *</label>
                <input className="input" placeholder="강남 아파트"
                  value={form.name} onChange={e => setForm({...form, name: e.target.value})}/>
              </div>
              <div className="grid grid-cols-2 gap-3">
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

              {/* 가액 */}
              <div className="grid grid-cols-2 gap-3">
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
              <div className="grid grid-cols-2 gap-3">
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

              {/* 수익·세금 */}
              <div className="grid grid-cols-2 gap-3">
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

              {/* 대출 */}
              <div className="grid grid-cols-3 gap-3">
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

              {/* 성장률 */}
              <div>
                <label className="label">기대 성장률 (% / 년)</label>
                <input type="number" step="0.5" className="input" placeholder="2"
                  value={form.expected_growth_pct || ''} onChange={e => setForm({...form, expected_growth_pct: +e.target.value})}/>
              </div>

              <div className="flex items-center gap-2">
                <input type="checkbox" id="pt" checked={form.is_planned_transfer}
                  onChange={e => setForm({...form, is_planned_transfer: e.target.checked})}
                  className="w-4 h-4 rounded border-gray-300"/>
                <label htmlFor="pt" className="text-sm text-gray-600">이전 계획 자산</label>
              </div>

              <div>
                <label className="label">메모</label>
                <textarea className="input resize-none h-16" placeholder="특이사항"
                  value={form.notes} onChange={e => setForm({...form, notes: e.target.value})}/>
              </div>
            </div>
            <div className="p-5 border-t border-gray-100 flex gap-2 justify-end">
              <button onClick={() => setOpen(false)} className="btn-secondary">취소</button>
              <button onClick={save} disabled={saving || !form.name} className="btn-primary">
                {saving ? '저장 중...' : '저장'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

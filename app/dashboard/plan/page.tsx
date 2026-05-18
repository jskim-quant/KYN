'use client';
import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase';
import { Asset, FamilyMember, MacroSettings, TransferPlan, TransferType } from '@/types';
import {
  calcGiftTax, calcCapitalGainsTax, calcInheritanceTax,
  generateDistributionStrategies,
  FamilyDistributionStrategy, StrategyAction,
} from '@/lib/tax';

// ── 상수 ──────────────────────────────────────────────────────
const TRANSFER_TYPES: TransferType[] = [
  '증여(생전)', '상속(사후)', '세대생략증여', '지분증여', '법인이전', '매각후분배', '가족간대출',
];
const TYPE_DESC: Record<string, string> = {
  '증여(생전)':   '생전에 자산을 직접 이전 — 증여세 발생',
  '상속(사후)':   '사망 후 상속 — 상속세 발생',
  '세대생략증여': '손자녀에게 직접 증여 — 30% 할증',
  '지분증여':     '부동산 지분 일부를 점진적으로 이전',
  '법인이전':     '법인 설립 후 자산 이전 — 법인세 구조',
  '매각후분배':   '자산 매각 → 현금으로 분배',
  '가족간대출':   '차용증 기반 자금 이전 — 이자율 4.6% 적용',
};
const PRIORITY_COLORS: Record<string, string> = {
  '즉시': 'bg-red-100 text-red-700',
  '단기': 'bg-orange-100 text-orange-700',
  '중기': 'bg-yellow-100 text-yellow-700',
  '장기': 'bg-green-100 text-green-700',
};
const DEDUCTION_DISPLAY: Record<string, string> = {
  '배우자': '6억/10년',
  '자녀': '5천만/10년',
  '손자녀': '2천만/10년',
  '며느리': '1천만/10년',
  '사위': '1천만/10년',
  '부모': '5천만/10년',
  '기타': '1천만/10년',
};

// ── 포매터 ────────────────────────────────────────────────────
function fmt(n: number, d = 1) {
  if (n === 0) return '0억';
  return (Math.round(n * Math.pow(10, d)) / Math.pow(10, d)).toLocaleString('ko-KR') + '억';
}
function fmtPct(n: number) {
  return n.toFixed(1) + '%';
}

// ── 빈 폼 ────────────────────────────────────────────────────
const EMPTY = {
  asset_id: '', from_member_id: '', to_member_id: '',
  transfer_type: '증여(생전)' as TransferType,
  transfer_pct: 100, year_offset: 1,
  priority: '중기', notes: '',
};

type MainTab = 'plans' | 'distribute';
type WizardStep = 1 | 2 | 3;

// ── 메인 페이지 ───────────────────────────────────────────────
export default function PlanPage() {
  const [plans, setPlans]     = useState<TransferPlan[]>([]);
  const [assets, setAssets]   = useState<Asset[]>([]);
  const [members, setMembers] = useState<FamilyMember[]>([]);
  const [macro, setMacro]     = useState<MacroSettings | null>(null);
  const [form, setForm]       = useState({ ...EMPTY });
  const [editing, setEditing] = useState<string | null>(null);
  const [open, setOpen]       = useState(false);
  const [saving, setSaving]   = useState(false);
  const [loading, setLoading] = useState(true);
  const [familyId, setFamilyId] = useState<string | null>(null);
  const [mainTab, setMainTab] = useState<MainTab>('plans');
  const supabase = createClient();

  useEffect(() => { load(); }, []);

  async function load() {
    const { data: p } = await supabase.from('profiles').select('family_id').single();
    if (!p?.family_id) { setLoading(false); return; }
    setFamilyId(p.family_id);
    const [{ data: pl }, { data: a }, { data: m }, { data: ms }] = await Promise.all([
      supabase
        .from('transfer_plans')
        .select('*, asset:assets(*), from_member:family_members!from_member_id(*), to_member:family_members!to_member_id(*)')
        .eq('family_id', p.family_id)
        .order('year_offset'),
      supabase.from('assets').select('*').eq('family_id', p.family_id),
      supabase.from('family_members').select('*').eq('family_id', p.family_id),
      supabase.from('macro_settings').select('*').eq('family_id', p.family_id).single(),
    ]);
    setPlans((pl as TransferPlan[]) || []);
    setAssets(a || []);
    setMembers(m || []);
    setMacro(ms || null);
    setLoading(false);
  }

  function estimateTax(f: typeof form): number {
    const asset    = assets.find(a => a.id === f.asset_id);
    const toMember = members.find(m => m.id === f.to_member_id);
    if (!asset || !toMember) return 0;
    const transferValue = asset.current_value * (f.transfer_pct / 100);
    if (f.transfer_type === '증여(생전)' || f.transfer_type === '지분증여') {
      return calcGiftTax(transferValue, toMember.relation);
    }
    if (f.transfer_type === '세대생략증여') {
      return calcGiftTax(transferValue, toMember.relation, 0, true);
    }
    if (f.transfer_type === '매각후분배') {
      return calcCapitalGainsTax({ ...asset, current_value: transferValue });
    }
    return 0;
  }

  function openNew() { setForm({ ...EMPTY }); setEditing(null); setOpen(true); }
  function openEdit(pl: TransferPlan) {
    setForm({
      asset_id: pl.asset_id || '', from_member_id: pl.from_member_id || '',
      to_member_id: pl.to_member_id || '', transfer_type: pl.transfer_type,
      transfer_pct: pl.transfer_pct, year_offset: pl.year_offset,
      priority: pl.priority, notes: pl.notes || '',
    });
    setEditing(pl.id); setOpen(true);
  }

  async function save() {
    if (!familyId) return;
    setSaving(true);
    const estimated_tax = estimateTax(form);
    const payload = {
      family_id: familyId,
      asset_id: form.asset_id || null,
      from_member_id: form.from_member_id || null,
      to_member_id: form.to_member_id || null,
      transfer_type: form.transfer_type,
      transfer_pct: form.transfer_pct,
      year_offset: form.year_offset,
      priority: form.priority,
      estimated_tax,
      notes: form.notes,
    };
    if (editing) {
      await supabase.from('transfer_plans').update({ ...payload, updated_at: new Date().toISOString() }).eq('id', editing);
    } else {
      await supabase.from('transfer_plans').insert(payload);
    }
    await load(); setOpen(false); setSaving(false);
  }

  async function del(id: string) {
    if (!confirm('삭제하시겠습니까?')) return;
    await supabase.from('transfer_plans').delete().eq('id', id);
    setPlans(pl => pl.filter(x => x.id !== id));
  }

  async function addStrategyActions(actions: StrategyAction[]) {
    if (!familyId) return;
    const selfMember = members.find(m => m.relation === '본인');
    const rows = actions.map(a => ({
      family_id: familyId,
      asset_id: a.assetId,
      from_member_id: selfMember?.id ?? null,
      to_member_id: a.recipientId,
      transfer_type: '증여(생전)' as TransferType,
      transfer_pct: Math.round(a.transferPct * 10) / 10,
      year_offset: a.yearOffset,
      priority: a.yearOffset === 0 ? '즉시' : a.yearOffset <= 1 ? '단기' : a.yearOffset <= 5 ? '중기' : '장기',
      estimated_tax: a.giftTax,
      notes: `배분 설계 자동 생성 · ${a.carryOverWarning ? '⚠ 5년 내 매각 시 이월과세 주의' : ''}`,
    }));
    await supabase.from('transfer_plans').insert(rows);
    await load();
    setMainTab('plans');
  }

  const totalEstimatedTax = plans.reduce((s, p) => s + (p.estimated_tax || 0), 0);
  const grouped = plans.reduce<Record<number, TransferPlan[]>>((acc, p) => {
    (acc[p.year_offset] ??= []).push(p); return acc;
  }, {});

  if (loading) return <div className="p-8 text-sm text-gray-400">로딩 중...</div>;

  return (
    <div className="p-8 max-w-5xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">이전 계획</h1>
          <p className="text-sm text-gray-500 mt-1">자산별 이전 전략 설계 및 세금 추정</p>
        </div>
        {mainTab === 'plans' && (
          <button onClick={openNew} className="btn-primary">+ 계획 추가</button>
        )}
      </div>

      {/* 탭 */}
      <div className="flex gap-1 bg-gray-100 rounded-xl p-1 mb-6 w-fit">
        {([
          ['plans', '이전 계획'],
          ['distribute', '배분 설계'],
        ] as [MainTab, string][]).map(([t, label]) => (
          <button key={t} onClick={() => setMainTab(t)}
            className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              mainTab === t ? 'bg-white text-blue-700 shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}>
            {label}
          </button>
        ))}
      </div>

      {/* ── 탭 1: 이전 계획 CRUD ── */}
      {mainTab === 'plans' && (
        <>
          {plans.length > 0 && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
              {([
                ['총 계획 수',     `${plans.length}건`,             'text-blue-700'],
                ['예상 세금 합계', fmt(totalEstimatedTax),          'text-red-600'],
                ['즉시/단기',      `${plans.filter(p => ['즉시','단기'].includes(p.priority)).length}건`, 'text-orange-600'],
                ['이전 자산 수',   `${new Set(plans.map(p => p.asset_id).filter(Boolean)).size}개`, 'text-gray-700'],
              ] as [string, string, string][]).map(([label, val, color]) => (
                <div key={label} className="metric-card">
                  <div className="text-xs text-gray-500 mb-1">{label}</div>
                  <div className={`text-xl font-bold ${color}`}>{val}</div>
                </div>
              ))}
            </div>
          )}

          {plans.length === 0 ? (
            <div className="card text-center py-16">
              <div className="text-4xl mb-4">📋</div>
              <p className="text-gray-500 text-sm mb-4">이전 계획을 추가해 세금을 미리 파악하세요</p>
              <div className="flex gap-2 justify-center">
                <button onClick={openNew} className="btn-primary">계획 직접 추가</button>
                <button onClick={() => setMainTab('distribute')} className="btn-secondary">배분 설계 마법사</button>
              </div>
            </div>
          ) : (
            <div className="space-y-6">
              {Object.entries(grouped).sort(([a], [b]) => +a - +b).map(([yr, items]) => (
                <div key={yr}>
                  <div className="flex items-center gap-3 mb-3">
                    <div className="w-8 h-8 bg-blue-600 rounded-full flex items-center justify-center text-white text-xs font-bold">
                      {yr}
                    </div>
                    <div className="text-sm font-semibold text-gray-700">
                      {yr === '0' ? '즉시' : `${yr}년 후`}
                    </div>
                    <div className="flex-1 h-px bg-gray-200" />
                    <div className="text-xs text-gray-400">
                      예상 세금 {fmt(items.reduce((s, p) => s + (p.estimated_tax || 0), 0))}
                    </div>
                  </div>
                  <div className="space-y-2 ml-10">
                    {items.map(pl => {
                      const asset = pl.asset as Asset | undefined;
                      const from  = pl.from_member as FamilyMember | undefined;
                      const to    = pl.to_member as FamilyMember | undefined;
                      return (
                        <div key={pl.id} className="card hover:border-blue-200 transition-all">
                          <div className="flex items-start justify-between">
                            <div className="flex items-start gap-3">
                              <div>
                                <div className="flex items-center gap-2 mb-1">
                                  <span className="text-sm font-semibold text-gray-900">
                                    {asset?.name || '자산 미지정'}
                                  </span>
                                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${PRIORITY_COLORS[pl.priority] || 'bg-gray-100 text-gray-600'}`}>
                                    {pl.priority}
                                  </span>
                                  <span className="text-xs bg-blue-50 text-blue-700 px-2 py-0.5 rounded-full">
                                    {pl.transfer_type}
                                  </span>
                                </div>
                                <div className="text-xs text-gray-500">
                                  {from?.name || '?'} → {to?.name || '?'}
                                  {pl.transfer_pct < 100 && ` · ${pl.transfer_pct}% 이전`}
                                  {asset && ` · ${fmt(asset.current_value * pl.transfer_pct / 100)}`}
                                </div>
                                <div className="text-xs text-gray-400 mt-1">{TYPE_DESC[pl.transfer_type]}</div>
                              </div>
                            </div>
                            <div className="flex items-center gap-3">
                              {pl.estimated_tax != null && pl.estimated_tax > 0 && (
                                <div className="text-right">
                                  <div className="text-xs text-gray-400">예상 세금</div>
                                  <div className="text-sm font-semibold text-red-600">{fmt(pl.estimated_tax)}</div>
                                </div>
                              )}
                              <div className="flex gap-1.5">
                                <button onClick={() => openEdit(pl)} className="text-xs text-blue-600 hover:underline">수정</button>
                                <button onClick={() => del(pl.id)} className="text-xs text-red-400 hover:underline">삭제</button>
                              </div>
                            </div>
                          </div>
                          {pl.notes && (
                            <div className="mt-2 text-xs text-gray-400 bg-gray-50 rounded-lg px-3 py-1.5">{pl.notes}</div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* ── 탭 2: 배분 설계 마법사 ── */}
      {mainTab === 'distribute' && (
        <DistributeWizard
          assets={assets}
          members={members}
          macro={macro}
          onAddPlans={addStrategyActions}
        />
      )}

      {/* 계획 추가/수정 모달 */}
      {open && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl w-full max-w-lg shadow-xl">
            <div className="p-5 border-b border-gray-100">
              <h2 className="font-semibold text-gray-900">{editing ? '계획 수정' : '이전 계획 추가'}</h2>
            </div>
            <div className="p-5 space-y-3 max-h-[70vh] overflow-y-auto">
              <div>
                <label className="label">대상 자산</label>
                <select className="select" value={form.asset_id} onChange={e => setForm({...form, asset_id: e.target.value})}>
                  <option value="">자산 선택</option>
                  {assets.map(a => <option key={a.id} value={a.id}>{a.name} ({fmt(a.current_value)})</option>)}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">보내는 사람</label>
                  <select className="select" value={form.from_member_id} onChange={e => setForm({...form, from_member_id: e.target.value})}>
                    <option value="">선택</option>
                    {members.map(m => <option key={m.id} value={m.id}>{m.name} ({m.relation})</option>)}
                  </select>
                </div>
                <div>
                  <label className="label">받는 사람</label>
                  <select className="select" value={form.to_member_id} onChange={e => setForm({...form, to_member_id: e.target.value})}>
                    <option value="">선택</option>
                    {members.map(m => <option key={m.id} value={m.id}>{m.name} ({m.relation})</option>)}
                  </select>
                </div>
              </div>
              <div>
                <label className="label">이전 방법</label>
                <select className="select" value={form.transfer_type} onChange={e => setForm({...form, transfer_type: e.target.value as TransferType})}>
                  {TRANSFER_TYPES.map(t => <option key={t}>{t}</option>)}
                </select>
                <p className="text-xs text-gray-400 mt-1">{TYPE_DESC[form.transfer_type]}</p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">이전 비율 (%)</label>
                  <input type="number" step="1" min="1" max="100" className="input" value={form.transfer_pct}
                    onChange={e => setForm({...form, transfer_pct: +e.target.value})} />
                </div>
                <div>
                  <label className="label">실행 시점 (몇 년 후)</label>
                  <input type="number" step="1" min="0" className="input" value={form.year_offset}
                    onChange={e => setForm({...form, year_offset: +e.target.value})} />
                </div>
              </div>
              <div>
                <label className="label">우선순위</label>
                <select className="select" value={form.priority} onChange={e => setForm({...form, priority: e.target.value})}>
                  {['즉시','단기','중기','장기'].map(p => <option key={p}>{p}</option>)}
                </select>
              </div>

              {form.asset_id && form.to_member_id && (
                <div className="bg-red-50 border border-red-100 rounded-xl p-3">
                  <div className="text-xs text-gray-500">예상 세금 (자동계산)</div>
                  <div className="text-lg font-bold text-red-600">{fmt(estimateTax(form))}</div>
                </div>
              )}

              <div>
                <label className="label">메모</label>
                <textarea className="input resize-none h-16" placeholder="특이사항"
                  value={form.notes} onChange={e => setForm({...form, notes: e.target.value})} />
              </div>
            </div>
            <div className="p-5 border-t border-gray-100 flex gap-2 justify-end">
              <button onClick={() => setOpen(false)} className="btn-secondary">취소</button>
              <button onClick={save} disabled={saving} className="btn-primary">
                {saving ? '저장 중...' : '저장'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── 배분 설계 마법사 ──────────────────────────────────────────
function DistributeWizard({
  assets,
  members,
  macro,
  onAddPlans,
}: {
  assets: Asset[];
  members: FamilyMember[];
  macro: MacroSettings | null;
  onAddPlans: (actions: StrategyAction[]) => Promise<void>;
}) {
  const [step, setStep] = useState<WizardStep>(1);
  const [selectedAssetIds, setSelectedAssetIds] = useState<Set<string>>(new Set());
  const [selectedRecipientIds, setSelectedRecipientIds] = useState<Set<string>>(new Set());
  const [strategies, setStrategies] = useState<FamilyDistributionStrategy[]>([]);
  const [addingId, setAddingId] = useState<string | null>(null);

  // 본인 제외 수증 가능 멤버
  const recipientMembers = members.filter(m => m.relation !== '본인');
  const selectedAssets = assets.filter(a => selectedAssetIds.has(a.id));
  const selectedRecipients = recipientMembers.filter(m => selectedRecipientIds.has(m.id));

  function toggleAsset(id: string) {
    setSelectedAssetIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }
  function toggleRecipient(id: string) {
    setSelectedRecipientIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function goStep2() {
    if (selectedAssetIds.size === 0) return;
    setStep(2);
  }

  function generateStrategies() {
    if (selectedRecipientIds.size === 0) return;
    const result = generateDistributionStrategies(
      selectedAssets,
      selectedRecipients,
      macro,
      members,
    );
    setStrategies(result);
    setStep(3);
  }

  async function handleAddStrategy(strategy: FamilyDistributionStrategy) {
    setAddingId(strategy.id);
    await onAddPlans(strategy.actions);
    setAddingId(null);
  }

  // 자산 시세차익률
  function gainPct(asset: Asset): number {
    if (asset.acquisition_cost <= 0) return 0;
    return ((asset.current_value - asset.acquisition_cost) / asset.acquisition_cost) * 100;
  }

  return (
    <div className="space-y-6">
      {/* 스텝 인디케이터 */}
      <div className="flex items-center gap-2">
        {([
          [1, '자산 선택'],
          [2, '수증자 선택'],
          [3, '전략 비교'],
        ] as [WizardStep, string][]).map(([s, label], idx) => (
          <div key={s} className="flex items-center gap-2">
            {idx > 0 && <div className="w-8 h-px bg-gray-300" />}
            <div className={`flex items-center gap-2 ${step === s ? 'text-blue-700' : step > s ? 'text-green-600' : 'text-gray-400'}`}>
              <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold border-2 ${
                step === s ? 'border-blue-600 bg-blue-600 text-white'
                : step > s ? 'border-green-500 bg-green-500 text-white'
                : 'border-gray-300 text-gray-400'
              }`}>
                {step > s ? '✓' : s}
              </div>
              <span className="text-sm font-medium">{label}</span>
            </div>
          </div>
        ))}
      </div>

      {/* ── Step 1: 자산 선택 ── */}
      {step === 1 && (
        <div>
          <h2 className="text-lg font-semibold text-gray-900 mb-1">이전할 자산을 선택하세요</h2>
          <p className="text-sm text-gray-500 mb-4">여러 자산을 동시에 선택할 수 있습니다.</p>

          {assets.length === 0 ? (
            <div className="card text-center py-10 text-gray-400 text-sm">
              등록된 자산이 없습니다. 자산을 먼저 등록해 주세요.
            </div>
          ) : (
            <div className="space-y-2">
              {assets.map(asset => {
                const gp = gainPct(asset);
                const isSelected = selectedAssetIds.has(asset.id);
                return (
                  <button
                    key={asset.id}
                    onClick={() => toggleAsset(asset.id)}
                    className={`w-full text-left rounded-xl border-2 p-4 transition-all ${
                      isSelected ? 'border-blue-500 bg-blue-50' : 'border-gray-200 bg-white hover:border-blue-200'
                    }`}>
                    <div className="flex items-center gap-3">
                      <div className={`w-5 h-5 rounded border-2 flex items-center justify-center flex-shrink-0 ${
                        isSelected ? 'bg-blue-600 border-blue-600' : 'border-gray-300'
                      }`}>
                        {isSelected && <span className="text-white text-xs font-bold">✓</span>}
                      </div>
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-0.5">
                          <span className="text-sm font-semibold text-gray-900">{asset.name}</span>
                          <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded">{asset.asset_type}</span>
                        </div>
                        <div className="text-xs text-gray-500">
                          현재가 <span className="font-medium text-gray-800">{fmt(asset.current_value)}</span>
                          {' · '}
                          취득가 <span className="font-medium">{fmt(asset.acquisition_cost)}</span>
                          {' · '}
                          시세차익
                          <span className={`font-medium ml-1 ${gp >= 0 ? 'text-red-600' : 'text-blue-600'}`}>
                            {gp >= 0 ? '+' : ''}{gp.toFixed(1)}%
                          </span>
                        </div>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          <div className="flex justify-between items-center mt-6">
            <span className="text-sm text-gray-500">{selectedAssetIds.size}개 선택됨</span>
            <button
              onClick={goStep2}
              disabled={selectedAssetIds.size === 0}
              className="btn-primary disabled:opacity-40 disabled:cursor-not-allowed">
              다음 →
            </button>
          </div>
        </div>
      )}

      {/* ── Step 2: 수증자 선택 ── */}
      {step === 2 && (
        <div>
          <h2 className="text-lg font-semibold text-gray-900 mb-1">수증자(받는 사람)를 선택하세요</h2>
          <p className="text-sm text-gray-500 mb-4">가족 중 자산을 받을 분들을 모두 선택해 주세요.</p>

          {recipientMembers.length === 0 ? (
            <div className="card text-center py-10 text-gray-400 text-sm">
              가족 구성원을 먼저 등록해 주세요.
            </div>
          ) : (
            <div className="space-y-2">
              {recipientMembers.map(member => {
                const isSelected = selectedRecipientIds.has(member.id);
                const dedDisplay = DEDUCTION_DISPLAY[member.relation] ?? '1천만/10년';
                return (
                  <button
                    key={member.id}
                    onClick={() => toggleRecipient(member.id)}
                    className={`w-full text-left rounded-xl border-2 p-4 transition-all ${
                      isSelected ? 'border-blue-500 bg-blue-50' : 'border-gray-200 bg-white hover:border-blue-200'
                    }`}>
                    <div className="flex items-center gap-3">
                      <div className={`w-5 h-5 rounded border-2 flex items-center justify-center flex-shrink-0 ${
                        isSelected ? 'bg-blue-600 border-blue-600' : 'border-gray-300'
                      }`}>
                        {isSelected && <span className="text-white text-xs font-bold">✓</span>}
                      </div>
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-0.5">
                          <span className="text-sm font-semibold text-gray-900">{member.name}</span>
                          <span className="text-xs bg-purple-50 text-purple-700 px-2 py-0.5 rounded">{member.relation}</span>
                          <span className="text-xs text-gray-400">{member.age}세</span>
                          {member.relation === '손자녀' && (
                            <span className="text-xs bg-orange-50 text-orange-600 px-2 py-0.5 rounded">세대생략 30% 할증</span>
                          )}
                        </div>
                        <div className="text-xs text-gray-400">
                          10년 증여공제 한도: <span className="font-medium text-gray-600">{dedDisplay}</span>
                        </div>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          <div className="flex justify-between items-center mt-6">
            <button onClick={() => setStep(1)} className="btn-secondary">← 이전</button>
            <div className="flex items-center gap-3">
              <span className="text-sm text-gray-500">{selectedRecipientIds.size}명 선택됨</span>
              <button
                onClick={generateStrategies}
                disabled={selectedRecipientIds.size === 0}
                className="btn-primary disabled:opacity-40 disabled:cursor-not-allowed">
                전략 생성
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Step 3: 전략 비교 ── */}
      {step === 3 && (
        <div>
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-lg font-semibold text-gray-900">4가지 배분 전략 비교</h2>
              <p className="text-sm text-gray-500">
                자산 {selectedAssets.length}개 · 수증자 {selectedRecipients.length}명 기준
              </p>
            </div>
            <button onClick={() => setStep(2)} className="btn-secondary text-sm">← 수정</button>
          </div>

          <div className="space-y-6">
            {strategies.map(strategy => (
              <StrategyCard
                key={strategy.id}
                strategy={strategy}
                isAdding={addingId === strategy.id}
                onAdd={() => handleAddStrategy(strategy)}
              />
            ))}
          </div>

          <div className="mt-6 text-xs text-gray-400 text-center">
            * 세금 계산은 단순화된 추정치입니다. 실제 집행 전 세무사 확인이 필요합니다.
          </div>
        </div>
      )}
    </div>
  );
}

// ── 전략 카드 컴포넌트 ────────────────────────────────────────
function StrategyCard({
  strategy,
  isAdding,
  onAdd,
}: {
  strategy: FamilyDistributionStrategy;
  isAdding: boolean;
  onAdd: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasCarryOverWarning = strategy.actions.some(a => a.carryOverWarning);

  return (
    <div className={`rounded-2xl border-2 overflow-hidden ${
      strategy.isRecommended ? 'border-blue-400' : 'border-gray-200'
    }`}>
      {/* 헤더 */}
      <div className={`px-5 py-4 ${strategy.isRecommended ? 'bg-blue-50' : 'bg-gray-50'}`}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <h3 className="text-base font-bold text-gray-900">{strategy.label}</h3>
              {strategy.isRecommended && (
                <span className="text-xs bg-blue-600 text-white px-2 py-0.5 rounded-full font-medium">추천</span>
              )}
            </div>
            <p className="text-sm text-gray-500">{strategy.tagline}</p>
          </div>
          <button
            onClick={() => setExpanded(e => !e)}
            className="text-xs text-blue-600 border border-blue-200 rounded-lg px-3 py-1.5 hover:bg-blue-50 flex-shrink-0">
            {expanded ? '접기' : '상세보기'}
          </button>
        </div>
      </div>

      <div className="px-5 py-4 bg-white">
        {/* 핵심 지표 */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
          <div className="bg-gray-50 rounded-xl p-3">
            <div className="text-xs text-gray-500 mb-0.5">증여세 합계</div>
            <div className="text-base font-bold text-red-600">
              {strategy.totalGiftTax > 0 ? fmt(strategy.totalGiftTax) : '없음'}
            </div>
          </div>
          <div className="bg-gray-50 rounded-xl p-3">
            <div className="text-xs text-gray-500 mb-0.5">5년 보유 후 실수령</div>
            <div className="text-base font-bold text-green-600">{fmt(strategy.netToFamilyGiftHold)}</div>
          </div>
          <div className="bg-gray-50 rounded-xl p-3">
            <div className="text-xs text-gray-500 mb-0.5">즉시 매각 총 세금</div>
            <div className="text-base font-bold text-orange-600">{fmt(strategy.cgtSellImmediately)}</div>
          </div>
          <div className="bg-gray-50 rounded-xl p-3">
            <div className="text-xs text-gray-500 mb-0.5">상속 유지 시 (10년 후)</div>
            <div className="text-base font-bold text-gray-600">{fmt(strategy.inheritanceAlt)}</div>
          </div>
        </div>

        {/* 이월과세 경고 */}
        {hasCarryOverWarning && strategy.actions.length > 0 && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-3 mb-4">
            <div className="text-sm font-semibold text-red-700 mb-2">이월과세 주의 (소득세법 §97의2)</div>
            {strategy.actions.filter(a => a.carryOverWarning).map((a, idx) => (
              <div key={idx} className="text-xs text-red-600 mb-1">
                <span className="font-medium">{a.assetName}</span>({a.recipientName})
                {' — '}5년 내 매각 시 원취득가({fmt(a.originalCost)}) 기준 양도세{' '}
                <span className="font-bold">{fmt(a.cgtIfImmediateSale)}</span> 발생.
                5년 이상 보유 시 <span className="font-bold">{fmt(a.cgtIf5yrHoldSale)}</span>으로 절감.
              </div>
            ))}
          </div>
        )}

        {/* 배분 액션 테이블 */}
        {strategy.actions.length > 0 && (
          <div className="mb-4">
            <div className="text-xs font-semibold text-gray-500 mb-2">배분 내역</div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-gray-100">
                    <th className="text-left py-2 pr-3 text-gray-500 font-medium">자산명</th>
                    <th className="text-left py-2 pr-3 text-gray-500 font-medium">수증자</th>
                    <th className="text-right py-2 pr-3 text-gray-500 font-medium">이전가치</th>
                    <th className="text-right py-2 pr-3 text-gray-500 font-medium">비율</th>
                    <th className="text-right py-2 pr-3 text-gray-500 font-medium">시점</th>
                    <th className="text-right py-2 pr-3 text-gray-500 font-medium">증여세</th>
                    <th className="text-center py-2 text-gray-500 font-medium">이월과세</th>
                  </tr>
                </thead>
                <tbody>
                  {strategy.actions.map((action, idx) => (
                    <tr key={idx} className="border-b border-gray-50 hover:bg-gray-50">
                      <td className="py-2 pr-3 font-medium text-gray-800">{action.assetName}</td>
                      <td className="py-2 pr-3 text-gray-600">
                        {action.recipientName}
                        <span className="text-gray-400 ml-1">({action.recipientRelation})</span>
                      </td>
                      <td className="py-2 pr-3 text-right text-gray-800">{fmt(action.giftValue)}</td>
                      <td className="py-2 pr-3 text-right text-gray-600">{action.transferPct.toFixed(1)}%</td>
                      <td className="py-2 pr-3 text-right text-gray-600">
                        {action.yearOffset === 0 ? '즉시' : `${action.yearOffset}년 후`}
                      </td>
                      <td className="py-2 pr-3 text-right font-medium text-red-600">
                        {action.giftTax > 0 ? fmt(action.giftTax) : '없음'}
                      </td>
                      <td className="py-2 text-center">
                        {action.carryOverWarning
                          ? <span className="text-red-500 font-bold">⚠</span>
                          : <span className="text-green-500">✓</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* 장단점 */}
        {expanded && (
          <div className="space-y-3 mb-4">
            <div>
              <div className="text-xs font-semibold text-green-700 mb-1">장점</div>
              <ul className="space-y-1">
                {strategy.pros.map((p, i) => (
                  <li key={i} className="text-xs text-gray-600 flex items-start gap-1.5">
                    <span className="text-green-500 flex-shrink-0 mt-0.5">+</span>{p}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <div className="text-xs font-semibold text-red-700 mb-1">주의사항</div>
              <ul className="space-y-1">
                {strategy.cons.map((c, i) => (
                  <li key={i} className="text-xs text-gray-600 flex items-start gap-1.5">
                    <span className="text-red-400 flex-shrink-0 mt-0.5">-</span>{c}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <div className="text-xs font-semibold text-blue-700 mb-1">적용 법규</div>
              <ul className="space-y-1">
                {strategy.keyRules.map((r, i) => (
                  <li key={i} className="text-xs text-gray-500 flex items-start gap-1.5">
                    <span className="text-blue-400 flex-shrink-0 mt-0.5">§</span>{r}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}

        {/* 전략 추가 버튼 */}
        {strategy.actions.length > 0 && (
          <button
            onClick={onAdd}
            disabled={isAdding}
            className="w-full btn-primary disabled:opacity-50 disabled:cursor-not-allowed">
            {isAdding ? '저장 중...' : '이 전략으로 계획 추가'}
          </button>
        )}
        {strategy.actions.length === 0 && (
          <div className="text-center text-sm text-gray-400 py-2">
            이 전략은 증여 없이 상속 유지 — 별도 계획이 생성되지 않습니다.
          </div>
        )}
      </div>
    </div>
  );
}

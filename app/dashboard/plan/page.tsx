'use client';
import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase';
import { Asset, FamilyMember, MacroSettings, TransferPlan, TransferType } from '@/types';
import {
  calcGiftTax, calcCapitalGainsTax,
  recommendFamilyDistribution,
  AssetDistributionRec, FamilyGroupUnit,
} from '@/lib/tax';

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

function fmt(n: number, d = 1) {
  return n ? (Math.round(n * Math.pow(10, d)) / Math.pow(10, d)).toLocaleString('ko-KR') + '억' : '0억';
}
function fmtPct(n: number) {
  return n.toFixed(1) + '%';
}

const EMPTY = {
  asset_id: '', from_member_id: '', to_member_id: '',
  transfer_type: '증여(생전)' as TransferType,
  transfer_pct: 100, year_offset: 1,
  priority: '중기', notes: '',
};

type Tab = 'plans' | 'smart';

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
  const [tab, setTab]         = useState<Tab>('plans');
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
  function prefillFromRec(rec: AssetDistributionRec) {
    const toMember = members.find(m => m.id === rec.targetGroupId);
    setForm({
      asset_id: rec.assetId,
      from_member_id: members.find(m => m.relation === '본인')?.id || '',
      to_member_id: toMember?.id || '',
      transfer_type: rec.transferType,
      transfer_pct: rec.transferPct,
      year_offset: rec.yearOffset,
      priority: rec.yearOffset === 0 ? '즉시' : rec.yearOffset <= 1 ? '단기' : rec.yearOffset <= 3 ? '중기' : '장기',
      notes: rec.rationale,
    });
    setEditing(null);
    setOpen(true);
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

  const totalEstimatedTax = plans.reduce((s, p) => s + (p.estimated_tax || 0), 0);
  const grouped = plans.reduce<Record<number, TransferPlan[]>>((acc, p) => {
    (acc[p.year_offset] ??= []).push(p); return acc;
  }, {});

  // 스마트 배분 계산
  const distPlan = assets.length > 0 && members.length > 0
    ? recommendFamilyDistribution(assets, members, macro || undefined)
    : null;

  if (loading) return <div className="p-8 text-sm text-gray-400">로딩 중...</div>;

  return (
    <div className="p-8 max-w-4xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">이전 계획</h1>
          <p className="text-sm text-gray-500 mt-1">자산별 이전 전략 설계 및 세금 추정</p>
        </div>
        <button onClick={openNew} className="btn-primary">+ 계획 추가</button>
      </div>

      {/* 탭 */}
      <div className="flex gap-1 bg-gray-100 rounded-xl p-1 mb-6 w-fit">
        {([['plans', '📋 이전 계획'], ['smart', '💡 스마트 배분 추천']] as [Tab, string][]).map(([t, label]) => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              tab === t ? 'bg-white text-blue-700 shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}>
            {label}
          </button>
        ))}
      </div>

      {/* ── 탭 1: 기존 이전 계획 ── */}
      {tab === 'plans' && (
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
                <button onClick={() => setTab('smart')} className="btn-secondary">💡 AI 배분 추천 보기</button>
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

      {/* ── 탭 2: 스마트 배분 추천 ── */}
      {tab === 'smart' && (
        <SmartDistributionPanel
          distPlan={distPlan}
          assets={assets}
          members={members}
          onAddPlan={prefillFromRec}
        />
      )}

      {/* 모달 */}
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

// ── 스마트 배분 패널 ─────────────────────────────────────────
function SmartDistributionPanel({
  distPlan,
  assets,
  members,
  onAddPlan,
}: {
  distPlan: ReturnType<typeof recommendFamilyDistribution> | null;
  assets: Asset[];
  members: FamilyMember[];
  onAddPlan: (rec: AssetDistributionRec) => void;
}) {
  const [selectedGroup, setSelectedGroup] = useState<string | null>(null);

  if (!distPlan || assets.length === 0) {
    return (
      <div className="card text-center py-16 text-gray-400">
        <div className="text-4xl mb-3">🏠</div>
        <p className="text-sm">자산과 가족 구성원을 등록하면 AI 배분 추천이 생성됩니다</p>
      </div>
    );
  }

  if (distPlan.groups.length === 0) {
    return (
      <div className="card text-center py-12 text-gray-400">
        <div className="text-3xl mb-3">👨‍👩‍👧‍👦</div>
        <p className="text-sm">자녀·손자녀를 가족 구성원으로 등록하면 배분 추천이 생성됩니다</p>
      </div>
    );
  }

  const activeRecs = selectedGroup
    ? distPlan.recommendations.filter(r => r.targetGroupId === selectedGroup)
    : distPlan.recommendations;

  const totalAssetValue = distPlan.totalAssetValue;
  const fmt2 = (n: number) => (Math.round(n * 10) / 10).toLocaleString('ko-KR') + '억';

  return (
    <div className="space-y-5">
      {/* 배분 요약 */}
      <div className="card bg-gradient-to-br from-blue-50 to-indigo-50 border-blue-200">
        <div className="text-sm font-semibold text-blue-800 mb-3">AI 자산 배분 추천 요약</div>
        <div className="grid grid-cols-3 gap-4 mb-3">
          <div>
            <div className="text-xs text-blue-600">총 배분 자산</div>
            <div className="text-lg font-bold text-blue-900">{fmt2(totalAssetValue)}</div>
          </div>
          <div>
            <div className="text-xs text-blue-600">예상 총 세금</div>
            <div className="text-lg font-bold text-red-700">{fmt2(distPlan.totalTax)}</div>
          </div>
          <div>
            <div className="text-xs text-blue-600">실효세율</div>
            <div className="text-lg font-bold text-gray-800">{fmtPct(distPlan.effectiveTaxPct)}</div>
          </div>
        </div>
        <div className="text-xs text-blue-600 bg-blue-100 rounded-lg px-3 py-2">
          ※ 각 수증자의 10년 내 기수증 금액 0 가정. 실제 계획 수립 전 사전증여 이력 확인 필요.
        </div>
      </div>

      {/* 가족 그룹 필터 */}
      <div>
        <div className="text-sm font-semibold text-gray-700 mb-3">수증 가족 단위 ({distPlan.groups.length}개)</div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {distPlan.groups.map((grp: FamilyGroupUnit) => {
            const summary = distPlan.groupSummary[grp.id] || { value: 0, tax: 0 };
            const sharePct = totalAssetValue > 0 ? (summary.value / totalAssetValue) * 100 : 0;
            const isActive = selectedGroup === grp.id;
            return (
              <button key={grp.id}
                onClick={() => setSelectedGroup(isActive ? null : grp.id)}
                className={`text-left rounded-xl border-2 p-4 transition-all ${
                  isActive
                    ? 'border-blue-500 bg-blue-50'
                    : 'border-gray-200 bg-white hover:border-blue-200'
                }`}>
                <div className="flex items-start justify-between mb-2">
                  <div>
                    <div className="text-sm font-semibold text-gray-900">{grp.label}</div>
                    <div className="text-xs text-gray-400">{grp.head.relation} · {grp.head.age}세</div>
                  </div>
                  <div className="text-right">
                    <div className="text-sm font-bold text-gray-900">{fmt2(summary.value)}</div>
                    <div className="text-xs text-gray-400">{fmtPct(sharePct)} 배분</div>
                  </div>
                </div>
                {/* 배분 비율 바 */}
                <div className="h-1.5 bg-gray-200 rounded-full overflow-hidden">
                  <div className="h-full bg-blue-500 rounded-full" style={{ width: `${sharePct}%` }} />
                </div>
                <div className="flex justify-between mt-1.5 text-xs text-gray-400">
                  <span>예상 세금 {fmt2(summary.tax)}</span>
                  <span>세율 {summary.value > 0 ? fmtPct((summary.tax / summary.value) * 100) : '0%'}</span>
                </div>
              </button>
            );
          })}
        </div>
        {selectedGroup && (
          <button onClick={() => setSelectedGroup(null)}
            className="mt-2 text-xs text-blue-600 hover:underline">
            전체 보기
          </button>
        )}
      </div>

      {/* 자산별 배분 추천 카드 */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <div className="text-sm font-semibold text-gray-700">
            자산별 배분 추천 ({activeRecs.length}건)
          </div>
          {selectedGroup && (
            <div className="text-xs text-blue-600">
              {distPlan.groups.find((g: FamilyGroupUnit) => g.id === selectedGroup)?.label} 필터
            </div>
          )}
        </div>

        {/* 그룹별로 묶어서 표시 */}
        {(selectedGroup
          ? distPlan.groups.filter((g: FamilyGroupUnit) => g.id === selectedGroup)
          : distPlan.groups
        ).map((grp: FamilyGroupUnit) => {
          const grpRecs = distPlan.recommendations.filter(r => r.targetGroupId === grp.id);
          if (grpRecs.length === 0) return null;
          const grpSummary = distPlan.groupSummary[grp.id] || { value: 0, tax: 0 };
          return (
            <div key={grp.id} className="mb-6">
              <div className="flex items-center gap-2 mb-2">
                <div className="w-2 h-2 rounded-full bg-blue-500" />
                <div className="text-xs font-semibold text-gray-600">{grp.label}</div>
                <div className="text-xs text-gray-400">
                  총 {fmt2(grpSummary.value)} · 세금 {fmt2(grpSummary.tax)}
                </div>
              </div>
              <div className="space-y-2 ml-4">
                {grpRecs.map((rec, idx) => (
                  <RecommendationCard key={idx} rec={rec} onAdd={() => onAddPlan(rec)} />
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {/* 분배 균형 차트 (텍스트) */}
      <div className="card">
        <div className="text-sm font-semibold text-gray-700 mb-3">가족 단위별 배분 현황</div>
        <div className="space-y-2">
          {distPlan.groups.map((grp: FamilyGroupUnit) => {
            const summary = distPlan.groupSummary[grp.id] || { value: 0, tax: 0 };
            const sharePct = totalAssetValue > 0 ? (summary.value / totalAssetValue) * 100 : 0;
            const netValue = summary.value - summary.tax;
            return (
              <div key={grp.id}>
                <div className="flex items-center justify-between text-xs mb-1">
                  <span className="text-gray-600">{grp.label}</span>
                  <div className="flex gap-3">
                    <span className="text-gray-500">세전 {fmt2(summary.value)}</span>
                    <span className="text-red-500">세금 -{fmt2(summary.tax)}</span>
                    <span className="font-semibold text-gray-800">실수령 {fmt2(netValue)}</span>
                  </div>
                </div>
                <div className="flex h-2 bg-gray-100 rounded-full overflow-hidden">
                  <div className="h-full bg-blue-400" style={{ width: `${sharePct}%` }} />
                  <div className="h-full bg-red-300"
                    style={{ width: `${totalAssetValue > 0 ? (summary.tax / totalAssetValue) * 100 : 0}%` }} />
                </div>
              </div>
            );
          })}
        </div>
        <div className="flex gap-4 mt-2 text-xs text-gray-400">
          <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-blue-400 inline-block" /> 배분 자산</span>
          <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-red-300 inline-block" /> 예상 세금</span>
        </div>
      </div>

      <div className="text-xs text-gray-400 text-center">
        * 추천은 균등 배분·세효율 최적화 기반 자동 계산입니다.
          실제 가족 상황(연령·소득·부채)과 기수증 이력을 반영하여 조정하세요.
      </div>
    </div>
  );
}

function RecommendationCard({
  rec,
  onAdd,
}: {
  rec: AssetDistributionRec;
  onAdd: () => void;
}) {
  const yearLabel = rec.yearOffset === 0 ? '즉시' : `${rec.yearOffset}년 후`;
  const priorityLabel = rec.yearOffset === 0 ? '즉시'
    : rec.yearOffset <= 1 ? '단기'
    : rec.yearOffset <= 3 ? '중기' : '장기';
  const priorityColor = PRIORITY_COLORS[priorityLabel] || 'bg-gray-100 text-gray-600';

  return (
    <div className="border border-gray-200 rounded-xl p-3 bg-white hover:border-blue-200 transition-all">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <span className="text-sm font-semibold text-gray-900">{rec.assetName}</span>
            {rec.transferPct < 100 && (
              <span className="text-xs bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded">{rec.transferPct}% 지분</span>
            )}
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${priorityColor}`}>{priorityLabel}</span>
            <span className="text-xs bg-blue-50 text-blue-700 px-2 py-0.5 rounded-full">{rec.transferType}</span>
          </div>
          <div className="text-xs text-gray-500 mb-1">
            이전가치 <span className="font-medium">{(Math.round(rec.assetValue * 10) / 10).toLocaleString('ko-KR')}억</span>
            {' · '}
            예상세금 <span className="font-medium text-red-600">{(Math.round(rec.estimatedTax * 100) / 100).toLocaleString('ko-KR')}억</span>
            {' · '}
            실효세율 <span className="font-medium">{rec.effectiveTaxPct.toFixed(1)}%</span>
            {' · '}
            {yearLabel} 실행
          </div>
          <div className="text-xs text-gray-400">{rec.rationale}</div>
        </div>
        <button onClick={onAdd}
          className="shrink-0 text-xs text-blue-600 border border-blue-200 rounded-lg px-3 py-1.5 hover:bg-blue-50 transition-colors">
          계획 추가
        </button>
      </div>
    </div>
  );
}

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase';
import { Asset, FamilyMember, TransferPlan, TransferType } from '@/types';
import { KynLoader } from '@/app/dashboard/components/KynLoader';
import { StrategyFlowNav } from '@/app/dashboard/components/StrategyFlowNav';
import {
  RECIPIENT_ASSIGNMENT_NOTE,
  isRecipientAssignmentPlan,
} from '@/lib/transfer-plan';

type MainTab = 'summary' | 'assign';

interface AssetAssignmentAction {
  assetId: string;
  recipientIds: string[];
}

function fmt(value: number): string {
  if (!Number.isFinite(value)) return '0억';
  if (Math.abs(value) >= 1) return `${value.toLocaleString('ko-KR', { maximumFractionDigits: 1 })}억`;
  return `${Math.round(value * 10000).toLocaleString('ko-KR')}만원`;
}

export default function PlanPage() {
  const supabase = useMemo(() => createClient(), []);
  const assignmentRef = useRef<HTMLDivElement>(null);
  const [plans, setPlans] = useState<TransferPlan[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [members, setMembers] = useState<FamilyMember[]>([]);
  const [familyId, setFamilyId] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [mainTab, setMainTab] = useState<MainTab>('assign');

  const load = useCallback(async () => {
    setLoading(true);
    const { data: profile } = await supabase.from('profiles').select('family_id').single();
    if (!profile?.family_id) { setLoading(false); return; }
    setFamilyId(profile.family_id);
    const [planResult, assetResult, memberResult] = await Promise.all([
      supabase.from('transfer_plans').select('*').eq('family_id', profile.family_id).order('year_offset', { ascending: true }),
      supabase.from('assets').select('*').eq('family_id', profile.family_id),
      supabase.from('family_members').select('*').eq('family_id', profile.family_id).order('generation', { ascending: true }),
    ]);
    setPlans((planResult.data ?? []) as TransferPlan[]);
    setAssets((assetResult.data ?? []) as Asset[]);
    setMembers((memberResult.data ?? []) as FamilyMember[]);
    setLoading(false);
  }, [supabase]);

  useEffect(() => { void load(); }, [load]);

  const assignmentPlans = useMemo(() => plans.filter(isRecipientAssignmentPlan), [plans]);

  const assignmentsByAsset = useMemo(() => {
    const grouped = new Map<string, TransferPlan[]>();
    assignmentPlans.forEach((plan) => {
      if (!plan.asset_id) return;
      const current = grouped.get(plan.asset_id) ?? [];
      current.push(plan);
      grouped.set(plan.asset_id, current);
    });
    return grouped;
  }, [assignmentPlans]);

  const assignedAssets = useMemo(() => assets.filter((a) => assignmentsByAsset.has(a.id)), [assets, assignmentsByAsset]);
  const assignedRecipientIds = useMemo(() => {
    const ids = assignmentPlans.map((p) => p.to_member_id).filter((id): id is string => Boolean(id));
    return new Set(ids);
  }, [assignmentPlans]);
  const assignedValue = assignedAssets.reduce((s, a) => s + a.current_value, 0);
  const multiRecipientAssetCount = assignedAssets.filter((a) => (assignmentsByAsset.get(a.id)?.length ?? 0) > 1).length;

  const saveAssignments = async (actions: AssetAssignmentAction[]) => {
    if (!familyId || saving) return;
    setSaving(true);
    const affectedAssetIds = new Set(actions.map((a) => a.assetId));
    const replacedPlans = assignmentPlans.filter((p) => p.asset_id && affectedAssetIds.has(p.asset_id));
    const newRows = actions.flatMap((action) => {
      const asset = assets.find((a) => a.id === action.assetId);
      if (!asset || action.recipientIds.length === 0) return [];
      return action.recipientIds.map((recipientId) => ({
        family_id: familyId, asset_id: asset.id,
        from_member_id: asset.owner_member_id, to_member_id: recipientId,
        transfer_type: '상속(사후)' as TransferType,
        transfer_pct: 100 / action.recipientIds.length,
        year_offset: 0, priority: '미정', estimated_tax: 0,
        notes: `${RECIPIENT_ASSIGNMENT_NOTE}: 자산별 수증자 후보 지정`,
      }));
    });
    if (newRows.length > 0) {
      const { error } = await supabase.from('transfer_plans').insert(newRows);
      if (error) { alert(`배정 저장에 실패했습니다: ${error.message}`); setSaving(false); return; }
    }
    if (replacedPlans.length > 0) {
      const { error } = await supabase.from('transfer_plans').delete().in('id', replacedPlans.map((p) => p.id));
      if (error) { alert(`기존 후보 정리에 실패했습니다: ${error.message}`); setSaving(false); await load(); return; }
    }
    await Promise.all(actions.map((action) => {
      const hasActualPlan = plans.some((p) => p.asset_id === action.assetId && !isRecipientAssignmentPlan(p));
      return supabase.from('assets').update({ is_planned_transfer: action.recipientIds.length > 0 || hasActualPlan }).eq('id', action.assetId);
    }));
    setSaving(false);
    await load();
    setMainTab('summary');
    assignmentRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const clearAssetAssignment = async (assetId: string) => {
    if (!confirm('이 자산의 수증자 후보 배정을 해제할까요?')) return;
    const planIds = assignmentPlans.filter((p) => p.asset_id === assetId).map((p) => p.id);
    if (planIds.length > 0) {
      const { error } = await supabase.from('transfer_plans').delete().in('id', planIds);
      if (error) { alert(`배정 해제에 실패했습니다: ${error.message}`); return; }
    }
    const hasActualPlan = plans.some((p) => p.asset_id === assetId && !isRecipientAssignmentPlan(p));
    await supabase.from('assets').update({ is_planned_transfer: hasActualPlan }).eq('id', assetId);
    await load();
  };

  if (loading) return <KynLoader />;

  return (
    <div className="main">
      <StrategyFlowNav active="/dashboard/plan" />
      <div className="page-header">
        <div>
          <div className="crumb">STEP 1 · TRANSFER PLANNING</div>
          <h1 className="page-title" style={{ marginTop: 10 }}>계획 설정</h1>
          <p style={{ margin: '6px 0 0', fontSize: 13.5, color: 'var(--ink-faint)', lineHeight: 1.6 }}>
            자산마다 받을 가족 구성원을 복수로 지정합니다. 구체적인 실행안은 다음 단계인 시나리오 비교에서 최적화합니다.
          </p>
        </div>
      </div>

      <div className="stepbar">
        <div>
          <b>1. 자산별 수증자 후보 지정</b>
          <span>자산을 받을 실제 가족 구성원을 선택합니다. 복수 선택이 가능하며 이 화면에서는 자산과 수증자 후보만 연결합니다.</span>
        </div>
        <Link href="/dashboard/scenarios" className="link" style={{ whiteSpace: 'nowrap' }}>
          배정 완료 후 시나리오 비교로 이동 →
        </Link>
      </div>

      <div ref={assignmentRef} className="segtabs">
        <button type="button" className={'segtab' + (mainTab === 'summary' ? ' active' : '')} onClick={() => setMainTab('summary')}>배정 현황</button>
        <button type="button" className={'segtab' + (mainTab === 'assign' ? ' active' : '')} onClick={() => setMainTab('assign')}>수증자 선택</button>
      </div>

      {mainTab === 'summary' ? (
        <SummaryView
          assignedAssets={assignedAssets} assignmentsByAsset={assignmentsByAsset}
          members={members} assignedValue={assignedValue}
          assignedRecipientIds={assignedRecipientIds} multiRecipientAssetCount={multiRecipientAssetCount}
          onEdit={() => setMainTab('assign')} onClear={clearAssetAssignment}
        />
      ) : (
        <AssetAssignmentDesigner assets={assets} members={members} plans={assignmentPlans} saving={saving} onSave={saveAssignments} />
      )}

      <div className="stepbar" style={{ marginTop: 20 }}>
        <span style={{ fontSize: 12.5, color: 'var(--ink-faint)', lineHeight: 1.7 }}>
          <b style={{ color: 'var(--ink-soft)' }}>계산 기준</b>{'  '}
          이 화면은 가족 구성원 후보만 지정합니다. 후보 배정만으로 증여세·취득세·상속세가 발생한 것으로 계산하지 않으며, 실제 실행안은 시나리오 비교에서 별도로 저장합니다.
        </span>
      </div>
    </div>
  );
}

function SummaryView({
  assignedAssets, assignmentsByAsset, members, assignedValue,
  assignedRecipientIds, multiRecipientAssetCount, onEdit, onClear,
}: {
  assignedAssets: Asset[];
  assignmentsByAsset: Map<string, TransferPlan[]>;
  members: FamilyMember[];
  assignedValue: number;
  assignedRecipientIds: Set<string>;
  multiRecipientAssetCount: number;
  onEdit: () => void;
  onClear: (assetId: string) => Promise<void>;
}) {
  return (
    <div className="card-kyn">
      <div className="card-head">
        <div>
          <div className="crumb" style={{ marginBottom: 8 }}>RECIPIENT ASSIGNMENT</div>
          <div className="t">자산별 수증자 후보
            <span className="sub">이 배정은 최종 증여 지시가 아닙니다. 시나리오 비교가 세금, 취득비용과 현금흐름을 비교해 실행안을 계산합니다.</span>
          </div>
        </div>
        <button type="button" onClick={onEdit}
          style={{ border: '1px solid var(--line-strong)', background: 'var(--bg)', color: 'var(--ink)', padding: '10px 18px', cursor: 'pointer', fontWeight: 600, fontSize: 13, fontFamily: 'var(--sans)' }}>
          배정 수정
        </button>
      </div>
      <div className="mini">
        <div><div className="l">배정 자산</div><div className="n">{assignedAssets.length}건</div></div>
        <div><div className="l">배정 자산가치</div><div className="n">{fmt(assignedValue)}</div></div>
        <div><div className="l">후보 구성원</div><div className="n">{assignedRecipientIds.size}명</div></div>
        <div><div className="l">복수 후보 자산</div><div className="n">{multiRecipientAssetCount}건</div></div>
      </div>
      {assignedAssets.length === 0 ? (
        <div style={{ padding: '56px 24px', textAlign: 'center', color: 'var(--ink-faint)', fontSize: 13.5 }}>
          아직 지정된 수증자 후보가 없습니다.
        </div>
      ) : (
        <div className="planlist">
          {assignedAssets.map((asset) => {
            const assetPlans = assignmentsByAsset.get(asset.id) ?? [];
            const owner = members.find((m) => m.id === asset.owner_member_id);
            return (
              <div key={asset.id} className="prow">
                <div style={{ minWidth: 180 }}>
                  <div style={{ fontWeight: 600, fontSize: 15, color: 'var(--ink)' }}>{asset.name}</div>
                  <div style={{ fontSize: 12, color: 'var(--ink-faint)', marginTop: 3 }}>
                    {owner?.name ?? '소유자 미지정'} · 현재가치 {fmt(asset.current_value)}
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', flex: 1, paddingLeft: 16 }}>
                  <span style={{ fontSize: 12, color: 'var(--ink-faint)' }}>받을 후보</span>
                  {assetPlans.map((plan) => {
                    const recipient = members.find((m) => m.id === plan.to_member_id);
                    return (
                      <span key={plan.id} className="pill gold" style={{ fontSize: 12 }}>
                        {recipient?.name ?? '미지정'}{recipient?.relation ? ` (${recipient.relation})` : ''}
                      </span>
                    );
                  })}
                </div>
                <button type="button" onClick={() => void onClear(asset.id)}
                  style={{ border: '1px solid var(--line)', background: 'var(--bg)', padding: '7px 12px', cursor: 'pointer', color: 'var(--ink-faint)', fontSize: 12.5, fontFamily: 'var(--sans)' }}>
                  해제
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function AssetAssignmentDesigner({
  assets, members, plans, saving, onSave,
}: {
  assets: Asset[];
  members: FamilyMember[];
  plans: TransferPlan[];
  saving: boolean;
  onSave: (actions: AssetAssignmentAction[]) => Promise<void>;
}) {
  const initialSelections = useMemo(() => {
    const next: Record<string, string[]> = {};
    assets.forEach((a) => {
      next[a.id] = plans.filter((p) => p.asset_id === a.id && p.to_member_id).map((p) => p.to_member_id as string);
    });
    return next;
  }, [assets, plans]);

  const [selections, setSelections] = useState<Record<string, string[]>>(initialSelections);
  useEffect(() => { setSelections(initialSelections); }, [initialSelections]);

  const toggleRecipient = (assetId: string, recipientId: string, checked: boolean) => {
    setSelections((cur) => {
      const sel = cur[assetId] ?? [];
      const next = checked ? Array.from(new Set([...sel, recipientId])) : sel.filter((id) => id !== recipientId);
      return { ...cur, [assetId]: next };
    });
  };

  const selectedAssetCount = assets.filter((a) => (selections[a.id]?.length ?? 0) > 0).length;
  const selectedLinkCount = assets.reduce((s, a) => s + (selections[a.id]?.length ?? 0), 0);
  const save = async () => onSave(assets.map((a) => ({ assetId: a.id, recipientIds: selections[a.id] ?? [] })));

  if (assets.length === 0) {
    return (
      <div className="card-kyn" style={{ padding: '56px 24px', textAlign: 'center', color: 'var(--ink-faint)', fontSize: 13.5 }}>
        먼저 자산 목록에 자산을 등록하세요.
      </div>
    );
  }

  return (
    <div>
      <div className="card-kyn">
        <div className="card-head">
          <div>
            <div className="crumb" style={{ marginBottom: 8 }}>ASSET RECIPIENTS</div>
            <div className="t">자산을 받을 가족 구성원을 선택하세요
              <span className="sub">자산별로 한 명 이상을 복수 선택할 수 있습니다. 선택 순서와 무관하며 이 화면은 자산별 수증자 후보만 저장합니다.</span>
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', border: '1px solid var(--line)', minWidth: 200 }}>
            <div style={{ padding: '14px 18px', borderRight: '1px solid var(--line)' }}>
              <div style={{ fontSize: 11.5, color: 'var(--ink-faint)', marginBottom: 5 }}>배정 자산</div>
              <div style={{ fontSize: 22, fontWeight: 600, fontFamily: 'var(--serif)', letterSpacing: '-0.02em' }}>{selectedAssetCount}건</div>
            </div>
            <div style={{ padding: '14px 18px' }}>
              <div style={{ fontSize: 11.5, color: 'var(--ink-faint)', marginBottom: 5 }}>후보 연결</div>
              <div style={{ fontSize: 22, fontWeight: 600, fontFamily: 'var(--serif)', letterSpacing: '-0.02em' }}>{selectedLinkCount}건</div>
            </div>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 14 }}>
        {assets.map((asset) => {
          const owner = members.find((m) => m.id === asset.owner_member_id);
          const candidates = members.filter((m) => m.id !== asset.owner_member_id);
          const selected = selections[asset.id] ?? [];
          return (
            <article key={asset.id} style={{ border: '1px solid var(--line)', background: 'var(--bg)', display: 'grid', gridTemplateColumns: '260px 1fr' }}>
              <div style={{ padding: '20px 22px', borderRight: '1px solid var(--line)', background: 'var(--paper)' }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
                  <div style={{ fontWeight: 600, fontSize: 15.5, color: 'var(--ink)' }}>{asset.name}</div>
                  <span style={{ border: '1px solid var(--line)', color: 'var(--ink-faint)', padding: '3px 6px', fontSize: 10.5, whiteSpace: 'nowrap' }}>{asset.asset_type}</span>
                </div>
                <div style={{ marginTop: 7, color: 'var(--ink-faint)', fontSize: 12.5, lineHeight: 1.7 }}>
                  {owner?.name ?? '소유자 미지정'} 보유<br />현재가치 {fmt(asset.current_value)}
                </div>
                <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--line)', fontSize: 12, fontWeight: 600, color: selected.length > 0 ? 'var(--gold-deep)' : 'var(--red)' }}>
                  {selected.length > 0 ? `${selected.length}명 후보 선택` : '수증자 후보를 선택하세요'}
                </div>
              </div>
              <div style={{ padding: '20px 22px' }}>
                <div style={{ fontSize: 11.5, color: 'var(--ink-faint)', letterSpacing: '0.08em', marginBottom: 13 }}>받을 가족 구성원 · 복수 선택 가능</div>
                {candidates.length === 0 ? (
                  <div style={{ color: 'var(--ink-faint)', fontSize: 13 }}>선택 가능한 가족 구성원이 없습니다.</div>
                ) : (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(155px, 1fr))', gap: 8 }}>
                    {candidates.map((member) => {
                      const checked = selected.includes(member.id);
                      return (
                        <label key={member.id}
                          style={{ border: `1px solid ${checked ? 'var(--gold)' : 'var(--line)'}`, background: checked ? 'var(--gold-tint)' : 'var(--bg)', padding: '11px 13px', display: 'flex', alignItems: 'center', gap: 9, cursor: 'pointer' }}>
                          <input type="checkbox" checked={checked}
                            onChange={(e) => toggleRecipient(asset.id, member.id, e.target.checked)}
                            style={{ accentColor: 'var(--gold-deep)', width: 14, height: 14, flexShrink: 0 }} />
                          <span>
                            <b style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--ink)' }}>{member.name}</b>
                            <span style={{ color: 'var(--ink-faint)', marginLeft: 5, fontSize: 12 }}>{member.relation}</span>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            </article>
          );
        })}
      </div>

      <div style={{ border: '1px solid var(--line)', borderTop: 0, background: 'var(--paper)', padding: '16px 22px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 20 }}>
        <div style={{ color: 'var(--ink-faint)', fontSize: 12.5 }}>후보 미지정 자산은 시나리오 비교에서 이전 대상으로 사용하지 않습니다.</div>
        <button type="button" onClick={() => void save()} disabled={saving}
          style={{ border: '1px solid var(--ink)', background: 'var(--ink)', color: '#F4F2EC', padding: '12px 24px', cursor: saving ? 'wait' : 'pointer', opacity: saving ? 0.65 : 1, fontWeight: 600, fontSize: 13.5, fontFamily: 'var(--sans)' }}>
          {saving ? '저장 중...' : '수증자 후보 저장'}
        </button>
      </div>
    </div>
  );
}

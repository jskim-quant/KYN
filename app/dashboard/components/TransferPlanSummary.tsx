import Link from 'next/link';
import type { Asset, FamilyMember, MacroSettings, TransferPlan } from '@/types';
import { isRecipientAssignmentPlan } from '@/lib/transfer-plan';

function fmt(n: number, digits = 1) {
  return `${Number(n.toFixed(digits)).toLocaleString('ko-KR')}억`;
}

export function TransferPlanSummaryCard({
  plans,
  assets,
  members,
  macro,
  title = '저장된 이전 계획',
  compact = false,
}: {
  plans: TransferPlan[];
  assets: Asset[];
  members: FamilyMember[];
  macro: MacroSettings | null;
  title?: string;
  compact?: boolean;
}) {
  void macro;
  const assignmentPlans = plans.filter(isRecipientAssignmentPlan);
  const plansByAsset = assignmentPlans.reduce<Record<string, TransferPlan[]>>(
    (acc, plan) => {
      if (!plan.asset_id) return acc;
      (acc[plan.asset_id] ??= []).push(plan);
      return acc;
    },
    {},
  );
  const assignedAssets = assets.filter(asset => (
    plansByAsset[asset.id]?.some(plan => Boolean(plan.to_member_id))
  ));
  const candidateIds = new Set(
    assignedAssets.flatMap(asset => (
      plansByAsset[asset.id]
        .map(plan => plan.to_member_id)
        .filter((memberId): memberId is string => Boolean(memberId))
    )),
  );
  const sharedAssetCount = assignedAssets.filter(asset => (
    new Set(plansByAsset[asset.id].map(plan => plan.to_member_id).filter(Boolean)).size > 1
  )).length;
  const assignedValue = assignedAssets.reduce(
    (sum, asset) => sum + Number(asset.current_value ?? 0),
    0,
  );

  return (
    <section className="card block">
      <div className="card-head">
        <div className="t">
          {title}
          <span className="sub">
            자산별로 받을 가족 구성원을 복수 지정하고, 실행안은 시나리오 비교에서 최적화합니다.
          </span>
        </div>
        <Link
          href="/dashboard/plan"
          className="link"
          style={{ whiteSpace: 'nowrap' }}
        >
          계획 관리 →
        </Link>
      </div>

      {assignedAssets.length === 0 ? (
        <div className="empty-note">
          아직 저장된 후보 배정이 없습니다. 이전 계획에서 자산별 받을 가족 구성원을 선택하세요.
        </div>
      ) : (
        <>
          <div className="mini">
            {[
              ['배정 자산', `${assignedAssets.length}건`],
              ['후보 구성원', `${candidateIds.size}명`],
              ['배정 자산가치', fmt(assignedValue)],
              ['복수 후보 자산', `${sharedAssetCount}건`],
            ].map(([label, value]) => (
              <div key={label}>
                <div className="l">{label}</div>
                <div className="n num">{value}</div>
              </div>
            ))}
          </div>

          {!compact && (
            <div className="planlist">
              {assignedAssets.slice(0, 4).map(asset => {
                const assetPlans = plansByAsset[asset.id];
                const owner = members.find(member => member.id === asset.owner_member_id);
                const recipients = Array.from(new Set(
                  assetPlans
                    .map(plan => plan.to_member_id)
                    .filter((memberId): memberId is string => Boolean(memberId)),
                ))
                  .map(memberId => members.find(member => member.id === memberId))
                  .filter((member): member is FamilyMember => Boolean(member));
                return (
                  <div key={asset.id} className="prow">
                    <span className="pl-name">
                      <strong>{asset.name}</strong>
                      <span className="arr">·</span>
                      {owner?.name ?? '보유자 미지정'} → {recipients.map(member => `${member.name} (${member.relation})`).join(', ')}
                    </span>
                    <span className="pl-meta">
                      현재가치 {fmt(Number(asset.current_value ?? 0))}
                      {' · '}후보 {recipients.length}명
                    </span>
                  </div>
                );
              })}
              {assignedAssets.length > 4 && (
                <div className="prow more">외 {assignedAssets.length - 4}건</div>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}

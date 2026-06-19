import type { Asset, FamilyMember, MacroSettings, TransferPlan, TransferType } from '@/types';
import {
  calcAcquisitionTax,
  calcCapitalGainsTax,
  calcGiftTax,
  getAssetGrowthRate,
  projectAssetValue,
} from '@/lib/tax';

export interface TransferPlanEstimate {
  plan: TransferPlan;
  asset: Asset | null;
  fromMember: FamilyMember | null;
  toMember: FamilyMember | null;
  growthRatePct: number;
  currentTransferValue: number;
  futureAssetValue: number;
  futureTransferValue: number;
  estimatedTax: number;
  note: string;
}

export interface TransferPlanSummary {
  estimates: TransferPlanEstimate[];
  totalCurrentTransferValue: number;
  totalFutureTransferValue: number;
  totalEstimatedTax: number;
  plannedAssetCount: number;
  recipientCount: number;
  overAllocatedAssets: Array<{
    assetId: string;
    assetName: string;
    plannedPct: number;
  }>;
}

export const RECIPIENT_ASSIGNMENT_NOTE = '수증자 후보 배정';
const LEGACY_RECIPIENT_ASSIGNMENT_NOTE = '배분 설계 자동 생성';

export function isRecipientAssignmentPlan(plan: Pick<TransferPlan, 'notes'>): boolean {
  const notes = plan.notes ?? '';
  return notes.startsWith(RECIPIENT_ASSIGNMENT_NOTE)
    || notes.startsWith(LEGACY_RECIPIENT_ASSIGNMENT_NOTE);
}

function isLikelyMultiHouseAcquisition(asset: Asset): boolean {
  return Number(asset.house_count ?? 0) >= 2 || Boolean(asset.is_regulated_area);
}

function getAcquisitionTaxNote(acquisitionTax: number, kind: 'gift' | 'inheritance' | 'corporate') {
  if (acquisitionTax <= 0) return '';
  if (kind === 'inheritance') return ` · 상속취득세 ${acquisitionTax.toFixed(1)}억 포함`;
  if (kind === 'corporate') return ` · 법인 취득세 ${acquisitionTax.toFixed(1)}억 포함`;
  return ` · 수증자 취득세 ${acquisitionTax.toFixed(1)}억 포함`;
}

export function estimateTransferTax(
  transferType: TransferType,
  asset: Asset,
  recipient: FamilyMember | null,
  transferPct: number,
  yearOffset: number,
  macro: MacroSettings | null,
): Pick<TransferPlanEstimate, 'growthRatePct' | 'currentTransferValue' | 'futureAssetValue' | 'futureTransferValue' | 'estimatedTax' | 'note'> {
  const safePct = Math.min(100, Math.max(0, Number(transferPct) || 0));
  const safeYears = Math.max(0, Number(yearOffset) || 0);
  const pctRatio = safePct / 100;
  const currentTransferValue = Number(asset.current_value) * pctRatio;
  const futureAssetValue = projectAssetValue(asset, safeYears, macro);
  const futureTransferValue = futureAssetValue * pctRatio;
  const growthRatePct = getAssetGrowthRate(asset, macro) * 100;

  if (!recipient) {
    return {
      growthRatePct,
      currentTransferValue,
      futureAssetValue,
      futureTransferValue,
      estimatedTax: 0,
      note: '수증자를 지정하면 세금을 계산합니다.',
    };
  }

  if (transferType === '증여(생전)' || transferType === '지분증여' || transferType === '세대생략증여') {
    const isGenerationSkip = transferType === '세대생략증여' || recipient.relation === '손자녀';
    const giftTax = calcGiftTax(
      futureTransferValue,
      recipient.relation,
      0,
      isGenerationSkip,
      false,
      recipient.age,
    );
    const acquisitionTax = calcAcquisitionTax(
      futureTransferValue,
      asset.asset_type,
      false,
      isLikelyMultiHouseAcquisition(asset),
      'gift',
    );
    return {
      growthRatePct,
      currentTransferValue,
      futureAssetValue,
      futureTransferValue,
      estimatedTax: giftTax + acquisitionTax,
      note: safeYears > 0
        ? `${safeYears}년 후 예상 가치 기준 증여세${getAcquisitionTaxNote(acquisitionTax, 'gift')}`
        : `현재 가치 기준 증여세${getAcquisitionTaxNote(acquisitionTax, 'gift')}`,
    };
  }

  if (transferType === '매각후분배') {
    return {
      growthRatePct,
      currentTransferValue,
      futureAssetValue,
      futureTransferValue,
      estimatedTax: calcCapitalGainsTax({
        ...asset,
        current_value: futureTransferValue,
        acquisition_cost: Number(asset.acquisition_cost) * pctRatio,
        necessary_expenses: Number(asset.necessary_expenses ?? 0) * pctRatio,
      }),
      note: `${safeYears}년 후 예상 매각가 기준 양도세`,
    };
  }

  if (transferType === '상속(사후)') {
    const inheritanceAcquisitionTax = calcAcquisitionTax(
      futureTransferValue,
      asset.asset_type,
      false,
      false,
      'inheritance',
    );
    return {
      growthRatePct,
      currentTransferValue,
      futureAssetValue,
      futureTransferValue,
      estimatedTax: inheritanceAcquisitionTax,
      note: inheritanceAcquisitionTax > 0
        ? `상속취득세만 반영. 상속세는 전체 상속재산과 공제를 함께 계산해야 합니다.`
        : '상속세는 전체 상속재산과 공제를 함께 계산해야 합니다.',
    };
  }

  if (transferType === '법인이전') {
    const corporateAcquisitionTax = calcAcquisitionTax(
      futureTransferValue,
      asset.asset_type,
      true,
      isLikelyMultiHouseAcquisition(asset),
      'purchase',
    );
    return {
      growthRatePct,
      currentTransferValue,
      futureAssetValue,
      futureTransferValue,
      estimatedTax: corporateAcquisitionTax,
      note: corporateAcquisitionTax > 0
        ? `법인 이전 취득세 보수 추정${getAcquisitionTaxNote(corporateAcquisitionTax, 'corporate')}`
        : '법인 이전은 별도 구조 검토가 필요한 계획입니다.',
    };
  }

  return {
    growthRatePct,
    currentTransferValue,
    futureAssetValue,
    futureTransferValue,
    estimatedTax: 0,
    note: '별도 구조 검토가 필요한 계획입니다.',
  };
}

export function summarizeTransferPlans(
  plans: TransferPlan[],
  assets: Asset[],
  members: FamilyMember[],
  macro: MacroSettings | null,
): TransferPlanSummary {
  const assetMap = new Map(assets.map(asset => [asset.id, asset]));
  const memberMap = new Map(members.map(member => [member.id, member]));

  const estimates = plans.map(plan => {
    const asset = plan.asset_id ? assetMap.get(plan.asset_id) ?? plan.asset ?? null : null;
    const fromMember = plan.from_member_id
      ? memberMap.get(plan.from_member_id) ?? plan.from_member ?? null
      : null;
    const toMember = plan.to_member_id
      ? memberMap.get(plan.to_member_id) ?? plan.to_member ?? null
      : null;

    if (!asset) {
      return {
        plan,
        asset: null,
        fromMember,
        toMember,
        growthRatePct: 0,
        currentTransferValue: 0,
        futureAssetValue: 0,
        futureTransferValue: 0,
        estimatedTax: isRecipientAssignmentPlan(plan)
          ? 0
          : Number(plan.estimated_tax ?? 0),
        note: '자산을 지정하면 미래가치와 세금을 계산합니다.',
      };
    }

    if (isRecipientAssignmentPlan(plan)) {
      return {
        plan,
        asset,
        fromMember,
        toMember,
        growthRatePct: getAssetGrowthRate(asset, macro) * 100,
        currentTransferValue: 0,
        futureAssetValue: Number(asset.current_value),
        futureTransferValue: 0,
        estimatedTax: 0,
        note: '수증자 후보만 배정된 상태입니다. 방식·시점·최종 비율은 전략 분석에서 결정합니다.',
      };
    }

    return {
      plan,
      asset,
      fromMember,
      toMember,
      ...estimateTransferTax(
        plan.transfer_type,
        asset,
        toMember,
        Number(plan.transfer_pct),
        Number(plan.year_offset),
        macro,
      ),
    };
  });
  const plannedPctByAsset = new Map<string, number>();
  for (const plan of plans) {
    if (!plan.asset_id || isRecipientAssignmentPlan(plan)) continue;
    plannedPctByAsset.set(
      plan.asset_id,
      (plannedPctByAsset.get(plan.asset_id) ?? 0) + Number(plan.transfer_pct ?? 0),
    );
  }
  const overAllocatedAssets = Array.from(plannedPctByAsset.entries())
    .filter(([, plannedPct]) => plannedPct > 100.0001)
    .map(([assetId, plannedPct]) => ({
      assetId,
      assetName: assetMap.get(assetId)?.name ?? '자산 미지정',
      plannedPct,
    }));

  return {
    estimates,
    totalCurrentTransferValue: estimates.reduce((sum, item) => sum + item.currentTransferValue, 0),
    totalFutureTransferValue: estimates.reduce((sum, item) => sum + item.futureTransferValue, 0),
    totalEstimatedTax: estimates.reduce((sum, item) => sum + item.estimatedTax, 0),
    plannedAssetCount: new Set(plans.map(plan => plan.asset_id).filter(Boolean)).size,
    recipientCount: new Set(plans.map(plan => plan.to_member_id).filter(Boolean)).size,
    overAllocatedAssets,
  };
}

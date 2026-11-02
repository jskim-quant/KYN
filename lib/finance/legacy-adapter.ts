import type { Asset, FamilyMember, MacroSettings } from '../../types';
import { calcAnnualHoldingTaxes, calcRentalIncomeTax, getAssetGrowthRate } from '../tax';
import { calendarMonth } from './cashflow';
import type { CashflowInput, ScheduledTax } from './cashflow';
import type { AssetClass, FinAsset, Liability, Person } from './types';
import { allocateByWeights, eokToWon, manToWon } from './units';
import type { KRW } from './units';

/**
 * 기존 DB 모델(억 단위, 자산당 소유자 1명·대출 1건)을 금융 엔진 입력(원 단위)으로 변환한다.
 * 변환하면서 해석을 바꾼 부분과 데이터 누락은 warnings / assumptions로 반환한다. 조용히 보정하지 않는다.
 */

export interface LegacyOptions {
  startMonth: string;
  horizonMonths: number;
  macro: MacroSettings | null;
  /** 매각비용 % 기본값(사용자 가정). 기본 0.5 */
  defaultSellCostPct?: number;
  /** 소유자 미지정 자산을 귀속시킬 구성원 ID. 없으면 해당 자산은 제외하고 excludedAssets에 표시한다. */
  unassignedOwnerId?: string | null;
}

export interface LegacyConversion {
  base: Omit<CashflowInput, 'events' | 'ratePathAdd'>;
  excludedAssets: Array<{ id: string; name: string; reason: string }>;
  warnings: string[];
  assumptions: string[];
}

const CLASS_MAP: Record<string, AssetClass> = {
  주거용부동산: 'real_estate', 상업용부동산: 'real_estate', 오피스텔: 'real_estate',
  토지: 'land', 농지: 'land', 임야: 'land',
  예금: 'deposit', 예금채권: 'deposit',
  채권: 'financial', 국내주식: 'financial', 해외주식: 'financial', 금융자산: 'financial', 보험: 'financial',
  비상장주식: 'unlisted_equity',
};

/** 사용자 입력이 없을 때의 매각 소요기간 기본 가정(개월). */
const DEFAULT_LEAD_MONTHS: Record<AssetClass, number> = {
  deposit: 0, financial: 0, real_estate: 6, land: 6, unlisted_equity: 6, other: 3,
};

export function assetClassOf(assetType: string): AssetClass {
  return CLASS_MAP[assetType] ?? 'other';
}

export function convertLegacy(assets: Asset[], members: FamilyMember[], opt: LegacyOptions): LegacyConversion {
  const warnings: string[] = [];
  const excludedAssets: LegacyConversion['excludedAssets'] = [];
  const memberIds = new Set(members.map(m => m.id));
  const sellCost = opt.defaultSellCostPct ?? 0.5;

  const persons: Person[] = members.map(m => ({ id: m.id, name: m.name, relation: m.relation, age: m.age ?? null }));

  const included: Asset[] = [];
  const ownerOf = new Map<string, string>();
  for (const a of assets) {
    const owner = a.owner_member_id && memberIds.has(a.owner_member_id) ? a.owner_member_id : opt.unassignedOwnerId ?? null;
    if (!owner || !memberIds.has(owner)) {
      excludedAssets.push({ id: a.id, name: a.name, reason: '소유자가 지정되지 않아 가족 장부에서 제외했습니다.' });
      continue;
    }
    if (!a.owner_member_id) warnings.push(`${a.name}: 소유자 미지정 → ${opt.unassignedOwnerId} 소유로 가정했습니다.`);
    if (a.ownership_share_pct !== null && a.ownership_share_pct !== undefined && a.ownership_share_pct < 100) {
      warnings.push(`${a.name}: 지분율 입력(${a.ownership_share_pct}%)은 기존 계산에서 사용되지 않아 무시하고, 입력한 시가를 소유자 보유분 가치로 해석했습니다.`);
    }
    if ((a.jeonse_deposit ?? 0) > 0) warnings.push(`${a.name}: 전세보증금은 부채로 반영하지 않았습니다(v1).`);
    if ((a.other_assumed_debt ?? 0) > 0) warnings.push(`${a.name}: 기타 채무는 부채로 반영하지 않았습니다(v1).`);
    const hasRent = (a.monthly_rent ?? 0) > 0;
    if (hasRent && a.annual_yield_pct > 0) {
      const rentYield = ((a.monthly_rent ?? 0) * 12 * 10_000) / Math.max(1, eokToWon(a.current_value)) * 100;
      if (Math.abs(rentYield - a.annual_yield_pct) > Math.max(0.5, a.annual_yield_pct * 0.2)) {
        warnings.push(`${a.name}: 월 임대료 환산 수익률(${rentYield.toFixed(1)}%)과 입력 수익률(${a.annual_yield_pct}%)이 다릅니다. 월 임대료를 우선 사용합니다.`);
      }
    }
    const cls = assetClassOf(a.asset_type);
    if ((cls === 'deposit' || cls === 'financial') && a.annual_yield_pct > 0 && a.expected_growth_pct > 0) {
      warnings.push(`${a.name}: 수익률과 성장률이 모두 입력되었습니다. 총수익률이 두 값에 중복 포함됐는지 확인하세요.`);
    }
    included.push(a);
    ownerOf.set(a.id, owner);
  }

  const finAssets: FinAsset[] = included.map(a => {
    const cls = assetClassOf(a.asset_type);
    const liquid = cls === 'deposit';
    const vac = (a.vacancy_rate_pct ?? 0) / 100;
    const pctYield = (cls === 'deposit' || cls === 'financial') ? (a.dividend_yield_pct ?? a.annual_yield_pct) : a.annual_yield_pct;
    const annualCashYield = (a.monthly_rent ?? 0) > 0
      ? Math.round(manToWon(a.monthly_rent) * 12 * (1 - vac))
      : Math.round((eokToWon(a.current_value) * pctYield) / 100);
    return {
      id: a.id, name: a.name, cls,
      marketValue: eokToWon(a.current_value), valuationDate: null,
      acquisitionCost: eokToWon(a.acquisition_cost),
      owners: [{ personId: ownerOf.get(a.id)!, pct: 100 }],
      liquid, sellable: true,
      sellCostPct: liquid ? 0 : sellCost,
      sellLeadMonths: a.sale_lead_months ?? DEFAULT_LEAD_MONTHS[cls],
      annualCashYield,
      annualOperatingCost: eokToWon(a.maintenance_cost),
      priceGrowthAnnual: getAssetGrowthRate(a, opt.macro),
    };
  });

  const liabilities: Liability[] = [];
  for (const a of included) {
    if (a.loan_amount > 0) {
      liabilities.push({
        id: `loan:${a.id}`, borrowerId: ownerOf.get(a.id)!, lenderId: null,
        principal: eokToWon(a.loan_amount), annualRate: a.loan_rate_pct / 100, rateType: a.loan_type,
        repayment: 'interest_only', remainingTermMonths: null, collateralAssetId: a.id, feeKRW: 0,
        repayOnCollateralSale: true,
      });
    }
  }
  for (const m of members) {
    if (m.total_debt > 0) {
      warnings.push(`${m.name}: 기타 부채는 금리·만기 정보가 없어 금리 0%, 만기 없음으로 반영했습니다. 이자 비용이 과소 계산됩니다.`);
      liabilities.push({
        id: `debt:${m.id}`, borrowerId: m.id, lenderId: null, principal: eokToWon(m.total_debt),
        annualRate: 0, rateType: 'fixed', repayment: 'interest_only', remainingTermMonths: null,
        collateralAssetId: null, feeKRW: 0, repayOnCollateralSale: false,
      });
    }
  }

  const cash: Record<string, KRW> = {};
  for (const m of members) cash[m.id] = eokToWon(m.cash_hold);
  const incomesMonthly = members
    .filter(m => m.annual_income > 0)
    .map(m => ({ personId: m.id, amount: Math.round(eokToWon(m.annual_income) / 12), label: '근로·사업소득' }));

  warnings.push('생활비가 입력 항목에 없어 0으로 계산합니다. 현금흐름이 과대평가됩니다.');

  const scheduledTaxes = buildScheduledTaxes(included, members, ownerOf, opt);

  const assumptions = [
    '입력한 소득은 세후 현금유입으로 간주합니다(근로·사업소득 세금 모형 없음).',
    '보유세는 오늘 기준 연액을 기간 내내 같은 명목금액으로 납부합니다(재평가 미반영). 재산세는 토지 9월, 그 외 7월·9월 절반씩, 종부세는 12월에 납부한다고 가정했습니다.',
    '종합부동산세는 인별 합산 대상이나, 자산 소유자 비례로 배분한 근사입니다.',
    '임대소득세는 구성원별 연 임대수입과 입력 소득을 기존 세금 함수에 넣어 매년 5월에 납부한다고 가정했습니다(근사).',
    `매각 소요기간은 입력값이 없으면 예금·금융자산 0개월, 부동산·토지·비상장주식 6개월, 기타 3개월을 가정했습니다. 매각비용은 ${sellCost}%(예금 제외)를 가정했습니다.`,
    '기존 대출은 만기·상환방식 정보가 없어 이자만 납부하고 만기를 연장한다고 가정했습니다.',
    '임대료는 명목 고정액입니다(임대료 상승 미반영).',
  ];

  return {
    base: {
      startMonth: opt.startMonth, horizonMonths: opt.horizonMonths,
      persons, assets: finAssets, liabilities, cash, incomesMonthly, scheduledTaxes,
    },
    excludedAssets, warnings, assumptions,
  };
}

function buildScheduledTaxes(
  assets: Asset[], members: FamilyMember[], ownerOf: Map<string, string>, opt: LegacyOptions,
): ScheduledTax[] {
  const out: ScheduledTax[] = [];
  const H = opt.horizonMonths;
  const holding = calcAnnualHoldingTaxes(assets);
  const byAssetWon = new Map<string, { asset: Asset; won: KRW }>();
  for (const row of holding.byAsset) {
    const asset = assets.find(a => a.id === row.assetId);
    if (!asset) continue;
    const eok = row.manualOverride > 0 ? row.manualOverride : row.propertyTax + row.localEducationTax + row.cityAreaTax;
    byAssetWon.set(row.assetId, { asset, won: eokToWon(eok) });
  }

  // 종부세: 부동산 소유자 비례 배분
  const reValue = new Map<string, number>();
  for (const a of assets) {
    if (['주거용부동산', '상업용부동산', '토지', '농지', '임야', '오피스텔'].includes(a.asset_type)) {
      const o = ownerOf.get(a.id)!;
      reValue.set(o, (reValue.get(o) ?? 0) + a.current_value);
    }
  }
  const reOwners = Array.from(reValue.keys());
  const rePortions = allocateByWeights(eokToWon(holding.comprehensiveRealEstateTax), reOwners.map(o => reValue.get(o)!));

  // 임대소득세: 구성원별
  const rentByOwner = new Map<string, number>();
  for (const a of assets) {
    const eok = (a.monthly_rent ?? 0) > 0 ? ((a.monthly_rent ?? 0) * 12 * (1 - (a.vacancy_rate_pct ?? 0) / 100)) / 10_000
      : (a.current_value * a.annual_yield_pct) / 100;
    if (['주거용부동산', '상업용부동산', '토지', '농지', '임야', '오피스텔'].includes(a.asset_type) && eok > 0) {
      const o = ownerOf.get(a.id)!;
      rentByOwner.set(o, (rentByOwner.get(o) ?? 0) + eok);
    }
  }

  for (let m = 0; m < H; m++) {
    const cal = calendarMonth(opt.startMonth, m);
    if (cal === 7 || cal === 9) {
      for (const { asset, won } of Array.from(byAssetWon.values())) {
        const isLand = ['토지', '농지', '임야'].includes(asset.asset_type);
        const share = isLand ? (cal === 9 ? won : 0) : Math.round(won / 2);
        if (share > 0) out.push({ month: m, personId: ownerOf.get(asset.id)!, amount: share, label: `재산세 ${asset.name}` });
      }
    }
    if (cal === 12) reOwners.forEach((o, k) => { if (rePortions[k] > 0) out.push({ month: m, personId: o, amount: rePortions[k], label: '종합부동산세' }); });
    if (cal === 5) {
      for (const [o, rent] of Array.from(rentByOwner.entries())) {
        const member = members.find(x => x.id === o);
        const tax = eokToWon(calcRentalIncomeTax(rent, member?.annual_income ?? 0));
        if (tax > 0) out.push({ month: m, personId: o, amount: tax, label: '임대소득세' });
      }
    }
  }
  return out;
}

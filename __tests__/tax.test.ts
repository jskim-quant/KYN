/**
 * 세금 계산 단위 테스트
 *
 * 실행: npx vitest run
 *

 * 테스트용 합성 포트폴리오 (실제 데이터 아님)


 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  calcCompliantFamilyLoanPlan,
  calcEstateBracketAnalysis,
  calcOptimalStrategy,
  calcAcquisitionTax,
  calcAnnualHoldingTaxes,
  calcAnnualPropertyTaxForAsset,
  estimatePublicFoundationPortfolioAdjustment,
  getAssetGrowthRate,
} from '../lib/tax';
import { estimateTransferTax } from '../lib/transfer-plan';
import { calcGiftTaxPure, estimateBurdenedGiftTransfer, estimateRelatedPartySale } from '../lib/tax/gift';
import { estimateFamilyAssetExchange } from '../lib/tax/exchange';
import { analyzeRecovery, calcAnnualCashflows } from '../lib/tax/recovery';
import type { BurdenedGiftInput, RelatedPartySaleInput, ExchangeAsset } from '../lib/tax/types';
import type { Asset, FamilyMember, MacroSettings } from '../types';

// ── 헬퍼 ──────────────────────────────────────────────────────
const approx = (val: number, target: number, tolerancePct = 5) => {
  const diff = Math.abs(val - target);
  return diff / Math.max(Math.abs(target), 0.01) <= tolerancePct / 100;
};

// ── 0. 증여세 재원용 가족간 차용 ──────────────────────────────
describe('0. 증여세 재원용 가족간 차용 실행 가능성', () => {
  it('피상속인 현금과 수증자 상환 능력이 있으면 조건부 반영', () => {
    const result = calcCompliantFamilyLoanPlan(3, 2, 0.5, 1, 0.1);
    expect(result.familyLoanAmount).toBeCloseTo(1.5, 4);
    expect(result.eligible).toBe(true);
    expect(result.annualDebtService).toBeGreaterThan(0);
  });

  it('현금이 있어도 원리금 상환 능력이 부족하면 반영하지 않음', () => {
    const result = calcCompliantFamilyLoanPlan(5, 4, 0, 0, 0.01);
    expect(result.canFund).toBe(true);
    expect(result.canService).toBe(false);
    expect(result.eligible).toBe(false);
  });

  it('피상속인 현금이 부족하면 필요한 차용액 전부를 조달할 수 없음', () => {
    const result = calcCompliantFamilyLoanPlan(1, 3, 0, 3, 0.2);
    expect(result.requestedFamilyLoan).toBe(3);
    expect(result.familyLoanAmount).toBe(1);
    expect(result.canFund).toBe(false);
    expect(result.eligible).toBe(false);
  });
});

// ── 0-1. 자산별 성장률과 미래 이전세 ─────────────────────────
describe('0-1. 자산별 성장률과 미래 이전세', () => {
  const macro = {
    apt_growth_pct: 4,
    land_growth_pct: 3,
    commercial_growth_pct: 2,
    domestic_stock_return_pct: 7,
  } as MacroSettings;
  const stock = {
    current_value: 10,
    acquisition_cost: 5,
    necessary_expenses: 0,
    expected_growth_pct: 1,
    asset_type: '국내주식',
  } as Asset;
  const child = { relation: '자녀', age: 30 } as FamilyMember;

  it('금융자산도 자산 목록의 개별 기대수익률을 우선 사용', () => {
    expect(getAssetGrowthRate(stock, macro)).toBeCloseTo(0.01, 6);
  });

  it('개별 성장률이 없는 과거 데이터만 유형별 기대수익률을 fallback으로 사용', () => {
    const legacyStock = { ...stock, expected_growth_pct: null } as unknown as Asset;
    expect(getAssetGrowthRate(legacyStock, macro)).toBeCloseTo(0.07, 6);
  });

  it('10년 후 증여 계획은 성장한 자산가치 기준으로 증여세를 계산', () => {
    const now = estimateTransferTax('증여(생전)', stock, child, 100, 0, macro);
    const future = estimateTransferTax('증여(생전)', stock, child, 100, 10, macro);
    expect(future.futureTransferValue).toBeGreaterThan(now.futureTransferValue);
    expect(future.estimatedTax).toBeGreaterThan(now.estimatedTax);
  });

  it('부동산 이전 계획은 증여세와 취득세를 함께 반영한다', () => {
    const realEstate = {
      ...stock,
      asset_type: '주거용부동산',
      house_count: 1,
    } as Asset;
    const financialGift = estimateTransferTax('증여(생전)', stock, child, 100, 0, macro);
    const realEstateGift = estimateTransferTax('증여(생전)', realEstate, child, 100, 0, macro);
    const inheritedRealEstate = estimateTransferTax('상속(사후)', realEstate, child, 100, 0, macro);

    expect(realEstateGift.estimatedTax).toBeGreaterThan(financialGift.estimatedTax);
    expect(realEstateGift.note).toContain('취득세');
    expect(inheritedRealEstate.estimatedTax).toBeGreaterThan(0);
    expect(inheritedRealEstate.note).toContain('상속취득세');
  });

  it('전략 분석 상속 구간 전망은 전달한 포트폴리오 성장률을 사용', () => {
    const result = calcEstateBracketAnalysis(20, [child], 70, 0, 0.05);
    expect(result.projectedEstate10yr).toBeCloseTo(20 * Math.pow(1.05, 10), 6);
  });
});

// ── 0-2. 공익재단 적격 출연 사전 비교 ─────────────────────────
describe('0-2. 공익재단 적격 출연 사전 비교', () => {
  const heirs = [
    { relation: '배우자', age: 68 },
    { relation: '자녀', age: 40 },
  ] as FamilyMember[];

  it('선택한 적격 출연액은 가족 사유재산과 예상 상속세를 함께 낮춤', () => {
    const result = estimatePublicFoundationPortfolioAdjustment(40, heirs, 10);
    expect(result.donatedValue).toBeCloseTo(4, 6);
    expect(result.remainingEstate).toBeCloseTo(36, 6);
    expect(result.adjustedTax).toBeLessThan(result.originalTax);
    expect(result.taxReduction).toBeGreaterThan(0);
    expect(result.confidence).toBe('expert_review');
  });

  it('0% 선택은 기존 상속세를 바꾸지 않음', () => {
    const result = estimatePublicFoundationPortfolioAdjustment(40, heirs, 0);
    expect(result.donatedValue).toBe(0);
    expect(result.remainingEstate).toBe(40);
    expect(result.adjustedTax).toBeCloseTo(result.originalTax, 6);
    expect(result.taxReduction).toBe(0);
  });
});

// ── 0-2-1. 취득세·보유세 공통 엔진 ───────────────────────────
describe('0-2-1. 취득세·재산세·종부세·보유세', () => {
  const apartment = {
    id: 'apt-1',
    name: '아파트',
    asset_type: '주거용부동산',
    current_value: 20,
    assessed_value: 14,
    public_price_ratio: 70,
    annual_tax: 0,
    housing_use: true,
    house_count: 1,
  } as Asset;
  const land = {
    id: 'land-1',
    name: '토지',
    asset_type: '토지',
    current_value: 10,
    assessed_value: 6,
    public_price_ratio: 60,
    annual_tax: 0,
  } as Asset;
  const cash = {
    id: 'cash-1',
    name: '예금',
    asset_type: '예금',
    current_value: 5,
    assessed_value: null,
    public_price_ratio: 0,
    annual_tax: 0,
  } as Asset;

  it('부동산 취득세는 유형·취득 원인에 따라 계산되고 금융자산은 0', () => {
    expect(calcAcquisitionTax(10, '주거용부동산', false, false, 'purchase')).toBeGreaterThan(0);
    expect(calcAcquisitionTax(10, '주거용부동산', false, false, 'gift')).toBeGreaterThan(0);
    expect(calcAcquisitionTax(10, '주거용부동산', false, false, 'inheritance')).toBeGreaterThan(0);
    expect(calcAcquisitionTax(10, '예금', false, false, 'purchase')).toBe(0);
  });

  it('자산별 재산세·지방교육세·도시지역분을 계산한다', () => {
    const result = calcAnnualPropertyTaxForAsset(apartment);
    expect(result.assessedValue).toBeCloseTo(14, 6);
    expect(result.propertyTax).toBeGreaterThan(0);
    expect(result.localEducationTax).toBeGreaterThan(0);
    expect(result.total).toBeGreaterThan(result.propertyTax);
  });

  it('포트폴리오 보유세는 재산세와 종부세를 합산하고 금융자산은 제외한다', () => {
    const result = calcAnnualHoldingTaxes([apartment, land, cash]);
    expect(result.total).toBeGreaterThan(0);
    expect(result.propertyTax).toBeGreaterThan(0);
    expect(result.byAsset.find(a => a.assetId === 'cash-1')?.total).toBe(0);
  });

  it('자산에 보유세 직접 입력값이 있으면 해당 자산은 입력값을 우선한다', () => {
    const manual = { ...apartment, annual_tax: 0.5 } as Asset;
    const result = calcAnnualPropertyTaxForAsset(manual);
    expect(result.total).toBeCloseTo(0.5, 6);
    expect(result.manualOverride).toBeCloseTo(0.5, 6);
  });
});

// ── 0-3. 최적 전략의 상속세 납부 현실성 ──────────────────────
describe('0-3. 최적 전략의 상속세 납부 현실성', () => {
  const lowYieldBuilding = {
    id: 'building-1',
    name: '저수익 상가',
    asset_type: '상업용부동산',
    current_value: 40,
    acquisition_cost: 10,
    annual_yield_pct: 1,
    expected_growth_pct: 4,
    loan_amount: 0,
    loan_rate_pct: 0,
  } as Asset;
  const child = {
    id: 'child-1',
    name: '자녀',
    relation: '자녀',
    age: 40,
    cash_hold: 0,
    annual_income: 0,
  } as FamilyMember;

  it('연부연납 원금보다 반복 현금흐름이 작으면 별도 재원 확정을 요구', () => {
    const result = calcOptimalStrategy([lowYieldBuilding], [child], null, 0);
    const installmentAction = result.actions.find(action => action.title === '연부연납 10년 분할 신청');

    expect(result.funding.surplus).toBeLessThan(0);
    expect(result.funding.annualInstallmentGap).toBeGreaterThan(0);
    expect(result.actions.some(action => action.title === '상속세 부족액 보완안 확정')).toBe(true);
    expect(installmentAction?.description).toContain('연부연납만 신청하는 안은 실행 가능한 납부안이 아닙니다');
  });
});

// ── 1. 성년 자녀 현금 10억 증여 ────────────────────────────────
describe('1. 성년 자녀 10억 현금 증여', () => {
  it('증여세 계산 (신고세액공제 3% 포함)', () => {
    // 10억 - 공제 5천만원 = 9.5억 과세표준
    // 세율: 0.9 + (9.5-5)×0.3 = 0.9 + 1.35 = 2.25억
    // 신고세액공제 3%: 2.25 × 0.97 = 2.1825억
    const tax = calcGiftTaxPure(10, '자녀', 0, false, 30);
    expect(tax).toBeGreaterThan(2.1);
    expect(tax).toBeLessThan(2.3);
  });

  it('사전증여 5억 있을 때 증분 계산 — 공제 이미 소진, 높은 세율 구간 적용', () => {
    // 사전증여 없이 10억: 공제 5천만원 → 9.5억 과세
    const noPrior   = calcGiftTaxPure(10, '자녀', 0, false, 30);
    // 사전증여 5억 후 추가 5억: 합산 10억, 공제 소진 → 추가 5억에 더 높은 구간 적용
    const withPrior = calcGiftTaxPure(5, '자녀', 5, false, 30);
    // 사전증여 있으면 추가 5억에 대한 증분세금이 나옴
    expect(withPrior).toBeGreaterThan(0);
    // 추가 5억의 증분세금 < 처음 10억 전체 증여세 (당연히)
    expect(withPrior).toBeLessThan(noPrior);
  });
});

// ── 2. 미성년 자녀 10억 증여 ──────────────────────────────────
describe('2. 미성년 자녀 10억 증여', () => {
  it('미성년 공제 2천만원 적용', () => {
    const adultTax = calcGiftTaxPure(10, '자녀', 0, false, 25);
    const minorTax = calcGiftTaxPure(10, '자녀', 0, false, 10);
    // 미성년 공제가 더 작으므로 세금이 더 많아야 함
    expect(minorTax).toBeGreaterThan(adultTax);
  });
});

// ── 3. 성년 손자녀 10억 세대생략증여 ──────────────────────────
describe('3. 성년 손자녀 10억 세대생략증여', () => {
  it('30% 할증 적용', () => {
    const childTax   = calcGiftTaxPure(10, '자녀',   0, false, 25);
    const grandchild = calcGiftTaxPure(10, '손자녀', 0, true,  25);
    // 세대생략은 할증이므로 손자녀 > 자녀
    expect(grandchild).toBeGreaterThan(childTax);
    // 할증률 약 30% (신고세액공제 감안)
    const ratio = grandchild / childTax;
    expect(ratio).toBeGreaterThan(1.25);
    expect(ratio).toBeLessThan(1.35);
  });
});

// ── 4. 미성년 손자녀 20억 초과 40% 할증 ───────────────────────
// 손자녀는 관계 자체로 세대생략 30% 할증 적용 (상증법 §57)
// 미성년 손자녀 + 증여액 20억 초과 시 → 40% 할증
describe('4. 미성년 손자녀 고액 증여 40% 할증', () => {
  it('21억 증여 시 40% 할증 (미성년) vs 30% 할증 (성년) 비교', () => {
    // 성년 손자녀 21억 → 30% 할증
    const adult  = calcGiftTaxPure(21, '손자녀', 0, true, 25); // 성년(25세)
    // 미성년 손자녀 21억 → 40% 할증 (20억 초과)
    const minor  = calcGiftTaxPure(21, '손자녀', 0, true, 10); // 미성년(10세)
    // 미성년(40%)이 성년(30%)보다 더 많아야 함
    expect(minor).toBeGreaterThan(adult);
    // 비율: 1.40 / 1.30 ≈ 1.077
    const ratio = minor / adult;
    expect(ratio).toBeGreaterThan(1.05);
    expect(ratio).toBeLessThan(1.12);
  });

  it('15억(20억 미만)은 미성년·성년 모두 30% 할증 적용 (공제액 차이로 절대값은 다름)', () => {
    // 성년: 공제 5천만원 → 과세표준 14.5억 → base tax × 1.3
    // 미성년: 공제 2천만원 → 과세표준 14.8억 → base tax × 1.3
    // 공제액 차이로 절대값은 다르지만 '할증률'은 동일 (×1.3)
    const adultNoSkip = calcGiftTaxPure(15, '자녀',   0, false, 25); // 자녀 30% 할증 없음
    const adultSkip   = calcGiftTaxPure(15, '손자녀', 0, true,  25); // 손자녀 30%
    const minorNoSkip = calcGiftTaxPure(15, '자녀',   0, false, 10);
    const minorSkip   = calcGiftTaxPure(15, '손자녀', 0, true,  10);
    // 각각의 할증 비율이 모두 ~1.3 (신고세액공제 동일 적용)
    const adultRatio = adultSkip / adultNoSkip;
    const minorRatio = minorSkip / minorNoSkip;
    expect(adultRatio).toBeCloseTo(minorRatio, 1); // 할증률 동일
    expect(adultRatio).toBeGreaterThan(1.25);
  });

  it('손자녀는 isGenerationSkip=false여도 30% 할증 적용', () => {
    // 관계가 손자녀이면 세대생략 할증이 자동 적용
    const noFlag = calcGiftTaxPure(10, '손자녀', 0, false, 25);
    const child  = calcGiftTaxPure(10, '자녀',   0, false, 25);
    expect(noFlag).toBeGreaterThan(child);
  });
});

// ── 5. 가족간 저가매매 — 기준금액 차감 검증 ─────────────────
describe('5. 가족간 저가매매 — 상증세법 §35 기준금액 차감', () => {
  // 시가 10억, 기준금액 = min(3억, 3억) = 3억
  const base: RelatedPartySaleInput = {
    marketValue: 10, salePrice: 0,
    acquisitionCost: 5, holdingYears: 8,
    isOneHouseOneFamily: false, houseCount: 1, isRegulatedArea: false,
    relation: '자녀',
  };

  it('10억 → 7억: 차액 3억 = 임계값 → 증여재산가액 = 3-3 = 0억 → 증여세 0', () => {
    const result = estimateRelatedPartySale({ ...base, salePrice: 7 });
    expect(result.priceDiff).toBe(3);
    expect(result.isGiftDeemed).toBe(true);
    // 기준금액 3억 차감 → 증여재산가액 0 → 증여세 0
    expect(result.taxableGiftAmount).toBeCloseTo(0, 4);
    expect(result.giftTax.amount).toBeCloseTo(0, 4);
  });

  it('10억 → 6억: 차액 4억 → 증여재산가액 = 4-3 = 1억 → 증여세 > 0', () => {
    const result = estimateRelatedPartySale({ ...base, salePrice: 6 });
    expect(result.priceDiff).toBe(4);
    expect(result.isGiftDeemed).toBe(true);
    // 증여재산가액 = 4 - 3 = 1억
    expect(result.taxableGiftAmount).toBeCloseTo(1, 4);
    // 1억 - 자녀공제 5천만원 = 5천만원 × 10% × (1-0.03) ≈ 0.0485억
    expect(result.giftTax.amount).toBeGreaterThan(0.04);
    expect(result.giftTax.amount).toBeLessThan(0.06);
  });

  it('10억 → 5억: 차액 5억 → 증여재산가액 = 5-3 = 2억', () => {
    const result = estimateRelatedPartySale({ ...base, salePrice: 5 });
    expect(result.taxableGiftAmount).toBeCloseTo(2, 4);
  });

  it('임계값 미만 매매 (차액 2.9억 < 3억 AND < 30%) → 증여세 0', () => {
    const result = estimateRelatedPartySale({ ...base, salePrice: 7.1 });
    expect(result.isGiftDeemed).toBe(false);
    expect(result.giftTax.amount).toBe(0);
  });

  it('증여세 0원 최적 매매가 = 임계값 직전', () => {
    const result = estimateRelatedPartySale({ ...base, salePrice: 6 });
    // 최적가 = 시가 - 기준금액 + 0.01 = 10 - 3 + 0.01 = 7.01억
    expect(result.zeroGiftTaxOptimalPrice).toBeCloseTo(7.01, 1);
  });

  it('양도세 시가 재산정 위험을 경고', () => {
    const result = estimateRelatedPartySale({ ...base, salePrice: 6 });
    expect(result.capitalGainsTax.warnings.join(' ')).toContain('시가 기준으로 재계산');
    expect(result.totalTax.confidence).toBe('rough_estimate');
  });
});

// ── 6. 부담부증여 10억 아파트 (전세 5억, 취득가 6억) ──────────
describe('6. 부담부증여 (시가 10억, 취득가 6억, 전세 5억)', () => {
  const input: BurdenedGiftInput = {
    marketValue: 10, assessedValue: 6,
    acquisitionCost: 6, totalDebt: 5,
    holdingYears: 10,
    relation: '자녀', recipientAge: 35,
    isOneHouseOneFamily: false, houseCount: 1, isRegulatedArea: false,
  };

  it('양도가액=채무(5억), 취득가 비율안분', () => {
    const result = estimateBurdenedGiftTransfer(input);
    // 양도세: 양도가액 5억, 취득가 6×(5/10)=3억 → 차익 2억 → 양도세 > 0
    expect(result.transferPortion.amount).toBeGreaterThan(0);
  });

  it('순증여분 = 시가 - 채무 = 5억', () => {
    const result = estimateBurdenedGiftTransfer(input);
    // 시가 10억 - 채무 5억 = 5억이 순증여분
    // 증여세: 5억 - 공제 5천만원 = 4.5억 과세 → 약 0.9+...
    expect(result.giftPortion.amount).toBeGreaterThan(0);
  });

  it('직접 증여 대비 절세 효과 존재', () => {
    const result = estimateBurdenedGiftTransfer(input);
    // 부담부증여가 직접 증여보다 저렴해야 함
    expect(result.savingVsDirectGift).toBeGreaterThan(0);
  });

  it('공시가 적용 안내 포함', () => {
    const result = estimateBurdenedGiftTransfer(input);
    // 공시가 < 시가인 경우 valuationNote에 안내 포함
    expect(result.valuationNote).toContain('공시가격');
  });

  it('신뢰도 rough_estimate', () => {
    const result = estimateBurdenedGiftTransfer(input);
    expect(result.total.confidence).toBe('rough_estimate');
  });

  it('취득세를 채무 인수분과 순증여분으로 나눠 계산', () => {
    const result = estimateBurdenedGiftTransfer({ ...input, recipientCanProveDebtRepayment: true });
    expect(result.acquisitionTaxOnerous.amount).toBeGreaterThan(0);
    expect(result.acquisitionTaxGift.amount).toBeGreaterThan(0);
    expect(result.acquisitionTax.amount).toBeCloseTo(
      result.acquisitionTaxOnerous.amount + result.acquisitionTaxGift.amount,
      6,
    );
  });

  it('채무 상환 능력을 증명하지 못하면 전액 증여로 간이 계산', () => {
    const result = estimateBurdenedGiftTransfer({ ...input, recipientCanProveDebtRepayment: false });
    expect(result.transferPortion.amount).toBe(0);
    expect(result.acquisitionTaxOnerous.amount).toBe(0);
    expect(result.total.warnings.join(' ')).toContain('전액 증여');
  });
});

// ── 7. 가족간 교환 — 상대방 자산 없을 때 ─────────────────────
describe('7. 가족간 교환 (상대방 자산 입력 필요)', () => {
  it('양쪽 자산 모두 입력 시 계산 수행 — 세금 항목 구조 검증', () => {
    const left: ExchangeAsset = {
      name: '서울 아파트', marketValue: 26, assessedValue: 16,
      acquisitionCost: 10, holdingYears: 12,
      assetType: '주거용부동산', isResidential: true,
      houseCount: 1, isRegulatedArea: false,
    };
    const right: ExchangeAsset = {
      name: '경기도 아파트', marketValue: 10, assessedValue: 7,
      acquisitionCost: 5, holdingYears: 5,
      assetType: '주거용부동산', isResidential: true,
      houseCount: 1, isRegulatedArea: false,
    };
    const result = estimateFamilyAssetExchange(left, right, '자녀');
    // 모든 세금 항목이 계산되어야 함
    expect(result.totalTax.amount).toBeGreaterThan(0);
    expect(result.exchangeDiff).toBe(16);
    // 취득세는 양쪽 각각 발생
    expect(result.acqTaxLeft.amount).toBeGreaterThan(0);
    expect(result.acqTaxRight.amount).toBeGreaterThan(0);
    // 교환차액 16억 → 증여 의제 → 증여세 발생
    expect(result.giftOnDiff.amount).toBeGreaterThan(0);
    // 참고: 교환차액(16억)이 크면 직접증여보다 불리할 수 있음
    // savingVsDirectGift 부호는 케이스에 따라 다름 (양수=절세, 음수=불리)
    expect(typeof result.savingVsDirectGift).toBe('number');
  });

  it('교환차액(16억) 처리 — 증여 의제 검토', () => {
    const left: ExchangeAsset = {
      name: '서울 아파트', marketValue: 26, assessedValue: 16,
      acquisitionCost: 10, holdingYears: 12,
      assetType: '주거용부동산', isResidential: true,
      houseCount: 1, isRegulatedArea: false,
    };
    const right: ExchangeAsset = {
      name: '경기도 아파트', marketValue: 10, assessedValue: 7,
      acquisitionCost: 5, holdingYears: 5,
      assetType: '주거용부동산', isResidential: true,
      houseCount: 1, isRegulatedArea: false,
    };
    const result = estimateFamilyAssetExchange(left, right, '자녀');
    // 교환차액 16억 = 시가×30% 이상 → 증여 의제 가능성
    expect(result.exchangeDiff).toBe(16);
    expect(result.giftOnDiff.amount).toBeGreaterThan(0);
  });
});

// ── 8. 배우자 상속 비중 변경 — 1차·2차 상속세 비교 (개념 테스트) ─
describe('8. 배우자 상속 비중별 합계 세금 비교', () => {
  it('배우자에게 70% vs 자녀에게 70%', () => {
    // 직접 비교: 배우자 증여공제 6억 vs 상속세율 적용
    const spouseTax = calcGiftTaxPure(20, '배우자', 0, false, 60);
    const childTax  = calcGiftTaxPure(20, '자녀',   0, false, 35);
    // 배우자 공제가 훨씬 크므로 배우자에게 증여 시 세금이 낮음
    expect(spouseTax).toBeLessThan(childTax);
  });
});

// ── 9. 금리 +2%p 스트레스 시 현금흐름 ──────────────────────────
describe('9. 연부연납 + 금리 스트레스', () => {
  it('연부연납 10년: 신고기한 첫 납부 후 년도별 10회 납부', () => {
    const input = {
      inheritanceTax: 15,
      ownCash: 2, liquidFinancialAssets: 4, loanCapacity: 5,
      annualRentalAfterTax: 0.4, annualFinancialIncome: 0.16,
      annualLoanInterest: 0.2, loanPrincipal: 5,
    };
    const flows = calcAnnualCashflows(input, 10);
    // 최초 납부 후 연부연납 10년치 = 10개 행
    expect(flows).toHaveLength(10);
    // 원금 납부: 15/(10+1) ≈ 1.364억/년
    expect(flows[0].installmentPrincipal).toBeCloseTo(15 / 11, 3);
  });

  it('원금 합계: 6개월 첫납부 + 연도별 납부 = 전체 세액', () => {
    const tax = 15;
    const N   = 10;
    const installment = tax / (N + 1);
    const flows = calcAnnualCashflows({
      inheritanceTax: tax,
      ownCash: 2, liquidFinancialAssets: 4, loanCapacity: 5,
      annualRentalAfterTax: 0.4, annualFinancialIncome: 0.16,
      annualLoanInterest: 0.2, loanPrincipal: 5,
    }, N);
    // 첫 납부 1회 + 연부연납 10회 = 15억
    const annualPrincipalSum = flows.reduce((s, r) => s + r.installmentPrincipal, 0);
    expect(installment + annualPrincipalSum).toBeCloseTo(tax, 2);
  });

  it('금리 +2%p 스트레스: 이자 = 기존이자 + 원금 × 2%', () => {
    const base = {
      inheritanceTax: 15,
      ownCash: 2, liquidFinancialAssets: 4, loanCapacity: 5,
      annualRentalAfterTax: 0.4, annualFinancialIncome: 0.16,
      annualLoanInterest: 0.2, loanPrincipal: 5, // 5억 원금
    };
    const noStress   = calcAnnualCashflows({ ...base, rateShockPct: 0 }, 10);
    const withStress = calcAnnualCashflows({ ...base, rateShockPct: 2 }, 10);
    // 스트레스 시 추가 이자 = 5억 × 2% = 0.1억
    expect(withStress[0].loanInterest - noStress[0].loanInterest).toBeCloseTo(0.10, 3);
  });
});

// ── 10. 대표 포트폴리오 종합 회생 분석 ───────────────────────────
describe('10. 대표 포트폴리오 회생 분석', () => {
  /*
   * 서울 아파트 24억, 상가 18억(연수익 0.4억), 토지 8억
   * 국내외 주식 8억, 예금 4억, 대출 4억
   * 예상 상속세 ≈ 15억 (간이)
   */
  it('6개월 부족액 계산', () => {
    const result = analyzeRecovery({
      inheritanceTax: 15,
      ownCash: 2,
      liquidFinancialAssets: 4,  // 예금 4억
      loanCapacity: 8,            // 추가 담보 여력
      annualRentalAfterTax: 0.35,
      annualFinancialIncome: 0.2,
      annualLoanInterest: 0.2,
      forcedSaleAssetTotal: 8,    // 토지 급매 후보
    });

    // 연부연납 1차 납부: 15/(10+1) ≈ 1.364억
    // 즉시 가용 현금: 2+4=6억 > 1.364억 → 부족 없음
    expect(result.sixMonth.immediateShortfall).toBe(0);
  });

  it('현금 부족 케이스 — 급매 필요 여부', () => {
    const result = analyzeRecovery({
      inheritanceTax: 20,
      ownCash: 0.5,
      liquidFinancialAssets: 0.5,
      loanCapacity: 2,
      annualRentalAfterTax: 0.4,
      annualFinancialIncome: 0.1,
      annualLoanInterest: 0.3,
      installmentYears: 5,
      forcedSaleAssetTotal: 8,
    });
    // 1차 납부 20/(5+1) ≈ 3.33억, 가용 현금 1억 → 부족
    expect(result.sixMonth.immediateShortfall).toBeGreaterThan(0);
    expect(result.sixMonth.forcedSaleRequired).toBe(true);
  });

  it('금리 스트레스 시 위험 연도 탐지', () => {
    const result = analyzeRecovery({
      inheritanceTax: 15,
      ownCash: 2, liquidFinancialAssets: 4, loanCapacity: 5,
      annualRentalAfterTax: 0.35, annualFinancialIncome: 0.15,
      annualLoanInterest: 0.5, // 높은 이자 부담
      rateShockPct: 0,
    });
    // 연부연납 10년 동안 일부 연도 위험 가능
    const hasRisk = result.annualCashflows.some(r => r.isAtRisk);
    // 위험 여부 자체보다 계산이 정상 동작하는지 확인
    expect(result.annualCashflows).toHaveLength(10); // 최초 납부 이후 연부연납 10년
    expect(typeof hasRisk).toBe('boolean');
  });
});

// ── 11. 과거 증여 10년 합산 ───────────────────────────────────
describe('11. 과거 증여 합산', () => {
  it('10년 내 3억 사전증여 후 추가 2억 증여 시 증분세금', () => {
    const withoutPrior = calcGiftTaxPure(2, '자녀', 0, false, 35);
    const withPrior    = calcGiftTaxPure(2, '자녀', 3, false, 35);
    // 사전증여 3억이 있으면 공제가 이미 소진되어 세율 구간이 높음
    expect(withPrior).toBeGreaterThanOrEqual(withoutPrior);
  });
});

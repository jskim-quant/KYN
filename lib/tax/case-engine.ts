import type { Asset, FamilyMember, MacroSettings } from '@/types';
import {
  calcGiftTaxPure,
  estimateBurdenedGiftTransfer,
  estimateRelatedPartySale,
} from './gift';

export type TaxCaseCategory =
  | '증여'
  | '매매'
  | '법인'
  | '공익'
  | '현금흐름'
  | '리스크';

export type TaxCaseConfidence = 'law_based' | 'input_estimate' | 'expert_review';

export interface TaxCaseInsight {
  id: string;
  title: string;
  category: TaxCaseCategory;
  score: number;
  summary: string;
  trigger: string;
  recommendedAction: string;
  estimatedBenefit?: number;
  estimatedCost?: number;
  confidence: TaxCaseConfidence;
  legalBasis: string[];
  sourceType: 'official_rule' | 'case_pattern';
}

function assetHoldingYears(asset: Asset): number {
  if (!asset.acquisition_date) return 5;
  const acquired = new Date(asset.acquisition_date);
  if (Number.isNaN(acquired.getTime())) return 5;
  return Math.max(0, (Date.now() - acquired.getTime()) / (365.25 * 24 * 60 * 60 * 1000));
}

function isResidential(asset: Asset): boolean {
  return asset.asset_type === '주거용부동산' || asset.asset_type === '오피스텔' || asset.housing_use === true;
}

function assessedValue(asset: Asset): number | null {
  if (asset.assessed_value !== null && asset.assessed_value !== undefined) return asset.assessed_value;
  if (asset.public_price_ratio > 0) return asset.current_value * asset.public_price_ratio / 100;
  return null;
}

function primaryRecipients(members: FamilyMember[]) {
  return members.filter(member => member.relation !== '본인');
}

function bestChildRecipient(members: FamilyMember[]) {
  return members.find(member => member.relation === '자녀')
    ?? members.find(member => member.relation === '손자녀')
    ?? primaryRecipients(members)[0];
}

function addCase(cases: TaxCaseInsight[], insight: TaxCaseInsight) {
  cases.push(insight);
}

export const TAX_CASE_LIBRARY_SIZE = 60;

interface TaxCaseContext {
  assets: Asset[];
  members: FamilyMember[];
  totalValue: number;
  totalDebt: number;
  totalCash: number;
  rentalAssets: Asset[];
  rentalIncome: number;
  annualYield: number;
  avgGrowth: number;
  recipients: FamilyMember[];
  child?: FamilyMember;
  spouse?: FamilyMember;
  owner?: FamilyMember;
  children: FamilyMember[];
  grandchildren: FamilyMember[];
  inLaws: FamilyMember[];
  highDebtAssets: Asset[];
  highGrowthAssets: Asset[];
  lowYieldAssets: Asset[];
  realEstateAssets: Asset[];
  stockAssets: Asset[];
  unlistedStockAssets: Asset[];
  primaryHome?: Asset;
}

interface TaxCaseRule {
  id: string;
  title: string;
  category: TaxCaseCategory;
  confidence: TaxCaseConfidence;
  sourceType: TaxCaseInsight['sourceType'];
  legalBasis: string[];
  when: (ctx: TaxCaseContext) => boolean;
  summary: (ctx: TaxCaseContext) => string;
  trigger: (ctx: TaxCaseContext) => string;
  action: (ctx: TaxCaseContext) => string;
  score: (ctx: TaxCaseContext) => number;
  benefit?: (ctx: TaxCaseContext) => number | undefined;
}

function countText(count: number, noun: string) {
  return `${noun} ${count}개`;
}

const TAX_CASE_RULES: TaxCaseRule[] = [
  {
    id: 'spouse-deduction-gift',
    title: '배우자 6억 공제 활용',
    category: '증여',
    confidence: 'law_based',
    sourceType: 'official_rule',
    legalBasis: ['상증세법 §53 (증여재산공제)'],
    when: c => Boolean(c.spouse) && c.totalValue >= 10,
    summary: () => '배우자가 있으면 10년 단위 배우자 증여공제를 우선 검토합니다.',
    trigger: c => `배우자 ${c.spouse?.name ?? ''}, 총자산 ${c.totalValue.toFixed(1)}억`,
    action: () => '배우자 증여 후 10년 합산, 향후 상속 배우자공제와 중복 효과를 비교',
    score: () => 68,
    benefit: () => 6 * 0.30,
  },
  {
    id: 'child-basic-deduction',
    title: '자녀별 10년 공제 분산',
    category: '증여',
    confidence: 'law_based',
    sourceType: 'official_rule',
    legalBasis: ['상증세법 §53 (증여재산공제)'],
    when: c => c.children.length > 0,
    summary: c => `자녀 ${c.children.length}명에게 공제와 세율 구간을 나누는 기본 케이스입니다.`,
    trigger: c => countText(c.children.length, '자녀'),
    action: () => '자녀별 현재 증여액, 10년 내 사전증여, 현금 납부능력을 함께 입력',
    score: c => 60 + c.children.length * 4,
  },
  {
    id: 'minor-child-deduction',
    title: '미성년 자녀 공제 축소',
    category: '리스크',
    confidence: 'law_based',
    sourceType: 'official_rule',
    legalBasis: ['상증세법 §53 (미성년 직계비속 공제)'],
    when: c => c.children.some(child => child.age < 19),
    summary: () => '미성년 자녀는 성년 자녀보다 공제가 작아 세액이 크게 달라질 수 있습니다.',
    trigger: c => c.children.filter(child => child.age < 19).map(child => child.name).join(', '),
    action: () => '미성년 수증자와 성년 수증자를 분리해 증여 순서를 조정',
    score: () => 64,
  },
  {
    id: 'marriage-birth-bonus',
    title: '혼인·출산 추가공제 검토',
    category: '증여',
    confidence: 'law_based',
    sourceType: 'official_rule',
    legalBasis: ['상증세법 §53의2 (혼인·출산 증여재산공제)'],
    when: c => c.children.some(child => child.age >= 20 && child.age <= 45),
    summary: () => '혼인·출산 이벤트가 있으면 추가 공제 적용 가능성을 별도 확인해야 합니다.',
    trigger: c => c.children.filter(child => child.age >= 20 && child.age <= 45).map(child => child.name).join(', '),
    action: () => '혼인신고일·출산일 기준 적용 기간과 기존 사용 여부를 입력',
    score: () => 57,
  },
  {
    id: 'grandchild-generation-skip',
    title: '손자녀 세대생략 증여',
    category: '증여',
    confidence: 'law_based',
    sourceType: 'official_rule',
    legalBasis: ['상증세법 §57 (세대생략 할증)'],
    when: c => c.grandchildren.length > 0 && c.totalValue >= 15,
    summary: () => '세대생략 할증을 부담하더라도 한 세대를 건너뛰는 효과를 비교합니다.',
    trigger: c => countText(c.grandchildren.length, '손자녀'),
    action: () => '자녀 증여안과 손자녀 증여안을 20년 순자산 기준으로 비교',
    score: () => 66,
  },
  {
    id: 'minor-grandchild-surcharge',
    title: '미성년 손자녀 고액증여 할증',
    category: '리스크',
    confidence: 'law_based',
    sourceType: 'official_rule',
    legalBasis: ['상증세법 §57 (미성년 세대생략 할증)'],
    when: c => c.grandchildren.some(g => g.age < 19) && c.totalValue >= 20,
    summary: () => '미성년 손자녀 고액증여는 일반 세대생략보다 할증 리스크가 큽니다.',
    trigger: c => c.grandchildren.filter(g => g.age < 19).map(g => g.name).join(', '),
    action: () => '손자녀별 증여 한도를 작게 나누고 자녀 증여안과 비교',
    score: () => 70,
  },
  {
    id: 'inlaw-five-year-lookback',
    title: '며느리·사위 5년 합산 활용',
    category: '증여',
    confidence: 'input_estimate',
    sourceType: 'case_pattern',
    legalBasis: ['상증세법 §13 (상속재산 가산 기간)'],
    when: c => c.inLaws.length > 0 && (c.owner?.age ?? 0) < 85,
    summary: () => '상속인이 아닌 며느리·사위 증여는 5년 합산 기간을 별도 검토합니다.',
    trigger: c => c.inLaws.map(m => m.name).join(', '),
    action: () => '가족관계 안정성, 이혼 리스크, 실질 귀속을 함께 검토',
    score: () => 59,
  },
  {
    id: 'ten-year-gift-ladder',
    title: '10년 주기 증여 사다리',
    category: '증여',
    confidence: 'law_based',
    sourceType: 'official_rule',
    legalBasis: ['상증세법 §53 (10년 합산 공제)'],
    when: c => c.recipients.length >= 2 && c.totalValue >= 10,
    summary: () => '수증자별 공제가 10년 단위로 리셋되는 점을 장기 플랜에 반영합니다.',
    trigger: c => `수증자 ${c.recipients.length}명`,
    action: () => '지금·10년 후·20년 후 증여 캘린더를 생성',
    score: () => 72,
  },
  {
    id: 'growth-first-transfer',
    title: '고성장 자산 우선 이전',
    category: '증여',
    confidence: 'input_estimate',
    sourceType: 'official_rule',
    legalBasis: ['상증세법 §13 (증여 당시 가액 합산)'],
    when: c => c.highGrowthAssets.length > 0 && c.recipients.length > 0,
    summary: c => `${countText(c.highGrowthAssets.length, '고성장 자산')}은 성장분 분리 효과가 큽니다.`,
    trigger: c => c.highGrowthAssets.map(a => a.name).slice(0, 3).join(', '),
    action: () => '성장률 높은 자산부터 공제·세율 구간에 맞춰 이전',
    score: () => 78,
    benefit: c => c.highGrowthAssets.reduce((s, a) => s + a.current_value * 0.20, 0),
  },
  {
    id: 'low-assessed-value-transfer',
    title: '공시가 낮은 부동산 이전',
    category: '증여',
    confidence: 'expert_review',
    sourceType: 'case_pattern',
    legalBasis: ['상증세법 §60 (평가 원칙)'],
    when: c => c.realEstateAssets.some(a => {
      const assessed = assessedValue(a);
      return assessed !== null && assessed < a.current_value * 0.75;
    }),
    summary: () => '공시가와 시가 차이가 큰 자산은 평가방법 확인이 절세의 핵심입니다.',
    trigger: c => c.realEstateAssets.filter(a => {
      const assessed = assessedValue(a);
      return assessed !== null && assessed < a.current_value * 0.75;
    }).map(a => a.name).join(', '),
    action: () => '유사매매사례, 감정평가, 공시가격 보충평가 가능성을 확인',
    score: () => 69,
  },
  {
    id: 'burdened-gift-debt',
    title: '채무부 부동산 부담부증여',
    category: '증여',
    confidence: 'input_estimate',
    sourceType: 'official_rule',
    legalBasis: ['소득세법 시행령 §159', '상증세법 §47'],
    when: c => c.highDebtAssets.length > 0 && Boolean(c.child),
    summary: () => '채무 인수분과 순증여분을 나누어 세금을 비교합니다.',
    trigger: c => c.highDebtAssets.map(a => a.name).join(', '),
    action: () => '수증자 상환능력 증빙과 채무 승계 가능성을 먼저 확인',
    score: () => 84,
  },
  {
    id: 'jeonse-burdened-gift',
    title: '전세보증금 승계 부담부증여',
    category: '증여',
    confidence: 'input_estimate',
    sourceType: 'official_rule',
    legalBasis: ['소득세법 시행령 §159', '지방세법 취득세 규정'],
    when: c => c.assets.some(a => (a.jeonse_deposit || 0) > 0),
    summary: () => '전세보증금은 채무 인수분으로 인정될 여지가 있어 부담부증여 비교 대상입니다.',
    trigger: c => c.assets.filter(a => (a.jeonse_deposit || 0) > 0).map(a => a.name).join(', '),
    action: () => '임대차계약서, 보증금 반환의무 승계, 실제 채무 부담자를 확인',
    score: () => 77,
  },
  {
    id: 'debt-repayment-proof',
    title: '채무 상환능력 증빙 리스크',
    category: '리스크',
    confidence: 'expert_review',
    sourceType: 'case_pattern',
    legalBasis: ['상증세법상 실질과세 및 채무 인정 검토'],
    when: c => c.child !== undefined && c.highDebtAssets.length > 0 && c.child.annual_income <= 0.3,
    summary: () => '수증자의 소득·재산이 약하면 채무 인수가 부인될 수 있습니다.',
    trigger: c => `${c.child?.name} 연소득 ${c.child?.annual_income.toFixed(1)}억`,
    action: () => '상환 스케줄, 이자 납부 계좌, 임대수익 귀속을 사전 설계',
    score: () => 73,
  },
  {
    id: 'related-party-safe-price',
    title: '가족 간 저가매매 안전가액',
    category: '매매',
    confidence: 'law_based',
    sourceType: 'official_rule',
    legalBasis: ['상증세법 §35', '상증세법 시행령 §26'],
    when: c => c.realEstateAssets.some(a => a.current_value >= 8) && Boolean(c.child),
    summary: () => '시가와 거래가 차액이 기준금액을 넘는지 자동 테스트합니다.',
    trigger: c => c.realEstateAssets.filter(a => a.current_value >= 8).map(a => a.name).slice(0, 3).join(', '),
    action: () => '실제 대금 지급, 자금출처, 시가 산정 근거를 함께 확보',
    score: () => 74,
  },
  {
    id: 'lineal-sale-presumption',
    title: '직계존비속 양도 증여추정',
    category: '리스크',
    confidence: 'law_based',
    sourceType: 'official_rule',
    legalBasis: ['상증세법 §44 (배우자 등에게 양도한 재산의 증여 추정)'],
    when: c => Boolean(c.child) && c.realEstateAssets.length > 0,
    summary: () => '직계존비속 매매는 실제 매매대금 지급을 강하게 입증해야 합니다.',
    trigger: c => `${c.child?.name} 대상 가족 간 거래 가능성`,
    action: () => '계약서, 계좌이체, 자금출처, 대출 실행 내역을 거래 전 확보',
    score: () => 71,
  },
  {
    id: 'buyer-funding-source',
    title: '매수자 자금출처 조사 리스크',
    category: '리스크',
    confidence: 'expert_review',
    sourceType: 'case_pattern',
    legalBasis: ['상증세법상 재산취득자금 증여추정 검토'],
    when: c => c.child !== undefined && c.child.cash_hold < c.totalValue * 0.05,
    summary: () => '가족 간 매매에서 매수자의 자금출처가 약하면 증여추정 위험이 있습니다.',
    trigger: c => `${c.child?.name} 보유현금 ${c.child?.cash_hold.toFixed(1)}억`,
    action: () => '매수자 소득, 대출 가능액, 기존 자산 처분계획을 먼저 구성',
    score: () => 70,
  },
  {
    id: 'cgt-market-recalculation',
    title: '저가양도 부당행위계산 부인',
    category: '리스크',
    confidence: 'input_estimate',
    sourceType: 'official_rule',
    legalBasis: ['소득세법 §101 (부당행위계산)'],
    when: c => c.realEstateAssets.some(a => a.current_value > Math.max(a.acquisition_cost * 1.5, 8)),
    summary: () => '가족 간 저가양도는 양도세가 시가 기준으로 재계산될 수 있습니다.',
    trigger: c => c.realEstateAssets.filter(a => a.current_value > Math.max(a.acquisition_cost * 1.5, 8)).map(a => a.name).join(', '),
    action: () => '매매가를 증여세 기준뿐 아니라 양도세 시가 재계산 기준으로도 검토',
    score: () => 65,
  },
  {
    id: 'primary-home-one-house',
    title: '1세대1주택 양도세/상속공제',
    category: '현금흐름',
    confidence: 'input_estimate',
    sourceType: 'official_rule',
    legalBasis: ['소득세법 §89', '상증세법 §23의2'],
    when: c => Boolean(c.primaryHome),
    summary: () => '거주주택은 양도세 비과세와 동거주택 상속공제를 같이 봐야 합니다.',
    trigger: c => c.primaryHome?.name ?? '',
    action: () => '보유·거주기간, 동거기간, 상속인 요건을 입력',
    score: () => 63,
  },
  {
    id: 'multi-house-acquisition-tax',
    title: '다주택 취득세 중과',
    category: '리스크',
    confidence: 'input_estimate',
    sourceType: 'official_rule',
    legalBasis: ['지방세법 취득세 중과 규정'],
    when: c => c.assets.some(a => isResidential(a) && (a.house_count ?? 1) >= 2),
    summary: () => '증여·매매 후 수증자 주택 수에 따라 취득세가 크게 달라집니다.',
    trigger: c => c.assets.filter(a => isResidential(a) && (a.house_count ?? 1) >= 2).map(a => a.name).join(', '),
    action: () => '수증자별 기존 주택 수와 규제지역 여부를 별도 입력',
    score: () => 68,
  },
  {
    id: 'gift-carryover-sale',
    title: '증여 후 단기매각 이월과세',
    category: '리스크',
    confidence: 'law_based',
    sourceType: 'official_rule',
    legalBasis: ['소득세법 §97의2 (이월과세)'],
    when: c => c.realEstateAssets.some(a => a.current_value > a.acquisition_cost * 1.2),
    summary: () => '배우자·직계존비속 증여 후 단기매각은 원취득가 기준 과세가 될 수 있습니다.',
    trigger: c => c.realEstateAssets.filter(a => a.current_value > a.acquisition_cost * 1.2).map(a => a.name).slice(0, 3).join(', '),
    action: () => '증여 후 5년 내 매각 계획이 있으면 즉시 경고',
    score: () => 76,
  },
  {
    id: 'long-term-holding-deduction',
    title: '장기보유특별공제 매각 시점',
    category: '현금흐름',
    confidence: 'input_estimate',
    sourceType: 'official_rule',
    legalBasis: ['소득세법 §95'],
    when: c => c.realEstateAssets.some(a => assetHoldingYears(a) >= 3 && a.current_value > a.acquisition_cost),
    summary: () => '매각형 전략은 장기보유특별공제 구간을 넘긴 뒤 파는지 비교해야 합니다.',
    trigger: c => c.realEstateAssets.filter(a => assetHoldingYears(a) >= 3).map(a => a.name).slice(0, 3).join(', '),
    action: () => '3년·5년·10년·15년 보유 구간별 양도세를 비교',
    score: () => 58,
  },
  {
    id: 'regulated-area-sale',
    title: '규제지역 매각·취득 리스크',
    category: '리스크',
    confidence: 'expert_review',
    sourceType: 'case_pattern',
    legalBasis: ['소득세법·지방세법 다주택/규제지역 규정 검토'],
    when: c => c.assets.some(a => a.is_regulated_area),
    summary: () => '규제지역 자산은 매각·증여·취득세 가정이 일반 자산과 달라질 수 있습니다.',
    trigger: c => c.assets.filter(a => a.is_regulated_area).map(a => a.name).join(', '),
    action: () => '조정대상지역 여부와 취득 당시/양도 당시 규정을 분리 확인',
    score: () => 61,
  },
  {
    id: 'rental-corp-conversion-rule',
    title: '임대법인 전환',
    category: '법인',
    confidence: 'expert_review',
    sourceType: 'case_pattern',
    legalBasis: ['조특법 §32', '법인세법'],
    when: c => c.rentalIncome >= 0.5,
    summary: () => '임대수익이 있으면 개인 종합소득세와 법인세/급여/배당 조합을 비교합니다.',
    trigger: c => `연 임대수익 ${c.rentalIncome.toFixed(1)}억`,
    action: () => '현물출자 비율, 대표 급여, 배당, 지분 승계 플랜을 같이 산출',
    score: c => 75 + Math.min(10, c.rentalIncome * 3),
    benefit: c => c.rentalIncome * 0.18 * 10,
  },
  {
    id: 'corp-ceo-salary',
    title: '대표이사 급여 최적화',
    category: '법인',
    confidence: 'input_estimate',
    sourceType: 'case_pattern',
    legalBasis: ['법인세법 손금산입 및 부당행위계산 검토'],
    when: c => c.rentalIncome >= 0.5 && Boolean(c.owner),
    summary: () => '법인 전환 시 대표 급여가 낮아도, 높아도 전체 세부담이 틀어집니다.',
    trigger: c => `대표 후보 ${c.owner?.name ?? '본인'}`,
    action: () => '급여 25%·40%·55% 시나리오를 비교',
    score: () => 73,
  },
  {
    id: 'corp-share-split',
    title: '법인 지분 분산',
    category: '법인',
    confidence: 'expert_review',
    sourceType: 'case_pattern',
    legalBasis: ['상증세법 비상장주식 평가', '상법 지배권 검토'],
    when: c => c.rentalIncome >= 0.5 && c.children.length > 0,
    summary: () => '본인 지배권과 자녀 지분 승계를 동시에 설계해야 합니다.',
    trigger: c => `자녀 ${c.children.length}명`,
    action: () => '본인 51% 이상 유지, 자녀 지분 분산, 배우자 지분 여부를 비교',
    score: () => 72,
  },
  {
    id: 'corp-dividend-policy',
    title: '배당정책 설계',
    category: '법인',
    confidence: 'input_estimate',
    sourceType: 'case_pattern',
    legalBasis: ['소득세법 배당소득 과세', '법인세법'],
    when: c => c.rentalIncome >= 0.8,
    summary: () => '법인 이익을 급여로 뺄지 배당으로 뺄지에 따라 세후 현금흐름이 달라집니다.',
    trigger: c => `법인 전환 대상 수익 ${c.rentalIncome.toFixed(1)}억`,
    action: () => '급여·배당·유보 3분법으로 현금흐름을 비교',
    score: () => 67,
  },
  {
    id: 'corp-five-year-recapture',
    title: '법인전환 5년 사후관리',
    category: '리스크',
    confidence: 'law_based',
    sourceType: 'official_rule',
    legalBasis: ['조특법 §32 (이월과세 사후관리)'],
    when: c => c.rentalAssets.length > 0 && c.totalValue >= 10,
    summary: () => '법인전환 후 단기 해산·처분은 이월과세 추징 리스크가 있습니다.',
    trigger: c => countText(c.rentalAssets.length, '전환 가능 자산'),
    action: () => '5년 보유, 처분 제한, 사업 실체 요건을 체크리스트화',
    score: () => 65,
  },
  {
    id: 'property-rich-company',
    title: '부동산과다보유법인 평가',
    category: '법인',
    confidence: 'expert_review',
    sourceType: 'case_pattern',
    legalBasis: ['상증세법 비상장주식 보충적 평가'],
    when: c => c.realEstateAssets.reduce((s, a) => s + a.current_value, 0) / Math.max(c.totalValue, 1) > 0.7,
    summary: () => '부동산 비중이 높은 법인은 비상장주식 할인 기대가 제한될 수 있습니다.',
    trigger: () => '부동산 중심 포트폴리오',
    action: () => '순자산가치 평가와 수익가치 평가 가능성을 세무사에게 확인',
    score: () => 69,
  },
  {
    id: 'family-employment',
    title: '가족 임원·직원 급여 실질성',
    category: '리스크',
    confidence: 'expert_review',
    sourceType: 'case_pattern',
    legalBasis: ['법인세법 손금 및 부당행위계산 검토'],
    when: c => c.rentalIncome >= 0.5 && c.recipients.length > 1,
    summary: () => '가족 급여는 실제 근무와 직무 증빙이 없으면 비용 인정이 흔들립니다.',
    trigger: c => `가족 구성원 ${c.recipients.length}명`,
    action: () => '직무기술서, 근무기록, 급여 수준 비교표를 준비',
    score: () => 58,
  },
  {
    id: 'unlisted-stock-gift',
    title: '비상장주식 증여',
    category: '증여',
    confidence: 'expert_review',
    sourceType: 'case_pattern',
    legalBasis: ['상증세법 비상장주식 평가 규정'],
    when: c => c.unlistedStockAssets.length > 0 && c.recipients.length > 0,
    summary: () => '비상장주식은 순자산가치·수익가치 평가와 지분율 변동을 같이 봅니다.',
    trigger: c => c.unlistedStockAssets.map(a => a.name).join(', '),
    action: () => '평가기준일 재무제표, 순손익, 부동산 보유 비중을 입력',
    score: () => 72,
  },
  {
    id: 'family-business-succession',
    title: '가업승계 사전검토',
    category: '법인',
    confidence: 'expert_review',
    sourceType: 'case_pattern',
    legalBasis: ['상증세법 가업상속·가업승계 증여 특례 검토'],
    when: c => c.unlistedStockAssets.some(a => a.current_value >= 5),
    summary: () => '비상장주식 규모가 크면 가업승계 특례 가능성을 별도 검토합니다.',
    trigger: c => c.unlistedStockAssets.filter(a => a.current_value >= 5).map(a => a.name).join(', '),
    action: () => '업종, 지분 보유기간, 대표 재직, 사후관리 요건을 확인',
    score: () => 64,
  },
  {
    id: 'public-foundation-real-estate',
    title: '공익법인 부동산 출연',
    category: '공익',
    confidence: 'expert_review',
    sourceType: 'official_rule',
    legalBasis: ['상증세법 §16', '상증세법 §48'],
    when: c => c.totalValue >= 20 && c.realEstateAssets.length > 0,
    summary: () => '부동산 출연은 과세가액 불산입과 직접 공익목적 사용 요건을 같이 봅니다.',
    trigger: c => c.realEstateAssets.map(a => a.name).slice(0, 2).join(', '),
    action: () => '공익목적 사용계획, 임대수익 사용처, 사후관리 의무를 검토',
    score: () => 60,
  },
  {
    id: 'public-foundation-stock-limit',
    title: '공익법인 주식 출연 한도',
    category: '공익',
    confidence: 'law_based',
    sourceType: 'official_rule',
    legalBasis: ['상증세법 §16', '상증세법 §48'],
    when: c => c.stockAssets.length > 0 && c.totalValue >= 10,
    summary: () => '주식 출연은 지분율 한도와 특수관계인 지배 가능성이 핵심입니다.',
    trigger: c => c.stockAssets.map(a => a.name).join(', '),
    action: () => '주식 종류별 지분율, 의결권, 특수관계인 보유분을 입력',
    score: () => 62,
  },
  {
    id: 'foundation-board-related-party',
    title: '공익법인 특수관계 이사 제한',
    category: '리스크',
    confidence: 'expert_review',
    sourceType: 'official_rule',
    legalBasis: ['상증세법 §48 (공익법인 사후관리)'],
    when: c => c.totalValue >= 20 && c.recipients.length >= 2,
    summary: () => '가족 중심 이사회는 공익법인 사후관리 위반 리스크가 있습니다.',
    trigger: c => `가족 후보 ${c.recipients.length}명`,
    action: () => '특수관계인 이사 비율, 외부이사, 감사 요건을 설계',
    score: () => 55,
  },
  {
    id: 'foundation-use-duty',
    title: '공익목적 사용·보고 의무',
    category: '리스크',
    confidence: 'expert_review',
    sourceType: 'official_rule',
    legalBasis: ['상증세법 §48'],
    when: c => c.totalValue >= 20,
    summary: () => '공익법인은 절세보다 사후관리 실패 시 추징 리스크가 더 큽니다.',
    trigger: () => '고액자산 공익출연 가능성',
    action: () => '연간 사용, 결산공시, 외부감사, 전용계좌 의무를 체크',
    score: () => 54,
  },
  {
    id: 'installment-payment',
    title: '상속세 연부연납',
    category: '현금흐름',
    confidence: 'law_based',
    sourceType: 'official_rule',
    legalBasis: ['상증세법 §71'],
    when: c => c.totalValue >= 10 && c.totalCash < c.totalValue * 0.15,
    summary: () => '현금이 부족하면 연부연납 가산금과 담보 제공 가능성을 먼저 봅니다.',
    trigger: c => `현금성 재원 ${c.totalCash.toFixed(1)}억`,
    action: () => '6개월 납부액, 10년 분납, 가산금, 담보 제공 자산을 계산',
    score: () => 78,
  },
  {
    id: 'in-kind-payment',
    title: '물납 가능성',
    category: '현금흐름',
    confidence: 'expert_review',
    sourceType: 'official_rule',
    legalBasis: ['상증세법 §73'],
    when: c => c.realEstateAssets.length > 0 && c.totalCash < c.totalValue * 0.08,
    summary: () => '현금 납부가 어려우면 물납 가능성과 처분 우선순위를 검토합니다.',
    trigger: c => c.realEstateAssets.map(a => a.name).slice(0, 3).join(', '),
    action: () => '물납 가능 재산, 관리·처분 부적당 재산 여부를 확인',
    score: () => 66,
  },
  {
    id: 'tax-loan-dscr',
    title: '상속세 담보대출 DSCR',
    category: '현금흐름',
    confidence: 'input_estimate',
    sourceType: 'case_pattern',
    legalBasis: ['금융기관 담보대출 심사 및 상속세 납부재원 검토'],
    when: c => c.realEstateAssets.length > 0 && c.totalCash < c.totalValue * 0.15,
    summary: () => '상속세 재원 대출은 LTV보다 이자상환 가능성이 먼저입니다.',
    trigger: c => `현금성 재원 비율 ${((c.totalCash / Math.max(c.totalValue, 1)) * 100).toFixed(0)}%`,
    action: () => '자산별 LTV, 금리 스트레스, 임대수익 DSCR을 산출',
    score: () => 75,
  },
  {
    id: 'forced-sale-discount',
    title: '급매 할인 리스크',
    category: '리스크',
    confidence: 'input_estimate',
    sourceType: 'case_pattern',
    legalBasis: ['상속세 신고기한 및 양도소득세 검토'],
    when: c => c.totalCash < c.totalValue * 0.05 && c.realEstateAssets.length > 0,
    summary: () => '납부기한에 쫓겨 매각하면 급매 할인과 양도세가 동시에 발생합니다.',
    trigger: c => `현금성 재원 ${c.totalCash.toFixed(1)}억`,
    action: () => '급매 대상 자산을 정하지 말고 담보대출·연부연납과 먼저 비교',
    score: () => 73,
  },
  {
    id: 'low-yield-sale',
    title: '저수익 자산 매각',
    category: '현금흐름',
    confidence: 'input_estimate',
    sourceType: 'case_pattern',
    legalBasis: ['소득세법 양도소득세', '금융소득 과세 검토'],
    when: c => c.lowYieldAssets.length > 0 && c.totalValue >= 10,
    summary: () => '수익률이 낮은 자산은 매각 후 금융운용과 보유를 비교합니다.',
    trigger: c => c.lowYieldAssets.map(a => a.name).slice(0, 3).join(', '),
    action: () => '양도세 후 순현금과 예금·채권·주식 포트폴리오를 복리 비교',
    score: () => 67,
  },
  {
    id: 'cash-portfolio-after-sale',
    title: '매각 후 금융 포트폴리오',
    category: '현금흐름',
    confidence: 'input_estimate',
    sourceType: 'case_pattern',
    legalBasis: ['금융소득 과세 및 종합과세 검토'],
    when: c => c.totalValue >= 10 && c.annualYield < 0.025,
    summary: () => '현금화 이후 예금·채권·국내주식·해외주식 운용수익률을 반영합니다.',
    trigger: c => `현재 자산수익률 ${(c.annualYield * 100).toFixed(1)}%`,
    action: () => '현금흐름형에서 세후 복리 운용률과 금융소득 종합과세를 비교',
    score: () => 63,
  },
  {
    id: 'financial-income-global-tax',
    title: '금융소득 종합과세',
    category: '리스크',
    confidence: 'input_estimate',
    sourceType: 'official_rule',
    legalBasis: ['소득세법 금융소득 종합과세'],
    when: c => c.stockAssets.reduce((s, a) => s + a.current_value * ((a.dividend_yield_pct ?? a.annual_yield_pct) || 0) / 100, 0) >= 0.2,
    summary: () => '배당·이자소득이 커지면 분리과세만으로 끝나지 않을 수 있습니다.',
    trigger: c => `금융자산 ${c.stockAssets.length}개`,
    action: () => '가족별 금융소득 분산과 종합소득세율을 반영',
    score: () => 58,
  },
  {
    id: 'related-party-loan-interest',
    title: '가족 간 차용증 적정이자',
    category: '리스크',
    confidence: 'law_based',
    sourceType: 'official_rule',
    legalBasis: ['상증세법 §41의4 (금전 무상대출 등에 따른 이익의 증여)'],
    when: c => c.totalCash < c.totalValue * 0.1 && c.recipients.length > 0,
    summary: () => '가족 간 자금대여는 적정이자와 실제 이자 지급을 남겨야 합니다.',
    trigger: c => `수증자/차입 후보 ${c.recipients.length}명`,
    action: () => '차용증, 이자율, 원리금 상환 내역, 이자 원천을 관리',
    score: () => 64,
  },
  {
    id: 'interest-underpayment-gift',
    title: '이자 미지급 증여의제',
    category: '리스크',
    confidence: 'law_based',
    sourceType: 'official_rule',
    legalBasis: ['상증세법 §41의4'],
    when: c => c.totalDebt >= 3 || c.totalCash < c.totalValue * 0.1,
    summary: () => '가족 간 대여금의 이자 미지급은 증여로 볼 수 있습니다.',
    trigger: c => `총부채 ${c.totalDebt.toFixed(1)}억`,
    action: () => '법정 적정이자율과 증여세 부과 기준을 반영',
    score: () => 61,
  },
  {
    id: 'recipient-tax-cash',
    title: '수증자 증여세 납부능력',
    category: '리스크',
    confidence: 'input_estimate',
    sourceType: 'case_pattern',
    legalBasis: ['상증세법 증여세 납세의무 및 자금출처 검토'],
    when: c => c.recipients.some(r => r.cash_hold < 0.5) && c.totalValue >= 10,
    summary: () => '수증자가 증여세를 낼 현금이 없으면 다시 자금증여 문제가 생깁니다.',
    trigger: c => c.recipients.filter(r => r.cash_hold < 0.5).map(r => r.name).join(', '),
    action: () => '증여세 납부재원까지 같이 이전하거나 대출 구조를 검토',
    score: () => 66,
  },
  {
    id: 'asset-manager-succession',
    title: '관리자 승계',
    category: '리스크',
    confidence: 'expert_review',
    sourceType: 'case_pattern',
    legalBasis: ['민법·상법·세법 종합 검토'],
    when: c => (c.owner?.age ?? 0) >= 75 && c.realEstateAssets.length >= 2,
    summary: () => '고령 보유자가 여러 자산을 관리하면 실행 권한 승계가 세금만큼 중요합니다.',
    trigger: c => `본인 나이 ${c.owner?.age ?? 0}세, 부동산 ${c.realEstateAssets.length}개`,
    action: () => '위임장, 법인 대표, 자산관리자, 임대차 관리 권한을 정리',
    score: () => 57,
  },
  {
    id: 'will-and-partition',
    title: '유언·상속재산분할 리스크',
    category: '리스크',
    confidence: 'expert_review',
    sourceType: 'case_pattern',
    legalBasis: ['민법 유류분·상속재산분할', '상증세법 신고기한'],
    when: c => c.children.length >= 2 && c.totalValue >= 10,
    summary: () => '자녀가 여러 명이면 절세안보다 분쟁 방지가 먼저일 수 있습니다.',
    trigger: c => `자녀 ${c.children.length}명`,
    action: () => '자산별 귀속, 유류분, 세금 납부자, 대출 부담자를 명시',
    score: () => 55,
  },
  {
    id: 'unequal-gift-equalization',
    title: '불균등 증여 보정',
    category: '리스크',
    confidence: 'expert_review',
    sourceType: 'case_pattern',
    legalBasis: ['민법 특별수익·유류분', '상증세법 사전증여 합산'],
    when: c => c.children.length >= 2 && c.highGrowthAssets.length > 0,
    summary: () => '특정 자녀에게 성장자산을 몰아주면 가족 간 정산 문제가 생깁니다.',
    trigger: c => c.highGrowthAssets.map(a => a.name).slice(0, 2).join(', '),
    action: () => '증여 당시가액과 미래가액을 나누어 형평 조정표를 생성',
    score: () => 54,
  },
  {
    id: 'insurance-beneficiary',
    title: '보험금 수익자 지정',
    category: '현금흐름',
    confidence: 'expert_review',
    sourceType: 'case_pattern',
    legalBasis: ['상증세법 보험금 과세 검토'],
    when: c => c.assets.some(a => a.asset_type === '보험'),
    summary: () => '보험은 계약자·피보험자·수익자 조합에 따라 상속/증여 과세가 달라집니다.',
    trigger: c => c.assets.filter(a => a.asset_type === '보험').map(a => a.name).join(', '),
    action: () => '계약자, 피보험자, 수익자, 보험료 납입자를 분리 입력',
    score: () => 60,
  },
  {
    id: 'financial-asset-deduction',
    title: '금융재산 상속공제',
    category: '현금흐름',
    confidence: 'law_based',
    sourceType: 'official_rule',
    legalBasis: ['상증세법 금융재산 상속공제'],
    when: c => c.assets.some(a => ['예금', '채권', '국내주식', '해외주식', '금융자산'].includes(a.asset_type)),
    summary: () => '금융재산은 상속공제와 납부재원 역할을 동시에 합니다.',
    trigger: c => c.assets.filter(a => ['예금', '채권', '국내주식', '해외주식', '금융자산'].includes(a.asset_type)).map(a => a.name).join(', '),
    action: () => '금융재산공제 한도와 상속세 납부재원으로 쓸 금액을 분리',
    score: () => 56,
  },
  {
    id: 'overseas-stock-currency',
    title: '해외주식 환율·양도세',
    category: '리스크',
    confidence: 'input_estimate',
    sourceType: 'official_rule',
    legalBasis: ['소득세법 국외주식 양도소득 과세'],
    when: c => c.assets.some(a => a.asset_type === '해외주식'),
    summary: () => '해외주식은 환율, 양도세, 금융소득을 별도 반영해야 합니다.',
    trigger: c => c.assets.filter(a => a.asset_type === '해외주식').map(a => a.name).join(', '),
    action: () => '취득환율, 양도환율, 배당소득, 외국납부세액을 입력',
    score: () => 52,
  },
  {
    id: 'farmland-transfer',
    title: '농지 증여·매각 자격',
    category: '리스크',
    confidence: 'expert_review',
    sourceType: 'case_pattern',
    legalBasis: ['농지법 및 양도소득세 감면 규정 검토'],
    when: c => c.assets.some(a => a.asset_type === '농지'),
    summary: () => '농지는 취득자격, 자경요건, 감면요건이 세금 계산보다 먼저입니다.',
    trigger: c => c.assets.filter(a => a.asset_type === '농지').map(a => a.name).join(', '),
    action: () => '농지취득자격, 자경기간, 감면 가능성을 별도 검토',
    score: () => 58,
  },
  {
    id: 'forest-land-valuation',
    title: '임야·토지 보충평가',
    category: '증여',
    confidence: 'expert_review',
    sourceType: 'case_pattern',
    legalBasis: ['상증세법 §60~§61 (부동산 평가)'],
    when: c => c.assets.some(a => ['토지', '임야'].includes(a.asset_type)),
    summary: () => '토지·임야는 유사매매사례와 공시지가 차이가 커 평가가 핵심입니다.',
    trigger: c => c.assets.filter(a => ['토지', '임야'].includes(a.asset_type)).map(a => a.name).join(', '),
    action: () => '감정평가 2개 여부, 유사매매사례, 개발계획을 확인',
    score: () => 57,
  },
  {
    id: 'commercial-building-vat',
    title: '상가 매각 부가세·포괄양수도',
    category: '리스크',
    confidence: 'expert_review',
    sourceType: 'case_pattern',
    legalBasis: ['부가가치세법 사업양도 검토', '소득세법 양도세'],
    when: c => c.assets.some(a => a.asset_type === '상업용부동산'),
    summary: () => '상업용부동산 매각은 양도세 외 부가세·포괄양수도 여부가 중요합니다.',
    trigger: c => c.assets.filter(a => a.asset_type === '상업용부동산').map(a => a.name).join(', '),
    action: () => '건물/토지 안분, 임대사업자 지위, 포괄양수도 가능성을 확인',
    score: () => 62,
  },
  {
    id: 'rent-growth-vacancy',
    title: '임대료 상승·공실 스트레스',
    category: '현금흐름',
    confidence: 'input_estimate',
    sourceType: 'case_pattern',
    legalBasis: ['임대소득세 및 현금흐름 추정'],
    when: c => c.rentalAssets.length > 0,
    summary: () => '임대자산은 세금보다 공실과 수선비가 DSCR을 깨는 경우가 많습니다.',
    trigger: c => countText(c.rentalAssets.length, '임대 가능 자산'),
    action: () => '공실률, 수선비, 임대료 상승률을 스트레스 테스트',
    score: () => 53,
  },
  {
    id: 'asset-location-concentration',
    title: '지역·자산 집중 리스크',
    category: '리스크',
    confidence: 'expert_review',
    sourceType: 'case_pattern',
    legalBasis: ['투자위험 및 상속세 납부재원 검토'],
    when: c => c.assets.some(a => a.current_value >= c.totalValue * 0.45),
    summary: () => '한 자산 비중이 너무 크면 분할증여와 납부재원 계획이 흔들립니다.',
    trigger: c => c.assets.filter(a => a.current_value >= c.totalValue * 0.45).map(a => a.name).join(', '),
    action: () => '지분증여, 담보대출, 일부 매각, 법인전환을 동시에 비교',
    score: () => 62,
  },
  {
    id: 'estate-tax-bracket-cliff',
    title: '상속세율 구간 절벽',
    category: '증여',
    confidence: 'law_based',
    sourceType: 'official_rule',
    legalBasis: ['상증세법 세율표'],
    when: c => c.totalValue >= 10,
    summary: () => '과세표준 구간이 올라갈수록 증여로 구간을 낮추는 효과가 커집니다.',
    trigger: c => `총자산 ${c.totalValue.toFixed(1)}억`,
    action: () => '현재 상속세율 구간과 증여 후 구간을 비교',
    score: () => 66,
  },
  {
    id: 'spouse-inheritance-deduction',
    title: '배우자 상속공제 배분',
    category: '증여',
    confidence: 'law_based',
    sourceType: 'official_rule',
    legalBasis: ['상증세법 배우자 상속공제'],
    when: c => Boolean(c.spouse) && c.totalValue >= 10,
    summary: () => '배우자에게 생전증여할지 상속공제를 남길지 비교해야 합니다.',
    trigger: c => `배우자 ${c.spouse?.name ?? ''}`,
    action: () => '배우자 생전증여, 상속 시 배우자공제, 2차 상속세를 같이 비교',
    score: () => 67,
  },
  {
    id: 'second-inheritance',
    title: '2차 상속세',
    category: '증여',
    confidence: 'input_estimate',
    sourceType: 'case_pattern',
    legalBasis: ['상증세법 배우자공제 및 사전증여 합산 검토'],
    when: c => Boolean(c.spouse) && c.children.length > 0 && c.totalValue >= 20,
    summary: () => '배우자에게 몰아주면 1차 상속세는 줄어도 2차 상속세가 커질 수 있습니다.',
    trigger: c => `배우자 + 자녀 ${c.children.length}명`,
    action: () => '1차/2차 상속을 합산한 순자산으로 비교',
    score: () => 71,
  },
  {
    id: 'charitable-donation-vs-foundation',
    title: '기부 vs 공익법인 설립',
    category: '공익',
    confidence: 'expert_review',
    sourceType: 'case_pattern',
    legalBasis: ['상증세법 §16·§48', '소득세법 기부금 공제 검토'],
    when: c => c.totalValue >= 20,
    summary: () => '공익 목적이면 직접 기부와 재단 설립을 비용·통제·사후관리로 비교합니다.',
    trigger: c => `총자산 ${c.totalValue.toFixed(1)}억`,
    action: () => '재단 설립비, 운영비, 외부감사, 가족 참여 제한을 비교',
    score: () => 51,
  },
  {
    id: 'documentation-pack',
    title: '증빙 패키지',
    category: '리스크',
    confidence: 'expert_review',
    sourceType: 'case_pattern',
    legalBasis: ['국세기본법 실질과세 및 세무조사 대응'],
    when: c => c.totalValue >= 10,
    summary: () => '가족 간 거래는 계산보다 증빙 누락이 더 자주 문제를 만듭니다.',
    trigger: () => '고액 가족거래 가능성',
    action: () => '계약서, 이사회 의사록, 감정평가, 계좌이체, 자금출처 파일을 묶어 관리',
    score: () => 60,
  },
];

export function analyzeTaxCases(
  assets: Asset[],
  members: FamilyMember[],
  macro: MacroSettings | null,
): TaxCaseInsight[] {
  const cases: TaxCaseInsight[] = [];
  const recipients = primaryRecipients(members);
  const child = bestChildRecipient(members);
  const totalValue = assets.reduce((sum, asset) => sum + asset.current_value, 0);
  const totalDebt = assets.reduce((sum, asset) => sum + (asset.loan_amount || 0) + (asset.jeonse_deposit || 0) + (asset.other_assumed_debt || 0), 0);
  const totalCash = members.reduce((sum, member) => sum + (member.cash_hold || 0), 0)
    + assets
      .filter(asset => ['예금', '예금채권', '금융자산', '채권', '국내주식', '해외주식'].includes(asset.asset_type))
      .reduce((sum, asset) => sum + Math.max(0, asset.current_value - (asset.loan_amount || 0)), 0);
  const rentalAssets = assets.filter(asset => ['주거용부동산', '상업용부동산', '토지', '오피스텔'].includes(asset.asset_type));
  const rentalIncome = rentalAssets.reduce((sum, asset) => sum + asset.current_value * asset.annual_yield_pct / 100, 0);
  const annualYield = totalValue > 0
    ? assets.reduce((sum, asset) => sum + asset.current_value * asset.annual_yield_pct / 100, 0) / totalValue
    : 0;
  const avgGrowth = totalValue > 0
    ? assets.reduce((sum, asset) => sum + asset.current_value * (asset.expected_growth_pct || 0) / 100, 0) / totalValue
    : 0;
  const owner = members.find(member => member.relation === '본인');
  const spouse = members.find(member => member.relation === '배우자');
  const children = members.filter(member => member.relation === '자녀');
  const grandchildren = members.filter(member => member.relation === '손자녀');
  const inLaws = members.filter(member => member.relation === '며느리' || member.relation === '사위');
  const realEstateAssets = assets.filter(asset => ['주거용부동산', '상업용부동산', '토지', '농지', '임야', '오피스텔'].includes(asset.asset_type));
  const stockAssets = assets.filter(asset => ['국내주식', '해외주식', '비상장주식'].includes(asset.asset_type));
  const unlistedStockAssets = assets.filter(asset => asset.asset_type === '비상장주식');
  const highDebtAssets = assets.filter(asset => {
    const debt = (asset.loan_amount || 0) + (asset.jeonse_deposit || 0) + (asset.other_assumed_debt || 0);
    return asset.current_value >= 5 && asset.current_value > 0 && debt / asset.current_value >= 0.25;
  });
  const highGrowthAssets = assets.filter(asset => (asset.expected_growth_pct || 0) >= 3 && asset.current_value >= 1);
  const lowYieldAssets = assets.filter(asset => asset.current_value >= 3 && (asset.annual_yield_pct || 0) < 1.5 && (asset.expected_growth_pct || 0) < 2);
  const primaryHome = assets.find(asset => asset.is_primary_residence);
  const ruleContext: TaxCaseContext = {
    assets,
    members,
    totalValue,
    totalDebt,
    totalCash,
    rentalAssets,
    rentalIncome,
    annualYield,
    avgGrowth,
    recipients,
    child,
    spouse,
    owner,
    children,
    grandchildren,
    inLaws,
    highDebtAssets,
    highGrowthAssets,
    lowYieldAssets,
    realEstateAssets,
    stockAssets,
    unlistedStockAssets,
    primaryHome,
  };

  for (const rule of TAX_CASE_RULES) {
    if (!rule.when(ruleContext)) continue;
    addCase(cases, {
      id: `rule-${rule.id}`,
      title: rule.title,
      category: rule.category,
      score: rule.score(ruleContext),
      summary: rule.summary(ruleContext),
      trigger: rule.trigger(ruleContext),
      recommendedAction: rule.action(ruleContext),
      estimatedBenefit: rule.benefit?.(ruleContext),
      confidence: rule.confidence,
      legalBasis: rule.legalBasis,
      sourceType: rule.sourceType,
    });
  }

  if (child) {
    for (const asset of rentalAssets) {
      const debt = (asset.loan_amount || 0) + (asset.jeonse_deposit || 0) + (asset.other_assumed_debt || 0);
      const debtRatio = asset.current_value > 0 ? debt / asset.current_value : 0;
      if (asset.current_value >= 5 && debtRatio >= 0.25) {
        const result = estimateBurdenedGiftTransfer({
          marketValue: asset.current_value,
          assessedValue: assessedValue(asset),
          acquisitionCost: asset.acquisition_cost,
          totalDebt: debt,
          holdingYears: assetHoldingYears(asset),
          relation: child.relation,
          recipientAge: child.age,
          isOneHouseOneFamily: Boolean(asset.is_primary_residence),
          houseCount: asset.house_count ?? 1,
          isRegulatedArea: Boolean(asset.is_regulated_area),
          isResidential: isResidential(asset),
          recipientCanProveDebtRepayment: child.annual_income > 0 || child.cash_hold > debt * 0.1,
          necessaryExpenses: asset.necessary_expenses ?? 0,
        });

        addCase(cases, {
          id: `burdened-gift-${asset.id}`,
          title: `${asset.name} 부담부증여 검토`,
          category: '증여',
          score: 82 + Math.min(12, debtRatio * 20),
          summary: `채무비율 ${(debtRatio * 100).toFixed(0)}%라 순증여분과 채무인수분을 나누어 검토할 여지가 있습니다.`,
          trigger: `시가 ${asset.current_value.toFixed(1)}억, 인수 가능 채무 ${debt.toFixed(1)}억`,
          recommendedAction: `수증자 ${child.name}의 소득·재산으로 채무 상환 능력을 증빙한 뒤 부담부증여와 일반증여를 비교`,
          estimatedBenefit: Math.max(0, result.savingVsDirectGift),
          estimatedCost: result.total.amount,
          confidence: 'input_estimate',
          legalBasis: result.total.legalBasis,
          sourceType: 'official_rule',
        });
      }
    }
  }

  if (child) {
    const saleTargets = rentalAssets
      .filter(asset => asset.current_value >= 8)
      .sort((a, b) => b.current_value - a.current_value)
      .slice(0, 2);
    for (const asset of saleTargets) {
      const safePrice = asset.current_value - Math.min(asset.current_value * 0.30, 3);
      const result = estimateRelatedPartySale({
        marketValue: asset.current_value,
        salePrice: safePrice,
        acquisitionCost: asset.acquisition_cost,
        holdingYears: assetHoldingYears(asset),
        isOneHouseOneFamily: Boolean(asset.is_primary_residence),
        houseCount: asset.house_count ?? 1,
        isRegulatedArea: Boolean(asset.is_regulated_area),
        isResidential: isResidential(asset),
        relation: child.relation,
        necessaryExpenses: asset.necessary_expenses ?? 0,
      });
      addCase(cases, {
        id: `related-party-sale-${asset.id}`,
        title: `${asset.name} 가족 간 매매가 테스트`,
        category: '매매',
        score: result.savingVsDirectGift > 0 ? 76 : 58,
        summary: `증여세 의제 기준을 피하는 매매가를 역산해 직접증여와 비교합니다.`,
        trigger: `증여세 0원 가능 매매가 근사치 ${result.zeroGiftTaxOptimalPrice.toFixed(1)}억`,
        recommendedAction: '실제 대금 지급, 자금출처, 부당행위계산 부인 가능성을 함께 확인',
        estimatedBenefit: Math.max(0, result.savingVsDirectGift),
        estimatedCost: result.totalTax.amount,
        confidence: 'law_based',
        legalBasis: result.totalTax.legalBasis,
        sourceType: 'official_rule',
      });
    }
  }

  if (recipients.length > 0 && avgGrowth >= 0.025) {
    const candidateGift = totalValue * 0.20;
    const tax = recipients.reduce((sum, member) => (
      sum + calcGiftTaxPure(candidateGift / recipients.length, member.relation, 0, member.relation === '손자녀', member.age)
    ), 0);
    const growthRemoved = candidateGift * (Math.pow(1 + avgGrowth, 10) - 1);
    addCase(cases, {
      id: 'growth-asset-early-gift',
      title: '성장자산 선증여',
      category: '증여',
      score: 78,
      summary: `10년 뒤 성장분 약 ${growthRemoved.toFixed(1)}억을 상속세 과세 밖으로 분리하는 케이스입니다.`,
      trigger: `가중 평균 성장률 ${(avgGrowth * 100).toFixed(1)}%, 수증자 ${recipients.length}명`,
      recommendedAction: '성장률 높은 자산부터 수증자별 공제와 세율 구간을 나누어 증여',
      estimatedBenefit: growthRemoved * 0.45,
      estimatedCost: tax,
      confidence: 'input_estimate',
      legalBasis: ['상증세법 §13 (사전증여재산 합산)', '상증세법 §53 (증여재산공제)'],
      sourceType: 'official_rule',
    });
  }

  if (rentalIncome >= 0.5 && rentalAssets.length > 0) {
    addCase(cases, {
      id: 'rental-corp-conversion',
      title: '임대자산 법인전환 심화 검토',
      category: '법인',
      score: 74 + Math.min(15, rentalIncome * 4),
      summary: `연 임대수익 ${rentalIncome.toFixed(1)}억이면 대표 급여, 배당, 지분분산을 같이 설계할 필요가 있습니다.`,
      trigger: `수익형 부동산 ${rentalAssets.length}개, 연수익 ${rentalIncome.toFixed(1)}억`,
      recommendedAction: '현물출자 비율, 대표 급여, 자녀 지분, 배당정책을 10년 단위로 비교',
      estimatedBenefit: rentalIncome * 0.18 * 10,
      confidence: 'expert_review',
      legalBasis: ['조세특례제한법 §32 (법인전환 이월과세)', '상증세법상 비상장주식 평가 규정 검토'],
      sourceType: 'case_pattern',
    });
  }

  const foundationCandidate = assets.find(asset => asset.current_value >= totalValue * 0.15 && asset.current_value >= 5);
  if (foundationCandidate && totalValue >= 20) {
    addCase(cases, {
      id: `foundation-${foundationCandidate.id}`,
      title: '공익법인 출연 한도·사후관리 검토',
      category: '공익',
      score: 62,
      summary: `고액자산 일부를 공익목적으로 분리하면 과세가액 불산입 가능성이 있으나 사후관리 리스크가 큽니다.`,
      trigger: `${foundationCandidate.name} ${foundationCandidate.current_value.toFixed(1)}억`,
      recommendedAction: '가족 지배 목적이 아닌 실제 공익사업 목적, 이사 구성, 주식 출연 한도부터 검토',
      estimatedBenefit: foundationCandidate.current_value * 0.45,
      confidence: 'expert_review',
      legalBasis: ['상증세법 §16 (공익법인 출연재산 과세가액 불산입)', '상증세법 §48 (공익법인 사후관리)'],
      sourceType: 'official_rule',
    });
  }

  if (totalDebt / Math.max(totalValue, 1) >= 0.35 || totalCash < totalValue * 0.08) {
    addCase(cases, {
      id: 'liquidity-tax-payment',
      title: '상속세 납부재원·연부연납 케이스',
      category: '현금흐름',
      score: 80,
      summary: '자산은 크지만 현금이 부족해 매각, 담보대출, 연부연납 조합을 먼저 설계해야 합니다.',
      trigger: `총부채 ${totalDebt.toFixed(1)}억, 확인 현금성 재원 ${totalCash.toFixed(1)}억`,
      recommendedAction: '6개월 신고기한 내 납부액, 연부연납, 담보대출 DSCR을 먼저 산출',
      confidence: 'input_estimate',
      legalBasis: ['상증세법 §67 (신고기한)', '상증세법 §71 (연부연납)'],
      sourceType: 'official_rule',
    });
  }

  if (annualYield < 0.015 && avgGrowth < 0.02 && totalValue >= 10) {
    const depositRate = Number(macro?.deposit_rate_pct ?? macro?.base_rate_pct ?? 3.5) / 100;
    addCase(cases, {
      id: 'low-yield-reallocation',
      title: '저수익 자산 매각 후 금융운용',
      category: '현금흐름',
      score: 66,
      summary: '보유세·관리비 대비 수익과 성장률이 낮아 현금화 후 포트폴리오 운용과 비교해야 합니다.',
      trigger: `자산 수익률 ${(annualYield * 100).toFixed(1)}%, 성장률 ${(avgGrowth * 100).toFixed(1)}%`,
      recommendedAction: '양도세를 반영한 세후 현금과 예금·채권·주식 포트폴리오의 10년 복리 비교',
      estimatedBenefit: totalValue * Math.max(0, depositRate - annualYield) * 10,
      confidence: 'input_estimate',
      legalBasis: ['소득세법상 양도소득세', '금융소득 종합과세 검토'],
      sourceType: 'case_pattern',
    });
  }

  const seen = new Set<string>();
  return cases
    .filter(item => {
      const key = `${item.title}__${item.trigger}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => b.score - a.score);
}

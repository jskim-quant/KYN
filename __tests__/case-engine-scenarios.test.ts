import { describe, expect, it } from 'vitest';
import { analyzeTaxCases, TAX_CASE_LIBRARY_SIZE } from '../lib/tax/case-engine';
import type { Asset, AssetType, FamilyMember, MacroSettings, Relation } from '../types';

const macro: MacroSettings = {
  id: 'macro',
  family_id: 'family',
  base_rate_pct: 3.5,
  rate_shock_pct: 1.5,
  apt_growth_pct: 2.5,
  land_growth_pct: 2.0,
  commercial_growth_pct: 1.5,
  inflation_pct: 2.0,
  deposit_rate_pct: 3.5,
  bond_return_pct: 4.2,
  domestic_stock_return_pct: 6.0,
  foreign_stock_return_pct: 7.0,
  unlisted_stock_return_pct: 5.0,
  rent_growth_pct: 2.0,
  vacancy_rate_pct: 5,
  forced_sale_discount_pct: 10,
  financial_stress_drop_pct: 20,
};

function member(id: string, relation: Relation, age: number, cash = 0.5, income = 0.5): FamilyMember {
  return {
    id,
    family_id: 'family',
    name: `${relation}-${id}`,
    relation,
    generation: relation === '본인' || relation === '배우자' ? 1 : relation === '손자녀' ? 3 : 2,
    age,
    annual_income: income,
    cash_hold: cash,
    total_debt: 0,
    color: '#999',
  };
}

function family(options: {
  ownerAge?: number;
  spouse?: boolean;
  children?: number;
  grandchildren?: number;
  inLaws?: boolean;
  childCash?: number;
  childIncome?: number;
} = {}): FamilyMember[] {
  const members: FamilyMember[] = [member('owner', '본인', options.ownerAge ?? 72, 1, 0.6)];
  if (options.spouse !== false) members.push(member('spouse', '배우자', 69, 1, 0.2));
  for (let i = 0; i < (options.children ?? 2); i += 1) {
    members.push(member(`child-${i}`, '자녀', 38 + i * 3, options.childCash ?? 0.7, options.childIncome ?? 0.7));
  }
  for (let i = 0; i < (options.grandchildren ?? 0); i += 1) {
    members.push(member(`grand-${i}`, '손자녀', 8 + i * 4, 0.1, 0));
  }
  if (options.inLaws) {
    members.push(member('inlaw-1', '며느리', 37, 0.3, 0.6));
    members.push(member('inlaw-2', '사위', 40, 0.4, 0.7));
  }
  return members;
}

function asset(id: string, assetType: AssetType, value: number, overrides: Partial<Asset> = {}): Asset {
  return {
    id,
    family_id: 'family',
    owner_member_id: 'owner',
    name: id,
    asset_type: assetType,
    current_value: value,
    acquisition_cost: value * 0.45,
    acquisition_date: '2010-01-01',
    assessed_value: null,
    public_price_ratio: 70,
    appraisal_value: null,
    valuation_source: 'market_price',
    necessary_expenses: 0,
    annual_yield_pct: assetType === '상업용부동산' ? 3.5 : assetType === '주거용부동산' ? 1.2 : 0,
    expected_growth_pct: assetType === '국내주식' ? 6 : assetType === '해외주식' ? 7 : assetType === '토지' ? 3 : 2,
    annual_tax: value * 0.002,
    monthly_rent: null,
    vacancy_rate_pct: null,
    maintenance_cost: null,
    dividend_yield_pct: null,
    loan_amount: 0,
    loan_rate_pct: 4,
    loan_type: 'variable',
    jeonse_deposit: null,
    other_assumed_debt: null,
    is_planned_transfer: false,
    is_primary_residence: false,
    is_regulated_area: false,
    housing_use: assetType === '주거용부동산' || assetType === '오피스텔',
    house_count: assetType === '주거용부동산' || assetType === '오피스텔' ? 1 : null,
    ownership_share_pct: 100,
    co_owner_count: 1,
    collateral_available: true,
    liquidity_score: 3,
    forced_sale_discount_pct: 10,
    sale_lead_months: 6,
    currency: 'KRW',
    volatility_pct: null,
    ...overrides,
  };
}

interface Fixture {
  name: string;
  members: FamilyMember[];
  assets: Asset[];
  expectedAny: string[];
}

const fixtures: Fixture[] = [
  {
    name: '고액 아파트+전세보증금 부담부증여',
    members: family({ childIncome: 1.2 }),
    assets: [asset('강남아파트', '주거용부동산', 28, { jeonse_deposit: 10, loan_amount: 2 })],
    expectedAny: ['부담부증여', '전세보증금'],
  },
  {
    name: '소득 없는 자녀에게 채무부 아파트 이전',
    members: family({ childIncome: 0, childCash: 0.1 }),
    assets: [asset('잠실아파트', '주거용부동산', 22, { loan_amount: 9 })],
    expectedAny: ['상환능력', '부담부증여'],
  },
  {
    name: '자녀 둘 고성장 주식 선증여',
    members: family({ children: 2 }),
    assets: [asset('국내성장주', '국내주식', 12, { expected_growth_pct: 8 })],
    expectedAny: ['고성장', '성장자산'],
  },
  {
    name: '손자녀 포함 세대생략',
    members: family({ grandchildren: 2 }),
    assets: [asset('토지', '토지', 18, { expected_growth_pct: 4 })],
    expectedAny: ['손자녀', '세대생략'],
  },
  {
    name: '미성년 손자녀 고액 증여',
    members: family({ grandchildren: 1 }),
    assets: [asset('상가', '상업용부동산', 35, { annual_yield_pct: 4 })],
    expectedAny: ['미성년', '손자녀'],
  },
  {
    name: '며느리 사위 5년 합산',
    members: family({ inLaws: true, ownerAge: 78 }),
    assets: [asset('임대상가', '상업용부동산', 20, { annual_yield_pct: 3 })],
    expectedAny: ['며느리', '사위', '5년'],
  },
  {
    name: '가족 간 저가매매 대상 고가 주택',
    members: family(),
    assets: [asset('고가주택', '주거용부동산', 25)],
    expectedAny: ['가족 간 매매', '저가매매'],
  },
  {
    name: '직계존비속 매매 증여추정',
    members: family(),
    assets: [asset('부모소유주택', '주거용부동산', 12)],
    expectedAny: ['직계존비속', '증여추정'],
  },
  {
    name: '자금출처 약한 자녀 매수',
    members: family({ childCash: 0.05, childIncome: 0.2 }),
    assets: [asset('서초아파트', '주거용부동산', 19)],
    expectedAny: ['자금출처'],
  },
  {
    name: '1세대1주택 상속공제 검토',
    members: family(),
    assets: [asset('거주주택', '주거용부동산', 18, { is_primary_residence: true })],
    expectedAny: ['1세대1주택', '동거주택'],
  },
  {
    name: '다주택 취득세 중과',
    members: family(),
    assets: [asset('2주택아파트', '주거용부동산', 15, { house_count: 2, is_regulated_area: true })],
    expectedAny: ['다주택', '취득세'],
  },
  {
    name: '증여 후 단기매각 이월과세',
    members: family(),
    assets: [asset('시세차익큰주택', '주거용부동산', 20, { acquisition_cost: 6 })],
    expectedAny: ['이월과세'],
  },
  {
    name: '규제지역 부동산',
    members: family(),
    assets: [asset('규제지역주택', '주거용부동산', 16, { is_regulated_area: true })],
    expectedAny: ['규제지역'],
  },
  {
    name: '임대상가 법인전환',
    members: family(),
    assets: [asset('대형상가', '상업용부동산', 40, { annual_yield_pct: 5 })],
    expectedAny: ['법인전환', '대표이사 급여'],
  },
  {
    name: '법인 지분 분산 대상',
    members: family({ children: 3 }),
    assets: [asset('임대빌딩', '상업용부동산', 55, { annual_yield_pct: 4 })],
    expectedAny: ['지분 분산', '대표이사'],
  },
  {
    name: '배당정책 대상 임대법인',
    members: family(),
    assets: [asset('고수익상가', '상업용부동산', 30, { annual_yield_pct: 5 })],
    expectedAny: ['배당정책'],
  },
  {
    name: '부동산과다보유법인',
    members: family(),
    assets: [asset('비상장부동산법인주식', '비상장주식', 15), asset('법인보유부동산', '상업용부동산', 45)],
    expectedAny: ['부동산과다', '비상장주식'],
  },
  {
    name: '가업승계 비상장주식',
    members: family(),
    assets: [asset('제조법인지분', '비상장주식', 25, { annual_yield_pct: 2, expected_growth_pct: 5 })],
    expectedAny: ['가업승계', '비상장주식'],
  },
  {
    name: '공익법인 부동산 출연',
    members: family(),
    assets: [asset('출연후보빌딩', '상업용부동산', 30), asset('예금', '예금', 5)],
    expectedAny: ['공익법인'],
  },
  {
    name: '공익법인 주식 출연 한도',
    members: family(),
    assets: [asset('상장주식', '국내주식', 18), asset('예금', '예금', 5)],
    expectedAny: ['주식 출연', '공익법인'],
  },
  {
    name: '현금 부족 연부연납',
    members: family({ childCash: 0.1 }),
    assets: [asset('현금없는빌딩', '상업용부동산', 50, { loan_amount: 5 })],
    expectedAny: ['연부연납', '납부재원'],
  },
  {
    name: '물납 가능성 검토',
    members: family({ childCash: 0.05 }),
    assets: [asset('토지만보유', '토지', 45)],
    expectedAny: ['물납'],
  },
  {
    name: '상속세 담보대출 DSCR',
    members: family(),
    assets: [asset('담보빌딩', '상업용부동산', 35, { annual_yield_pct: 2.5, loan_amount: 4 })],
    expectedAny: ['담보대출', 'DSCR'],
  },
  {
    name: '급매 할인 리스크',
    members: family({ childCash: 0 }),
    assets: [asset('급매위험토지', '토지', 32, { liquidity_score: 5, sale_lead_months: 18 })],
    expectedAny: ['급매'],
  },
  {
    name: '저수익 자산 매각 후 운용',
    members: family(),
    assets: [asset('저수익토지', '토지', 20, { annual_yield_pct: 0, expected_growth_pct: 1 })],
    expectedAny: ['저수익', '금융운용'],
  },
  {
    name: '현금 포트폴리오 운용 비교',
    members: family(),
    assets: [asset('저수익건물', '상업용부동산', 18, { annual_yield_pct: 1, expected_growth_pct: 1 })],
    expectedAny: ['금융 포트폴리오', '금융운용'],
  },
  {
    name: '금융소득 종합과세',
    members: family(),
    assets: [asset('고배당주식', '국내주식', 12, { annual_yield_pct: 3, dividend_yield_pct: 3 })],
    expectedAny: ['금융소득'],
  },
  {
    name: '가족 간 차용증',
    members: family({ childCash: 0.05 }),
    assets: [asset('상속세부족주택', '주거용부동산', 14)],
    expectedAny: ['차용증', '이자'],
  },
  {
    name: '이자 미지급 증여의제',
    members: family(),
    assets: [asset('부채많은상가', '상업용부동산', 20, { loan_amount: 8 })],
    expectedAny: ['이자 미지급', '적정이자'],
  },
  {
    name: '수증자 납부능력 부족',
    members: family({ childCash: 0.1, childIncome: 0.2 }),
    assets: [asset('증여세부담주택', '주거용부동산', 17)],
    expectedAny: ['납부능력'],
  },
  {
    name: '고령자 관리자 승계',
    members: family({ ownerAge: 82, children: 2 }),
    assets: [asset('상가1', '상업용부동산', 15), asset('상가2', '상업용부동산', 12)],
    expectedAny: ['관리자 승계'],
  },
  {
    name: '자녀 다수 유언 분할',
    members: family({ children: 4 }),
    assets: [asset('분할어려운빌딩', '상업용부동산', 40)],
    expectedAny: ['유언', '상속재산분할'],
  },
  {
    name: '불균등 증여 보정',
    members: family({ children: 3 }),
    assets: [asset('성장토지', '토지', 20, { expected_growth_pct: 5 })],
    expectedAny: ['불균등', '형평'],
  },
  {
    name: '보험 수익자 지정',
    members: family(),
    assets: [asset('종신보험', '보험', 8), asset('예금', '예금', 3)],
    expectedAny: ['보험'],
  },
  {
    name: '금융재산 상속공제',
    members: family(),
    assets: [asset('예금', '예금', 8), asset('채권', '채권', 5)],
    expectedAny: ['금융재산'],
  },
  {
    name: '해외주식 환율 양도세',
    members: family(),
    assets: [asset('미국주식', '해외주식', 10, { currency: 'USD', volatility_pct: 25 })],
    expectedAny: ['해외주식'],
  },
  {
    name: '농지 자격 리스크',
    members: family(),
    assets: [asset('농지', '농지', 9)],
    expectedAny: ['농지'],
  },
  {
    name: '임야 보충평가',
    members: family(),
    assets: [asset('임야', '임야', 12, { public_price_ratio: 35 })],
    expectedAny: ['임야', '토지'],
  },
  {
    name: '상가 부가세 포괄양수도',
    members: family(),
    assets: [asset('상업용상가', '상업용부동산', 22)],
    expectedAny: ['부가세', '포괄양수도'],
  },
  {
    name: '임대료 공실 스트레스',
    members: family(),
    assets: [asset('공실위험상가', '상업용부동산', 16, { vacancy_rate_pct: 20, annual_yield_pct: 2 })],
    expectedAny: ['공실', '임대료'],
  },
  {
    name: '단일 자산 집중',
    members: family(),
    assets: [asset('초대형빌딩', '상업용부동산', 60), asset('예금', '예금', 2)],
    expectedAny: ['집중'],
  },
  {
    name: '상속세율 구간 절벽',
    members: family(),
    assets: [asset('상속구간자산', '주거용부동산', 18)],
    expectedAny: ['상속세율'],
  },
  {
    name: '배우자 상속공제 배분',
    members: family({ spouse: true }),
    assets: [asset('배우자공제자산', '주거용부동산', 22)],
    expectedAny: ['배우자'],
  },
  {
    name: '2차 상속세',
    members: family({ spouse: true, children: 2 }),
    assets: [asset('2차상속빌딩', '상업용부동산', 35)],
    expectedAny: ['2차 상속'],
  },
  {
    name: '기부 vs 재단',
    members: family(),
    assets: [asset('고액자산', '토지', 25), asset('예금', '예금', 5)],
    expectedAny: ['기부', '공익법인'],
  },
  {
    name: '증빙 패키지',
    members: family(),
    assets: [asset('가족거래예정주택', '주거용부동산', 14)],
    expectedAny: ['증빙'],
  },
  {
    name: '공시가 낮은 부동산',
    members: family(),
    assets: [asset('공시가낮은토지', '토지', 20, { assessed_value: 8, public_price_ratio: 40 })],
    expectedAny: ['공시가', '평가방법'],
  },
  {
    name: '장기보유특별공제 매각 시점',
    members: family(),
    assets: [asset('오래보유상가', '상업용부동산', 18, { acquisition_date: '2005-01-01', acquisition_cost: 5 })],
    expectedAny: ['장기보유'],
  },
  {
    name: '가족 직원 급여 실질성',
    members: family({ children: 2 }),
    assets: [asset('가족법인후보상가', '상업용부동산', 28, { annual_yield_pct: 4 })],
    expectedAny: ['가족 임원', '직원 급여'],
  },
  {
    name: '공익법인 이사회 특수관계',
    members: family({ children: 3 }),
    assets: [asset('재단후보자산', '토지', 26), asset('예금', '예금', 2)],
    expectedAny: ['특수관계 이사', '공익법인'],
  },
];

describe('세무 실제형 사례 50개 케이스 엔진 시뮬레이션', () => {
  it('50개 이상의 실제형 사례를 엔진에 넣어 각 사례별 세무 케이스를 감지한다', () => {
    expect(fixtures).toHaveLength(50);
    expect(TAX_CASE_LIBRARY_SIZE).toBeGreaterThanOrEqual(50);

    const misses: Array<{ name: string; expected: string[]; actual: string[] }> = [];
    const categoryHits = new Map<string, number>();

    for (const fixture of fixtures) {
      const insights = analyzeTaxCases(fixture.assets, fixture.members, macro);
      expect(insights.length, fixture.name).toBeGreaterThan(0);
      expect(insights[0].score, fixture.name).toBeGreaterThan(0);
      expect(insights.every(item => Number.isFinite(item.score)), fixture.name).toBe(true);

      for (const insight of insights) {
        categoryHits.set(insight.category, (categoryHits.get(insight.category) ?? 0) + 1);
      }

      const haystack = insights
        .flatMap(item => [item.title, item.summary, item.trigger, item.recommendedAction])
        .join(' ');
      const matched = fixture.expectedAny.some(keyword => haystack.includes(keyword));
      if (!matched) {
        misses.push({
          name: fixture.name,
          expected: fixture.expectedAny,
          actual: insights.slice(0, 5).map(item => item.title),
        });
      }
    }

    expect(Object.fromEntries(categoryHits)).toMatchObject({
      증여: expect.any(Number),
      리스크: expect.any(Number),
      현금흐름: expect.any(Number),
    });
    expect(misses).toEqual([]);
  });
});

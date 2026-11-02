import type { TaxRuleMeta } from './types';

const D = '2026-10-02';   // 1차 조사일
const D2 = '2026-10-04';  // 2차 점검일 (코드와 대조해 새로 확인한 규칙)

/**
 * 근거가 확인된 규칙만 등록한다 (docs: KYN 세무 전략 리서치 1·2차 보고서).
 * 공식 원문(law.go.kr) 대조는 구현 전 필수이며, 대조 전까지 confidence는 최대 HIGH(조문 인용 확인)로 둔다.
 */
export const VERIFIED_RULES: TaxRuleMeta[] = [
  {
    ruleId: 'KR-GIFT-S53-DEDUCTION',
    taxType: 'GiftTax',
    title: '증여재산공제 한도 (배우자 6억, 직계존속 5천만·미성년 2천만, 직계비속 5천만, 기타친족 1천만)',
    legalBasis: ['상속세 및 증여세법 제53조'],
    effectiveFrom: null,
    effectiveTo: null,
    lastVerified: D2,
    confidence: 'HIGH',
    status: 'SUPPORTED',
    implementedIn: 'lib/tax/policy.ts GIFT_DEDUCTIONS_BY_RELATION, lib/tax.ts calcGiftTax',
    sources: [
      { type: 'statute', ref: '제53조 조문 인용(개정 2025.3.14 표기)', url: 'https://korea.legal/wiki/%ec%83%81%ec%86%8d%ec%84%b8-%eb%b0%8f-%ec%a6%9d%ec%97%ac%ec%84%b8%eb%b2%95-%ec%a0%9c53%ec%a1%b0/', accessedOn: D2 },
      { type: 'practitioner', ref: '이투데이 세무가이드 2025-10-12: 사위·며느리는 기타 친족', url: 'https://bravo.etoday.co.kr/view/atc_view/17379', accessedOn: D2 },
    ],
    openIssues: [
      '직계존속에는 수증자의 직계존속과 혼인 중인 배우자(계부·계모)가 포함된다. 며느리·사위는 인척이라 기타친족 1천만 원이다.',
      '현행 시행일은 조문에서 확인하지 못함 — 원문 대조 필요',
    ],
  },
  {
    ruleId: 'KR-GIFT-S53-2-MARRIAGE-BIRTH',
    taxType: 'GiftTax',
    title: '혼인·출산 증여재산공제 +1억 (직계존속 증여, 기존 5천만과 합산 최대 1.5억)',
    legalBasis: ['상속세 및 증여세법 제53조의2'],
    effectiveFrom: '2024-01-01',
    effectiveTo: null,
    lastVerified: D2,
    confidence: 'MEDIUM',
    status: 'SUPPORTED_WITH_CONDITIONS',
    implementedIn: 'lib/tax/policy.ts MARRIAGE_BIRTH_BONUS, lib/tax.ts calcGiftTax',
    sources: [
      { type: 'practitioner', ref: 'Taxly: 24년 증여분부터 적용', url: 'https://taxly.kr/post/1039--증여한도추가혼인할-경우-직계존속으로부터-1억-추가로-받을-수-있음-24년-증여분부터-적용', accessedOn: D2 },
      { type: 'practitioner', ref: 'tilnote 해설: 기존 5천만 + 1억 = 1억5천만', url: 'https://tilnote.io/pages/69d52b936b890bb9dc7969b3', accessedOn: D2 },
      { type: 'statute', ref: '제53조 조문이 제53조의2를 인용', accessedOn: D2 },
    ],
    openIssues: ['혼인·출산 요건(기간, 증여자 범위)과 1억 한도의 증여자 합산 방식은 구현이 단순화돼 있음'],
  },
  {
    ruleId: 'KR-GIFT-S57-GEN-SKIP',
    taxType: 'GiftTax',
    title: '직계비속 증여 할증과세: 산출세액 +30%, 수증자 미성년이고 증여재산가액 20억 초과 시 +40%',
    legalBasis: ['상속세 및 증여세법 제57조', '같은 법 시행령 제46조의3'],
    effectiveFrom: null,
    effectiveTo: null,
    lastVerified: D2,
    confidence: 'HIGH',
    status: 'SUPPORTED',
    implementedIn: 'lib/tax.ts calcGiftTax',
    sources: [
      { type: 'statute', ref: '제57조 ① 조문 인용(변호사 해설)', url: 'https://www.lawtalk.co.kr/posts/48238', accessedOn: D2 },
      { type: 'decree', ref: '시행령 제46조의3 할증과세액 산식', url: 'https://korea.legal/wiki/%ec%83%81%ec%86%8d%ec%84%b8-%eb%b0%8f-%ec%a6%9d%ec%97%ac%ec%84%b8%eb%b2%95-%ec%8b%9c%ed%96%89%eb%a0%b9-%ec%a0%9c46%ec%a1%b0%ec%9d%983/', accessedOn: D2 },
      { type: 'press', ref: '택스타임즈 2025-10-10, 세계일보 2025-10-10', url: 'https://www.taxtimes.co.kr/news/article.html?no=271773', accessedOn: D2 },
    ],
    openIssues: [
      '시행령 §46조의3: 할증액 = 산출세액 × (부모 외 직계존속 증여분 / 총 증여재산가액) × 30%(40%) − 종전 납부 할증액. 코드는 전체 증여가 조부모 증여라고 보고 전액에 할증을 적용한다(근사).',
      '대습(부모 사망) 시 할증 제외 여부는 §57 원문으로 확인하지 못함(상속 §27에는 대습상속 제외 조문이 있음).',
      '40% 구간 신설 시기: 블로그(watax)는 2024년 신설이라고 하나 상속 §27 개정 연혁(2015.12.15, 2016.12.20)과 상충 — 확정하지 않음',
    ],
  },
  {
    ruleId: 'KR-GIFT-S41-4-LOAN',
    taxType: 'GiftTax',
    title: '금전 무상·저리 대출 증여: 이익 = 대출금 × 4.6% − 실제 이자, 연 1천만 원 이상이면 과세',
    legalBasis: ['상속세 및 증여세법 제41조의4', '같은 법 시행령 제31조의4', '시행규칙(적정이자율 연 4.6%)'],
    effectiveFrom: null,
    effectiveTo: null,
    lastVerified: D2,
    confidence: 'HIGH',
    status: 'SUPPORTED',
    implementedIn: 'lib/tax.ts FAIR_LOAN_RATE, LOAN_GIFT_THRESHOLD, calcFamilyLoanAnalysis',
    sources: [
      { type: 'nts_interpretation', ref: '국세청 해석 인용(Taxly 1870): 4.6% 차액 1천만 원 미만 제외', url: 'https://taxly.kr/post/1870-증여세-가족-등-타인으로부터-차용시-세법상-문제가-없는-가장-낮은-이자율-적용방법', accessedOn: D2 },
      { type: 'law_firm', ref: '박예준 변호사(로톡) 해설', url: 'https://www.lawtalk.co.kr/posts/49006', accessedOn: D2 },
      { type: 'practitioner', ref: 'KB Think 칼럼 2023-05-31 (2억·1% 예시)', url: 'https://kbthink.com/main/economy/expert-column/gw-tax/gw-tax-230531.html', accessedOn: D2 },
      { type: 'practitioner', ref: 'wikidocs: 조문·원천징수율 대조 주장, 4.6% 2016년 이후 불변', url: 'https://wikidocs.net/blog/@Insight_Lab/27306/', accessedOn: D2 },
    ],
    openIssues: [
      '개인 간은 1천만 원, 특정법인(§45의5)은 1억 원 기준 — 서로 다름',
      '코드는 isGiftTaxable = 이자 미달액 > 1천만 원(초과). 조문은 1천만 원 이상 과세. 경계값 한 지점만 다름(실무상 영향 미미)',
      '4.6% 시행규칙의 시행일은 확인하지 못함',
    ],
  },
  {
    ruleId: 'KR-GIFT-S35-RELATED-PARTY',
    taxType: 'GiftTax',
    title: '특수관계인 저가양수·고가양도 증여: 차액 ≥ min(시가×30%, 3억)이면 과세, 증여재산가액 = 차액 − min(시가×30%, 3억)',
    legalBasis: ['상속세 및 증여세법 제35조', '같은 법 시행령(기준금액)'],
    effectiveFrom: null,
    effectiveTo: null,
    lastVerified: D,
    confidence: 'MEDIUM',
    status: 'SUPPORTED_WITH_CONDITIONS',
    implementedIn: 'lib/tax/gift.ts estimateRelatedPartySale',
    sources: [
      { type: 'nts_interpretation', ref: '서면-2016-상속증여-4969 (2018-11-29)', url: 'https://casenote.kr/%EA%B5%AD%EC%84%B8%EC%B2%AD/%EC%84%9C%EB%A9%B4-2016-%EC%83%81%EC%86%8D%EC%A6%9D%EC%97%AC-4969-25f461', accessedOn: D },
      { type: 'nts_interpretation', ref: '서면인터넷방문상담4팀-747 (2005-05-13)', url: 'https://casenote.kr/%EA%B5%AD%EC%84%B8%EC%B2%AD/%EC%84%9C%EB%A9%B4%EC%9D%B8%ED%84%B0%EB%84%B7%EB%B0%A9%EB%AC%B8%EC%83%81%EB%8B%B44%ED%8C%80-747-32eba1', accessedOn: D },
      { type: 'practitioner', ref: '조세일보 칼럼, 소셜포커스, 선우회계법인, Taxly 1326(산식 예시가 min 규칙과 일치)', url: 'https://www.socialfocus.co.kr/news/articleView.html?idxno=19521', accessedOn: D },
    ],
    openIssues: [
      '비특수관계인은 요건 30%, 차감액 3억 단일(별도 규칙)',
      '현재 시행령 조문번호는 확인하지 못함(자료는 구 §26 표기)',
      '고가양도·고가양수 방향은 estimateRelatedPartySale이 지원하지 않음',
      'Taxly 1326 본문은 ‘3억 단일 차감’이라 쓰나 같은 글의 계산 예시(5억 재산 3억 매수 → 5천만 원)는 min 규칙과 일치',
    ],
  },
  {
    ruleId: 'KR-GIFT-S45-5-SPECIFIC-CORP',
    taxType: 'GiftTax',
    title: '특정법인(지배주주 등 보유비율 30% 이상) 거래 증여의제: 이익 × 지분율, 거래 유형별 1억 이상, 같은 유형은 소급 1년 합산',
    legalBasis: ['상속세 및 증여세법 제45조의5', '같은 법 시행령 제34조의5 ⑤', '같은 법 제43조 ②', '기획재정부 서면-2025-자본거래-3489 (2026-06-01)'],
    effectiveFrom: '2025-05-07',
    effectiveTo: null,
    lastVerified: D,
    confidence: 'MEDIUM',
    status: 'SUPPORTED_WITH_CONDITIONS',
    implementedIn: 'lib/rules/specific-corp.ts evaluateSpecificCorp',
    sources: [
      { type: 'law_firm', ref: 'BKL Legal Update: 조문 인용 + 예규 요지(2026-06-30)', url: 'https://www.bkl.co.kr/law/insight/newsletter/6623', accessedOn: D },
      { type: 'court', ref: '대법원 2025-12-04 선고 2025두34494 (무상대여 채권 소멸시효 완성 후 과세 불가)', url: 'https://www.shinkim.com/kor/media/lawinfo/pdf/389', accessedOn: D },
      { type: 'decree', ref: '시행령 제34조의5', url: 'https://korea.legal/wiki/%ec%83%81%ec%86%8d%ec%84%b8-%eb%b0%8f-%ec%a6%9d%ec%97%ac%ec%84%b8%eb%b2%95-%ec%8b%9c%ed%96%89%eb%a0%b9-%ec%a0%9c34%ec%a1%b0%ec%9d%985/', accessedOn: D },
    ],
    openIssues: [
      'effectiveFrom은 제3호의2(불균등 감자 등) 시행령 신설일. 법 개정 시행일은 확인하지 못함',
      '1억 기준이 인별인지 지배주주 등 합산인지 미확정',
      '특정법인의 이익 계산(법인세 상당액 차감 등)과 기과세분 처리는 미구현 — 호출자가 이익을 계산해 넣어야 함',
      '조심 2026소0326(지분율 동일 법인 간 ‘자기증여’ 쟁점)은 결과 미확인',
      '1년 소급 기간의 경계(포함 여부)는 포함으로 가정',
    ],
  },
  {
    ruleId: 'KR-CGT-S97-2-CARRYOVER',
    taxType: 'CapitalGainsTax',
    title: '배우자·직계존비속 증여 후 양도 이월과세: 부동산 10년(증여일 2023-01-01 이후)·5년(이전)',
    legalBasis: ['소득세법 제97조의2'],
    effectiveFrom: '2023-01-01',
    effectiveTo: null,
    lastVerified: D,
    confidence: 'MEDIUM',
    status: 'SUPPORTED_WITH_CONDITIONS',
    implementedIn: 'lib/tax/policy.ts carryOverPeriodYears, lib/tax.ts calcCarryOverCGT',
    sources: [
      { type: 'practitioner', ref: 'Taxly 이월과세', url: 'https://taxly.kr/post/1093-양도소득세-이월과세', accessedOn: D },
      { type: 'practitioner', ref: 'watax 이월과세 10년', url: 'https://www.watax.kr/3786b0d2-2682-8179-912a-e63c207e74ef', accessedOn: D },
      { type: 'practitioner', ref: 'wikidocs: 2023.1.1 이후 증여 10년, 주식 1년', url: 'https://wikidocs.net/blog/@Insight_Lab/27102/', accessedOn: D },
      { type: 'practitioner', ref: '해온세무 가이드', url: 'https://www.haeontax.com/kor/guide/view/210-부동산_증여시_차후_양도소득세_이월과세_사후관리까지_반드시_고려해야_합니다', accessedOn: D },
      { type: 'law_firm', ref: '신김 Legal Update: 5년 시기 개정 설명', url: 'https://www.shinkim.com/attachment/513', accessedOn: D },
    ],
    openIssues: [
      '공식 원문 대조 전 — 기간은 실무 소스 4건 일치',
      '주식 1년(2025 개정, 증여일 2025-01-01 이후)은 과세대상 주식 판정이 필요해 미반영 — 부동산이 아닌 자산은 기존 5년 동작 유지',
      '이월과세 시 증여세 필요경비 산입, 1세대1주택 비과세 시 배제, 비교과세는 미반영',
    ],
  },
];

export function getRule(ruleId: string): TaxRuleMeta | undefined {
  return VERIFIED_RULES.find(r => r.ruleId === ruleId);
}

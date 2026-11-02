import { calcGiftTax } from '../tax';
import { FAIR_LOAN_RATE } from '../tax/policy';
import { eokToWon, wonToEok } from '../finance/units';
import type { KRW } from '../finance/units';
import { evaluateSpecificCorp, SPECIFIC_CORP_THRESHOLD_KRW } from '../rules/specific-corp';
import type { SpecificCorpTx } from '../rules/specific-corp';
import type { AuditFlag, CompanyNode, FamilySnapshot, PersonNode, PlanOptions, PlanStep, StrategyPlan } from './types';

/**
 * 가족 법인 구조 생성기 (보고서 §11).
 *
 * 원칙
 *  - 근거가 확인된 규칙(§53 공제, §57 할증, §41의4·§45의5 대여)이 있는 단계만 세액을 계산한다.
 *  - 법인 간 거래·법인세·일감몰아주기 등 미검증 단계는 구조만 만들고 NOT_COMPUTED로 표시한다.
 *  - 결과는 ‘최적 전략’이 아니라 ‘설정한 가정에서 계산 가능한 세액’이다.
 */

const MINOR_AGE = 19;

function giftTaxKRW(amount: KRW, prior: KRW, age: number, bonus: boolean): KRW {
  if (amount <= 0) return 0;
  const eok = calcGiftTax(wonToEok(amount), '자녀', wonToEok(prior), false, bonus, age);
  return Math.round(eokToWon(eok));
}

function addYearsPlusDay(iso: string, years: number): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  // 연 반복 거래는 직전 거래와 1년+1일 간격이 되도록 매년 하루씩 더한다 (소급 1년 합산에 걸리지 않게)
  const dt = new Date(Date.UTC(y + years, m - 1, d + years));
  return dt.toISOString().slice(0, 10);
}

function firstChild(s: FamilySnapshot): PersonNode {
  const c = s.persons.find(p => p.role === 'child');
  if (!c) throw new Error('자녀가 없어 구조를 만들 수 없습니다.');
  return c;
}

function controlledBy(company: CompanyNode, personIds: string[]): number {
  return company.owners.filter(o => personIds.includes(o.personId)).reduce((s, o) => s + o.pct, 0);
}

function finish(plan: Omit<StrategyPlan, 'computedTaxKRW' | 'coverage' | 'comparable'>): StrategyPlan {
  const computed = plan.steps.filter(s => s.computation === 'COMPUTED');
  return {
    ...plan,
    computedTaxKRW: computed.reduce((s, st) => s + (st.taxKRW ?? 0), 0),
    coverage: { computed: computed.length, total: plan.steps.length },
    comparable: plan.openRules.length === 0 && computed.length === plan.steps.length,
  };
}

/** 연 증여의제이익(평가기와 같은 반올림 규칙). 원금·이자율·지분율이 주어졌을 때. */
function annualDeemedGift(principal: KRW, annualRate: number, controllingPct: number): KRW {
  const benefit = Math.max(0, Math.round(principal * (FAIR_LOAN_RATE - annualRate)));
  return Math.round((benefit * controllingPct) / 100);
}

/**
 * 연 증여의제이익이 기준(1억) 미만으로 유지되는 최대 대여 원금.
 * 이자율이 4.6% 이상이면 null(제한 없음). 평가기와 같은 반올림을 써서 경계에서 어긋나지 않게 한다.
 */
export function maxLoanBelowSpecificCorpThreshold(controllingPct: number, annualRate: number): KRW | null {
  const gap = FAIR_LOAN_RATE - annualRate;
  if (gap <= 0 || controllingPct <= 0) return null;
  let p = Math.floor(SPECIFIC_CORP_THRESHOLD_KRW / (gap * (controllingPct / 100)));
  while (p > 0 && annualDeemedGift(p, annualRate, controllingPct) >= SPECIFIC_CORP_THRESHOLD_KRW) p -= 1;
  while (annualDeemedGift(p + 1, annualRate, controllingPct) < SPECIFIC_CORP_THRESHOLD_KRW) p += 1;
  return p;
}

function directGift(s: FamilySnapshot): StrategyPlan {
  const child = firstChild(s);
  const prior = s.priorGiftsKRW?.[child.id] ?? 0;
  const bonus = s.marriageOrBirthBonus?.[child.id] ?? false;
  const tax = giftTaxKRW(s.targetTransferKRW, prior, child.age, bonus);
  return finish({
    id: 'DIRECT_GIFT',
    label: '일시 증여',
    steps: [{
      id: 'g0', offsetYears: 0, kind: 'gift_cash', description: '부모 → 자녀 현금 일시 증여',
      from: 'parent', to: child.id, amountKRW: s.targetTransferKRW,
      ruleIds: ['KR-GIFT-S53-DEDUCTION', 'KR-GIFT-S53-2-MARRIAGE-BIRTH'],
      computation: 'COMPUTED', taxKRW: tax,
    }],
    openRules: [], auditFlags: [],
    notes: ['증여세는 calcGiftTax 기준(신고세액공제 3% 포함)이며 10년 합산은 증분 방식 근사다.'],
  });
}

function stagedGift(s: FamilySnapshot, cycles: number): StrategyPlan {
  const child = firstChild(s);
  const bonus = s.marriageOrBirthBonus?.[child.id] ?? false;
  const per = Math.floor(s.targetTransferKRW / cycles);
  const steps: PlanStep[] = [];
  for (let i = 0; i < cycles; i++) {
    const amount = i === cycles - 1 ? s.targetTransferKRW - per * (cycles - 1) : per;
    const prior = i === 0 ? (s.priorGiftsKRW?.[child.id] ?? 0) : 0; // 10년 간격이면 합산 초기화
    steps.push({
      id: `g${i}`, offsetYears: i * 10, kind: 'gift_cash',
      description: `${i * 10}년차 증여 (직전 증여와 10년 간격 → 공제 재사용)`,
      from: 'parent', to: child.id, amountKRW: amount,
      ruleIds: ['KR-GIFT-S53-DEDUCTION', ...(i === 0 && bonus ? ['KR-GIFT-S53-2-MARRIAGE-BIRTH'] : [])],
      computation: 'COMPUTED', taxKRW: giftTaxKRW(amount, prior, child.age + i * 10, i === 0 && bonus),
    });
  }
  return finish({
    id: 'STAGED_GIFT',
    label: `${cycles}회 분할 증여 (10년 간격)`,
    steps, openRules: [], auditFlags: [],
    notes: ['부모 생존·자산 가치 변동·상속 개시 시 사전증여 합산(상속인 10년)은 반영하지 않았다.', '자녀 나이는 회차마다 10년씩 증가한다고 가정했다.'],
  });
}

interface ChildCorpBuild {
  steps: PlanStep[];
  flags: AuditFlag[];
  notes: string[];
  openRules: string[];
  childCompany: CompanyNode;
  childPct: number;
}

function buildChildCorp(s: FamilySnapshot, o: Required<Pick<PlanOptions, 'loanAnnualRate' | 'loanYears'>> & PlanOptions): ChildCorpBuild {
  const child = firstChild(s);
  const familyIds = s.persons.map(p => p.id);
  const existing = s.companies.find(c => controlledBy(c, [child.id]) >= 30);
  const steps: PlanStep[] = [];
  const flags: AuditFlag[] = [];
  const notes: string[] = [];
  const openRules: string[] = [];
  let company = existing;
  let childPct = existing ? controlledBy(existing, [child.id]) : 100;

  if (!existing) {
    const prior = s.priorGiftsKRW?.[child.id] ?? 0;
    const bonus = s.marriageOrBirthBonus?.[child.id] ?? false;
    const cap = (child.age >= MINOR_AGE ? 50_000_000 : 20_000_000) + (bonus ? 100_000_000 : 0);
    const seed = Math.max(0, Math.min(cap - prior, s.targetTransferKRW));
    steps.push({
      id: 'c0', offsetYears: 0, kind: 'gift_cash',
      description: '자녀 자본금 마련: 증여재산공제 한도 내 증여(신고)',
      from: 'parent', to: child.id, amountKRW: seed,
      ruleIds: ['KR-GIFT-S53-DEDUCTION', ...(bonus ? ['KR-GIFT-S53-2-MARRIAGE-BIRTH'] : [])],
      computation: 'COMPUTED', taxKRW: giftTaxKRW(seed, prior, child.age, bonus),
    });
    company = { id: 'child-corp', name: '자녀 법인(신설)', owners: [{ personId: child.id, pct: 100 }] };
    steps.push({
      id: 'c1', offsetYears: 0, kind: 'create_company',
      description: '자녀가 100% 출자해 법인 설립 (자본금 = 위 증여액)',
      to: company.id, amountKRW: seed, ruleIds: [],
      computation: 'NOT_COMPUTED', taxKRW: null,
      notComputedReason: '설립 비용·등록면허세·법인 유지비는 조사하지 않았다. 출자 자체의 과세는 없다고 가정했으나 미검증이다.',
    });
    openRules.push('법인 설립·유지 비용 (미조사)');
    flags.push({
      code: 'SEED_FUNDS_TRACE', severity: 'warning', basis: 'official',
      message: '자녀 출자금은 신고된 증여로 만들고 자금 흐름을 남겨야 한다. 국세청은 부동산·법인 취득자금의 출처를 우선 검증한다.',
      sourceRef: '국세청 보도자료 2026-07-07, 서울경제 2026-05-19',
    });
  }

  const principal = o.loanPrincipalKRW ?? Math.min(s.parentCashKRW, s.targetTransferKRW);
  const rate = o.loanAnnualRate;
  const years = o.loanYears;
  const prior0 = s.priorGiftsKRW?.[child.id] ?? 0;
  const seedAmount = steps.find(x => x.id === 'c0')?.amountKRW ?? 0;
  const annualBenefit = Math.max(0, Math.round(principal * (FAIR_LOAN_RATE - rate)));
  const txs: SpecificCorpTx[] = [];
  for (let k = 0; k < years; k++) {
    txs.push({ id: `loan-y${k}`, date: addYearsPlusDay(s.asOf, k), type: 'free_provision', corpBenefitKRW: annualBenefit });
  }
  const evalRes = evaluateSpecificCorp({ controllingHoldersPct: childPct, transactions: txs });
  let running = prior0 + seedAmount;
  let loanTax = 0;
  let taxableYears = 0;
  for (const it of evalRes.items) {
    if (it.meetsThreshold) {
      loanTax += giftTaxKRW(it.deemedGiftKRW, running, child.age, false);
      running += it.deemedGiftKRW;
      taxableYears += 1;
    }
  }
  steps.push({
    id: 'c2', offsetYears: 0, kind: 'loan_to_company',
    description: `부모 → 자녀 법인 대여 (연 ${(rate * 100).toFixed(2)}%, ${years}년, 원금 ${principal.toLocaleString('ko-KR')}원)`,
    from: 'parent', to: company!.id, amountKRW: principal,
    ruleIds: ['KR-GIFT-S45-5-SPECIFIC-CORP', 'KR-GIFT-S41-4-LOAN'],
    computation: 'COMPUTED', taxKRW: loanTax,
  });
  const cap = maxLoanBelowSpecificCorpThreshold(childPct, rate);
  notes.push(cap === null
    ? '이자율이 적정이자율(4.6%) 이상이라 증여의제이익이 생기지 않는다. 이자를 실제로 지급해야 하며 지급이자는 대여자의 이자소득이다.'
    : `이 이자율·지분율에서 연 증여의제이익이 1억 원 미만으로 유지되는 최대 원금은 약 ${cap.toLocaleString('ko-KR')}원이다 (1억 ÷ ((4.6% − 이자율) × 지분율)).`);
  notes.push('1억 기준은 거래 유형별로 판단하고 같은 유형은 소급 1년 합산한다(기재부 예규 2026-06-01). 연 반복 대여는 매년 새 거래(1년+1일 간격)로 모형화했다.');
  if (taxableYears > 0) {
    flags.push({
      code: 'DEEMED_GIFT_OVER_THRESHOLD', severity: 'high', basis: 'official',
      message: `연 증여의제이익이 1억 원 이상인 해가 ${taxableYears}회 있어 특정법인 증여의제(§45의5)로 증여세가 과세된다.`,
      sourceRef: '상증법 §45의5, 시행령 §34의5 ⑤, 기재부 서면-2025-자본거래-3489',
    });
  }
  if (rate === 0) {
    flags.push({
      code: 'ZERO_INTEREST_LOAN', severity: 'warning', basis: 'practitioner',
      message: '무이자 대여는 차용 계약·상환 계획·사용처 기록이 없으면 실질이 증여로 재분류될 수 있다. 상환기한이 사망 시점이거나 이자를 후불로 정한 차용증은 국세청이 허위 채무로 의심해 조사한 유형이다.',
      sourceRef: '서울경제 2026-05-19(국세청 발표), Taxly 세무사 답변',
    });
  }
  flags.push({
    code: 'BUSINESS_SUBSTANCE', severity: 'info', basis: 'practitioner',
    message: '법인은 실질적인 사업 활동(임대 운영, 장부, 급여·경비의 실질)을 유지해야 한다. 이름만 빌린 법인은 명의신탁·가공인건비 문제가 생긴다.',
    sourceRef: '한국경제 2026-08-05, 택스워치 2026-08-25',
  });
  flags.push({
    code: 'LOAN_STATUTE_OF_LIMITATIONS', severity: 'info', basis: 'official',
    message: '무상 대여 채권을 시효 중단 없이 방치하면 소멸시효 완성 후에는 특정법인 증여의제 과세가 불가하다는 대법원 판결이 있으나, 이를 전제로 계획을 세워서는 안 된다.',
    sourceRef: '대법원 2025-12-04 선고 2025두34494',
  });
  steps.push({
    id: 'c3', offsetYears: 0, kind: 'company_invest',
    description: '자녀 법인이 대여금으로 부동산·금융자산 취득 및 운용',
    from: company!.id, ruleIds: [], computation: 'NOT_COMPUTED', taxKRW: null,
    notComputedReason: '법인세, 법인 부동산 취득세·종합부동산세는 검증하지 못했다.',
  });
  openRules.push('법인세 계산', '법인 부동산 취득세·종부세(2.7%/5% 분기 미확인)');
  void familyIds;
  return { steps, flags, notes, openRules, childCompany: company!, childPct };
}

function childCorpLoan(s: FamilySnapshot, o: PlanOptions): StrategyPlan {
  const b = buildChildCorp(s, { ...o, loanAnnualRate: o.loanAnnualRate ?? 0, loanYears: o.loanYears ?? 5 });
  return finish({
    id: 'CHILD_CORP_LOAN',
    label: s.companies.some(c => c.id === b.childCompany.id) ? '기존 자녀 법인 활용 + 부모 대여' : '자녀 법인 설립 + 부모 대여',
    steps: b.steps, openRules: b.openRules, auditFlags: b.flags, notes: b.notes,
  });
}

function parentAndChildCorp(s: FamilySnapshot, o: PlanOptions): StrategyPlan {
  const b = buildChildCorp(s, { ...o, loanAnnualRate: o.loanAnnualRate ?? 0, loanYears: o.loanYears ?? 5 });
  const parent = s.persons.find(p => p.role === 'parent');
  const parentIds = s.persons.filter(p => p.role !== 'child').map(p => p.id);
  const existingParentCorp = s.companies.find(c => controlledBy(c, parentIds) >= 50);
  const steps: PlanStep[] = [];
  const openRules = [...b.openRules];
  if (!existingParentCorp && parent) {
    steps.push({
      id: 'p0', offsetYears: 0, kind: 'create_company',
      description: '부모(및 배우자)가 100% 출자해 부모 법인 설립',
      to: 'parent-corp', ruleIds: [], computation: 'NOT_COMPUTED', taxKRW: null,
      notComputedReason: '설립 비용은 조사하지 않았다.',
    });
    steps.push({
      id: 'p1', offsetYears: 0, kind: 'contribute_capital',
      description: '부모가 현금 출자 (부동산 현물출자는 별도 검토)', from: parent.id, to: 'parent-corp',
      amountKRW: s.parentCashKRW, ruleIds: [], computation: 'NOT_COMPUTED', taxKRW: null,
      notComputedReason: '현금 출자의 과세 여부는 미검증이다. 부동산 현물출자는 양도세·취득세·이월과세(조특법) 검토가 필요하다.',
    });
  }
  steps.push(...b.steps);
  steps.push({
    id: 'x0', offsetYears: 1, kind: 'company_loan',
    description: '부모 법인 → 자녀 법인 대여 (인정이자 이상 이자 지급 가정)',
    from: 'parent-corp', to: b.childCompany.id, ruleIds: [],
    computation: 'NOT_COMPUTED', taxKRW: null,
    notComputedReason: '법인세법 §52 인정이자(가중평균차입이자율 원칙)와 §45의5 적용 여부(조세심판 2026소0326, 쟁점 진행 중)가 확정되지 않았다.',
  });
  steps.push({
    id: 'x1', offsetYears: 1, kind: 'company_asset_sale',
    description: '부모 법인 → 자녀 법인 자산을 시가로 양도', from: 'parent-corp', to: b.childCompany.id, ruleIds: [],
    computation: 'NOT_COMPUTED', taxKRW: null,
    notComputedReason: '법인세법 §52·시행령 §88의 시가 판정과 5%/3억 기준(원문 미확인), 법인세·부가세·취득세가 필요하다.',
  });
  steps.push({
    id: 'x2', offsetYears: 2, kind: 'company_dividend',
    description: '부모 법인 이익을 배당 (주주 구성에 따라 차등·초과배당 여부 검토)', from: 'parent-corp', ruleIds: [],
    computation: 'NOT_COMPUTED', taxKRW: null,
    notComputedReason: '배당소득세와 초과배당 증여 여부는 미검증이다(보고서 Report 1 #18, DISPUTED).',
  });
  openRules.push(
    '법인 간 대여: 법인세법 §52 인정이자·시가(이자율 수치 미확인)',
    '법인 간 자산 양도: 시가 판정과 5%/3억 기준 원문',
    '초과배당·차등배당 증여(§41의2) 및 배당소득세',
    '일감몰아주기·일감떼어주기 증여의제(§45의3·§45의4)',
    '합병·분할(§38)',
  );
  const flags = [...b.flags, {
    code: 'INTERCOMPANY_REPEATED_TRADES', severity: 'warning' as const, basis: 'unverified_lead' as const,
    message: '두 법인 사이의 반복적인 거래는 일감몰아주기(§45의3) 또는 부당행위계산부인(법인세법 §52) 검토 대상이 될 수 있다. 이번 조사에서 근거를 확보하지 못했다.',
    sourceRef: '보고서 Report 1 #21~#24 (UNVERIFIED)',
  }, {
    code: 'SUPER_CAR_TOLL_CASE', severity: 'high' as const, basis: 'practitioner' as const,
    message: '자녀 지배법인에 저가 양도하고 통행세를 받는 구조는 국세청이 2026년에 조사 대상으로 삼은 유형이다.',
    sourceRef: '택스타임즈 2026-06-11 (세무법인 센트릭 해설)',
  }];
  return finish({
    id: 'PARENT_AND_CHILD_CORP',
    label: '부모 법인 + 자녀 법인 설립',
    steps,
    openRules: Array.from(new Set(openRules)),
    auditFlags: flags,
    notes: [...b.notes, '법인 간 단계는 구조만 제시한다. 검증되지 않은 규칙으로 세액을 추정하지 않았으며, 위 단계가 포함된 계획은 다른 계획과 세액을 비교할 수 없다.'],
  });
}

export function generateFamilyCorpPlans(snapshot: FamilySnapshot, options: PlanOptions = {}): StrategyPlan[] {
  return [
    directGift(snapshot),
    stagedGift(snapshot, options.stagedCycles ?? 3),
    childCorpLoan(snapshot, options),
    parentAndChildCorp(snapshot, options),
  ];
}

/** 세액을 끝까지 계산할 수 있는 계획만 세액 오름차순으로 비교한다. ‘최적 전략’이 아니라 계산 가능한 세액의 비교다. */
export function compareComputablePlans(plans: StrategyPlan[]): StrategyPlan[] {
  return plans.filter(p => p.comparable).sort((a, b) => a.computedTaxKRW - b.computedTaxKRW);
}

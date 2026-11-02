# KYN 세무 전략 엔진 — Report 2 · 4 · 5

기준일: 2026-11-01. 작성 범위: 스펙의 Report 2(거래 매트릭스), 4(룰 엔진 스펙), 5(구현 갭 분석).
Report 1(전략 맵)·3(가족법인 심층)은 기존 리서치 문서에 있다.

## 읽는 법 (중요)
- **VERIFIED** = `lib/rules/registry.ts`에 등록된 7개 규칙. 2차 자료로 교차 확인했지만 law.go.kr 원문 대조는 아직이다.
- **UNVERIFIED** = 일반적으로 알려진 제도 이름과 조문 번호. 이 문서의 조문 번호는 기억에 의존한 것이라 틀릴 수 있다. 원문 대조 전에는 계산에 쓰지 않는다.
- 세율·한도·금액은 VERIFIED 칸에만 적었다. UNVERIFIED 칸에는 숫자를 쓰지 않았다.
- 이 문서는 절세 방법이 아니라 "어떤 거래가 어떤 과세 사건을 만드는가"를 정리한 것이다.

---

## Report 2 — 거래 매트릭스 (FROM × TO)

### 2.1 Person → Person
| 거래 | 발생 세목 | 핵심 규칙 | 상태 |
|---|---|---|---|
| 현금·부동산·주식 증여 | 증여세 | §53 공제(배우자 6억, 직계존속 5천/미성년 2천, 직계비속 5천, 기타친족 1천), §53의2 혼인·출산 +1억 | VERIFIED |
| 미성년 직계비속 20억 초과 등 세대생략 | 증여세 할증 | §57 산출세액 +30%, 미성년+20억 초과 +40% | VERIFIED |
| 저가양수·고가양도 | 증여세 | §35 차액 ≥ min(시가 30%, 3억)이면 과세 | VERIFIED(조건부) |
| 무상·저리 금전대차 | 증여세 | §41의4 이익 = 원금×4.6% − 실제이자, 1천만 원 이상 과세 | VERIFIED |
| 증여 후 양도 | 양도소득세(이월과세) | 소득세법 §97의2 부동산 10년(증여일 2023-01-01 이후)·5년(이전) | VERIFIED(조건부) |
| 부담부증여 | 증여세 + 양도세 | 채무 인수분 양도 간주 | 구현됨(`lib/tax/gift.ts`), 규칙 미등록 |
| 채무면제·인수 | 증여세 | 상증법 채무면제 이익 조항 | UNVERIFIED |
| 부동산 무상사용 | 증여세 | 무상사용 이익 조항 | UNVERIFIED |
| 10년 합산(직계존비속) | 증여세 누진 | 합산과세 기간 10년 | 코드에 상수 있음(`PRIOR_GIFT_HEIR_YEARS`), 규칙 미등록 |
| 사망 시 상속 | 상속세 | 기초·일괄·배우자공제 | 코드 구현, 규칙 미등록 |

### 2.2 Person → Company
| 거래 | 발생 세목 | 핵심 규칙 | 상태 |
|---|---|---|---|
| 현금 출자 | 없음(자본거래). 이후 주식 가치로 상속·증여 대상 | 비상장주식 평가 필요 | UNVERIFIED |
| 부모→법인 대여(무이자) | 법인: 이자 비용·세무조정 쟁점 / 주주 가치 이전 쟁점 | 특정법인 §45의5 | VERIFIED(조건부) |
| 부동산 양도(개인→법인) | 양도세 + 법인 취득세 | 시가 거래 여부가 쟁점 | 취득세 코드 있음, 법적 검증 필요 |
| 시가보다 낮은 양도 | 증여세(§35 또는 §45의5) + 법인세 부당행위 | 두 규정이 동시에 걸릴 수 있음 | §35 VERIFIED, 법인세 측 UNVERIFIED |
| 현물출자 | 양도세 이연 여부 | 조세특례제한법 | UNVERIFIED |
| 지분 증여(자녀에게 법인 주식) | 증여세 | 비상장 평가 | UNVERIFIED |

### 2.3 Company → Person
| 거래 | 발생 세목 | 상태 |
|---|---|---|
| 급여·상여·퇴직금 | 법인 비용 / 개인 근로소득 | 한도·손금 규칙 UNVERIFIED |
| 배당 | 법인 배당(비용 아님) / 개인 배당소득, 금융소득 종합과세 | UNVERIFIED |
| 대여(가지급금) | 인정이자·부당행위계산 | UNVERIFIED |
| 자산 매각(법인→개인) | 법인세 + 개인 취득세 | 시가 판단 쟁점, UNVERIFIED |
| 감자·청산 | 의제배당 | UNVERIFIED |

### 2.4 Company → Company
이 칸이 가장 크고, 현재 **거의 전부 UNVERIFIED**다. 전략 생성기도 이 단계를 `NOT_COMPUTED`로 둔다.
| 거래 | 쟁점이 되는 규칙군 | 상태 |
|---|---|---|
| 자산·부동산 양도 | 법인세 부당행위계산 부인(시가 조정) + 주주 단계 가치이전 | UNVERIFIED |
| 대여(무이자·저리) | 인정이자, 증여의제(주주) | 특정법인 부분만 VERIFIED |
| 배당 | 수입배당금 익금불산입 | UNVERIFIED |
| 용역·임대차 | 일감 몰아주기·떼어주기 | UNVERIFIED |
| 합병·분할 | 합병 이익 증여, 이월결손금 | UNVERIFIED |
| 증자·감자·전환사채 | 불균등 증자 이익 증여 | UNVERIFIED |
| 보증·채무인수 | 부당행위 | UNVERIFIED |

### 2.5 Estate → Person / Company
| 거래 | 발생 세목 | 상태 |
|---|---|---|
| 상속재산 분할 | 상속세(상속인별 안분), 연부연납·물납 | 상속세 일부 구현 |
| 사망 전 증여 합산 | 상속세 과세가액에 가산(상속인 10년·비상속인 5년) | 상수 있음, 규칙 미등록 |
| 상속주식(법인) | 최대주주 할증 평가 | UNVERIFIED |
| 상속인 간 채무·대여 | 가족 내 대여는 연결 대차에서 소거 | 재무 엔진에 구현 |

---

## Report 4 — 룰 엔진 스펙

### 4.1 스키마 (현재 `lib/rules/types.ts`와 스펙의 차이)
스펙 필드 중 현재 레지스트리에 있는 것은 `id, title, effectiveFrom, status, sources, implementedIn, openIssues`다. 추가가 필요한 필드:

```json
{
  "rule_id": "string",
  "tax_type": "GiftTax|InheritanceTax|CorporateIncomeTax|PersonalIncomeTax|CapitalGainsTax|DividendIncomeTax|AcquisitionTax|VAT|LocalTax",
  "trigger": "string",
  "conditions": [{"field": "string", "op": "gte|lte|eq|in", "value": "number|string|array", "unit": "KRW|pct|years"}],
  "taxpayer": "donor|donee|company|shareholder|heir",
  "valuation_method": "string|null",
  "formula": "string",
  "exceptions": ["string"],
  "legal_basis": [{"law": "string", "article": "string", "paragraph": "string|null"}],
  "effective_from": "YYYY-MM-DD|null",
  "effective_to": "YYYY-MM-DD|null",
  "source_version": "string",
  "last_verified": "YYYY-MM-DD",
  "status": "SUPPORTED|SUPPORTED_WITH_CONDITIONS|DISPUTED|OUTDATED|UNSUPPORTED|UNVERIFIED",
  "tax_interpretation_risk": "LOW|MEDIUM|HIGH|NOT_ASSESSED",
  "open_issues": ["string"],
  "implemented_in": ["path#symbol"]
}
```

설계 규칙:
- `effective_from`이 null이면 `open_issues`가 반드시 있어야 한다(이미 게이트 테스트로 강제 중).
- 거래일 기준으로 규칙을 선택한다: `effective_from ≤ tx_date < effective_to`. 현재 세율을 과거 거래에 쓰지 않는다.
- `tax_interpretation_risk`는 근거(법문 명확성, 예규, 심판례, 판례, 충돌 해석)가 있을 때만 채운다. 기본값은 NOT_ASSESSED이고, 임의로 LOW/MEDIUM/HIGH를 쓰지 않는다.
- Economic Risk(시뮬레이션 분포)와 Tax Interpretation Risk는 별도 필드로 둔다.

### 4.2 현재 등록된 규칙을 새 스키마로 옮긴 예
```json
{
  "rule_id": "GIFT_LOAN_IMPUTED_INTEREST",
  "tax_type": "GiftTax",
  "trigger": "무상 또는 적정 이자율 미만 금전 대출",
  "conditions": [{"field": "imputed_benefit", "op": "gte", "value": 10000000, "unit": "KRW"}],
  "taxpayer": "donee",
  "valuation_method": null,
  "formula": "benefit = principal * 0.046 - actual_interest",
  "exceptions": [],
  "legal_basis": [{"law": "상속세 및 증여세법", "article": "제41조의4", "paragraph": null}],
  "effective_from": null,
  "effective_to": null,
  "last_verified": "2026-10-02",
  "status": "SUPPORTED",
  "tax_interpretation_risk": "NOT_ASSESSED",
  "open_issues": ["시행일 미확인", "법령 원문 대조 전"],
  "implemented_in": ["lib/tax.ts#FAIR_LOAN_RATE", "lib/tax.ts#calcFamilyLoanAnalysis"]
}
```
나머지 6개(§53, §53의2, §57, §35, §45의5, 소득세법 §97의2)도 같은 변환이 필요하다. 필드 값은 `registry.ts`의 기존 내용을 그대로 옮기고, 새로 지어내지 않는다.

### 4.3 아직 규칙으로 등록하지 못한 후보 (조사 큐)
등록하려면 최소한 공식 원문 + 시행일 + 구현 위치가 필요하다.

| 우선순위 | 후보 | 왜 필요한가 |
|---|---|---|
| 1 | 비상장주식 평가 | 가족법인 구조 거의 전부의 전제. 이게 없으면 주식 이전 세금이 계산 불가 |
| 2 | 법인세 부당행위계산 부인(시가 조정) | 법인↔개인·법인 간 거래의 법인 측 과세 |
| 3 | 증자·감자 이익 증여 | 불균등 증자 시나리오 |
| 4 | 특수관계법인 거래(일감 몰아주기) | 법인 간 용역·거래 |
| 5 | 합병 이익 증여 | 법인 구조 정리 시나리오 |
| 6 | 법인 간 배당 익금불산입 | HoldCo 구조 |
| 7 | 법인세율·사업연도별 분기 | 법인세 계산 정확도 |
| 8 | 법인 취득세·종부세 | PropertyCo 구조 |

---

## Report 5 — 구현 갭 분석 (2026-11-01 코드 기준)

분류 기준: 구현됨 = 코드가 있고 테스트가 있음. 법적 검증 필요 = 코드는 있으나 규칙 레지스트리에 근거가 없음.

### 5.1 현재 구현됨
| 영역 | 위치 | 비고 |
|---|---|---|
| 증여세 계산(공제·할증·누진) | `lib/tax.ts calcGiftTax`, `lib/tax/gift.ts` | 규칙 3개 VERIFIED |
| 부담부증여 | `lib/tax/gift.ts estimateBurdenedGiftTransfer` | 규칙 미등록 |
| 저가양수·고가양도 | `lib/tax/gift.ts estimateRelatedPartySale` | §35 VERIFIED |
| 가족 간 금전대차 | `lib/tax.ts calcFamilyLoanAnalysis` 등 | §41의4 VERIFIED |
| 이월과세 | `lib/tax/policy.ts carryOverPeriodYears` | 10/5년 분기 |
| 특정법인 증여의제 | `lib/rules/specific-corp.ts` | 30%·1억·1년 합산 |
| 재무 엔진(대차대조표, 월별 현금흐름, 연결 소거) | `lib/finance/*` | 29개 테스트 |
| 가족법인 전략 생성기 | `lib/strategy/*` | COMPUTED/NOT_COMPUTED 구분 |

### 5.2 부분 구현
| 항목 | 상태 |
|---|---|
| 상속세 | 공제와 누진 계산은 있다. 사전증여 합산, 연부연납·물납, 비상장주식 평가 연동은 미통합 |
| 법인 | `corporations`, `corp_shares` 테이블과 `calcCorporateTax`, `calcCorpConversionBenefit`가 있다. 법인 간 거래·다단계 소유는 없다 |
| 전략 생성기 → UI | `app/dashboard/strategy`와 연결되지 않았다(`generateFamilyCorpPlans`를 쓰는 화면 없음) |
| 재무 엔진 → UI | `legacy-adapter`까지만 있고 화면 연결 없음 |

### 5.3 미구현
- 거래 그래프(Transaction Graph): 노드·엣지 모델, 거래 시퀀스 저장 테이블
- Look-through 가치 이전 엔진(직접/간접/법인/주주 단계 ΔNW 분해)
- TaxEvent 엔진(한 거래에서 여러 세목 동시 발생)
- 비상장주식·부동산 평가 모듈(Market/Tax/Book/Acquisition 4가지 값 분리)
- 법인세 부당행위계산 부인, 증자·감자, 합병·분할
- 다년 전략 시뮬레이터, Monte Carlo(N≥10,000), 최적화(scipy 포함)
- 설명 가능성 출력(단계별 산식 + 법령 + 출처)
- 출처 DB(`tax_sources` 테이블)와 규칙 버전 관리의 DB화

### 5.4 잘못 구현됐거나 의심되는 것
| 항목 | 내용 | 조치 |
|---|---|---|
| 단위 이중화 | 레거시 `lib/tax.ts`는 억 단위 float, 신규 `lib/finance`는 원 단위 정수 | 신규 코드는 정수 원만 사용. 레거시는 어댑터 경유 |
| `lib/tax.ts` 3,500줄 단일 파일 | 규칙이 계산 함수 안에 섞여 있어 추적이 어렵다 | 규칙 상수는 `policy.ts`로 계속 이동 |
| 이월과세 5년 고정(수정 완료) | 2023-01-01 이후 부동산 증여는 10년이어야 했다 | 이번 브랜치에서 수정, 테스트 있음 |
| 법인세율 | `calcCorporateTax`는 단일 세율표(2억/200억/3000억 구간)이고 사업연도별 분기가 없다 | 법적 검증 필요. 사업연도 기준 분기 구조로 바꿔야 한다 |

### 5.5 법적 검증 필요 (코드는 있고 근거가 없음)
상속세 공제 상수(`INHERITANCE_*`), 양도세율(`SHORT_TERM_RATES`, `LTHD_RATES`), 취득세율(`ACQUISITION_TAX_*`), 종부세(`calcComprehensiveRealEstateTax`), 연부연납 가산율, 법인세율, 장기보유특별공제. 모두 정책 파일에 값은 있지만 `VERIFIED_RULES`에는 없다. 먼저 레지스트리에 등록하고 원문과 대조해야 "검증된 것"이라고 부를 수 있다.

### 5.6 변경 제안 (기존 코드 최대한 유지)

**DB 스키마 추가**
```sql
tax_sources(id, source_type, author, organization, title, publication_date,
            access_date, url, law_reference, strategy_tags, claim_summary, reliability_notes)
tax_rules(id, rule_id, version, effective_from, effective_to, status, body jsonb,
          last_verified, source_ids uuid[])
entities(id, family_id, kind)               -- person | company | estate
transactions(id, family_id, kind, from_id, to_id, date, amount_krw,
             market_value_krw, price_krw, interest_rate, meta jsonb)
tax_events(id, transaction_id, taxpayer_id, tax_type, base_krw, tax_krw,
           rule_id, rule_version, explanation jsonb)
```
기존 `corporations`, `corp_shares`, `debts`는 `entities`/`transactions`로 마이그레이션하지 말고 어댑터로 읽는다.

**TypeScript 모듈**
```
lib/graph/       노드·엣지 타입, 거래 시퀀스 검증
lib/valuation/   자산별 4종 가치 + method/legal_basis/inputs/confidence
lib/taxevents/   transaction → TaxEvent[] (규칙 레지스트리 조회, 거래일 기준 버전 선택)
lib/antiavoid/   재분류 규칙 평가(현재 specific-corp를 여기로 일반화)
lib/explain/     TaxEvent → 단계별 설명 문자열 + 법령 + 출처
```

**구현 순서 (스펙 P0~P7에 맞춤)**
| 단계 | 내용 | 완료 조건 |
|---|---|---|
| P0 | 기존 상수를 `VERIFIED_RULES`로 전부 등록(5.5 목록) | 원문 대조 후 status 확정 |
| P1 | 거래 그래프 + 개인↔개인 TaxEvent | 스펙 Case 1~4 통과 |
| P2 | 비상장주식 평가 + 개인↔법인 | Case 5~6 |
| P3 | 법인↔법인, 다단계 소유 | Case 7~8 |
| P4 | 재분류 엔진 + look-through 이전 탐지 | Case 9 |
| P5 | 다년 시뮬레이터 | Case 10 |
| P6 | Monte Carlo + 최적화 | 분포 출력 |
| P7 | 세무사 검토 화면 | 계산 과정 재현 가능 |

각 단계는 테스트 통과 후 다음으로 간다. 규칙은 근거 없이 코드에 넣지 않는다.

### 5.7 스펙 테스트 케이스 10개의 현재 상태
| Case | 현재 |
|---|---|
| 1 현금증여 | 계산 가능 |
| 2 부동산증여 | 계산 가능(평가액을 사용자가 입력) |
| 3 부담부증여 | 계산 가능 |
| 4 저가매매 | 계산 가능(§35) |
| 5 부모→자녀법인 자산매각 | 증여 측만 부분 계산, 법인세 측 불가 |
| 6 부모→가족법인 대여 | §45의5 증여의제 계산 가능, 법인 측 불가 |
| 7 부모법인→자녀법인 거래 | 불가 |
| 8 HoldCo→PropertyCo | 불가 |
| 9 불균등 증자 | 불가 |
| 10 10년 복합 증여 후 상속 | 재무 엔진 + 증여세 부분 가능, 상속세 통합 미완 |

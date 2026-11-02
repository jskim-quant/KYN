# KYN v2 Architecture — 가족 자산이전 시뮬레이터

이 문서는 기존 KYN(Next.js + Supabase, 클라이언트 계산)에서 `backend/` 신규 Python 백엔드로의
아키텍처 전환을 정의한다. Next.js는 프론트엔드로만 남고, 모든 세무·시나리오·점수 계산은
`backend/`의 FastAPI 서비스가 담당한다.

## 0. 계층 분리 원칙

기존 KYN의 가장 큰 문제는 "계산"과 "문장/추천"이 한 파일(`scenarios/page.tsx`, 3천 줄+)에
뒤섞여 있었다는 것이다. v2는 5개 계층을 물리적으로 분리한다.

```
┌─────────────────────────────────────────────────────────┐
│ 5. LLM 보고서 엔진 (계산된 결과만 문장화, 숫자 생성 금지)     │
├─────────────────────────────────────────────────────────┤
│ 4. 리스크 엔진 (실현가능성 / 세무상 설명부담 / 유동성 / 레버리지) │
├─────────────────────────────────────────────────────────┤
│ 3. 최적화 엔진 (목표·제약에 따라 시나리오 선별·순위)          │
├─────────────────────────────────────────────────────────┤
│ 2. 시나리오 엔진 (거래 원자 조합, 선행조건, 시간순 배열)       │
├─────────────────────────────────────────────────────────┤
│ 1. 규칙 엔진 (법령 버전 테이블 기반 세액·현금흐름 계산)        │
└─────────────────────────────────────────────────────────┘
```

각 계층은 별도 모듈이며, 아래 계층의 출력만 입력으로 받는다. LLM은 4번 계층까지 계산된
결과(숫자, 등급, 사유 코드)만 받아 문장을 생성하고, 세액·세율·공제액·법적 결론을 스스로
만들어내지 않는다.

## 1. 폴더 구조

```
KYN/
├── app/                      # Next.js 프론트엔드 (기존 유지)
├── backend/                  # 신규 Python 백엔드
│   ├── app/
│   │   ├── models/           # Pydantic 도메인 모델 (Person, Asset, Debt, Scenario, ...)
│   │   ├── engines/
│   │   │   ├── rules/        # 1. 규칙 엔진 (거주자판정, 평가가액, 증여세, 상속세, 양도세, ...)
│   │   │   ├── scenario/     # 2. 시나리오 엔진 (거래 원자, 선행조건, 조합)
│   │   │   ├── optimization/ # 3. 최적화 엔진
│   │   │   └── risk/         # 4. 리스크 엔진 (feasibility.py, tax_review_risk.py, ...)
│   │   ├── rule_tables/      # 법령 버전 테이블 (JSON/YAML, 코드에 세율 하드코딩 금지)
│   │   ├── api/              # FastAPI 라우터
│   │   └── main.py
│   └── tests/
└── docs/
    └── ARCHITECTURE.md       # 이 문서
```

## 2. 법령 버전 테이블

모든 세율·공제·한도·적정이자율·평가기간·신고기한은 코드가 아니라
`backend/app/rule_tables/*.yaml`에 `LegalRuleVersion` 레코드로 저장한다
(스키마: `backend/app/models/legal_rule.py`).

계산 결과에는 항상 다음을 표시한다: 계산 기준일 · 적용 법령 시행일 · 적용 조문 ·
평가방법 · 입력값 출처 · 상태(`CALCULATED`/`ESTIMATED`/`ASSUMED`/`REQUIRES_DOCUMENT`/
`REQUIRES_EXPERT`/`NOT_IMPLEMENTED`).

## 3. Money 타입

모든 금액은 부동소수점이 아니라 `Decimal`을 사용한다 (`backend/app/models/money.py`).

## 4. 원장 불변식

가족 내부 거래(증여·매매·대여)는 가족 전체 순자산을 임의로 증가시킬 수 없다.

```
가족 전체 자산 변화 = 외부 소득·지출 + 시장가치 변화 - 세금·거래비용
```

각 `ScenarioEvent`는 복식 원장 항목을 남기고, 시뮬레이션 엔진은 매 연도 이 불변식을
검증한다 (`backend/app/engines/scenario/ledger.py`, Phase 3에서 구현 예정).

## 5. 현재 구현 범위

**Phase 1**
- [x] 폴더 구조
- [x] 핵심 Pydantic 모델: `Person`, `TaxResidencyAssessment`, `Asset`, `Debt`, `ValuationSet`,
      `Scenario`, `ScenarioEvent`, `LegalRuleVersion`
- [x] 리스크 엔진 중 **실현 가능성 점수(F1~F10)** — `backend/app/engines/risk/feasibility.py`

**Phase 2**
- [x] **세무상 설명부담 점수 (T1~T12)** — `backend/app/engines/risk/tax_review_risk.py`
      (위험 상호작용 보정, 순환거래 탐지, 세 층 분리 포함)
- [x] **법령 버전 테이블 로더** — `backend/app/engines/rules/rule_loader.py` +
      `backend/app/rule_tables/*.yaml` (모든 값은 `status: pending_review`로
      시작 — 세무사 검토 전까지 결과 status는 `REQUIRES_EXPERT`)
- [x] **거주자·비거주자 판정 엔진** — `backend/app/engines/rules/residency.py`
      (불명확 시 3개 병렬 시나리오 생성)
- [x] **증여세·상속세·양도소득세·취득세 규칙 엔진** — `backend/app/engines/rules/*_tax.py`
      (기존 `lib/tax.ts`와 수치 교차검증 완료, 누진세 계산은 `bracket_calc.py`로 공유)

**Phase 3**
- [x] **거래 원자 9개** — `backend/app/engines/scenario/transaction_atoms.py`
      (즉시증여·부담부증여·가족간대여·저가양수·제3자매매·채무인수·교환·현물출자·법정상속)
      — 스펙 3장의 150여 개 중 일부만 구현, 나머지는 미착수
- [x] **시나리오 빌더 + 기준 시나리오** — `backend/app/engines/scenario/builder.py`,
      `backend/app/engines/scenario/baseline.py` (규칙엔진 → 시나리오 → 리스크엔진 전체 연결)
- [x] **최적화 엔진** — `backend/app/engines/optimization/optimizer.py`
      (목표유형별 가중 효용함수, Pareto frontier, 하드탈락 시나리오 순위 제외)
- [x] **PostgreSQL 연동** — `backend/app/db/*` (SQLAlchemy + Alembic, 로컬 `kyn_dev` DB에
      실제 시딩·저장·재조회까지 검증). 법령 테이블은 YAML이 원천이고 DB는 영속화 계층.
- [x] **FastAPI 라우터 + Next.js 프론트엔드 연결 확인** — `backend/app/api/routes.py`,
      `lib/kyn-backend.ts`, `app/api/kyn-backend-check/route.ts` (연결 프록시만, 기존
      3천 줄 scenarios 페이지는 안전하게 그대로 둠 — 실제 전환은 별도 승인 필요)

테스트: `backend/tests/` — `python -m pytest -q` (103 passed)

## 5-1. "KYN Quant Wealth Engine" 신규 스펙과의 단계 매핑

2026-08-15에 추가된 "Quantitative Family Wealth, Leverage & Succession Planning Engine"
스펙(Phase 1~11, Monte Carlo·ML·다목적 최적화 포함)은 위 5장의 Phase 1~3과 번호가
겹치므로 혼동하지 않도록 별도 표로 매핑한다.

| 신규 스펙 Phase | 상태 | 위치 |
|---|---|---|
| 1. Tax & Succession Rule Engine | 대부분 기완료 | `engines/rules/*`, `engines/scenario/*` |
| **2. Family Balance Sheet Engine** | **완료** | `engines/balance_sheet/engine.py`, `models/balance_sheet.py` — Net Worth/D-E/LTV/Liquid Asset Ratio/Debt Service Ratio/Interest Coverage/Asset Concentration + 연간 현금흐름(Free Cash Flow) |
| **3. Leverage & Capital Recycling** | **완료** | `engines/leverage/engine.py`, `models/leverage.py` — Equity Ratio(20/40/60/80%)별 ROE/현금흐름/LTV/이자부담/DSCR, 자산가치 하락 스트레스(깡통 여부), 자본순환(담보→차입→신규매입, 순자산 불변식 검증) |
| 4. Asset Allocation Engine | 미착수 | — |
| 5. Deterministic Stress Testing (Equity Ratio × Scenario 매트릭스) | 부분 (F10 스트레스생존만) | `engines/risk/feasibility.py` |
| 6. Multi-Period Simulation (10/20/30yr) | 부분 (단순 선형만) | `engines/scenario/builder.py` |
| 7. Monte Carlo Risk Engine | 미착수 | — |
| 8. ML Layer (유동성 부족 예측 등) | 미착수 | — |
| 9~10. Optimization / Pareto | 부분 (이산 후보 비교만, 연속변수 최적화 아님) | `engines/optimization/optimizer.py` |
| 11. Decision Dashboard | 미착수 | — |

Phase 2(대차대조표)가 Phase 3~11 전부의 입력이 되는 기반이라 우선 구현했고,
이어서 Phase 3(레버리지·자본순환)을 완료했다. 다음 자연스러운 단계는 Phase 4
(자산배분 엔진 — 가족 전체 대차대조표를 하나의 포트폴리오로 보는 확장 Markowitz 분석)다.

## 6. 왜 기존 `lib/tax.ts`/`lib/tax/*`를 이번에 포함하지 않았는가

기존 TS 엔진은 계산과 표시 로직이 섞여 있고, 세율이 `policy.ts`에 상수로 박혀 있어
법령 버전 관리가 안 된다. v2 규칙 엔진(Phase 2)에서 이 값들을 `rule_tables/*.yaml`로
이전하면서 재구현한다. 기존 TS 엔진은 마이그레이션 완료 전까지 프론트엔드 폴백으로만 유지한다.

# 가족 자산 플래너 — Estate Planner

## 🚀 로컬 실행 (5분)

### 1. 설치
```bash
npm install
```

### 2. Supabase 설정
1. https://app.supabase.com → New Project (Region: Seoul)
2. **SQL Editor** → `supabase/schema.sql` 내용 전체 붙여넣기 → Run
3. **Settings → API** → URL, anon key 복사

### 3. 환경변수
```bash
cp .env.local.example .env.local
# .env.local 열어서 Supabase URL, anon key 입력
```

### 4. 실행
```bash
npm run dev
# http://localhost:3000
```

---

## ☁️ Vercel 배포 (10분)

### 1. GitHub 푸시
```bash
git init
git add .
git commit -m "feat: initial estate planner"
git remote add origin https://github.com/jskim-quant/estate-planner.git
git push -u origin main
```

### 2. Vercel 연결
- https://vercel.com → Import Git Repository → estate-planner
- Environment Variables 추가:
  - `NEXT_PUBLIC_SUPABASE_URL`
  - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- Deploy

### 3. 가족 공유
배포된 URL을 가족에게 공유 → 초대 코드로 합류

---

## 📁 프로젝트 구조

```
estate-planner/
├── app/
│   ├── page.tsx              # 랜딩 페이지
│   ├── auth/
│   │   ├── login/            # 로그인
│   │   └── signup/           # 회원가입 + 가족 코드 합류
│   └── dashboard/
│       ├── page.tsx          # 개요
│       ├── members/          # 가족 구성원
│       ├── assets/           # 자산 목록
│       ├── tax/              # 세금 분석
│       ├── plan/             # 이전 계획
│       ├── scenarios/        # 시나리오 비교
│       └── settings/         # 설정 (초대코드, 거시변수)
├── lib/
│   ├── supabase.ts           # Supabase client
│   └── tax.ts                # 세금 계산 엔진
├── types/
│   └── index.ts              # TypeScript 타입
└── supabase/
    └── schema.sql            # DB 스키마 (SQL Editor에서 실행)
```

---

## 🗺️ 로드맵

### Phase 1 — 현재 (기본 구조)
- [x] 인증 (회원가입/로그인)
- [x] 가족 생성 + 초대 코드
- [x] 자산 등록
- [x] 세금 엔진 (증여·상속·양도·보유)
- [x] 개요 대시보드

### Phase 2 — 4주 후 (핵심 기능)
- [ ] 가족 구성원 CRUD
- [ ] 자산 CRUD (지분 구조 포함)
- [ ] 이전 계획 설계
- [ ] 10가지 시나리오 비교
- [ ] 현금흐름 방어 시나리오

### Phase 3 — 8주 후 (전문가 도구)
- [ ] PCI 역산 (세무조사 리스크)
- [ ] 자금출처 소명 계산기
- [ ] 감정평가 타이밍 최적화
- [ ] 증여 vs 상속 손익분기점
- [ ] 상담 PDF 리포트 자동 생성

### Phase 4 — SaaS
- [ ] 멀티 가족 계정
- [ ] 세무사 구독 플랜
- [ ] 세법 업데이트 시스템

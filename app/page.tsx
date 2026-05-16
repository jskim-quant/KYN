import Link from 'next/link';
import { createServerSupabaseClient } from '@/lib/supabase';
import { redirect } from 'next/navigation';

export default async function HomePage() {
  const supabase = createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (user) redirect('/dashboard');

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-blue-950 to-slate-900 flex flex-col">
      {/* Nav */}
      <nav className="px-6 py-4 flex items-center justify-between max-w-6xl mx-auto w-full">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 bg-blue-500 rounded-xl flex items-center justify-center">
            <span className="text-white font-bold text-sm tracking-wider">KYN</span>
          </div>
          <div>
            <div className="text-white font-bold text-sm leading-tight">KYN</div>
            <div className="text-slate-400 text-xs leading-tight">가족 자산의 뿌리</div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <Link href="/auth/login" className="text-slate-300 hover:text-white text-sm transition-colors">
            로그인
          </Link>
          <Link href="/auth/signup" className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors">
            무료 시작
          </Link>
        </div>
      </nav>

      {/* Hero */}
      <main className="flex-1 flex flex-col items-center justify-center px-6 py-16 text-center max-w-4xl mx-auto w-full">
        <div className="inline-flex items-center gap-2 bg-blue-500/10 border border-blue-500/20 text-blue-300 text-xs font-medium px-3 py-1.5 rounded-full mb-8">
          한국 세법 기반 가족 자산 최적화 엔진
        </div>

        <div className="mb-4">
          <span className="text-7xl md:text-8xl font-bold text-white tracking-tight">KYN</span>
        </div>
        <p className="text-slate-400 text-lg mb-3">가족 자산의 뿌리</p>
        <p className="text-slate-500 text-sm mb-10 max-w-xl">
          증여세·상속세·양도세를 통합 계산하고, 법인·신탁·재단 구조를 비교해
          최적의 자산 이전 전략을 자동으로 추천합니다.
        </p>

        <div className="flex flex-col sm:flex-row gap-4 mb-16">
          <Link href="/auth/signup"
            className="bg-blue-600 text-white px-8 py-3.5 rounded-xl text-base font-semibold hover:bg-blue-700 transition-colors">
            가족 계정 만들기 →
          </Link>
          <Link href="/auth/login"
            className="bg-white/10 text-white border border-white/20 px-8 py-3.5 rounded-xl text-base font-medium hover:bg-white/20 transition-colors">
            초대 코드로 합류
          </Link>
        </div>

        {/* Features */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 w-full text-left">
          {[
            { icon: '🏠', title: '다자산 통합 관리',
              desc: '부동산·금융·비상장주식을 한 곳에서. 취득가·취득일 기반 정확한 세금 계산.' },
            { icon: '⚖️', title: '세무조사 리스크 사전 체크',
              desc: 'PCI 역산으로 리스크 미리 파악. 자금출처 소명 준비 가이드.' },
            { icon: '🎯', title: '10가지 시나리오 비교',
              desc: '개인·법인·신탁·재단 구조를 10년 순자산 기준으로 자동 비교 추천.' },
            { icon: '👨‍👩‍👧‍👦', title: '가족 공동 접근',
              desc: '초대 코드 하나로 가족 전체가 같은 데이터를 실시간 공유.' },
            { icon: '📊', title: '현금흐름 방어 시나리오',
              desc: '금리 스트레스·보유세 부담으로 자산을 얼마나 오래 버틸 수 있는지 계산.' },
            { icon: '📄', title: '상담 리포트 자동 생성',
              desc: '세무사 상담용 PDF를 클릭 한 번으로. 지금 당장 해야 할 것 체크리스트.' },
          ].map(f => (
            <div key={f.title} className="bg-white/5 border border-white/10 rounded-xl p-5">
              <div className="text-2xl mb-3">{f.icon}</div>
              <div className="text-white font-semibold text-sm mb-1.5">{f.title}</div>
              <div className="text-slate-400 text-xs leading-relaxed">{f.desc}</div>
            </div>
          ))}
        </div>
      </main>

      <footer className="text-center py-6 text-slate-600 text-xs">
        KYN · 의사결정 보조 도구입니다. 실제 세금 신고 전 세무사 확인 필수.
      </footer>
    </div>
  );
}

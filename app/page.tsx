import Link from 'next/link';
import { Noto_Serif_KR, Noto_Sans_KR } from 'next/font/google';

const serif = Noto_Serif_KR({ subsets: ['latin'], weight: ['300','400','500','600'] });
const sans  = Noto_Sans_KR ({ subsets: ['latin'], weight: ['300','400','500','700'] });

export default function HomePage() {
  return (
    <div className={`lp ${sans.className}`}>

      {/* Nav */}
      <nav className="lp-nav">
        <Link href="/" style={{ textDecoration: 'none' }}>
          <span className="kyn-wordmark">KYN</span>
        </Link>
        <div className="lp-nav-right">
          <Link href="/auth/login" className="lp-navlink">로그인</Link>
          <Link href="/auth/signup" className="lp-btn-sm">시작하기</Link>
        </div>
      </nav>

      {/* Split */}
      <div className="lp-split">

        {/* LEFT — Hero */}
        <section className="lp-left">
          <div className="hero">
            <span className="hero-eyebrow">가족 자산 이전 설계 엔진</span>
            <h1 className={`lp-h1 ${serif.className}`}>
              부의 이전
              <span className="hero-line2">설계하는 가족</span>
            </h1>
            <p className="hero-sub">
              자산은 충분하지만, 현금은 부족합니다.<br />
              설계가 없으면 무너지는 건 세금이 아니라 <strong>자산</strong>입니다.
            </p>
            <div className="cta-row">
              <Link href="/auth/signup" className="cta-primary">가족 계정 만들기</Link>
              <Link href="/auth/signup" className="cta-link">→ 초대 코드로 합류</Link>
            </div>
          </div>
        </section>

        {/* RIGHT — Questions + Tools */}
        <aside className="lp-right">
          <div>
            <div className="col-label">핵심 질문</div>
            <div className="qlist">
              {[
                { n: '01', q: '현금흐름이 버틸 수 있는가', p: '상속 발생 후 6개월. 임대수익·담보대출·예금으로 세금을 감당할 수 있는지 연도별로 계산합니다.' },
                { n: '02', q: '어떤 자산을, 언제, 누구에게', p: '지금 증여할지·10년 뒤 공제를 리셋해 이전할지·세대를 건너뛸지, 세후 순자산으로 비교합니다.' },
                { n: '03', q: '금리·공실·가격 하락에도 견디는가', p: '금리 +2%p, 공실 상승 시나리오에서 납부 계획이 무너지는 시점을 미리 찾아냅니다.' },
              ].map(item => (
                <div key={item.n} className="qitem">
                  <span className={`qn ${serif.className}`}>{item.n}</span>
                  <div>
                    <h4>{item.q}</h4>
                    <p>{item.p}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div>
            <div className="col-label">설계 도구</div>
            <div className="tools">
              {[
                { t: '현금흐름 회생 진단', d: '6개월 내 부족액 — 급매 없이 버틸 수 있는 한계' },
                { t: '전략 시나리오 비교', d: '7가지 이전 전략을 10년 순자산 기준으로 비교' },
                { t: '납부 재원 설계', d: '연부연납·담보대출·임대수익을 조합한 재원 계획' },
              ].map(tool => (
                <div key={tool.t} className="tool">
                  <div className="tool-t">{tool.t}</div>
                  <div className="tool-d">{tool.d}</div>
                </div>
              ))}
            </div>
          </div>
        </aside>
      </div>

    </div>
  );
}

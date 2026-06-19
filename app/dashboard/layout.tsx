'use client';
import { useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import Link from 'next/link';
import { createClient } from '@/lib/supabase';

const NAV = [
  { href: '/dashboard',           label: '개요' },
  { href: '/dashboard/members',   label: '가족 구성' },
  { href: '/dashboard/assets',    label: '자산 목록' },
  { href: '/dashboard/tax',       label: '세금 분석' },
  { href: '/dashboard/plan',      label: '이전 계획' },
  { href: '/dashboard/strategy',  label: '전략 분석' },
  { href: '/dashboard/scenarios', label: '시나리오' },
  { href: '/dashboard/settings',  label: '설정' },
];

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const router   = useRouter();
  const pathname = usePathname();
  const supabase = createClient();
  const [inviteCode, setInviteCode] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) router.push('/auth/login');
    });
    supabase.from('profiles').select('family_id').single().then(({ data }) => {
      if (data?.family_id) {
        supabase.from('families').select('invite_code').eq('id', data.family_id).single()
          .then(({ data: fam }) => { if (fam?.invite_code) setInviteCode(fam.invite_code); });
      }
    });
  }, []);

  useEffect(() => {
    document.querySelector('.kyn-topnav a[aria-current="page"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [pathname]);

  async function handleLogout() {
    await supabase.auth.signOut();
    router.push('/');
  }

  function copyInvite() {
    navigator.clipboard.writeText(inviteCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="kyn-dashboard-shell">
      <header className="kyn-topbar">
        <div className="kyn-topbar-row">
          <Link href="/dashboard" className="kyn-wordmark" aria-label="KYN 대시보드">
            KYN
          </Link>
          <nav className="kyn-topnav" aria-label="대시보드 메뉴">
            {NAV.map(item => {
              const active = pathname === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={active ? 'active' : ''}
                  aria-current={active ? 'page' : undefined}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
          <div className="kyn-topbar-actions">
            {inviteCode && (
              <button onClick={copyInvite} className="kyn-invite-code" title="초대 코드 복사">
                <span>초대 코드</span>
                <strong>{copied ? '복사됨' : inviteCode}</strong>
              </button>
            )}
            <button onClick={handleLogout} className="kyn-logout">로그아웃</button>
          </div>
        </div>
      </header>

      <main className="kyn-dashboard-content">
        {children}
      </main>
    </div>
  );
}

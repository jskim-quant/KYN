'use client';
import { useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import Link from 'next/link';
import clsx from 'clsx';
import { createClient } from '@/lib/supabase';

const NAV = [
  { href: '/dashboard',           label: '개요',          icon: '▦' },
  { href: '/dashboard/members',   label: '가족 구성',     icon: '◎' },
  { href: '/dashboard/assets',    label: '자산 목록',     icon: '◈' },
  { href: '/dashboard/tax',       label: '세금 분석',     icon: '◉' },
  { href: '/dashboard/plan',      label: '이전 계획',     icon: '◆' },
  { href: '/dashboard/scenarios', label: '시나리오',      icon: '◇' },
  { href: '/dashboard/settings',  label: '설정',          icon: '⚙' },
];

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const router   = useRouter();
  const pathname = usePathname();
  const supabase = createClient();
  const [inviteCode, setInviteCode] = useState<string>('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) router.push('/auth/login');
    });
    // 초대 코드 로드
    supabase
      .from('profiles')
      .select('family_id')
      .single()
      .then(({ data }) => {
        if (data?.family_id) {
          supabase
            .from('families')
            .select('invite_code')
            .eq('id', data.family_id)
            .single()
            .then(({ data: fam }) => {
              if (fam?.invite_code) setInviteCode(fam.invite_code);
            });
        }
      });
  }, []);

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
    <div className="flex min-h-screen bg-gray-50">
      {/* Sidebar */}
      <aside className="w-56 bg-white border-r border-gray-200 flex flex-col fixed h-full z-10">
        <div className="p-4 border-b border-gray-100">
          <Link href="/" className="flex items-center gap-2.5">
            <div className="w-9 h-9 bg-blue-600 rounded-xl flex items-center justify-center">
              <span className="text-white font-bold text-xs tracking-wider">KYN</span>
            </div>
            <div>
              <div className="text-sm font-bold text-gray-900">KYN</div>
              <div className="text-xs text-gray-400">Family Wealth, Rooted.</div>
            </div>
          </Link>
        </div>

        <nav className="flex-1 p-3 space-y-0.5 overflow-y-auto">
          {NAV.map(item => (
            <Link key={item.href} href={item.href}
              className={clsx(
                'flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors',
                pathname === item.href
                  ? 'bg-blue-50 text-blue-700 font-medium'
                  : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
              )}
            >
              <span className="w-5 text-center">{item.icon}</span>
              {item.label}
            </Link>
          ))}
        </nav>

        {/* Invite code */}
        {inviteCode && (
          <div className="p-3 border-t border-gray-100">
            <div className="text-xs text-gray-400 mb-1.5">가족 초대 코드</div>
            <button onClick={copyInvite}
              className="w-full flex items-center justify-between bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 hover:bg-gray-100 transition-colors">
              <span className="font-mono font-bold text-blue-700 tracking-widest text-sm">
                {inviteCode}
              </span>
              <span className="text-xs text-gray-400">
                {copied ? '복사됨 ✓' : '복사'}
              </span>
            </button>
          </div>
        )}

        <div className="p-3 border-t border-gray-100">
          <button onClick={handleLogout}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-500 hover:text-gray-700 hover:bg-gray-50 rounded-lg transition-colors">
            <span>→</span> 로그아웃
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 ml-56 min-h-screen">
        {children}
      </main>
    </div>
  );
}

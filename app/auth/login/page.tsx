'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { createClient } from '@/lib/supabase';

export default function LoginPage() {
  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');
  const [error, setError]       = useState('');
  const [loading, setLoading]   = useState(false);
  const router = useRouter();
  const supabase = createClient();

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true); setError('');
    try {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      router.push('/dashboard');
      router.refresh();
    } catch {
      setError('이메일 또는 비밀번호가 올바르지 않습니다.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ minHeight: '100vh', background: '#FFFFFF', display: 'flex', flexDirection: 'column' }}>

      {/* Top bar */}
      <div style={{ width: '100%', height: 2, background: '#1E1E20' }} />

      {/* Nav */}
      <nav style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '22px 48px', borderBottom: '1px solid #D8D8D6' }}>
        <Link href="/" className="kyn-wordmark" style={{ textDecoration: 'none' }}>
          KYN
        </Link>
        <Link href="/auth/signup" style={{ fontSize: 12.5, color: '#8E8E93', border: '1px solid #D8D8D6', padding: '4px 10px', textDecoration: 'none', fontWeight: 300 }}>
          회원가입
        </Link>
      </nav>

      {/* Form */}
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        <div style={{ width: '100%', maxWidth: 380 }}>

          {/* 헤더 */}
          <div style={{ marginBottom: 40 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
              <div style={{ width: 20, height: 1, background: '#B8973A' }} />
              <span style={{ fontSize: 9, letterSpacing: 2, color: '#8E8E93', textTransform: 'uppercase' as const }}>Sign In</span>
            </div>
            <h1 style={{ fontFamily: 'var(--serif)', fontSize: 32, fontWeight: 300, color: '#1E1E20', letterSpacing: -1, marginBottom: 6 }}>
              로그인
            </h1>
            <p style={{ fontSize: 12.5, color: '#8E8E93', fontWeight: 300 }}>
              KYN 가족 자산 플래너
            </p>
          </div>

          {/* 입력 폼 */}
          <form onSubmit={handleLogin}>
            <div style={{ marginBottom: 16 }}>
              <label style={{ display: 'block', fontSize: 10, letterSpacing: 1, color: '#8E8E93', textTransform: 'uppercase' as const, marginBottom: 8 }}>
                이메일
              </label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="example@email.com"
                autoFocus
                style={{ width: '100%', padding: '12px 14px', fontSize: 13, border: '1px solid #D8D8D6', background: '#FFFFFF', color: '#1E1E20', outline: 'none', fontFamily: 'inherit', boxSizing: 'border-box' }}
              />
            </div>

            <div style={{ marginBottom: 24 }}>
              <label style={{ display: 'block', fontSize: 10, letterSpacing: 1, color: '#8E8E93', textTransform: 'uppercase' as const, marginBottom: 8 }}>
                비밀번호
              </label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                style={{ width: '100%', padding: '12px 14px', fontSize: 13, border: '1px solid #D8D8D6', background: '#FFFFFF', color: '#1E1E20', outline: 'none', fontFamily: 'inherit', boxSizing: 'border-box' }}
              />
            </div>

            {error && (
              <div style={{ marginBottom: 16, padding: '10px 14px', border: '1px solid #D8D8D6', fontSize: 12, color: '#8E8E93', borderLeft: '2px solid #1E1E20' }}>
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading || !email || !password}
              style={{ width: '100%', padding: '14px', fontSize: 10, letterSpacing: 2, textTransform: 'uppercase' as const, background: loading ? '#8E8E93' : '#1E1E20', color: '#FFFFFF', border: '1.5px solid #B8973A', cursor: loading ? 'not-allowed' : 'pointer', fontWeight: 500 }}>
              {loading ? '로그인 중...' : '로그인'}
            </button>
          </form>

          {/* 하단 링크 */}
          <div style={{ marginTop: 28, paddingTop: 24, borderTop: '1px solid #D8D8D6', display: 'flex', justifyContent: 'center', gap: 6 }}>
            <span style={{ fontSize: 12, color: '#8E8E93', fontWeight: 300 }}>계정이 없으신가요?</span>
            <Link href="/auth/signup" style={{ fontSize: 12, color: '#1E1E20', textDecoration: 'none', fontWeight: 400, borderBottom: '1px solid #D8D8D6' }}>
              회원가입
            </Link>
          </div>
        </div>
      </div>

      {/* Bottom */}
      <div style={{ borderTop: '1px solid #D8D8D6', padding: '14px 52px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 9, color: '#8E8E93' }}>의사결정 보조 도구 · 실제 세금 신고 전 세무사 확인 필수</span>
        <span style={{ fontSize: 9, color: '#8E8E93' }}>KYN © 2026</span>
      </div>
    </div>
  );
}

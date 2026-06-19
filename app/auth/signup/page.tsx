'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { createClient } from '@/lib/supabase';

export default function SignupPage() {
  const [name, setName]           = useState('');
  const [email, setEmail]         = useState('');
  const [password, setPassword]   = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [mode, setMode]           = useState<'new' | 'join'>('new');
  const [error, setError]         = useState('');
  const [loading, setLoading]     = useState(false);
  const router = useRouter();
  const supabase = createClient();

  async function handleSignup(e: React.FormEvent) {
    e.preventDefault();
    if (!name || !email || !password) { setError('모든 항목을 입력하세요.'); return; }
    if (password.length < 6) { setError('비밀번호는 6자 이상이어야 합니다.'); return; }
    if (mode === 'join' && !inviteCode) { setError('초대 코드를 입력하세요.'); return; }

    setLoading(true); setError('');
    try {
      const { error: signupError } = await supabase.auth.signUp({
        email, password,
        options: { data: { name } },
      });
      if (signupError) throw signupError;

      const { error: loginError } = await supabase.auth.signInWithPassword({ email, password });
      if (loginError) throw loginError;

      if (mode === 'new') {
        await supabase.rpc('create_family', { family_name: `${name} 가족` });
      } else {
        const { data: joinData } = await supabase.rpc('join_family', {
          code: inviteCode.trim().toUpperCase(),
        });
        if (joinData?.error) throw new Error(joinData.error);
      }

      router.push('/dashboard');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '오류가 발생했습니다.');
    } finally {
      setLoading(false);
    }
  }

  const inputStyle = {
    width: '100%',
    padding: '12px 14px',
    fontSize: 13,
    border: '1px solid #D8D8D6',
    background: '#FFFFFF',
    color: '#1E1E20',
    outline: 'none',
    fontFamily: 'inherit',
    boxSizing: 'border-box' as const,
  };

  const labelStyle = {
    display: 'block',
    fontSize: 10,
    letterSpacing: 1,
    color: '#8E8E93',
    textTransform: 'uppercase' as const,
    marginBottom: 8,
  };

  return (
    <div style={{ minHeight: '100vh', background: '#FFFFFF', display: 'flex', flexDirection: 'column' }}>

      {/* Top bar */}
      <div style={{ width: '100%', height: 2, background: '#1E1E20' }} />

      {/* Nav */}
      <nav style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '22px 48px', borderBottom: '1px solid #D8D8D6' }}>
        <Link href="/" className="kyn-wordmark" style={{ textDecoration: 'none' }}>
          KYN
        </Link>
        <Link href="/auth/login" style={{ fontSize: 12.5, color: '#8E8E93', border: '1px solid #D8D8D6', padding: '4px 10px', textDecoration: 'none', fontWeight: 300 }}>
          로그인
        </Link>
      </nav>

      {/* Form */}
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        <div style={{ width: '100%', maxWidth: 380 }}>

          {/* 헤더 */}
          <div style={{ marginBottom: 36 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
              <div style={{ width: 20, height: 1, background: '#B8973A' }} />
              <span style={{ fontSize: 9, letterSpacing: 2, color: '#8E8E93', textTransform: 'uppercase' as const }}>Create Account</span>
            </div>
            <h1 style={{ fontFamily: 'var(--serif)', fontSize: 32, fontWeight: 300, color: '#1E1E20', letterSpacing: -1, marginBottom: 6 }}>
              계정 만들기
            </h1>
            <p style={{ fontSize: 12.5, color: '#8E8E93', fontWeight: 300 }}>
              KYN 가족 자산 플래너
            </p>
          </div>

          {/* 모드 탭 */}
          <div style={{ display: 'flex', border: '1px solid #D8D8D6', marginBottom: 28 }}>
            {(['new', 'join'] as const).map((m, i) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                style={{
                  flex: 1,
                  padding: '10px',
                  fontSize: 11,
                  fontWeight: mode === m ? 500 : 300,
                  color: mode === m ? '#1E1E20' : '#8E8E93',
                  background: mode === m ? '#F2F2F0' : '#FFFFFF',
                  border: 'none',
                  borderLeft: i === 1 ? '1px solid #D8D8D6' : 'none',
                  cursor: 'pointer',
                  letterSpacing: 0.5,
                }}>
                {m === 'new' ? '새 가족 만들기' : '초대 코드 합류'}
              </button>
            ))}
          </div>

          {/* 입력 폼 */}
          <form onSubmit={handleSignup}>
            <div style={{ marginBottom: 16 }}>
              <label style={labelStyle}>이름</label>
              <input
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="홍길동"
                autoFocus
                style={inputStyle}
              />
            </div>

            <div style={{ marginBottom: 16 }}>
              <label style={labelStyle}>이메일</label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="example@email.com"
                style={inputStyle}
              />
            </div>

            <div style={{ marginBottom: mode === 'join' ? 16 : 24 }}>
              <label style={labelStyle}>비밀번호 (6자 이상)</label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                style={inputStyle}
              />
            </div>

            {mode === 'join' && (
              <div style={{ marginBottom: 24 }}>
                <label style={labelStyle}>초대 코드</label>
                <input
                  value={inviteCode}
                  onChange={e => setInviteCode(e.target.value)}
                  placeholder="XXXXXX"
                  style={{ ...inputStyle, letterSpacing: 3, textTransform: 'uppercase' }}
                />
              </div>
            )}

            {error && (
              <div style={{ marginBottom: 16, padding: '10px 14px', border: '1px solid #D8D8D6', fontSize: 12, color: '#8E8E93', borderLeft: '2px solid #1E1E20' }}>
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading || !name || !email || !password}
              style={{ width: '100%', padding: '14px', fontSize: 10, letterSpacing: 2, textTransform: 'uppercase' as const, background: loading ? '#8E8E93' : '#1E1E20', color: '#FFFFFF', border: '1.5px solid #B8973A', cursor: loading ? 'not-allowed' : 'pointer', fontWeight: 500 }}>
              {loading ? '처리 중...' : mode === 'new' ? '가족 계정 만들기' : '가족에 합류하기'}
            </button>
          </form>

          {/* 하단 링크 */}
          <div style={{ marginTop: 28, paddingTop: 24, borderTop: '1px solid #D8D8D6', display: 'flex', justifyContent: 'center', gap: 6 }}>
            <span style={{ fontSize: 12, color: '#8E8E93', fontWeight: 300 }}>이미 계정이 있으신가요?</span>
            <Link href="/auth/login" style={{ fontSize: 12, color: '#1E1E20', textDecoration: 'none', fontWeight: 400, borderBottom: '1px solid #D8D8D6' }}>
              로그인
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

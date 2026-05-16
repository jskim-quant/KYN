'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { createClient } from '@/lib/supabase';

export default function SignupPage() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [mode, setMode] = useState<'new' | 'join'>('new');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const supabase = createClient();

  async function handleSignup(e: React.FormEvent) {
    e.preventDefault();
    if (!name || !email || !password) { setError('모든 항목을 입력하세요.'); return; }
    if (password.length < 6) { setError('비밀번호는 6자 이상이어야 합니다.'); return; }
    if (mode === 'join' && !inviteCode) { setError('초대 코드를 입력하세요.'); return; }

    setLoading(true); setError('');
    try {
      // 1. 회원가입
      const { error: signupError } = await supabase.auth.signUp({
        email, password,
        options: { data: { name } },
      });
      if (signupError) throw signupError;

      // 2. 바로 로그인
      const { error: loginError } = await supabase.auth.signInWithPassword({ email, password });
      if (loginError) throw loginError;

      // 3. 가족 생성 (로그인 후에 호출)
      if (mode === 'new') {
        await supabase.rpc('create_family', { family_name: `${name} 가족` });
      } else {
        const { data: joinData } = await supabase.rpc('join_family', {
          code: inviteCode.trim().toUpperCase(),
        });
        if (joinData?.error) throw new Error(joinData.error);
      }

      router.push('/dashboard');
    } catch (err: any) {
      setError(err.message || '오류가 발생했습니다.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <Link href="/" className="inline-flex items-center gap-2 mb-4">
            <div className="w-10 h-10 bg-blue-600 rounded-xl flex items-center justify-center mx-auto">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5">
                <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
              </svg>
            </div>
          </Link>
          <h1 className="text-2xl font-bold text-gray-900">계정 만들기</h1>
          <p className="text-sm text-gray-500 mt-1">KYN 시작하기</p>
        </div>

        {/* Mode tabs */}
        <div className="flex bg-gray-100 rounded-xl p-1 mb-6">
          <button
            onClick={() => setMode('new')}
            className={`flex-1 py-2 text-sm font-medium rounded-lg transition-all ${mode === 'new' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'
              }`}
          >새 가족 만들기</button>
          <button
            onClick={() => setMode('join')}
            className={`flex-1 py-2 text-sm font-medium rounded-lg transition-all ${mode === 'join' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'
              }`}
          >초대 코드 합류</button>
        </div>

        <div className="card">
          <form onSubmit={handleSignup} className="space-y-4">
            <div>
              <label className="label">이름</label>
              <input className="input" placeholder="김준성" value={name}
                onChange={e => setName(e.target.value)} />
            </div>
            <div>
              <label className="label">이메일</label>
              <input type="email" className="input" placeholder="example@email.com" value={email}
                onChange={e => setEmail(e.target.value)} />
            </div>
            <div>
              <label className="label">비밀번호 (6자 이상)</label>
              <input type="password" className="input" value={password}
                onChange={e => setPassword(e.target.value)} />
            </div>

            {mode === 'join' && (
              <div>
                <label className="label">가족 초대 코드</label>
                <input className="input uppercase tracking-widest text-center text-lg font-mono"
                  placeholder="ABC123" maxLength={6} value={inviteCode}
                  onChange={e => setInviteCode(e.target.value.toUpperCase())} />
                <p className="text-xs text-gray-400 mt-1">가족 구성원에게 코드를 받으세요</p>
              </div>
            )}

            {error && <div className="error-box">{error}</div>}

            <button type="submit" disabled={loading} className="btn-primary w-full">
              {loading ? '처리 중...' : mode === 'new' ? '가족 계정 만들기' : '가족에 합류하기'}
            </button>
          </form>
        </div>

        <p className="text-center text-sm text-gray-500 mt-4">
          이미 계정이 있으신가요?{' '}
          <Link href="/auth/login" className="text-blue-600 font-medium hover:underline">
            로그인
          </Link>
        </p>
      </div>
    </div>
  );
}

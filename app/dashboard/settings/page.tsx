'use client';
import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase';
import { MacroSettings } from '@/types';

function Field({ label, sub, children }: { label: string; sub?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="label">{label}</label>
      {sub && <p className="text-xs text-gray-400 mb-1">{sub}</p>}
      {children}
    </div>
  );
}

export default function SettingsPage() {
  const [familyName, setFamilyName] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [macro, setMacro]           = useState<MacroSettings | null>(null);
  const [macroForm, setMacroForm]   = useState<Partial<MacroSettings>>({});
  const [familyId, setFamilyId]     = useState<string | null>(null);
  const [loading, setLoading]       = useState(true);
  const [saving, setSaving]         = useState(false);
  const [savingMacro, setSavingMacro] = useState(false);
  const [copied, setCopied]         = useState(false);
  const [savedMsg, setSavedMsg]     = useState('');
  const supabase = createClient();

  useEffect(() => {
    async function load() {
      const { data: p } = await supabase.from('profiles').select('family_id').single();
      if (!p?.family_id) { setLoading(false); return; }
      setFamilyId(p.family_id);
      const [{ data: fam }, { data: ms }] = await Promise.all([
        supabase.from('families').select('name, invite_code').eq('id', p.family_id).single(),
        supabase.from('macro_settings').select('*').eq('family_id', p.family_id).single(),
      ]);
      setFamilyName(fam?.name || '');
      setInviteCode(fam?.invite_code || '');
      setMacro(ms || null);
      setMacroForm(ms || {});
      setLoading(false);
    }
    load();
  }, []);

  async function saveFamilyName() {
    if (!familyId || !familyName.trim()) return;
    setSaving(true);
    await supabase.from('families').update({ name: familyName, updated_at: new Date().toISOString() }).eq('id', familyId);
    setSaving(false);
    flash('가족 이름이 저장됐어요');
  }

  async function saveMacro() {
    if (!familyId) return;
    setSavingMacro(true);
    if (macro?.id) {
      await supabase.from('macro_settings').update({ ...macroForm, updated_at: new Date().toISOString() }).eq('id', macro.id);
    } else {
      await supabase.from('macro_settings').insert({ ...macroForm, family_id: familyId });
    }
    setSavingMacro(false);
    flash('거시 변수가 저장됐어요');
  }

  function flash(msg: string) {
    setSavedMsg(msg);
    setTimeout(() => setSavedMsg(''), 2500);
  }

  function copyInvite() {
    navigator.clipboard.writeText(inviteCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function mf(key: keyof MacroSettings) {
    return {
      value: (macroForm[key] as number) ?? 0,
      onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
        setMacroForm(prev => ({ ...prev, [key]: +e.target.value })),
    };
  }

  if (loading) return <div className="p-8 text-sm text-gray-400">로딩 중...</div>;

  return (
    <div className="p-8 max-w-2xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">설정</h1>
        <p className="text-sm text-gray-500 mt-1">가족 정보 및 거시 변수 설정</p>
      </div>

      {savedMsg && (
        <div className="mb-4 bg-green-50 border border-green-200 rounded-xl px-4 py-3 text-sm text-green-700 flex items-center gap-2">
          ✓ {savedMsg}
        </div>
      )}

      {/* 가족 정보 */}
      <section className="card mb-4">
        <div className="text-sm font-semibold text-gray-700 mb-4">가족 정보</div>
        <div className="space-y-3">
          <Field label="가족 이름">
            <div className="flex gap-2">
              <input className="input flex-1" value={familyName}
                onChange={e => setFamilyName(e.target.value)}
                placeholder="김씨 가족" />
              <button onClick={saveFamilyName} disabled={saving} className="btn-primary shrink-0">
                {saving ? '저장 중...' : '저장'}
              </button>
            </div>
          </Field>

          <Field label="초대 코드" sub="가족 구성원에게 공유하면 같은 데이터를 함께 볼 수 있어요">
            <div className="flex items-center justify-between bg-gray-50 border border-gray-200 rounded-xl px-4 py-3">
              <span className="font-mono font-bold text-blue-700 tracking-widest text-lg">
                {inviteCode || '—'}
              </span>
              <button onClick={copyInvite}
                className="text-sm text-gray-500 hover:text-gray-700 transition-colors">
                {copied ? '✓ 복사됨' : '복사'}
              </button>
            </div>
          </Field>
        </div>
      </section>

      {/* 거시 변수 */}
      <section className="card mb-4">
        <div className="flex items-center justify-between mb-4">
          <div>
            <div className="text-sm font-semibold text-gray-700">거시 변수</div>
            <div className="text-xs text-gray-400 mt-0.5">시나리오·시뮬레이션에 사용되는 가정값</div>
          </div>
          <button onClick={saveMacro} disabled={savingMacro} className="btn-primary text-sm">
            {savingMacro ? '저장 중...' : '저장'}
          </button>
        </div>

        <div className="space-y-5">
          {/* 금리 */}
          <div>
            <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">금리</div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="기준금리 (%)" sub="현재 한국은행 기준금리">
                <input type="number" step="0.1" className="input" {...mf('base_rate_pct')} />
              </Field>
              <Field label="금리 스트레스 (추가 %p)" sub="변동금리 부담 시나리오">
                <input type="number" step="0.1" className="input" {...mf('rate_shock_pct')} />
              </Field>
            </div>
          </div>

          {/* 자산 성장률 */}
          <div>
            <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">자산 연간 성장률 (%)</div>
            <div className="grid grid-cols-3 gap-3">
              <Field label="아파트">
                <input type="number" step="0.5" className="input" {...mf('apt_growth_pct')} />
              </Field>
              <Field label="토지">
                <input type="number" step="0.5" className="input" {...mf('land_growth_pct')} />
              </Field>
              <Field label="상업용부동산">
                <input type="number" step="0.5" className="input" {...mf('commercial_growth_pct')} />
              </Field>
            </div>
          </div>

          {/* 물가 */}
          <div>
            <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">기타</div>
            <Field label="물가 상승률 (%)">
              <input type="number" step="0.1" className="input w-1/2" {...mf('inflation_pct')} />
            </Field>
          </div>
        </div>

        {/* 현재 설정값 요약 */}
        <div className="mt-4 bg-gray-50 rounded-xl p-3">
          <div className="text-xs font-semibold text-gray-500 mb-2">현재 설정 요약</div>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-gray-600">
            <div>기준금리: <b>{macroForm.base_rate_pct ?? 3.5}%</b></div>
            <div>스트레스: +<b>{macroForm.rate_shock_pct ?? 1.5}%p</b></div>
            <div>아파트 성장: <b>{macroForm.apt_growth_pct ?? 2.5}%</b></div>
            <div>토지 성장: <b>{macroForm.land_growth_pct ?? 2.0}%</b></div>
            <div>상업 성장: <b>{macroForm.commercial_growth_pct ?? 1.5}%</b></div>
            <div>물가: <b>{macroForm.inflation_pct ?? 2.0}%</b></div>
          </div>
        </div>
      </section>

      {/* 세법 기준 안내 */}
      <section className="card border-blue-100 bg-blue-50">
        <div className="text-sm font-semibold text-blue-800 mb-3">📋 적용 세법 기준 (2026년)</div>
        <div className="space-y-1.5 text-xs text-blue-700">
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
            <div>• 상속·증여세율: <b>10% ~ 50%</b> (5단계)</div>
            <div>• 자녀 증여공제: <b>5천만원</b> / 10년</div>
            <div>• 배우자 증여공제: <b>6억원</b> / 10년</div>
            <div>• 혼인·출산 추가공제: <b>+1억원</b> (2024~)</div>
            <div>• 양도세: 소득세율 <b>6% ~ 45%</b></div>
            <div>• 단기양도세: <b>50%</b>(1년미만) / <b>40%</b>(2년미만)</div>
            <div>• 종부세: <b>0.5% ~ 2.7%</b> (2주택이하)</div>
            <div>• 공정시장가액비율: <b>60%</b></div>
            <div>• 법인세: <b>10%/20%/22%/25%</b> (2026~)</div>
            <div>• 차용증 적정이자율: <b>4.6%</b></div>
            <div>• 무이자 한도: <b>약 2.17억원</b></div>
            <div>• 현물출자 취득세 경감: <b>50%</b> (~2027.12)</div>
          </div>
          <div className="mt-2 text-blue-600 border-t border-blue-200 pt-2">
            ※ 2026년 상속세 개정(자녀공제 5억, 최고세율 40%)은 국회 부결 — 현행 유지
          </div>
        </div>
      </section>
    </div>
  );
}

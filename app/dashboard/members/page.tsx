'use client';
import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase';
import { FamilyMember, Relation } from '@/types';

const RELATIONS: Relation[] = ['본인','배우자','자녀','며느리','사위','부모','조부모','삼촌','고모','손자녀','기타'];
const COLORS = ['#B5D4F4','#9FE1CB','#FCD34D','#FCA5A5','#C4B5FD','#F9A8D4','#86EFAC','#FDA4AF','#A5F3FC'];
const EMPTY: Omit<FamilyMember,'id'|'family_id'> = {
  name:'', relation:'자녀', generation:-1, age:0,
  annual_income:0, cash_hold:0, total_debt:0, color:COLORS[0], notes:''
};

function fmt(n: number) { return n ? n.toLocaleString('ko-KR') : '0'; }

export default function MembersPage() {
  const [members, setMembers] = useState<FamilyMember[]>([]);
  const [form, setForm]       = useState({ ...EMPTY });
  const [editing, setEditing] = useState<string | null>(null);
  const [open, setOpen]       = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving]   = useState(false);
  const [familyId, setFamilyId] = useState<string | null>(null);
  const supabase = createClient();

  useEffect(() => { load(); }, []);

  async function load() {
    const { data: p } = await supabase.from('profiles').select('family_id').single();
    if (!p?.family_id) { setLoading(false); return; }
    setFamilyId(p.family_id);
    const { data } = await supabase
      .from('family_members').select('*')
      .eq('family_id', p.family_id)
      .order('generation', { ascending: false });
    setMembers(data || []);
    setLoading(false);
  }

  function openNew() {
    setForm({ ...EMPTY });
    setEditing(null);
    setOpen(true);
  }
  function openEdit(m: FamilyMember) {
    setForm({ name:m.name, relation:m.relation, generation:m.generation,
      age:m.age, annual_income:m.annual_income, cash_hold:m.cash_hold,
      total_debt:m.total_debt, color:m.color, notes:m.notes||'' });
    setEditing(m.id);
    setOpen(true);
  }

  async function save() {
    if (!form.name || !familyId) return;
    setSaving(true);
    if (editing) {
      await supabase.from('family_members').update({
        name:form.name, relation:form.relation, generation:form.generation,
        age:form.age, annual_income:form.annual_income, cash_hold:form.cash_hold,
        total_debt:form.total_debt, color:form.color, notes:form.notes,
        updated_at: new Date().toISOString()
      }).eq('id', editing);
    } else {
      await supabase.from('family_members').insert({ ...form, family_id: familyId });
    }
    await load();
    setOpen(false);
    setSaving(false);
  }

  async function del(id: string) {
    if (!confirm('삭제하시겠습니까?')) return;
    await supabase.from('family_members').delete().eq('id', id);
    setMembers(m => m.filter(x => x.id !== id));
  }

  const genLabel: Record<number,string> = { 2:'조부모 세대', 1:'부모 세대', 0:'본인 세대', [-1]:'자녀 세대', [-2]:'손자녀 세대' };
  const grouped = members.reduce<Record<number, FamilyMember[]>>((acc, m) => {
    (acc[m.generation] ??= []).push(m); return acc;
  }, {});

  if (loading) return <div className="p-8 text-sm text-gray-400">로딩 중...</div>;

  return (
    <div className="p-8 max-w-4xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">가족 구성원</h1>
          <p className="text-sm text-gray-500 mt-1">가족 구성원별 나이·소득·자산 정보</p>
        </div>
        <button onClick={openNew} className="btn-primary">+ 구성원 추가</button>
      </div>

      {members.length === 0 ? (
        <div className="card text-center py-16">
          <div className="text-4xl mb-4">👨‍👩‍👧‍👦</div>
          <p className="text-gray-500 text-sm mb-4">아직 가족 구성원이 없어요</p>
          <button onClick={openNew} className="btn-primary">첫 번째 구성원 추가</button>
        </div>
      ) : (
        <div className="space-y-6">
          {[2,1,0,-1,-2].filter(g => grouped[g]?.length).map(gen => (
            <div key={gen}>
              <div className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">
                {genLabel[gen] ?? `세대 ${gen}`}
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {grouped[gen].map(m => (
                  <div key={m.id} className="card hover:border-blue-200 transition-all">
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2.5">
                        <div className="w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold text-gray-700"
                          style={{ background: m.color }}>
                          {m.name[0]}
                        </div>
                        <div>
                          <div className="font-semibold text-gray-900 text-sm">{m.name}</div>
                          <div className="text-xs text-gray-400">{m.relation} · {m.age}세</div>
                        </div>
                      </div>
                      <div className="flex gap-1.5">
                        <button onClick={() => openEdit(m)} className="text-xs text-blue-600 hover:underline">수정</button>
                        <button onClick={() => del(m.id)} className="text-xs text-red-400 hover:underline">삭제</button>
                      </div>
                    </div>
                    <div className="grid grid-cols-3 gap-2 text-xs">
                      {[
                        ['연소득', `${fmt(m.annual_income)}억`],
                        ['보유현금', `${fmt(m.cash_hold)}억`],
                        ['부채', `${fmt(m.total_debt)}억`],
                      ].map(([label, val]) => (
                        <div key={label} className="bg-gray-50 rounded-lg p-2 text-center">
                          <div className="text-gray-400 mb-0.5">{label}</div>
                          <div className="font-semibold text-gray-700">{val}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 모달 */}
      {open && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl w-full max-w-md shadow-xl">
            <div className="p-5 border-b border-gray-100">
              <h2 className="font-semibold text-gray-900">
                {editing ? '구성원 수정' : '구성원 추가'}
              </h2>
            </div>
            <div className="p-5 space-y-3 max-h-[70vh] overflow-y-auto">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">이름 *</label>
                  <input className="input" placeholder="김준성"
                    value={form.name} onChange={e => setForm({...form, name: e.target.value})}/>
                </div>
                <div>
                  <label className="label">나이</label>
                  <input type="number" className="input" placeholder="25"
                    value={form.age || ''} onChange={e => setForm({...form, age: +e.target.value})}/>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">관계</label>
                  <select className="select" value={form.relation}
                    onChange={e => setForm({...form, relation: e.target.value as Relation})}>
                    {RELATIONS.map(r => <option key={r}>{r}</option>)}
                  </select>
                </div>
                <div>
                  <label className="label">세대 구분</label>
                  <select className="select" value={form.generation}
                    onChange={e => setForm({...form, generation: +e.target.value})}>
                    <option value={2}>조부모 세대</option>
                    <option value={1}>부모 세대</option>
                    <option value={0}>본인 세대</option>
                    <option value={-1}>자녀 세대</option>
                    <option value={-2}>손자녀 세대</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="label">연간 소득 (억원)</label>
                <input type="number" step="0.1" className="input" placeholder="1.2"
                  value={form.annual_income || ''} onChange={e => setForm({...form, annual_income: +e.target.value})}/>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">보유 현금 (억원)</label>
                  <input type="number" step="0.1" className="input" placeholder="0"
                    value={form.cash_hold || ''} onChange={e => setForm({...form, cash_hold: +e.target.value})}/>
                </div>
                <div>
                  <label className="label">기타 부채 (억원)</label>
                  <input type="number" step="0.1" className="input" placeholder="0"
                    value={form.total_debt || ''} onChange={e => setForm({...form, total_debt: +e.target.value})}/>
                </div>
              </div>
              <div>
                <label className="label">프로필 색상</label>
                <div className="flex gap-2 mt-1">
                  {COLORS.map(c => (
                    <button key={c} onClick={() => setForm({...form, color: c})}
                      className="w-7 h-7 rounded-full border-2 transition-transform hover:scale-110"
                      style={{ background: c, borderColor: form.color === c ? '#374151' : 'transparent' }}/>
                  ))}
                </div>
              </div>
              <div>
                <label className="label">메모</label>
                <textarea className="input resize-none h-16" placeholder="특이사항"
                  value={form.notes} onChange={e => setForm({...form, notes: e.target.value})}/>
              </div>
            </div>
            <div className="p-5 border-t border-gray-100 flex gap-2 justify-end">
              <button onClick={() => setOpen(false)} className="btn-secondary">취소</button>
              <button onClick={save} disabled={saving || !form.name} className="btn-primary">
                {saving ? '저장 중...' : '저장'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

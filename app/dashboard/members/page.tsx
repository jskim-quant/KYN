'use client';
import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase';
import { FamilyMember, Relation } from '@/types';
import { KynLoader } from '@/app/dashboard/components/KynLoader';

const RELATIONS: Relation[] = ['본인','배우자','자녀','며느리','사위','부모','조부모','삼촌','고모','손자녀','기타'];
const COLORS = ['#B5D4F4','#9FE1CB','#FCD34D','#FCA5A5','#C4B5FD','#F9A8D4','#86EFAC','#FDA4AF','#A5F3FC'];
const EMPTY: Omit<FamilyMember,'id'|'family_id'> = {
  name:'', relation:'자녀', generation:1, age:0,
  annual_income:0, cash_hold:0, total_debt:0, color:COLORS[0], notes:''
};

// 관계 → 기본 세대 매핑
const RELATION_GEN: Record<string, number> = {
  '조부모': 2, '부모': 1, '삼촌': 1, '고모': 1,
  '본인': 0, '배우자': 0,
  '자녀': -1, '며느리': -1, '사위': -1,
  '손자녀': -2, '기타': 0,
};

// 관계별 세금 공제 한도 설명
const RELATION_TAX: Record<string, string> = {
  '배우자': '증여공제 6억원 / 10년',
  '자녀':   '증여공제 5천만원 / 10년',
  '며느리': '증여공제 1천만원 / 10년 (기타친족)',
  '사위':   '증여공제 1천만원 / 10년 (기타친족)',
  '부모':   '증여공제 5천만원 / 10년',
  '조부모': '증여공제 5천만원 / 10년',
  '손자녀': '증여공제 2천만원 / 10년 (세대생략 30% 할증)',
  '삼촌':   '증여공제 1천만원 / 10년 (기타친족)',
  '고모':   '증여공제 1천만원 / 10년 (기타친족)',
  '기타':   '증여공제 1천만원 / 10년',
  '본인':   '자산 보유자 (증여자)',
};

function fmt(n: number) { return n ? n.toLocaleString('ko-KR') : '0'; }

// Avatar generation class: gen1 = charcoal (본인/부모세대), gen2 = gold (조부모), none = unset
function avaClass(m: FamilyMember): string {
  if (m.generation >= 2) return 'ava gen2';
  if (m.generation >= 0) return 'ava gen1';
  return 'ava none';
}

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
      .from('family_members')
      .select('*')
      .eq('family_id', p.family_id)
      .order('generation', { ascending: false });
    setMembers(data || []);
    setLoading(false);
  }

  function openNew() { setForm({ ...EMPTY }); setEditing(null); setOpen(true); }
  function openEdit(m: FamilyMember) {
    setForm({ name:m.name, relation:m.relation, generation:m.generation,
      age:m.age, annual_income:m.annual_income, cash_hold:m.cash_hold,
      total_debt:m.total_debt, color:m.color, notes:m.notes||'' });
    setEditing(m.id); setOpen(true);
  }

  function handleRelationChange(r: Relation) {
    setForm(f => ({ ...f, relation: r, generation: RELATION_GEN[r] ?? 0 }));
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
    await load(); setOpen(false); setSaving(false);
  }

  async function del(id: string) {
    if (!confirm('삭제하시겠습니까?')) return;
    await supabase.from('family_members').delete().eq('id', id);
    setMembers(m => m.filter(x => x.id !== id));
  }

  // Derived KPI counts
  const totalCount   = members.length;
  const holderCount  = members.filter(m => m.relation === '본인').length;
  const recipientCount = members.filter(m => m.relation !== '본인').length;
  const unassignedCount = members.filter(m => !m.cash_hold && m.relation !== '본인').length;

  // Allocation summary: each non-본인 member as share of total cash_hold
  const totalCash = members.reduce((s, m) => s + (m.cash_hold || 0), 0);

  const selfMember = members.find(m => m.relation === '본인');

  if (loading) return <KynLoader />;

  return (
    <div className="main">
      {/* Breadcrumb */}
      <div className="crumb">FAMILY MEMBERS</div>

      {/* Page head */}
      <div className="pagehead">
        <div>
          <h1>가족 구성</h1>
        </div>
        <button onClick={openNew} className="btn-primary">+ 구성원 추가</button>
      </div>

      {/* Rule */}
      <div className="rule" />

      {/* KPI strip */}
      <div className="kpis">
        <div className="kpi">
          <div className="label">구성원</div>
          <div className="v ink num">{totalCount}<span className="u">명</span></div>
          <div className="foot">등록된 가족</div>
        </div>
        <div className="kpi">
          <div className="label">자산 보유자</div>
          <div className="v ink num">{holderCount}<span className="u">명</span></div>
          <div className="foot">증여자 기준</div>
        </div>
        <div className="kpi">
          <div className="label">수증자</div>
          <div className="v ink num">{recipientCount}<span className="u">명</span></div>
          <div className="foot">증여 대상</div>
        </div>
        <div className="kpi">
          <div className="label">미지정 수증자</div>
          <div className="v ink num">{unassignedCount}<span className="u">건</span></div>
          <div className="foot">현금 미배분</div>
        </div>
      </div>

      {/* 본인 미등록 경고 */}
      {!selfMember && members.length > 0 && (
        <div className="callout is-warn" style={{ marginTop: 24 }}>
          <strong>"본인"</strong>이 아직 등록되지 않았습니다. 자산 보유자를 "본인"으로 추가해 주세요.
        </div>
      )}

      {members.length === 0 ? (
        <div className="card" style={{ marginTop: 32, textAlign: 'center', padding: '64px 40px' }}>
          <div className="serif" style={{ fontSize: 28, color: 'var(--gold-deep)', marginBottom: 16 }}>KYN</div>
          <p style={{ color: 'var(--ink-faint)', fontSize: 13, marginBottom: 8 }}>아직 가족 구성원이 없어요</p>
          <p style={{ color: 'var(--ink-faint)', fontSize: 12, marginBottom: 20 }}>자산 보유자(증여자)를 <strong>"본인"</strong>으로 먼저 추가하세요</p>
          <button onClick={openNew} className="btn-primary">첫 번째 구성원 추가</button>
        </div>
      ) : (
        <>
          {/* Person cards grid */}
          <div className="grid3">
            {members.map(m => (
              <div key={m.id} className="person">
                <div className="top">
                  <div className={avaClass(m)}>{m.name[0]}</div>
                  <div>
                    <div className="nm">
                      {m.name}
                      {m.relation === '본인' && (
                        <span className="pill gold" style={{ marginLeft: 8 }}>자산 보유자</span>
                      )}
                    </div>
                    <div className="role">{m.relation} · {m.age}세</div>
                  </div>
                </div>
                <div className="meta">
                  <div className="r">
                    <span className="k">연소득</span>
                    <span className="val num">{fmt(m.annual_income)}억</span>
                  </div>
                  <div className="r">
                    <span className="k">보유현금</span>
                    <span className="val num">{fmt(m.cash_hold)}억</span>
                  </div>
                  <div className="r">
                    <span className="k">부채</span>
                    <span className="val num">{fmt(m.total_debt)}억</span>
                  </div>
                  <div className="r">
                    <span className="k">증여공제</span>
                    <span className="val" style={{ fontSize: 11, color: 'var(--ink-faint)' }}>{RELATION_TAX[m.relation]}</span>
                  </div>
                  <div className="r" style={{ marginTop: 4 }}>
                    <button onClick={() => openEdit(m)} className="btn-secondary" style={{ padding: '4px 12px', fontSize: 11 }}>수정</button>
                    <button onClick={() => del(m.id)} className="btn-danger" style={{ padding: '4px 12px', fontSize: 11 }}>삭제</button>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Allocation summary card */}
          {members.length > 1 && totalCash > 0 && (
            <div className="card block">
              <div className="card-head">
                <div className="t">
                  이전 배분 요약
                  <span className="sub">보유 현금 기준 구성원별 비중</span>
                </div>
                <a className="link" href="/dashboard/plan">배분 설계 →</a>
              </div>
              <div style={{ padding: '0 24px 20px' }}>
                {members.map(m => {
                  const pct = totalCash > 0 ? Math.round((m.cash_hold / totalCash) * 100) : 0;
                  const barClass = m.relation === '본인' ? 'pine' : 'brass';
                  return (
                    <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 14 }}>
                      <div className={avaClass(m)} style={{ width: 32, height: 32, fontSize: 14 }}>{m.name[0]}</div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                          <span style={{ fontSize: 13, fontWeight: 600 }}>{m.name}</span>
                          <span className="num" style={{ fontSize: 13, color: 'var(--ink-faint)' }}>{fmt(m.cash_hold)}억 · {pct}%</span>
                        </div>
                        <div className="bar">
                          <span className={barClass} style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Status summary strip */}
          <div className="summary">
            <div className={`s ${holderCount > 0 ? 'ok' : 'warn'}`}>
              <span className="dot" />
              {holderCount > 0
                ? <><b>자산 보유자</b> 등록 완료</>
                : <><b>자산 보유자</b> 미등록</>}
            </div>
            <div className={`s ${recipientCount > 0 ? 'ok' : 'note'}`}>
              <span className="dot" />
              {recipientCount > 0
                ? <><b>수증자</b> {recipientCount}명 등록</>
                : <><b>수증자</b> 미등록</>}
            </div>
            <div className={`s ${unassignedCount === 0 ? 'ok' : 'warn'}`}>
              <span className="dot" />
              {unassignedCount === 0
                ? <>현금 배분 <b>설정 완료</b></>
                : <><b>{unassignedCount}건</b> 미지정 수증자</>}
            </div>
          </div>

          {/* Legal callout */}
          <div className="callout is-legal" style={{ marginTop: 28 }}>
            본 정보는 세무·법률 자문을 대체하지 않습니다. 증여세 신고 및 절세 전략은 반드시 공인 세무사·변호사와 상담하세요.
          </div>
        </>
      )}

      {/* Modal */}
      {open && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: 16 }}>
          <div style={{ background: '#fff', width: '100%', maxWidth: 440, boxShadow: '0 8px 40px rgba(0,0,0,0.18)' }}>
            <div style={{ padding: '20px 24px', borderBottom: '1px solid var(--line)' }}>
              <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--ink)' }}>
                {editing ? '구성원 수정' : '구성원 추가'}
              </div>
              <div className="label" style={{ marginTop: 4, marginBottom: 0 }}>관계는 자산 보유자(본인) 기준으로 입력</div>
            </div>
            <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 14, maxHeight: '70vh', overflowY: 'auto' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <label className="label">이름 *</label>
                  <input className="input" placeholder="홍길동"
                    value={form.name} onChange={e => setForm({...form, name: e.target.value})}/>
                </div>
                <div>
                  <label className="label">나이</label>
                  <input type="number" className="input" placeholder="60"
                    value={form.age || ''} onChange={e => setForm({...form, age: +e.target.value})}/>
                </div>
              </div>

              <div>
                <label className="label">관계 (자산 보유자 기준)</label>
                <select className="select" value={form.relation}
                  onChange={e => handleRelationChange(e.target.value as Relation)}>
                  {RELATIONS.map(r => <option key={r}>{r}</option>)}
                </select>
                {form.relation && (
                  <div style={{ marginTop: 8 }}>
                    <span className="pill gold">{RELATION_TAX[form.relation] ?? ''}</span>
                  </div>
                )}
              </div>

              <div>
                <label className="label">연간 소득 (억원)</label>
                <input type="number" step="0.1" className="input" placeholder="1.2"
                  value={form.annual_income || ''} onChange={e => setForm({...form, annual_income: +e.target.value})}/>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
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
                <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                  {COLORS.map(c => (
                    <button key={c} onClick={() => setForm({...form, color: c})}
                      style={{
                        width: 28, height: 28, background: c, cursor: 'pointer',
                        border: form.color === c ? '2px solid var(--ink)' : '2px solid transparent',
                        flexShrink: 0,
                      }}/>
                  ))}
                </div>
              </div>
              <div>
                <label className="label">메모</label>
                <textarea className="input" placeholder="특이사항"
                  style={{ resize: 'none', height: 64 }}
                  value={form.notes} onChange={e => setForm({...form, notes: e.target.value})}/>
              </div>
            </div>
            <div style={{ padding: '16px 24px', borderTop: '1px solid var(--line)', display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
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

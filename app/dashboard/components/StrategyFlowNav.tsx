'use client';

import Link from 'next/link';

const STEPS = [
  { href: '/dashboard/plan',      step: 1, label: '계획 설정',   desc: '자산별 수증자 배정' },
  { href: '/dashboard/scenarios', step: 2, label: '시나리오 비교', desc: 'S1~S9 비교 · 최적 전략' },
  { href: '/dashboard/strategy',  step: 3, label: '심화 전략',   desc: '공익법인 · 단계별 계획 · 회수 전략' },
] as const;

export function StrategyFlowNav({ active }: { active: '/dashboard/plan' | '/dashboard/scenarios' | '/dashboard/strategy' }) {
  return (
    <nav
      aria-label="전략 수립 단계"
      style={{
        display: 'flex',
        alignItems: 'stretch',
        border: '1px solid var(--line)',
        marginBottom: 24,
        background: 'var(--paper)',
      }}
    >
      {STEPS.map((s, i) => {
        const isActive = s.href === active;
        return (
          <Link
            key={s.href}
            href={s.href}
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '12px 16px',
              textDecoration: 'none',
              borderLeft: i === 0 ? 'none' : '1px solid var(--line)',
              borderBottom: isActive ? '2px solid var(--gold)' : '2px solid transparent',
              background: isActive ? 'var(--gold-tint)' : 'transparent',
            }}
          >
            <span
              style={{
                fontFamily: 'var(--serif)',
                fontSize: 13,
                width: 20,
                height: 20,
                flexShrink: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: isActive ? 'var(--gold-deep)' : 'var(--ink-faint)',
                border: `1px solid ${isActive ? 'var(--gold)' : 'var(--line-strong)'}`,
              }}
            >
              {s.step}
            </span>
            <span>
              <span
                style={{
                  display: 'block',
                  fontSize: 13.5,
                  fontWeight: isActive ? 700 : 500,
                  color: isActive ? 'var(--ink)' : 'var(--ink-soft)',
                }}
              >
                {s.label}
              </span>
              <span style={{ display: 'block', fontSize: 11.5, color: 'var(--ink-faint)', marginTop: 1 }}>
                {s.desc}
              </span>
            </span>
          </Link>
        );
      })}
    </nav>
  );
}

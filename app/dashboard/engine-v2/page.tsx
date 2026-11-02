'use client';
import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase';
import {
  buildImmediateGiftScenario, checkBackendHealth, type ScenarioResponse,
  computeBalanceSheet, type BalanceSheetMetricsResponse, type FamilyBalanceSheetResponse,
  compareLeverageLevels, type LeverageLevelComparisonResponse,
  computePortfolioMetrics, type PortfolioAllocationResultResponse, type AssetCategory,
} from '@/lib/kyn-backend';
import { KOREAN_TO_ASSET_CATEGORY, KOREAN_TO_BACKEND_ASSET_TYPE, liquidityScore01, ALLOCATION_ASSUMPTIONS as SHARED_ALLOCATION_ASSUMPTIONS } from '@/lib/asset-type-map';

interface Asset {
  id: string; asset_type: string; current_value: number;
  loan_amount?: number; annual_yield_pct?: number; acquisition_date?: string | null;
  liquidity_score?: number | null; // 1(즉시 현금화)~5(매각 매우 어려움), 자산별 직접 설정 (assets 페이지)
}

function assetLiquidityScore01(a: Asset): number {
  return liquidityScore01(a.liquidity_score, KOREAN_TO_ASSET_CATEGORY[a.asset_type] ?? 'OTHER');
}
interface FamilyMember { id: string; name: string; relation: string; age: number; cash_hold?: number; }

const CATEGORY_LABEL: Record<AssetCategory, string> = {
  REAL_ESTATE: '부동산', EQUITY: '상장주식', BONDS: '채권/금융자산',
  CASH: '현금성자산', BUSINESS_EQUITY: '법인지분', OTHER: '기타',
};

// 한글 자산유형 → 백엔드 AssetType. 매핑 안 되면 OTHER.
const KOREAN_TO_BACKEND_TYPE = KOREAN_TO_BACKEND_ASSET_TYPE;

// Phase 4 자산군별 기대수익·변동성 참고값 — 실측 데이터 아님, 세무사/투자자문 확인 전 ASSUMED
const ALLOCATION_ASSUMPTIONS = SHARED_ALLOCATION_ASSUMPTIONS as Array<{
  category: AssetCategory; expected_return_pct: number; volatility_pct: number;
  income_yield_pct: number; liquidity_score: number;
}>;

const EQUITY_RATIOS = [0.2, 0.4, 0.6, 0.8];

function fmt(n: number | string, d = 1): string {
  const v = typeof n === 'string' ? Number(n) : n;
  return `${v.toFixed(d)}억`;
}
function pct(n: number | null, d = 1): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return `${(n * 100).toFixed(d)}%`;
}

function StatusPill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className="pill" style={ok
      ? { color: 'var(--green-ink)', borderColor: 'var(--green)', background: 'var(--green-tint)' }
      : { color: 'var(--red)', borderColor: 'var(--red)', background: 'var(--red-tint)' }}>
      {label}
    </span>
  );
}

export default function EngineV2Page() {
  const supabase = createClient();
  const [assets, setAssets] = useState<Asset[]>([]);
  const [members, setMembers] = useState<FamilyMember[]>([]);
  const [backendUp, setBackendUp] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);

  const [bs, setBs] = useState<{ balance_sheet: FamilyBalanceSheetResponse; metrics: BalanceSheetMetricsResponse } | null>(null);
  const [leverage, setLeverage] = useState<LeverageLevelComparisonResponse[] | null>(null);
  const [allocation, setAllocation] = useState<PortfolioAllocationResultResponse | null>(null);
  const [enginesError, setEnginesError] = useState<string | null>(null);

  const [giftAmount, setGiftAmount] = useState(3.0);
  const [availableCash, setAvailableCash] = useState(1.0);
  const [result, setResult] = useState<ScenarioResponse | null>(null);
  const [scenarioError, setScenarioError] = useState<string | null>(null);
  const [calculating, setCalculating] = useState(false);

  useEffect(() => {
    checkBackendHealth().then(setBackendUp);
    (async () => {
      const { data: profile } = await supabase.from('profiles').select('family_id').single();
      if (!profile?.family_id) { setLoading(false); return; }
      const [assetsRes, membersRes] = await Promise.all([
        supabase.from('assets').select('id, asset_type, current_value, loan_amount, annual_yield_pct, acquisition_date, liquidity_score').eq('family_id', profile.family_id),
        supabase.from('family_members').select('id, name, relation, age, cash_hold').eq('family_id', profile.family_id),
      ]);
      setAssets(assetsRes.data ?? []);
      setMembers(membersRes.data ?? []);
      setLoading(false);
    })();
  }, []);

  const familyTotalAssets = assets.reduce((s, a) => s + Number(a.current_value ?? 0), 0);
  // 백엔드 포트폴리오 지표의 유동성 점수는 카테고리 평균(부동산은 전부 0.1)이라
  // 강남 핵심지 vs 지방처럼 자산별로 다른 유동성을 반영 못 한다 — 자산별
  // liquidity_score(assets 페이지에서 설정)로 가중평균해 여기서 덮어쓴다.
  const portfolioLiquidityScore = familyTotalAssets > 0
    ? assets.reduce((s, a) => s + assetLiquidityScore01(a) * Number(a.current_value ?? 0), 0) / familyTotalAssets
    : null;
  const children = members.filter(m => m.relation === '자녀');
  const donor = members.find(m => m.relation === '본인');
  const totalCash = members.reduce((s, m) => s + Number(m.cash_hold ?? 0), 0);
  const largestRealEstate = [...assets]
    .filter(a => ['주거용부동산', '상업용부동산', '토지', '오피스텔'].includes(a.asset_type))
    .sort((a, b) => b.current_value - a.current_value)[0];

  useEffect(() => {
    if (backendUp !== true || assets.length === 0) return;
    let cancelled = false;
    (async () => {
      try {
        const today = new Date().toISOString().slice(0, 10);
        const backendAssets = assets.map(a => ({
          id: a.id, owner_id: 'family', ownership_ratio: 1,
          asset_type: KOREAN_TO_BACKEND_TYPE[a.asset_type] ?? 'OTHER',
          acquisition_date: a.acquisition_date ?? '2015-01-01',
          acquisition_cost: a.current_value,
          valuation: { user_estimate: a.current_value },
        }));

        const bsResult = await computeBalanceSheet({ assets: backendAssets, as_of: today });
        if (cancelled) return;
        setBs(bsResult);

        const weights: Partial<Record<AssetCategory, number>> = {};
        const totalAssetsFromBs = Object.values(bsResult.balance_sheet.assets_by_category)
          .reduce((s, v) => s + Number(v), 0);
        for (const [cat, v] of Object.entries(bsResult.balance_sheet.assets_by_category)) {
          weights[cat as AssetCategory] = totalAssetsFromBs > 0 ? Number(v) / totalAssetsFromBs : 0;
        }
        const allocResult = await computePortfolioMetrics({ weights, assumptions: ALLOCATION_ASSUMPTIONS });
        if (cancelled) return;
        setAllocation(allocResult);

        if (largestRealEstate) {
          const lev = await compareLeverageLevels({
            asset_value: largestRealEstate.current_value,
            equity_ratio: 0.4,
            annual_income_yield_pct: (largestRealEstate.annual_yield_pct ?? 0) / 100,
            annual_appreciation_pct: 0.02,
            debt: { rate_type: 'FIXED', interest_rate_pct: 0.045, amortization: 'INTEREST_ONLY', maturity_years: 30 },
          }, EQUITY_RATIOS);
          if (cancelled) return;
          setLeverage(lev);
        }
      } catch (e) {
        if (!cancelled) setEnginesError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [backendUp, assets, largestRealEstate]);

  async function runScenario() {
    setCalculating(true);
    setScenarioError(null);
    setResult(null);
    try {
      const scenario = await buildImmediateGiftScenario({
        donor_id: donor?.id ?? 'donor',
        family_total_assets: familyTotalAssets,
        available_cash: availableCash,
        recipients: children.length > 0
          ? children.map(c => ({ person_id: c.id, relation: '자녀', gift_amount: giftAmount / children.length, is_adult: c.age >= 19 }))
          : [{ person_id: 'child-sample', relation: '자녀', gift_amount: giftAmount, is_adult: true }],
        event_date: new Date().toISOString().slice(0, 10),
      });
      setResult(scenario);
    } catch (e) {
      setScenarioError(e instanceof Error ? e.message : String(e));
    } finally {
      setCalculating(false);
    }
  }

  if (loading) return <div style={{ padding: 24, fontSize: 13, color: 'var(--ink-faint)' }}>불러오는 중...</div>;

  const totalAssetsFromBs = bs ? Object.values(bs.balance_sheet.assets_by_category).reduce((s, v) => s + Number(v), 0) : 0;

  return (
    <div style={{ maxWidth: 980, margin: '0 auto', padding: '32px 24px 80px', display: 'flex', flexDirection: 'column', gap: 20 }}>

      {/* ── Header ── */}
      <div>
        <div className="eyebrow">KYN QUANT WEALTH ENGINE · BETA</div>
        <h1 style={{ fontFamily: 'var(--serif)', fontSize: 28, fontWeight: 500, marginTop: 10, letterSpacing: '-0.01em' }}>
          가족 대차대조표 · 레버리지 · 자산배분
        </h1>
        <p style={{ fontSize: 13.5, color: 'var(--ink-faint)', marginTop: 6, maxWidth: 640 }}>
          기존 시나리오 페이지는 그대로입니다. 이 페이지는 새 Python 백엔드(대차대조표·레버리지·자산배분·
          실현가능성·세무상설명부담 엔진)가 이 가족의 실제 자산 데이터로 작동하는 것을 보여주는 별도 공간입니다.
        </p>
        <div style={{ marginTop: 12 }}>
          <span className="pill" style={backendUp
            ? { color: 'var(--green-ink)', borderColor: 'var(--green)', background: 'var(--green-tint)' }
            : { color: 'var(--red)', borderColor: 'var(--red)', background: 'var(--red-tint)' }}>
            {backendUp === null ? '백엔드 확인 중...' : backendUp ? '● 백엔드 연결됨' : '● 백엔드 연결 안 됨 — uvicorn 실행 필요'}
          </span>
        </div>
      </div>

      {/* ── KPI row ── */}
      <div className="kpis">
        <div className="kpi">
          <div className="label">총자산</div>
          <div className="v num">{familyTotalAssets.toFixed(1)}<span className="u">억</span></div>
          <div className="foot">가족 구성원 {members.length}명</div>
        </div>
        <div className="kpi">
          <div className="label">순자산 (Net Worth)</div>
          <div className="v num">{bs ? Number(bs.metrics.net_worth).toFixed(1) : '—'}<span className="u">억</span></div>
          <div className="foot">D/E {bs?.metrics.debt_to_equity !== null && bs ? pct(bs.metrics.debt_to_equity) : '—'}</div>
        </div>
        <div className="kpi">
          <div className="label">LTV</div>
          <div className="v num">{bs ? pct(bs.metrics.ltv) : '—'}</div>
          <div className="foot">부동산 담보부채 비율</div>
        </div>
        <div className="kpi">
          <div className="label">유동자산 비율</div>
          <div className="v num">{bs ? pct(bs.metrics.liquid_asset_ratio) : '—'}</div>
          <div className="foot">현금성자산 / 총자산</div>
        </div>
      </div>

      {enginesError && (
        <div style={{ border: '1px solid var(--red)', background: 'var(--red-tint)', color: 'var(--red)', padding: 12, fontSize: 12.5 }}>
          엔진 호출 오류: {enginesError}
        </div>
      )}

      {/* ── 대차대조표 구성 ── */}
      <div className="card-kyn">
        <div className="card-head">
          <div>
            <div className="crumb" style={{ marginBottom: 8 }}>FAMILY BALANCE SHEET</div>
            <div className="t">자산군별 구성
              <span className="sub">현금·부동산·주식·법인지분 등 가족 전체 자산을 하나의 대차대조표로 집계합니다.</span>
            </div>
          </div>
        </div>
        <div style={{ padding: '4px 24px 22px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {bs && totalAssetsFromBs > 0 ? Object.entries(bs.balance_sheet.assets_by_category).sort((a, b) => Number(b[1]) - Number(a[1])).map(([cat, value]) => {
            const w = Number(value) / totalAssetsFromBs;
            return (
              <div key={cat}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, marginBottom: 4 }}>
                  <span style={{ color: 'var(--ink-soft)' }}>{CATEGORY_LABEL[cat as AssetCategory] ?? cat}</span>
                  <span className="num" style={{ color: 'var(--ink)' }}>{fmt(value)} · {pct(w, 0)}</span>
                </div>
                <div className="bar"><span className="brass" style={{ width: `${w * 100}%` }} /></div>
              </div>
            );
          }) : <div style={{ fontSize: 12.5, color: 'var(--ink-faint)' }}>계산 대기 중...</div>}
          {bs && bs.metrics.concentration_category && (
            <div style={{ fontSize: 11.5, color: 'var(--ink-faint)', marginTop: 4 }}>
              집중도: {CATEGORY_LABEL[bs.metrics.concentration_category]}에 {pct(bs.metrics.asset_concentration, 0)} 쏠림
            </div>
          )}
        </div>
      </div>

      {/* ── 레버리지 비교 ── */}
      <div className="card-kyn">
        <div className="card-head">
          <div>
            <div className="crumb" style={{ marginBottom: 8 }}>LEVERAGE ENGINE</div>
            <div className="t">자기자본 비율별 비교{largestRealEstate ? ` — ${largestRealEstate.asset_type}` : ''}
              <span className="sub">자산가치 -25% 하방 스트레스에서 자기자본이 얼마나 버티는지 함께 봅니다.</span>
            </div>
          </div>
        </div>
        {leverage ? (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
              <thead>
                <tr style={{ borderTop: '1px solid var(--line)', borderBottom: '1px solid var(--line-strong)' }}>
                  {['자기자본', 'LTV', '연 현금흐름', 'Total ROE', 'DSCR', '-25% 스트레스'].map(h => (
                    <th key={h} style={{ textAlign: 'left', padding: '10px 24px', fontWeight: 600, color: 'var(--ink-faint)', fontSize: 11 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {leverage.map(c => (
                  <tr key={c.scenario.equity_ratio} style={{ borderBottom: '1px solid var(--line)' }}>
                    <td style={{ padding: '12px 24px', fontWeight: 600 }}>{pct(c.scenario.equity_ratio, 0)}</td>
                    <td className="num" style={{ padding: '12px 24px' }}>{pct(c.scenario.ltv, 0)}</td>
                    <td className="num" style={{ padding: '12px 24px' }}>{fmt(c.scenario.annual_cashflow_to_equity, 2)}</td>
                    <td className="num" style={{ padding: '12px 24px' }}>{pct(c.scenario.total_roe)}</td>
                    <td className="num" style={{ padding: '12px 24px' }}>{c.scenario.dscr ? c.scenario.dscr.toFixed(2) : '—'}</td>
                    <td style={{ padding: '12px 24px' }}>
                      <StatusPill ok={!c.downside.equity_wiped_out} label={c.downside.equity_wiped_out ? '깡통' : '생존'} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div style={{ padding: '20px 24px', fontSize: 12.5, color: 'var(--ink-faint)' }}>
            {largestRealEstate ? '계산 대기 중...' : '부동산 자산이 없어 레버리지 비교를 생략합니다.'}
          </div>
        )}
      </div>

      {/* ── 자산배분 ── */}
      <div className="card-kyn">
        <div className="card-head">
          <div>
            <div className="crumb" style={{ marginBottom: 8 }}>ASSET ALLOCATION ENGINE</div>
            <div className="t">포트폴리오 지표
              <span className="sub">기대수익·변동성은 참고 가정치입니다 (ASSUMED) — 실제 투자자문 확인 전 시뮬레이션용.</span>
            </div>
          </div>
        </div>
        {allocation ? (
          <div className="mini">
            <div><div className="l">기대 총수익률</div><div className="n num">{pct(allocation.expected_total_return_pct)}</div></div>
            <div><div className="l">변동성</div><div className="n num">{pct(allocation.volatility_pct)}</div></div>
            <div><div className="l">유동성 점수</div><div className="n num">{(portfolioLiquidityScore ?? allocation.liquidity_score).toFixed(2)}</div></div>
            <div><div className="l">집중도</div><div className="n num">{pct(allocation.concentration, 0)}</div></div>
          </div>
        ) : (
          <div style={{ padding: '20px 24px', fontSize: 12.5, color: 'var(--ink-faint)' }}>계산 대기 중...</div>
        )}
      </div>

      {/* ── 증여 시나리오 (실현가능성/세무상설명부담) ── */}
      <div className="card-kyn">
        <div className="card-head">
          <div>
            <div className="crumb" style={{ marginBottom: 8 }}>SCENARIO + RISK ENGINE</div>
            <div className="t">증여 시나리오 실행가능성 테스트
              <span className="sub">입력한 증여액·가용현금으로 실현 가능성(F1~F10)과 세무상 설명부담(T1~T12)을 계산합니다.</span>
            </div>
          </div>
        </div>
        <div style={{ padding: '4px 24px 22px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
            <label style={{ fontSize: 12.5, color: 'var(--ink-soft)' }}>총 증여액 (억)
              <input type="number" value={giftAmount} step={0.5} min={0}
                onChange={e => setGiftAmount(Number(e.target.value))}
                style={{ marginLeft: 8, width: 90, border: '1px solid var(--line-strong)', padding: '5px 8px', fontFamily: 'var(--sans)' }} />
            </label>
            <label style={{ fontSize: 12.5, color: 'var(--ink-soft)' }}>가용 현금 (억)
              <input type="number" value={availableCash} step={0.5} min={0}
                onChange={e => setAvailableCash(Number(e.target.value))}
                style={{ marginLeft: 8, width: 90, border: '1px solid var(--line-strong)', padding: '5px 8px', fontFamily: 'var(--sans)' }} />
            </label>
            <button onClick={runScenario} disabled={calculating || !backendUp}
              style={{
                border: 'none', background: 'var(--ink)', color: '#F2EFE7', padding: '9px 20px',
                fontSize: 12.5, fontWeight: 700, cursor: backendUp ? 'pointer' : 'not-allowed',
                opacity: backendUp ? 1 : 0.5, fontFamily: 'var(--sans)',
              }}>
              {calculating ? '계산 중...' : '실행'}
            </button>
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--ink-faint)' }}>
            가족 보유현금 합계 {totalCash.toFixed(1)}억 (참고용)
          </div>

          {scenarioError && (
            <div style={{ border: '1px solid var(--red)', background: 'var(--red-tint)', color: 'var(--red)', padding: 12, fontSize: 12.5 }}>
              {scenarioError}
            </div>
          )}

          {result && (
            <div className="grid2" style={{ marginTop: 4 }}>
              <div>
                {result.feasibility_score && (
                  <>
                    <div style={{ fontSize: 12, color: 'var(--ink-faint)', marginBottom: 4 }}>실현 가능성</div>
                    <div style={{ fontSize: 22, fontFamily: 'var(--serif)', color: result.feasibility_score.hard_blocked ? 'var(--red)' : 'var(--ink)' }}>
                      {result.feasibility_score.total_score.toFixed(0)}점 <span style={{ fontSize: 14 }}>({result.feasibility_score.grade})</span>
                    </div>
                    {result.feasibility_score.top_constraints.slice(0, 3).map(c => (
                      <div key={c} style={{ fontSize: 12, color: 'var(--ink-soft)', marginTop: 4 }}>· {c}</div>
                    ))}
                  </>
                )}
              </div>
              <div>
                {result.tax_review_risk && (
                  <>
                    <div style={{ fontSize: 12, color: 'var(--ink-faint)', marginBottom: 4 }}>세무상 설명부담</div>
                    <div style={{ fontSize: 22, fontFamily: 'var(--serif)' }}>
                      {result.tax_review_risk.overall_risk_score.toFixed(0)}점 <span style={{ fontSize: 14 }}>({result.tax_review_risk.grade})</span>
                    </div>
                    <div style={{ fontSize: 10.5, color: 'var(--ink-faint)', marginTop: 6 }}>{result.tax_review_risk.disclaimer}</div>
                  </>
                )}
              </div>
              {result.rejected && (
                <div style={{ gridColumn: '1 / -1', border: '1px solid var(--red)', background: 'var(--red-tint)', padding: 12, marginTop: 4 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--red)', marginBottom: 4 }}>하드 탈락 — 실행 불가</div>
                  {result.rejection_reasons.map(r => (
                    <div key={r} style={{ fontSize: 11.5, color: 'var(--red)' }}>· {r}</div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

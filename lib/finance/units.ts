/**
 * 금융 엔진 단위 규칙: 모든 금액은 원(KRW) 정수. 기존 DB·UI의 억/만원 단위는 경계에서만 변환한다.
 */
export type KRW = number;

export const WON_PER_EOK = 100_000_000;
export const WON_PER_MAN = 10_000;

export function eokToWon(eok: number | null | undefined): KRW {
  return Math.round((eok ?? 0) * WON_PER_EOK);
}

export function manToWon(man: number | null | undefined): KRW {
  return Math.round((man ?? 0) * WON_PER_MAN);
}

export function wonToEok(won: KRW): number {
  return won / WON_PER_EOK;
}

/** total을 weights 비율로 정수 배분한다. 합계는 항상 total과 같다(잔여는 가중치가 가장 큰 항목에 배정). */
export function allocateByWeights(total: KRW, weights: number[]): KRW[] {
  const sum = weights.reduce((s, w) => s + w, 0);
  if (weights.length === 0) return [];
  if (sum <= 0 || total === 0) return weights.map(() => 0);
  const sign = total < 0 ? -1 : 1;
  const abs = Math.abs(total);
  const parts = weights.map(w => Math.floor((abs * w) / sum));
  let rest = abs - parts.reduce((s, p) => s + p, 0);
  const order = weights
    .map((w, i) => ({ w, i }))
    .sort((a, b) => b.w - a.w || a.i - b.i);
  for (let k = 0; rest > 0; k = (k + 1) % order.length, rest--) parts[order[k].i] += 1;
  return parts.map(p => p * sign);
}

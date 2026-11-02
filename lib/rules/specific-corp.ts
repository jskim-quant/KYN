import type { KRW } from '../finance/units';

/**
 * 상속세 및 증여세법 §45의5 특정법인과의 거래를 통한 이익의 증여의제 (규칙 KR-GIFT-S45-5-SPECIFIC-CORP).
 *
 * 구현 범위 (근거: 조문 인용 + 기재부 예규 서면-2025-자본거래-3489):
 *  - 지배주주 등 보유비율 30% 이상 법인만 대상
 *  - 증여의제이익 = 특정법인의 이익 × 지배주주 등 주식보유비율
 *  - 1억 원 이상일 때만 과세, 거래 유형별로 따로 판단, 같은 유형은 소급 1년 합산 (§43 ②)
 *  - 무상대여 채권이 소멸시효로 소멸한 뒤에는 이익 없음 (대법원 2025-12-04)
 * 구현하지 않음(UNVERIFIED): 법인세 상당액 차감, 기과세분 공제, 1억 기준의 인별/합산 단위.
 */

export type SpecificCorpTxType =
  | 'free_provision'        // 제1호 재산·용역 무상 제공
  | 'low_price_in'          // 제2호 현저히 낮은 대가로 제공받음
  | 'high_price_out'        // 제3호 현저히 높은 대가로 제공
  | 'capital_transaction'   // 제3호의2 불균등 감자 등 자본거래 (2025 신설)
  | 'similar';              // 제4호 유사 거래

export interface SpecificCorpTx {
  id: string;
  /** 거래일 YYYY-MM-DD */
  date: string;
  type: SpecificCorpTxType;
  /** 특정법인이 얻은 이익(원). 법인세 상당액 차감 여부는 호출자가 결정한다. */
  corpBenefitKRW: KRW;
  /** 무상대여 채권이 소멸시효 완성으로 소멸한 이후의 이익이면 true */
  receivableExtinguished?: boolean;
}

export interface SpecificCorpInput {
  /** 지배주주와 그 친족 등의 주식보유비율 합계(%) */
  controllingHoldersPct: number;
  transactions: SpecificCorpTx[];
  /** 과세 기준금액. 기본 1억 원 */
  thresholdKRW?: KRW;
}

export interface SpecificCorpItem {
  txId: string;
  type: SpecificCorpTxType;
  deemedGiftKRW: KRW;
  /** 같은 유형의 소급 1년 이내 거래를 합산한 증여의제이익 */
  windowAggregateKRW: KRW;
  meetsThreshold: boolean;
  reason: string;
}

export interface SpecificCorpResult {
  isSpecificCorp: boolean;
  items: SpecificCorpItem[];
  notes: string[];
}

export const SPECIFIC_CORP_MIN_HOLDING_PCT = 30;
export const SPECIFIC_CORP_THRESHOLD_KRW: KRW = 100_000_000;

function minusOneYear(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  const dt = new Date(Date.UTC(y - 1, m - 1, d));
  return dt.toISOString().slice(0, 10);
}

export function evaluateSpecificCorp(input: SpecificCorpInput): SpecificCorpResult {
  const threshold = input.thresholdKRW ?? SPECIFIC_CORP_THRESHOLD_KRW;
  const isSpecificCorp = input.controllingHoldersPct >= SPECIFIC_CORP_MIN_HOLDING_PCT;
  const notes = [
    '법인세 상당액 차감, 기과세분 처리, 1억 기준의 인별/합산 단위는 확정되지 않았다(UNVERIFIED). 결과는 과세 가능성 판단용이다.',
    '소급 1년 기간은 거래일 포함으로 가정했다.',
  ];

  const sorted = [...input.transactions].sort((a, b) => a.date.localeCompare(b.date));
  const deemed = new Map<string, KRW>();
  for (const tx of sorted) {
    const base = isSpecificCorp && !tx.receivableExtinguished
      ? Math.round((tx.corpBenefitKRW * input.controllingHoldersPct) / 100)
      : 0;
    deemed.set(tx.id, Math.max(0, base));
  }

  const items: SpecificCorpItem[] = sorted.map(tx => {
    const from = minusOneYear(tx.date);
    const aggregate = sorted
      .filter(o => o.type === tx.type && o.date <= tx.date && o.date >= from)
      .reduce((s, o) => s + (deemed.get(o.id) ?? 0), 0);
    const own = deemed.get(tx.id) ?? 0;
    const meets = isSpecificCorp && aggregate >= threshold;
    let reason: string;
    if (!isSpecificCorp) reason = `지배주주 등 보유비율 ${input.controllingHoldersPct}%가 ${SPECIFIC_CORP_MIN_HOLDING_PCT}% 미만이라 특정법인이 아니다`;
    else if (tx.receivableExtinguished) reason = '무상대여 채권이 소멸시효로 소멸해 특정법인의 이익이 없다(대법원 2025-12-04)';
    else if (meets) reason = `같은 유형 소급 1년 합산 ${aggregate}원이 기준 ${threshold}원 이상`;
    else reason = `같은 유형 소급 1년 합산 ${aggregate}원이 기준 ${threshold}원 미만`;
    return { txId: tx.id, type: tx.type, deemedGiftKRW: own, windowAggregateKRW: aggregate, meetsThreshold: meets, reason };
  });

  return { isSpecificCorp, items, notes };
}

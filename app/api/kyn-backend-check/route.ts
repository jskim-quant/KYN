import { NextResponse } from 'next/server';
import { calcGiftTax, checkBackendHealth } from '@/lib/kyn-backend';

/**
 * KYN v2 Python 백엔드(backend/) 연결 확인용 라우트.
 * 실제 기능 페이지가 아니라, Next.js → FastAPI 파이프라인이 살아있는지 검증하는 진단 엔드포인트.
 */
export async function GET() {
  const healthy = await checkBackendHealth();
  if (!healthy) {
    return NextResponse.json(
      { connected: false, message: 'backend/ (FastAPI)가 실행 중이 아닙니다. uvicorn app.main:app --port 8000' },
      { status: 503 },
    );
  }

  try {
    const giftTax = await calcGiftTax({
      gift_amount: 3.0,
      relation: '자녀',
      recipient_is_adult: true,
      as_of: new Date().toISOString().slice(0, 10),
    });
    return NextResponse.json({ connected: true, sample_gift_tax_calc: giftTax });
  } catch (err) {
    return NextResponse.json(
      { connected: true, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

'use client';

import { useEffect } from 'react';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="kyn-error-screen">
      <div className="kyn-error-mark" aria-hidden="true" />
      <p className="kyn-error-kicker">KYN SYSTEM</p>
      <h1>페이지를 불러오지 못했습니다</h1>
      <p>잠시 후 다시 시도하거나 첫 화면으로 이동해 주세요.</p>
      <div className="kyn-error-actions">
        <button type="button" onClick={reset}>
          다시 시도
        </button>
        <a href="/">첫 화면으로</a>
      </div>
    </main>
  );
}

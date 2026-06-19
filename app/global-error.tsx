'use client';

export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="ko">
      <body>
        <main
          style={{
            minHeight: '100vh',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 14,
            background: '#fff',
            color: '#1d1d1f',
            fontFamily: 'Arial, sans-serif',
            textAlign: 'center',
          }}
        >
          <div
            aria-hidden="true"
            style={{
              width: 34,
              height: 34,
              border: '3px solid #e8dfc6',
              borderRightColor: '#9b7620',
              borderBottomColor: '#9b7620',
              borderRadius: '50%',
            }}
          />
          <p style={{ margin: 0, fontSize: 10, letterSpacing: '0.35em', color: '#8a8d93' }}>
            KYN SYSTEM
          </p>
          <h1 style={{ margin: '8px 0 0', fontSize: 24, fontWeight: 500 }}>
            화면을 불러오지 못했습니다
          </h1>
          <button
            type="button"
            onClick={reset}
            style={{
              marginTop: 8,
              padding: '12px 24px',
              border: '1px solid #9b7620',
              background: '#fff',
              color: '#6f5314',
              cursor: 'pointer',
            }}
          >
            다시 시도
          </button>
        </main>
      </body>
    </html>
  );
}

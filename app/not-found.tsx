export default function NotFound() {
  return (
    <main className="kyn-error-screen">
      <div className="kyn-error-mark" aria-hidden="true" />
      <p className="kyn-error-kicker">404</p>
      <h1>페이지를 찾을 수 없습니다</h1>
      <p>주소를 확인하거나 첫 화면으로 이동해 주세요.</p>
      <div className="kyn-error-actions">
        <a href="/">첫 화면으로</a>
      </div>
    </main>
  );
}

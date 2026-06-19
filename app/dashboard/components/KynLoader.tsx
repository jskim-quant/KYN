export function KynLoader({ label = 'LOADING...' }: { label?: string }) {
  return (
    <div className="kyn-loader-screen" role="status" aria-live="polite" aria-label={label} suppressHydrationWarning>
      <div className="kyn-loader-ring" aria-hidden="true" />
      <div className="kyn-loader-label">{label}</div>
    </div>
  );
}

/** Skeleton loading placeholders — replaces plain "加载中…" text fallbacks.
 *  Mimics the layout shape of the real content (sidebar, message stream,
 *  composer) so the initial paint looks structured instead of empty. */

export function SurfaceSkeleton() {
  return (
    <div className="skeleton-surface">
      <div className="skeleton-msg-block" />
      <div className="skeleton-msg-block short" />
      <div className="skeleton-msg-block" />
      <div className="skeleton-composer" />
    </div>
  )
}

/** Sidebar list skeleton — for session list / file tree loading. */
export function ListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="skeleton-list">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="skeleton-list-row" style={{ width: `${60 + Math.random() * 35}%` }} />
      ))}
    </div>
  )
}

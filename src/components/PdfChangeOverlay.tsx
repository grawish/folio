import type { PageComparison } from '../pdf-compare';

// A non-interactive layer drawn over one rendered PDF page, in the same CSS
// pixel space as its canvas (page-relative percentages, so zoom and DPR
// changes never need it to recompute). Exported PDFs and annotations never
// see this layer — it only exists in the viewer DOM. Change regions and the
// inserted-page outline follow the timed flash; the removed-page marker is
// structural and stays until the run's highlight data is cleared.
export function PdfChangeOverlay({
  comparison,
  phase,
  removedAdjacent,
}: {
  comparison?: PageComparison;
  phase: 'hidden' | 'visible' | 'fading';
  /** Set on the nearest surviving page when the next page in the before-PDF was removed. */
  removedAdjacent?: boolean;
}) {
  return (
    <div className="pdf-change-overlay" aria-hidden="true">
      <div className={`pdf-change-flash ${phase}`}>
        {comparison?.status === 'changed' &&
          comparison.regions.map((region, i) => (
            <div
              key={i}
              className={`pdf-change-region ${region.kind}`}
              style={{
                left: `${region.x * 100}%`,
                top: `${region.y * 100}%`,
                width: `${region.width * 100}%`,
                height: `${region.height * 100}%`,
              }}
            />
          ))}
        {comparison?.status === 'inserted' && (
          <>
            <div className="pdf-change-page-outline" />
            <div className="pdf-change-page-label">Inserted page</div>
          </>
        )}
      </div>
      {removedAdjacent && (
        <div className="pdf-change-removed-marker">Page removed after this one</div>
      )}
    </div>
  );
}

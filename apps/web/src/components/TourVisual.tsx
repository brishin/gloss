import { sanitizeSvg, type Visual } from '@gloss/protocol';
import { lazy, Suspense, useId, useMemo } from 'react';

const MermaidVisual = lazy(() => import('./MermaidVisual.tsx'));
const BeforeAfterVisual = lazy(() => import('./BeforeAfterVisual.tsx'));

type Timeline = Extract<Visual, { kind: 'timeline' }>;

/**
 * The tour's one picture of its main decision. Model output, so it is drawn from data
 * the normalizer already checked, never from model-written markup.
 */
export function TourVisual({ visual }: { visual: Visual }) {
  return (
    <figure className="visual">
      {visual.kind === 'before-after' ? (
        <Suspense fallback={null}>
          <BeforeAfterVisual before={visual.before} after={visual.after} />
        </Suspense>
      ) : visual.kind === 'timeline' ? (
        <TimelineVisual timeline={visual} />
      ) : visual.kind === 'svg' ? (
        <SketchVisual svg={visual.svg} caption={visual.caption} />
      ) : (
        <Suspense fallback={null}>
          <MermaidVisual source={visual.source} />
        </Suspense>
      )}
      {visual.caption && <figcaption className="muted">{visual.caption}</figcaption>}
    </figure>
  );
}

/**
 * A model-drawn sketch, inline so the stylesheet can restyle it like the Mermaid
 * diagrams: the sketch palette's fixed colors become theme tokens (see .visual-sketch).
 * The markup passes the protocol's allowlist again here, so nothing in it can run or
 * link, and its ids get this figure's prefix so two sketches' markers never collide.
 */
function SketchVisual({ svg, caption }: { svg: string; caption?: string | undefined }) {
  const prefix = useId().replace(/[^\w-]/g, '');
  const html = useMemo(() => {
    const clean = sanitizeSvg(svg);
    return typeof clean === 'string'
      ? clean
          .replace(/ id="([^"]*)"/g, ` id="${prefix}-$1"`)
          .replace(/url\(\s*#([\w-]+)\s*\)/g, `url(#${prefix}-$1)`)
          .replace(/^<svg/, `<svg role="img" aria-label="${escapeAttribute(caption ?? '')}"`)
      : undefined;
  }, [svg, caption, prefix]);
  return html ? <div className="visual-sketch" dangerouslySetInnerHTML={{ __html: html }} /> : null;
}

function escapeAttribute(text: string) {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function TimelineVisual({ timeline }: { timeline: Timeline }) {
  return (
    <div className="visual-timeline">
      {timeline.markers.length > 0 && (
        <>
          <span />
          <div className="timeline-track timeline-markers">
            {timeline.markers.map((marker, index) => (
              <span key={index} className="timeline-marker" style={edge(marker.at)}>
                {marker.text}
              </span>
            ))}
          </div>
        </>
      )}
      {timeline.lanes.map((lane, index) => (
        <div key={index} className="timeline-lane">
          <span className="visual-label">{lane.label}</span>
          <div className="timeline-track">
            {timeline.markers.map((marker, at) => (
              <span key={at} className="timeline-rule" style={{ left: `${marker.at}%` }} />
            ))}
            {lane.spans.map((span, at) => (
              <span
                key={at}
                className={`timeline-span tone-${span.tone ?? 'accent'}`}
                style={{ left: `${span.from}%`, width: `${span.to - span.from}%` }}
                title={span.text}
              >
                {span.text}
              </span>
            ))}
            {lane.outcome && (
              <span className={`timeline-outcome tone-${lane.outcome.tone}`} style={edge(lane.outcome.at)}>
                {lane.outcome.text}
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Text that starts at `at`, or ends there once it is past the middle, so it stays on the track. */
function edge(at: number) {
  return at > 60 ? { right: `${100 - at}%`, textAlign: 'right' as const } : { left: `${at}%` };
}

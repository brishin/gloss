import type { Visual } from '@gloss/protocol';
import { lazy, Suspense } from 'react';

const MermaidVisual = lazy(() => import('./MermaidVisual.tsx'));

type Timeline = Extract<Visual, { kind: 'timeline' }>;

/**
 * The tour's one picture of its main decision. Model output, so it is drawn from data
 * the normalizer already checked, never from model-written markup.
 */
export function TourVisual({ visual }: { visual: Visual }) {
  return (
    <figure className="visual">
      {visual.kind === 'before-after' ? (
        <div className="visual-before-after">
          <VisualColumn label="Before" rows={visual.before} />
          <VisualColumn label="After" rows={visual.after} />
        </div>
      ) : visual.kind === 'timeline' ? (
        <TimelineVisual timeline={visual} />
      ) : (
        <Suspense fallback={null}>
          <MermaidVisual source={visual.source} />
        </Suspense>
      )}
      {visual.caption && <figcaption className="muted">{visual.caption}</figcaption>}
    </figure>
  );
}

function VisualColumn({ label, rows }: { label: string; rows: readonly string[] }) {
  return (
    <div className="visual-column">
      <div className="visual-label">{label}</div>
      <ul>
        {rows.map((row, index) => (
          <li key={index}>
            <InlineCode text={row} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Backtick spans as code; everything else as plain text. */
function InlineCode({ text }: { text: string }) {
  return text
    .split(/(`[^`]+`)/)
    .map((part, index) =>
      part.startsWith('`') && part.endsWith('`') && part.length > 2 ? (
        <code key={index}>{part.slice(1, -1)}</code>
      ) : (
        part
      ),
    );
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

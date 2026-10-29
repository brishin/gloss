import { useMemo } from 'react';
import { Diagram, mermaidSvg } from './MermaidVisual.tsx';

/** Wider than this, two diagrams side by side shrink past reading, so they stack. */
const SIDE_BY_SIDE = 340;

/** The old flow next to the new one, or above it when either is too wide to halve. */
export default function BeforeAfterVisual({ before, after }: { before: string; after: string }) {
  const sides = useMemo(() => [mermaidSvg(before), mermaidSvg(after)] as const, [before, after]);
  const stacked = sides.some((svg) => (svg?.width ?? 0) > SIDE_BY_SIDE);
  return (
    <div className={stacked ? 'visual-before-after stacked' : 'visual-before-after'}>
      {sides.map((svg, index) => (
        <div key={index} className="visual-column">
          <div className="visual-label">{index ? 'After' : 'Before'}</div>
          {svg && <Diagram svg={svg} />}
        </div>
      ))}
    </div>
  );
}

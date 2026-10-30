import { callLocations, callParents, type Visual } from '@gloss/protocol';

type Callstack = Extract<Visual, { kind: 'callstack' }>;

/** Row height and indent per level, in px; `.callstack-row` and the Jev image use the same. */
const ROW = 28;
const INDENT = 22;
const MARK = 9;
/** Space above each entry point after the first, so separate paths read apart. */
const ROOT_GAP = 10;

const STATUS = { new: 'new', changed: 'changed', same: 'unchanged' } as const;

/**
 * The call path a change adds, as an indented tree: dim receiver, bold name, dim arguments,
 * and where each function is defined on the right. Connectors are one SVG under the rows,
 * drawn from the same row geometry.
 */
export function CallstackVisual({ visual }: { visual: Callstack }) {
  const { frames } = visual;
  const parents = callParents(frames);
  const locations = callLocations(frames);
  const counts = (['new', 'changed', 'same'] as const)
    .map((status) => [status, frames.filter((frame) => frame.status === status).length] as const)
    .filter(([, count]) => count > 0);
  const tops = frames.map((_, index) => index * ROW + ROOT_GAP * rootsBefore(frames, index));
  const mid = (index: number) => tops[index]! + ROW / 2;
  return (
    <div className="visual-callstack">
      <div className="callstack-legend">
        {counts.map(([status, count]) => (
          <span key={status}>
            <span className={`callstack-mark ${status}`} />
            {status === 'same' ? STATUS[status] : `${count} ${STATUS[status]}`}
          </span>
        ))}
      </div>
      <div className="callstack-tree">
        <svg className="callstack-lines" width="100%" height={tops.at(-1)! + ROW} aria-hidden>
          {frames.map((frame, index) => {
            const parent = parents[index]!;
            if (parent < 0) {
              return null;
            }
            const x = frames[parent]!.depth * INDENT + MARK / 2;
            const y = mid(index);
            return (
              <path
                key={index}
                d={`M${x} ${mid(parent) + MARK / 2 + 2}V${y - 6}Q${x} ${y} ${x + 6} ${y}H${frame.depth * INDENT - 3}`}
              />
            );
          })}
        </svg>
        {frames.map((frame, index) => {
          const location = locations[index]!;
          const file = location.startsWith(':') ? '' : location.replace(/:\d+$/, '');
          return (
            <div
              key={index}
              className="callstack-row"
              style={{ paddingLeft: frame.depth * INDENT, marginTop: index && !frame.depth ? ROOT_GAP : 0 }}
              title={`${frame.receiver ? `${frame.receiver}.` : ''}${frame.name}(${frame.args ?? ''})${frame.path ? `\n${frame.path}${frame.line ? `:${frame.line}` : ''}` : ''}`}
            >
              <span className={`callstack-mark ${frame.status}`} aria-label={STATUS[frame.status]} />
              <code className="callstack-call">
                {frame.receiver && `${frame.receiver}.`}
                <b>{frame.name}</b>({frame.args ?? ''})
              </code>
              <code className="callstack-at">
                {file}
                <span>{location.slice(file.length)}</span>
              </code>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Entry points after the first, up to and including `index`. */
function rootsBefore(frames: Callstack['frames'], index: number): number {
  return frames.slice(1, index + 1).filter((frame) => frame.depth === 0).length;
}

import { StatusDot } from '@astryxdesign/core/StatusDot';
import type { Stage, StageStatus } from '@gloss/protocol';
import { STAGES } from '@gloss/protocol';

const LABELS: Record<Stage, string> = {
  fetch: 'Diff',
  define: 'Groups',
  judge: 'Jev',
  place: 'Placement',
  notes: 'Notes',
};

const VARIANT = {
  pending: 'neutral',
  running: 'accent',
  done: 'success',
  skipped: 'neutral',
  failed: 'error',
} as const;

export function StageRail({ stages }: { stages: Record<Stage, StageStatus> }) {
  return (
    <div className="stage-rail" aria-label="Tour progress">
      {STAGES.map((stage) => {
        const status = stages[stage];
        const label = `${LABELS[stage]}: ${status.state}${status.detail ? ` (${status.detail})` : ''}`;
        return (
          <span className="stage" key={stage} title={label}>
            <StatusDot variant={VARIANT[status.state]} label={label} isPulsing={status.state === 'running'} />
            <span style={{ opacity: status.state === 'skipped' ? 0.5 : 1 }}>{LABELS[stage]}</span>
          </span>
        );
      })}
    </div>
  );
}

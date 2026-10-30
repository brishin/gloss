import { Banner } from '@astryxdesign/core/Banner';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import { Text } from '@astryxdesign/core/Text';
import { useAtomValue } from '@effect/atom-react';
import type { SourceRef, TraceStep } from '@gloss/protocol';
import { describeRef } from '@gloss/protocol';
import { Link, useRouter } from '@tanstack/react-router';
import { AsyncResult } from 'effect/reactivity';
import { useEffect, useMemo } from 'react';
import { pipelineAtom } from '../lib/client.ts';
import { navigateToPipeline, navigateToRef, RefLink } from '../lib/source-routes.tsx';
import {
  duration,
  layoutGraph,
  NODE,
  promptLines,
  selectedStep,
  STEP_KINDS,
  stepFacts,
  stepTitle,
} from '../lib/trace-view.ts';
import { Logo } from './Logo.tsx';

const GRAPH_WIDTH = 420;

/**
 * The pipeline debug view: the tour's steps as a DAG, and one step's prompt (each part
 * marked with the step it came from) next to what it returned. `j`/`k` move between
 * steps; `d` goes back to the tour.
 */
export function PipelinePage({ sourceRef, jobId, stepId }: { sourceRef: SourceRef; jobId?: string; stepId?: string }) {
  const router = useRouter();
  const result = useAtomValue(pipelineAtom(JSON.stringify({ ref: sourceRef, jobId })));
  const pipeline = AsyncResult.getOrElse(result, () => undefined);
  const steps = useMemo(() => pipeline?.trace.steps ?? [], [pipeline]);
  const layout = useMemo(() => layoutGraph(steps, GRAPH_WIDTH), [steps]);
  const selected = selectedStep(steps, stepId);
  const open = (id: string) => void navigateToPipeline(router, sourceRef, { job: jobId, step: id });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      const order = layout.nodes.map((node) => node.step.id);
      const at = selected ? order.indexOf(selected.id) : -1;
      if (event.key === 'j' || event.key === 'k') {
        const target = order[at + (event.key === 'j' ? 1 : -1)];
        if (target) {
          void navigateToPipeline(router, sourceRef, { job: jobId, step: target });
        }
      } else if (event.key === 'd') {
        void navigateToRef(router, sourceRef);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [layout, selected, router, sourceRef, jobId]);

  return (
    <div className="app pipeline-app">
      <header className="topbar">
        <Link to="/" className="brand">
          <Logo />
        </Link>
        <div className="topbar-meta">
          <span className="topbar-ref">
            <Text color="secondary" size="sm">
              {describeRef(sourceRef)}
            </Text>
          </span>
          <span className="topbar-title">{pipeline?.title}</span>
        </div>
        <nav className="pipeline-crumbs" aria-label="View">
          <RefLink sourceRef={sourceRef}>Tour</RefLink>
          <span aria-hidden="true">/</span>
          <strong aria-current="page">Pipeline</strong>
        </nav>
      </header>
      {AsyncResult.isFailure(result) && (
        <Banner status="error" title="Could not load the pipeline" description="Is the gloss server running?" />
      )}
      {!pipeline ? (
        AsyncResult.isFailure(result) ? null : (
          <div className="pipeline-empty">
            <Skeleton height={240} />
          </div>
        )
      ) : steps.length === 0 ? (
        <div className="pipeline-empty">
          <Text color="secondary">
            {pipeline.trace.done
              ? 'This tour was cached before gloss kept pipeline traces. Re-run the tour to record one.'
              : 'Starting…'}
          </Text>
        </div>
      ) : (
        <div className="pipeline">
          <aside className="pipeline-graph">
            <Text color="secondary" size="sm">
              {graphFacts(steps)}
            </Text>
            <div className="graph" style={{ width: GRAPH_WIDTH, height: layout.height }}>
              <Edges layout={layout} selected={selected} />
              {layout.nodes.map(({ step, x, y }) => (
                <button
                  type="button"
                  key={step.id}
                  className="graph-node"
                  data-selected={step.id === selected?.id}
                  data-state={step.state}
                  style={{ left: x, top: y, width: NODE.width, height: NODE.height }}
                  onClick={() => open(step.id)}
                >
                  <span className="graph-node-head">
                    <span className="actor-dot" data-actor={STEP_KINDS[step.kind].actor} />
                    <span className="graph-node-label">{STEP_KINDS[step.kind].label}</span>
                  </span>
                  <span className="graph-node-sub">
                    {[step.subject ?? step.summary, duration(step)].filter(Boolean).join(' · ')}
                  </span>
                </button>
              ))}
            </div>
          </aside>
          {selected && <Inspector step={selected} steps={steps} />}
        </div>
      )}
    </div>
  );
}

function graphFacts(steps: readonly TraceStep[]): string {
  const end = Math.max(...steps.map((step) => step.endMs ?? step.startMs));
  const calls = (actor: string) => steps.filter((step) => STEP_KINDS[step.kind].actor === actor).length;
  const model = calls('llm') + calls('notes');
  return [`${(end / 1000).toFixed(1)} s`, `${model} model calls`, calls('jev') ? `${calls('jev')} Jev steps` : '']
    .filter(Boolean)
    .join(' · ');
}

/** Every step's first input, faintly; the selected step's inputs and readers in the accent. */
function Edges({ layout, selected }: { layout: ReturnType<typeof layoutGraph>; selected?: TraceStep }) {
  const at = new Map(layout.nodes.map((node) => [node.step.id, node]));
  const edges: { from: string; to: string; hot: boolean }[] = [];
  for (const { step } of layout.nodes) {
    step.inputs.forEach((input, index) => {
      const hot = step.id === selected?.id || input === selected?.id;
      if (at.has(input) && (index === 0 || hot)) {
        edges.push({ from: input, to: step.id, hot });
      }
    });
  }
  // Hot edges last, so they draw on top.
  edges.sort((a, b) => Number(a.hot) - Number(b.hot));
  return (
    <svg className="graph-edges" width={layout.width} height={layout.height} aria-hidden="true">
      {edges.map(({ from, to, hot }) => {
        const a = at.get(from)!;
        const b = at.get(to)!;
        const x1 = a.x + NODE.width / 2;
        const y1 = a.y + NODE.height;
        const x2 = b.x + NODE.width / 2;
        const y2 = b.y;
        const bend = Math.max(16, (y2 - y1) / 2);
        return (
          <path
            key={`${from}>${to}`}
            data-hot={hot}
            d={`M${x1} ${y1} C${x1} ${y1 + bend} ${x2} ${y2 - bend} ${x2} ${y2}`}
          />
        );
      })}
    </svg>
  );
}

function Inspector({ step, steps }: { step: TraceStep; steps: readonly TraceStep[] }) {
  const blocks = useMemo(() => promptBlocks(step, steps), [step, steps]);
  const kindOf = new Map(steps.map((other) => [other.id, other.kind]));
  const reads = step.inputs.map((id) => kindOf.get(id)).filter((kind) => kind !== undefined);
  return (
    <section className="inspector" aria-label={stepTitle(step)}>
      <div className="inspector-head">
        <h2>{stepTitle(step)}</h2>
        <Text color="secondary" size="sm">
          {stepFacts(step)}
        </Text>
      </div>
      <div className="inspector-panes">
        {step.prompt !== undefined ? (
          <div className="inspector-pane">
            <div className="pane-title">Prompt</div>
            <div className="pane-body">
              {step.system && (
                <details className="system-prompt">
                  <summary>System prompt</summary>
                  <pre>{step.system}</pre>
                </details>
              )}
              {blocks.map((block) => (
                <div className="prompt-block" key={block.line} data-actor={block.actor}>
                  <span className="prompt-tag">{block.tag}</span>
                  <pre>{block.text}</pre>
                </div>
              ))}
            </div>
          </div>
        ) : (
          reads.length > 0 && (
            <div className="inspector-pane inspector-reads">
              <div className="pane-title">Reads</div>
              <div className="pane-body">{reads.map((kind) => STEP_KINDS[kind].label).join(', ')}</div>
            </div>
          )
        )}
        <div className="inspector-pane">
          <div className="pane-title">Output</div>
          <div className="pane-body">
            {step.warnings?.length ? (
              <div className="step-warnings" data-state={step.state}>
                <strong>{step.state === 'failed' ? 'Failed' : 'Normalized'}</strong>
                {step.warnings.map((warning) => (
                  <div key={warning}>{warning}</div>
                ))}
              </div>
            ) : null}
            {step.output !== undefined ? (
              <pre className="step-output">{JSON.stringify(step.output, null, 2)}</pre>
            ) : (
              <Text color="secondary">{step.state === 'running' ? 'Running…' : 'No output.'}</Text>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

/** Runs of prompt lines from one source, so a long diff is one `<pre>` rather than a row per line. */
function promptBlocks(step: TraceStep, steps: readonly TraceStep[]) {
  const kindOf = new Map(steps.map((other) => [other.id, other.kind]));
  const blocks: { line: number; tag?: string; actor?: string; text: string }[] = [];
  promptLines(step, steps).forEach(({ text, from, tag }, line) => {
    const last = blocks.at(-1);
    const kind = from ? kindOf.get(from) : undefined;
    const actor = kind ? STEP_KINDS[kind].actor : undefined;
    if (last && !tag && last.actor === actor) {
      last.text += `\n${text}`;
    } else {
      blocks.push({ line, tag, actor, text });
    }
  });
  return blocks;
}

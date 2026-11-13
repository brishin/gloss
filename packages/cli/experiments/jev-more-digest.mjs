// EVAL ONLY: packs the jev-more outputs into one small HTML file (gzip + base64 JSON) for reading elsewhere.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const dir = process.env.OUT ?? join(homedir(), 'Programming/gloss/.eval-out/jev-more');
const read = (name) => readFileSync(join(dir, name), 'utf8');
const out = { tours: {}, traces: {}, stderr: {}, analysis: {} };
for (const name of readdirSync(dir)) {
  try {
    if (name.endsWith('.trace.json')) {
      out.traces[name.replace('.trace.json', '')] = JSON.parse(read(name)).map((step) => ({
        id: step.id,
        startMs: step.startMs,
        endMs: step.endMs,
        cached: step.cached,
        summary: step.summary,
        reads: step.reads,
        usage: step.usage,
        warnings: step.warnings,
        chars: step.prompt?.length,
        truncated: (step.prompt?.match(/^\.\.\. \(truncated\)/gm) ?? []).length,
        omitted: /omitted for budget: ([^.]*)\./.exec(step.prompt ?? '')?.[1],
        folded: (step.prompt?.match(/\(mechanical edit a classifier/g) ?? []).length,
        keyHints: /## Hunks where the main behavior is decided\n[^\n]*\n((?:- .*\n)*)/.exec(step.prompt ?? '')?.[1],
        output: /^(define|followup|place|description-check|section|callpath|walkthrough)/.test(step.id) ? step.output : undefined,
      }));
    } else if (name.endsWith('.stderr')) {
      out.stderr[name.replace('.stderr', '')] = read(name);
    } else if (/-(place|diet|precheck|verify|dedupe)\.json$/.test(name)) {
      const data = JSON.parse(read(name));
      if (data.mode === 'verify') {
        data.result.rows = data.result.rows.map((row, at) => {
          const flagged = row.contradicted >= 0.3 || row.grounded <= 0.5 || row.actionable <= 0.4;
          return flagged || at % 6 === 0 ? { ...row, hunk: row.hunk?.slice(0, 3500) } : { ...row, hunk: undefined };
        });
      }
      out.analysis[name.replace('.json', '')] = data;
    } else if (/-(base|rk|dietarm)\.json$/.test(name)) {
      const { files, judgments, placements, visuals, ...tour } = JSON.parse(read(name));
      out.tours[name.replace('.json', '')] = {
        ...tour,
        files: files.map(({ id, path, additions, deletions, hunkIds }) => ({ id, path, additions, deletions, hunks: hunkIds?.length })),
        placements,
      };
    }
  } catch (error) {
    out.stderr[`DIGEST-ERROR ${name}`] = String(error);
  }
}
const packed = gzipSync(JSON.stringify(out)).toString('base64');
writeFileSync(
  join(dir, 'bundle.html'),
  `<!doctype html><meta charset="utf-8"><title>Jev eval bundle</title><p>Jev exploration outputs, packed for analysis.</p><script id="d" type="application/octet-stream">${packed}</script>`,
);
console.log(`bundle.html ${Math.round(packed.length / 1024)} KB`);

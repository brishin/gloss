// Eval only: one text digest of every tour's decisions and notes, per PR and arm.
//   node eval/python-checks/digest.mjs <dir> > digest.txt
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const dir = process.argv[2];
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .sort();
for (const f of files) {
  const tour = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  const path = Object.fromEntries(tour.files.map((x) => [x.id, x.path]));
  const short = (id) => (path[id] ?? id ?? '').split('/').slice(-2).join('/');
  console.log(`\n##### ${f.replace('.json', '')}`);
  for (const d of tour.decisions ?? []) console.log(`CW [${d.priority}] ${d.text}`);
  for (const g of tour.groups) {
    const n = tour.notes[g.key];
    if (!n) continue;
    const py = g.fileIds.some((id) => /\.pyi?$/.test(path[id] ?? '')) ? ' py' : '';
    console.log(`-- ${g.key}${py} notes=${n.fileNotes.length + n.lineNotes.length + n.riskNotes.length}`);
    for (const d of n.decisions ?? []) console.log(`D [${d.priority}] ${short(d.fileId)}:${d.line ?? ''} ${d.text}`);
    const re =
      /services|batch|N\+1|per (row|item|user|person|candidate)|one at a time|enqueue|dedupe|debounce|tuple|dataclass|TYPE_CHECKING|import cycle|circular|round trip|concurren|unbounded|quer(y|ies)/i;
    for (const x of [...n.fileNotes, ...n.lineNotes])
      if (re.test(x.text)) console.log(`N ${short(x.fileId)}:${x.line ?? ''} ${x.text}`);
  }
}

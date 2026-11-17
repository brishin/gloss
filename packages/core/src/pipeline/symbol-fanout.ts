import * as v from 'valibot';
import { blocksAround } from '../sources/symbol-uses.ts';

/**
 * Experiment: the symbol card as parallel readers. Each reader gets one place that defines or
 * uses the symbol, reads at most one hop out from it, and reports in a few words; they all run
 * at once. One short call with no tools then writes the card from their reports. This turns the
 * single model's three rounds of reading into one round, run side by side.
 */

/** A place the readers start from: a function or class around one or more lines that name the symbol. */
export interface SymbolSite {
  role: 'clicked' | 'definition' | 'use';
  path: string;
  from: number;
  to: number;
  /** The lines in the block that name the symbol. */
  marks: number[];
  /** The block, numbered, with `>` on the marked lines. */
  code: string;
}

/** The readers per card: the clicked place, the definition, and up to this many other uses. */
export const SITE_USES = 4;
const SITE_LINES = 70;
const SITE_AROUND = 8;
const TEST_PATH = /(^|\/)(tests?|__tests__|specs?)\/|\.(test|spec)\.[a-z]+$|(^|\/)test_[^/]*\.py$|_test\.(py|go)$/;

/** Which places get a reader: the click, the definition, then uses outside tests first, one block each. */
export async function symbolSites(
  definitions: readonly { path: string; line: number }[],
  uses: readonly { path: string; line: number; kind?: string }[],
  clicked: { path: string; line: number },
  read: (path: string) => Promise<string | undefined>,
): Promise<SymbolSite[]> {
  const order = [...uses].sort(
    (a, b) =>
      Number(TEST_PATH.test(a.path)) - Number(TEST_PATH.test(b.path)) ||
      Number(a.kind === 'read') - Number(b.kind === 'read'),
  );
  const points = [
    { role: 'clicked' as const, ...clicked },
    ...definitions.slice(0, 1).map((at) => ({ role: 'definition' as const, path: at.path, line: at.line })),
    ...order.map((at) => ({ role: 'use' as const, path: at.path, line: at.line })),
  ];
  const sources = new Map<string, string[] | undefined>();
  const sites: SymbolSite[] = [];
  let useSites = 0;
  let testSites = 0;
  for (const point of points) {
    if (!sources.has(point.path)) {
      sources.set(point.path, (await read(point.path))?.replace(/\n$/, '').split('\n'));
    }
    const rows = sources.get(point.path);
    if (!rows || point.line > rows.length) {
      continue;
    }
    // A line already inside a chosen block only adds its mark.
    const inside = sites.find((site) => site.path === point.path && point.line >= site.from && point.line <= site.to);
    if (inside) {
      inside.marks.push(point.line);
      continue;
    }
    if (point.role === 'use') {
      const test = TEST_PATH.test(point.path);
      if (useSites >= SITE_USES || (test && testSites >= 1)) {
        continue;
      }
      useSites++;
      testSites += Number(test);
    }
    const block = (await blocksAround(point.path, rows.join('\n'), [point.line]).catch(() => undefined))?.get(
      point.line,
    );
    let from = block && block.to > block.from ? block.from : Math.max(1, point.line - SITE_AROUND);
    let to = block && block.to > block.from ? block.to : Math.min(rows.length, point.line + SITE_AROUND);
    if (to - from + 1 > SITE_LINES) {
      from = Math.max(from, point.line - Math.floor(SITE_LINES / 3));
      to = Math.min(to, from + SITE_LINES - 1);
    }
    sites.push({ role: point.role, path: point.path, from, to, marks: [point.line], code: '' });
  }
  for (const site of sites) {
    const rows = sources.get(site.path)!;
    site.code = rows
      .slice(site.from - 1, site.to)
      .map((row, index) => {
        const line = site.from + index;
        return `${site.marks.includes(line) ? '>' : ' '}${String(line).padStart(5)} ${row}`;
      })
      .join('\n');
  }
  return sites;
}

export const SITE_SYSTEM = `A reviewer reading a pull request clicked a name in the diff. Several readers each look at one place in the code that defines or uses that name, all at the same time. You are one of them: look at your place only.

Lines marked ">" name the symbol. Go at most one hop out from your place with read_file and search_code, four calls at most, and none when the code shown is enough:
- When the name is a value passed in or stored: who calls the enclosing function, and what each caller passes.
- When it is a flag, check or condition: what makes it true, and which entry points (requests, Slack, jobs, admin) can ever get it there.
- When it is a helper: the default or edge case that matters at this place.
search_code shows at most 5 matches per file, so a missing match proves nothing; read the file before you say something has no caller or never runs.

Report in plain words, a few each:
- place: where this is, by the name a reader of this codebase would use ("threads DAG", "Slack handler"), with path:line.
- does: what this place does with the name.
- decides: what decides the value here or whether this code runs, one hop out, naming the places. Empty when nothing does.
- gate: when the name is a flag or check, or is read only behind one: "passes" when this path can make it true, "fails" when it never can; otherwise "none".
- finding: ONE sentence, 20 words at most, that a reviewer of the diff would not see and would want to know (a caller that never supplies the value, a default that matters, an edge case). Empty when there is none, which is most places.
Every fact must come from code you read. No advice, no hedging.`;

export const SiteReportSchema = v.object({
  place: v.string(),
  does: v.string(),
  decides: v.string(),
  gate: v.picklist(['passes', 'fails', 'none']),
  finding: v.string(),
});
export type SiteReport = v.InferOutput<typeof SiteReportSchema>;

const ROLE = { clicked: 'where the reviewer clicked', definition: 'the definition', use: 'a use' } as const;

export function buildSitePrompt(
  { title, symbol, clicked, hunk }: { title: string; symbol: string; clicked: string; hunk: string },
  site: SymbolSite,
): string {
  return [
    `# ${title}`,
    `## The click\nSymbol: \`${symbol}\` at ${clicked}`,
    site.role === 'clicked' ? '' : hunk ? `## The hunk the reviewer is reading\n${hunk}` : '',
    `## Your place: ${ROLE[site.role]}, ${site.path}:${site.from}-${site.to}\n${site.code}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** What the readers found, for the call that writes the card. */
export function readerReports(sites: readonly SymbolSite[], reports: readonly (SiteReport | undefined)[]): string {
  return sites
    .map((site, index) => {
      const report = reports[index];
      const head = `### ${ROLE[site.role]}: ${site.path}:${site.from}-${site.to}`;
      if (!report) {
        return `${head}\n(the reader failed)`;
      }
      return [
        head,
        `place: ${report.place}`,
        `does: ${report.does}`,
        report.decides && `decides: ${report.decides}`,
        report.gate !== 'none' && `gate: ${report.gate}`,
        report.finding && `finding: ${report.finding}`,
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n\n');
}

/** The card call after the readers: the card rules of the one-model prompt, without its reading or `checked`. */
export function synthSystem(single: string): string {
  const card = single.slice(single.indexOf('## The card'));
  const withoutChecked = card.replace(/\nchecked: [\s\S]*?\n\nlead:/, '\nlead:');
  return `A reviewer reading a pull request clicked a symbol in the diff. They can read code. Tell them the one or two things they would otherwise have to leave the diff to find out, and nothing else.

## What you have

Readers each read one place that defines or uses the symbol, one hop out, and reported what they found. Their reports, the code each started from, and every line that names the symbol are in the prompt. You have no tools: write the card from these. Every fact must come from a report or from code shown. When reports differ (some paths pass a gate, some never do; some callers pass a value, some pass None), that difference is usually the lead. Do not claim that something has no caller or never runs unless a report says so.

${withoutChecked}`;
}

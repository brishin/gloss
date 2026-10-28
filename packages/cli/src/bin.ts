#!/usr/bin/env node
import { execFile } from 'node:child_process';
import process from 'node:process';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { createSource, runTour } from '@gloss/core';
import { configPath, glossPath, login, logout, providerStatus, SUBSCRIPTIONS, type Subscription } from '@gloss/models';
import type { TourEventBody } from '@gloss/protocol';
import { createHttpGlossClient, describeRef, RISK_LABELS, RISK_KEYS } from '@gloss/protocol';
import { createBackend, loadGlossEnv, VERSION } from './backend.ts';
import { DEFAULT_PORT, startServer } from './serve.ts';
import { resolveTarget, webPath } from './target.ts';

const HELP = `gloss ${VERSION} — streaming review tours for pull requests and local diffs

Usage
  gloss [target]              Open a tour in the browser (starts the local server)
  gloss serve                 Run the local server only
  gloss tour <target>         Print a tour in the terminal (--json for the full tour)
  gloss login claude|chatgpt  Sign in with a Claude or ChatGPT subscription
  gloss logout claude|chatgpt
  gloss status                Show providers, models and judge
  gloss cache prune [--days N]

Targets
  https://github.com/o/r/pull/1, o/r#1   A GitHub pull request (via the gh CLI)
  (none)                                  This repo: uncommitted changes, else branch vs main
  <dir>                                   That repo, same default
  main...HEAD, HEAD~3..HEAD, <commit>     A git range or commit in this repo
  worktree                                Uncommitted changes in this repo

Options
  --port <n>      Server port (default ${DEFAULT_PORT})
  --host <addr>   Bind address (default 127.0.0.1)
  --token <t>     Require this bearer token on /api (or GLOSS_TOKEN)
  --force         Ignore cached results
  --no-open       Do not open the browser
  --json          (tour) Print the finished tour as JSON

Config: ${configPath()}   Keys: environment or ${glossPath('.env')}`;

function openBrowser(url: string) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  execFile(command, [url], () => {});
}

const elapsed = (start: number) => `${((performance.now() - start) / 1000).toFixed(1)}s`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      port: { type: 'string' },
      host: { type: 'string' },
      token: { type: 'string' },
      days: { type: 'string' },
      force: { type: 'boolean', default: false },
      'no-open': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
  });
  if (values.help) {
    console.log(HELP);
    return;
  }
  if (values.version) {
    console.log(VERSION);
    return;
  }
  const port = Number(values.port ?? process.env.GLOSS_PORT ?? DEFAULT_PORT);
  const host = values.host ?? '127.0.0.1';
  const token = values.token ?? process.env.GLOSS_TOKEN;
  const [command, ...rest] = positionals;

  switch (command) {
    case 'login':
    case 'logout': {
      const subscription = rest[0] as Subscription;
      if (!(subscription in SUBSCRIPTIONS)) {
        throw new Error(`Usage: gloss ${command} ${Object.keys(SUBSCRIPTIONS).join('|')}`);
      }
      if (command === 'logout') {
        await logout(subscription);
        console.log(`Signed out of ${SUBSCRIPTIONS[subscription].label}.`);
        return;
      }
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        await login(subscription, {
          notify: (event) => {
            if (event.type === 'auth_url') {
              console.error(`Opening ${event.url}${event.instructions ? `\n${event.instructions}` : ''}`);
              openBrowser(event.url);
            } else if (event.type === 'device_code') {
              console.error(`Go to ${event.verificationUri} and enter ${event.userCode}`);
              openBrowser(event.verificationUri);
            } else {
              console.error(event.message);
            }
          },
          prompt: async (prompt) => {
            if (prompt.type === 'select') {
              prompt.options.forEach((option, index) => console.error(`  ${index + 1}. ${option.label}`));
              const answer = await rl.question(`${prompt.message} `);
              return prompt.options[Number(answer) - 1]?.id ?? answer;
            }
            return rl.question(`${prompt.message} `);
          },
        });
      } finally {
        rl.close();
      }
      console.log(`Signed in with ${SUBSCRIPTIONS[subscription].label}.`);
      return;
    }

    case 'status': {
      loadGlossEnv();
      const backend = await createBackend();
      const health = await backend.health();
      console.log(
        `Models: define ${health.models.define}, followup ${health.models.followup}, notes ${health.models.notes}`,
      );
      console.log(`Judge: ${health.judge.available ? health.judge.model : 'off (set TYPESAFE_API_KEY to enable Jev)'}`);
      for (const provider of await providerStatus()) {
        console.log(
          `  ${provider.id}: ${provider.configured ? `configured (${provider.source ?? 'ok'})` : 'not configured'}`,
        );
      }
      backend.cache.close();
      return;
    }

    case 'cache': {
      if (rest[0] !== 'prune') {
        throw new Error('Usage: gloss cache prune [--days N]');
      }
      const backend = await createBackend();
      const removed = backend.cache.prune(Number(values.days ?? 30) * 86_400_000);
      console.log(`Removed ${removed} cache entries.`);
      backend.cache.close();
      return;
    }

    case 'tour': {
      const ref = await resolveTarget(rest[0], process.cwd());
      const backend = await createBackend();
      const start = performance.now();
      const controller = new AbortController();
      process.once('SIGINT', () => controller.abort(new DOMException('Interrupted', 'AbortError')));
      console.error(`Touring ${describeRef(ref)}${backend.judge ? '' : ' (no judge: LLM places files)'}`);
      const log = (event: TourEventBody) => {
        const at = elapsed(start).padStart(6);
        switch (event.type) {
          case 'job.started':
            if (event.cached) console.error(`${at}  cached`);
            break;
          case 'diff.ready':
            console.error(`${at}  diff: ${event.files.length} files — ${event.meta.title}`);
            break;
          case 'groups.provisional':
            console.error(`${at}  provisional: ${event.groups.map((group) => group.label).join(', ')}`);
            break;
          case 'group.defined':
            console.error(`${at}  group: ${event.group.label}`);
            break;
          case 'groups.resolved':
            console.error(
              `${at}  placed: ${event.groups.map((group) => `${group.label} (${group.fileIds.length})`).join(', ')}`,
            );
            break;
          case 'group.notes':
            console.error(
              `${at}  notes: ${event.groupKey} (${event.notes.lineNotes.length + event.notes.fileNotes.length} notes${event.source === 'cache' ? ', cached' : ''})`,
            );
            break;
          case 'stage.status':
            if (event.state !== 'running')
              console.error(`${at}  ${event.stage} ${event.state}${event.detail ? `: ${event.detail}` : ''}`);
            break;
          case 'job.warning':
          case 'job.error':
            console.error(`${at}  ! ${event.message}`);
            break;
        }
      };
      try {
        const tour = await runTour({
          ref,
          source: createSource(ref),
          cache: backend.cache,
          model: backend.model,
          judge: backend.judge,
          force: values.force,
          signal: controller.signal,
          emit: log,
        });
        console.error(`${elapsed(start).padStart(6)}  done`);
        if (values.json) {
          console.log(JSON.stringify(tour, null, 2));
          return;
        }
        const paths = new Map(tour.files.map((file) => [file.id, file.path]));
        console.log(`\n# ${tour.meta.title}\n\n${tour.overallSummary ?? ''}\n`);
        for (const group of tour.groups) {
          console.log(
            `## ${group.label}${group.critical ? '  [critical]' : ''}  (${group.category})\n${group.summary}`,
          );
          for (const fileId of group.fileIds) {
            console.log(`  - ${paths.get(fileId)}`);
          }
          const notes = tour.notes[group.key];
          for (const note of notes?.riskNotes ?? []) {
            console.log(
              `  ! ${paths.get(note.fileId)}: ${RISK_LABELS[note.risk as (typeof RISK_KEYS)[number]]}. ${note.text}`,
            );
          }
          for (const note of notes?.fileNotes ?? []) {
            console.log(`  > ${paths.get(note.fileId)}: ${note.text}`);
          }
          for (const note of notes?.lineNotes ?? []) {
            console.log(`  > ${paths.get(note.fileId)}:${note.line}: ${note.text}`);
          }
          console.log('');
        }
      } finally {
        backend.cache.close();
        // Flue's runtime keeps handles open; a one-shot command exits explicitly.
        setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref();
      }
      return;
    }

    case 'serve':
    case undefined:
    default: {
      const serveOnly = command === 'serve';
      const ref = serveOnly ? undefined : await resolveTarget(command, process.cwd());
      const corsOrigins = [
        'http://127.0.0.1:4778',
        'http://localhost:4778',
        ...(process.env.GLOSS_CORS_ORIGINS?.split(',') ?? []),
      ];
      let url = `http://${host}:${port}`;
      const running = await createHttpGlossClient({ baseUrl: url, token })
        .health()
        .then(() => true)
        .catch(() => false);
      if (!running) {
        const backend = await createBackend();
        const server = await startServer(backend, { port, host, token, corsOrigins });
        url = server.url;
        console.error(`gloss server on ${url}${backend.judge ? '' : ' (judge off: set TYPESAFE_API_KEY for Jev)'}`);
        process.once('SIGINT', () => void server.close().then(() => process.exit(0)));
      } else if (serveOnly) {
        console.error(`gloss is already running on ${url}`);
        return;
      }
      if (ref) {
        // Start the tour before the page loads; the page attaches to the same job.
        await createHttpGlossClient({ baseUrl: url, token }).startTour(ref, { force: values.force });
        const page = `${url}${webPath(ref)}`;
        console.error(`Touring ${describeRef(ref)}: ${page}`);
        if (!values['no-open']) {
          openBrowser(page);
        }
        if (running) {
          return;
        }
      }
      return;
    }
  }
}

main().catch((error: unknown) => {
  console.error(`gloss: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

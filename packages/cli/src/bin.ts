#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { RepoClones, TourCache } from '@gloss/core';
import { configPath, glossPath, login, logout, providerStatus, SUBSCRIPTIONS, type Subscription } from '@gloss/models';
import type { TourEventBody } from '@gloss/protocol';
import {
  createHttpGlossClient,
  describeRef,
  initialTourState,
  reduceTourEvent,
  renderTourMarkdown,
  tourFromState,
  tourProgress,
} from '@gloss/protocol';
import { Effect, ManagedRuntime } from 'effect';
import { installAgentSkill, uninstallAgentSkill } from './agent.ts';
import { BackendInfo, BackendLayer, VERSION } from './backend.ts';
import { startDetached, stopServer } from './daemon.ts';
import { exportBackend, exportName, exportTour } from './export.ts';
import { EXTENSION_DIR, installExtension, uninstallExtension } from './extension.ts';
import { DEFAULT_PORT, startServer } from './serve.ts';
import { resolveTarget, webPath } from './target.ts';
import { syncCheckout } from './update.ts';

const HELP = `gloss ${VERSION} — streaming review tours for pull requests and local diffs

Usage
  gloss [target]              Update gloss, then open a tour in the browser (starts the local server)
  gloss serve                 Run the local server only
  gloss update                Pull, install, build, and restart the server in the background
  gloss restart               Restart the server in the background on this checkout's code
  gloss tour <target>         Print a tour as compact markdown, for you or an agent (--json for the full tour)
  gloss export <target>       Run a tour and save it as one self-contained HTML file
  gloss login claude|chatgpt  Sign in with a Claude or ChatGPT subscription
  gloss logout claude|chatgpt
  gloss status                Show providers, models and judge
  gloss extension install     Let the browser extension start the server (uninstall to undo)
  gloss agent install         Teach Claude Code to read tours with gloss tour (uninstall to undo)
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
  --no-update     Skip the pull, install and build that gloss [target] runs first
  --brief         (tour) Decisions, groups and files only; no notes or walks
  --code          (tour) Print each snippet's lines instead of its path:from-to
  --wait <s>      (tour) Give up after s seconds (exit 2); running it again joins the same job
  --json          (tour) Print the finished tour as JSON
  -o, --out <f>   (export) Where to write the HTML (default gloss-<target>.html)
  --backend <url> (export) Use a running gloss server instead of an in-process one

Config: ${configPath()}   Keys: environment or ${glossPath('.env')}`;

function openBrowser(url: string) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  execFile(command, [url], () => {});
}

const log = (line: string) => console.error(`gloss: ${line}`);

/** Stops the server on `port` and starts it again in the background on this checkout's code. */
async function restart(port: number, host?: string, token?: string) {
  const stopped = await stopServer(port, token);
  if (stopped.length > 0) console.error(`Stopped ${stopped.join(', ')}`);
  const result = await startDetached(port, { host, token });
  if ('error' in result) throw new Error(result.error);
  console.log(`gloss server on ${result.url} (logs: ${glossPath('serve.log')})`);
}

/**
 * What `gloss [target]` does first: pull, install and build, then make sure the server runs
 * the new code. A running server on an older commit is restarted; with none running, this
 * process (still on the old code) re-runs itself and returns its exit code.
 */
async function updateFirst(port: number, url: string, host?: string, token?: string): Promise<number | undefined> {
  let synced: { before?: string; after?: string };
  try {
    synced = await syncCheckout(log);
  } catch (error) {
    const reason = (error instanceof Error ? error.message : String(error)).trim().split('\n').slice(-1)[0];
    log(`could not update (${reason}); continuing on the code as it is`);
    return undefined;
  }
  if (!synced.after) {
    return undefined;
  }
  const health = await createHttpGlossClient({ baseUrl: url, token })
    .health()
    .catch(() => undefined);
  if (health && health.commit !== synced.after) {
    log('restarting the server on the new code');
    await restart(port, host, token);
    return undefined;
  }
  if (!health && synced.before !== synced.after) {
    const child = spawn(process.execPath, [...process.argv.slice(1), '--no-update'], { stdio: 'inherit' });
    // The child gets Ctrl-C too and shuts its server down; this one only waits for it.
    process.on('SIGINT', () => {});
    return new Promise((resolve) => child.on('exit', (code) => resolve(code ?? 0)));
  }
  return undefined;
}

/** One stderr line per milestone of a `gloss tour` run. */
function logTourEvent(event: TourEventBody, at: string) {
  switch (event.type) {
    case 'job.started':
      if (event.cached) console.error(`${at}  cached`);
      break;
    case 'diff.ready':
      console.error(`${at}  diff: ${event.files.length} files — ${event.meta.title}`);
      break;
    case 'groups.resolved':
      console.error(
        `${at}  placed: ${event.groups.map((group) => `${group.label} (${group.fileIds.length})`).join(', ')}`,
      );
      break;
    case 'group.notes':
      console.error(`${at}  notes: ${event.groupKey}${event.source === 'cache' ? ' (cached)' : ''}`);
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
      'no-update': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      brief: { type: 'boolean', default: false },
      code: { type: 'boolean', default: false },
      wait: { type: 'string' },
      out: { type: 'string', short: 'o' },
      backend: { type: 'string' },
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
      const runtime = ManagedRuntime.make(BackendLayer);
      const health = await runtime.runPromise(BackendInfo.use((info) => Effect.promise(() => info.health())));
      console.log(
        `Models: define ${health.models.define}, followup ${health.models.followup}, notes ${health.models.notes}`,
      );
      console.log(`Judge: ${health.judge.available ? health.judge.model : 'off (set TYPESAFE_API_KEY to enable Jev)'}`);
      for (const provider of await providerStatus()) {
        console.log(
          `  ${provider.id}: ${provider.configured ? `configured (${provider.source ?? 'ok'})` : 'not configured'}`,
        );
      }
      await runtime.dispose();
      return;
    }

    case 'restart': {
      await restart(port, values.host, token);
      return;
    }

    case 'update': {
      const { before, after } = await syncCheckout(log);
      if (before && before === after) log('already up to date');
      await restart(port, values.host, token);
      return;
    }

    case 'agent': {
      if (rest[0] === 'uninstall') {
        uninstallAgentSkill();
        console.log('Removed the gloss skill.');
        return;
      }
      if (rest[0] !== 'install') {
        throw new Error('Usage: gloss agent install|uninstall');
      }
      console.log(`Wrote the gloss skill for Claude Code to ${installAgentSkill()}`);
      return;
    }

    case 'extension': {
      if (rest[0] === 'uninstall') {
        uninstallExtension();
        console.log('Removed the gloss native host.');
        return;
      }
      if (rest[0] !== 'install') {
        throw new Error('Usage: gloss extension install|uninstall');
      }
      const { browsers } = installExtension();
      console.log(`Registered the gloss native host for:\n${browsers.map((browser) => `  ${browser}`).join('\n')}`);
      console.log(`\nLoad the extension once: chrome://extensions, Developer mode, Load unpacked:\n  ${EXTENSION_DIR}`);
      return;
    }

    case 'cache': {
      if (rest[0] !== 'prune') {
        throw new Error('Usage: gloss cache prune [--days N]');
      }
      const runtime = ManagedRuntime.make(BackendLayer);
      const days = Number(values.days ?? 30);
      const removed = await runtime.runPromise(
        TourCache.use((cache) => Effect.sync(() => cache.prune(days * 86_400_000))),
      );
      const pruned = await runtime.runPromise(RepoClones.use((clones) => clones.prune()));
      console.log(
        `Removed ${removed} cache entries, and ${pruned.heads} PR heads (${pruned.clones} clones) unused for 2 days.`,
      );
      await runtime.dispose();
      return;
    }

    case 'tour': {
      const ref = await resolveTarget(rest[0], process.cwd());
      // A running server shares its jobs with any open tab and keeps a past-placement job going if this exits.
      const url = `http://${host}:${port}`;
      const running = await createHttpGlossClient({ baseUrl: url, token })
        .health()
        .then(() => true)
        .catch(() => false);
      const backend = await exportBackend(running ? url : undefined, token);
      const start = performance.now();
      const controller = new AbortController();
      process.once('SIGINT', () => controller.abort());
      const waitSeconds = Number(values.wait ?? 0);
      if (waitSeconds > 0) {
        setTimeout(() => controller.abort(), waitSeconds * 1000).unref();
      }
      let state = initialTourState();
      try {
        const health = await backend.client.health();
        console.error(
          `Touring ${describeRef(ref)}${running ? ` on ${url}` : ''}${health.judge?.available === false ? ' (no judge: LLM places files)' : ''}`,
        );
        const { jobId } = await backend.client.startTour(ref, { force: values.force });
        try {
          for await (const event of backend.client.events(jobId, { signal: controller.signal })) {
            state = reduceTourEvent(state, event);
            logTourEvent(event, elapsed(start).padStart(6));
          }
        } catch (error) {
          if (!controller.signal.aborted) throw error;
        }
        const tour = tourFromState(state);
        if (state.status !== 'complete' || !tour) {
          console.error(controller.signal.aborted ? tourProgress(state) : 'The tour ended without finishing.');
          process.exitCode = 2;
          return;
        }
        console.error(`${elapsed(start).padStart(6)}  done`);
        if (values.json) {
          console.log(JSON.stringify(tour, null, 2));
          return;
        }
        const files = values.code ? (await backend.client.diff(tour.diffId)).files : undefined;
        process.stdout.write(renderTourMarkdown(tour, { detail: values.brief ? 'brief' : 'full', files }));
      } finally {
        await backend.close();
        // Flue's runtime keeps handles open; a one-shot command exits explicitly.
        setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref();
      }
      return;
    }

    case 'export': {
      const ref = await resolveTarget(rest[0], process.cwd());
      const out = resolve(values.out ?? `gloss-${exportName(ref)}.html`);
      const backend = await exportBackend(values.backend, token);
      const start = performance.now();
      console.error(`Exporting ${describeRef(ref)}`);
      try {
        const html = await exportTour(backend.client, ref, {
          force: values.force,
          onEvent: (event) => {
            if (event.type === 'job.started' && event.cached) console.error(`${elapsed(start).padStart(6)}  cached`);
            if (event.type === 'stage.status' && event.state !== 'running')
              console.error(`${elapsed(start).padStart(6)}  ${event.stage} ${event.state}`);
          },
        });
        writeFileSync(out, html);
        console.error(`${elapsed(start).padStart(6)}  wrote ${out} (${(html.length / 1e6).toFixed(1)} MB)`);
      } finally {
        await backend.close();
        setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref();
      }
      return;
    }

    case 'serve':
    case undefined:
    default: {
      const serveOnly = command === 'serve';
      if (!serveOnly && !values['no-update']) {
        const exitCode = await updateFirst(port, `http://${host}:${port}`, values.host, token);
        if (exitCode !== undefined) {
          process.exitCode = exitCode;
          return;
        }
      }
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
        const server = await startServer({ port, host, token, corsOrigins });
        url = server.url;
        console.error(`gloss server on ${url}${server.judge ? '' : ' (judge off: set TYPESAFE_API_KEY for Jev)'}`);
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

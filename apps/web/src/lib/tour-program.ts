import type { SourceRef, Stack } from '@gloss/protocol';
import { type GlossClient, GlossHttpError, serializeRef } from '@gloss/protocol';
import { type AnyRouter, defaultParseSearch } from '@tanstack/react-router';
import { Deferred, Effect, Queue, Stream } from 'effect';
import * as v from 'valibot';
import { type AskTurnView, savedTurns } from './ask-model.ts';
import { Gloss, glossRuntime, isExport, request } from './client.ts';
import type { SavedReview } from './review-draft.ts';
import { stackRefs } from './sidebar-tree.ts';
import { navigateToPipeline, navigateToRef } from './source-routes.tsx';
import { makeProgram } from './tea.ts';
import {
  type Cmd,
  type ConnectionError,
  EDITABLE,
  init,
  type Msg,
  type Position,
  type RailAnchor,
  SHORTCUT_KEYS,
  type Spied,
  update,
} from './tour-model.ts';
import { OVERVIEW, STICKY_OFFSET } from './tour-view.ts';

/** The line a file or note must cross to count as "current": just below the sticky bars. */
const READING_LINE = STICKY_OFFSET + 16;

/** Input that means the reader is moving on their own, so a restored position stops being held. */
const RELEASE_EVENTS = ['wheel', 'touchstart', 'keydown', 'mousedown'] as const;

/** How long a restored file is held in place while the page above it lays out. */
const PIN_MS = 3000;

/** Tells a stale page apart from an unreachable backend: they need different fixes. */
export function describeError(error: unknown): ConnectionError {
  const message = error instanceof Error ? error.message : String(error);
  if (v.isValiError(error)) {
    return {
      title: 'This page is out of date with the gloss backend',
      message: `The backend sent an event this build of the web app does not understand. Rebuild it with \`pnpm --filter @gloss/web build\` and reload. (${message})`,
    };
  }
  if (error instanceof GlossHttpError) {
    return { title: `The gloss backend returned an error (${error.status})`, message };
  }
  return { title: 'Could not reach the gloss backend', message };
}

/**
 * Each stack loaded in this tab, by each of its PRs, so a page opened from another PR in the
 * same stack (Shift+J/K, a rail click) shows the stack at once instead of the rail moving
 * when the fetch lands.
 */
const knownStacks = new Map<string, Stack>();

/** The tour page's program for one ref. The page creates one per mount, so two tours never share state. */
export function tourProgram(ref: SourceRef, router: AnyRouter) {
  return makeProgram(glossRuntime, {
    init: init(ref, readPosition(router.state.location.search), knownStacks.get(serializeRef(ref)), isExport()),
    update,
    run: (cmd) => run(cmd, router),
    key: (cmd) =>
      cmd.type === 'StartTour'
        ? 'session'
        : cmd.type === 'FetchDiff'
          ? 'diff'
          : cmd.type === 'RestoreFile' || cmd.type === 'RestoreGroup'
            ? 'pin'
            : cmd.type === 'SetTitle'
              ? 'title'
              : cmd.type === 'StartAsk' || cmd.type === 'StopAsk'
                ? 'ask'
                : undefined,
    subscriptions: () => Stream.mergeAll([keys, scrollSpy, history(router)], { concurrency: 'unbounded' }),
  });
}

// The router JSON-parses search values, so a commit-like key arrives as a number.
function readPosition(search: Record<string, unknown>): Position {
  const text = (value: unknown) => (typeof value === 'string' || typeof value === 'number' ? String(value) : undefined);
  return { g: text(search.g), f: text(search.f) };
}

function run(cmd: Cmd, router: AnyRouter): Stream.Stream<Msg, never, Gloss> {
  switch (cmd.type) {
    case 'StartTour':
      return session(cmd.ref, cmd.force);
    case 'AbortTour':
      return once(request((client) => client.abort(cmd.jobId)));
    case 'FetchDiff':
      // Hunk bodies come separately from the event stream, as soon as the diff exists.
      return once(
        request((client) => client.diff(cmd.diffId)).pipe(Effect.map((diff): Msg => ({ type: 'DiffLoaded', diff }))),
      );
    case 'PrefetchLfs':
      // The responses are immutable, so the browser keeps them for when the images render.
      return once(
        Effect.forEach(cmd.oids, (oid) => request((client) => client.lfsObject(cmd.diffId, oid)).pipe(Effect.ignore), {
          concurrency: 4,
          discard: true,
        }),
      );
    case 'StartAsk':
      return answer(cmd.turnId, cmd.request);
    case 'StopAsk':
      // Keyed with `StartAsk`: running it interrupts the answer, which aborts its request.
      return Stream.empty;
    case 'FocusAsk':
      return once(nextFrame.pipe(Effect.map(() => document.querySelector<HTMLElement>(ASK_INPUT)?.focus())));
    case 'LoadAsk':
      return once(
        Effect.sync((): Msg => {
          const stored = storage(() => localStorage.getItem(askKey(cmd.diffId)));
          const turns = (stored ? storage(() => JSON.parse(stored) as AskTurnView[]) : undefined) ?? [];
          const model = storage(() => localStorage.getItem(ASK_MODEL_KEY)) ?? undefined;
          return { type: 'AskLoaded', diffId: cmd.diffId, turns: savedTurns(turns), model };
        }),
      );
    case 'SaveAsk':
      return once(
        Effect.sync(() =>
          storage(() =>
            cmd.turns.length
              ? localStorage.setItem(askKey(cmd.diffId), JSON.stringify(cmd.turns))
              : localStorage.removeItem(askKey(cmd.diffId)),
          ),
        ),
      );
    case 'SaveAskModel':
      return once(Effect.sync(() => storage(() => localStorage.setItem(ASK_MODEL_KEY, cmd.model))));
    case 'LoadViewed':
      return once(
        Effect.sync((): Msg => {
          const stored = storage(() => localStorage.getItem(viewedKey(cmd.diffId)));
          const fileIds = storage(() => JSON.parse(stored ?? '[]') as string[]) ?? [];
          return { type: 'ViewedLoaded', diffId: cmd.diffId, fileIds };
        }),
      );
    case 'LoadReview':
      return once(
        Effect.sync((): Msg | void => {
          const stored = storage(() => localStorage.getItem(reviewKey(cmd.diffId)));
          const saved = stored ? storage(() => JSON.parse(stored) as SavedReview) : undefined;
          return saved ? { type: 'ReviewLoaded', diffId: cmd.diffId, saved } : undefined;
        }),
      );
    case 'SaveReview':
      return once(
        Effect.sync(() =>
          storage(() =>
            cmd.saved.body || cmd.saved.comments.length
              ? localStorage.setItem(reviewKey(cmd.diffId), JSON.stringify(cmd.saved))
              : localStorage.removeItem(reviewKey(cmd.diffId)),
          ),
        ),
      );
    case 'SubmitReview':
      return Stream.fromEffect(
        request((client) => client.review(cmd.request)).pipe(
          Effect.match({
            onSuccess: ({ url }): Msg => ({
              type: 'ReviewSent',
              diffId: cmd.diffId,
              verdict: cmd.request.verdict,
              url,
            }),
            onFailure: ({ cause }): Msg => ({ type: 'ReviewFailed', diffId: cmd.diffId, error: reviewError(cause) }),
          }),
        ),
      );
    case 'SaveViewed':
      // Storage unavailable (private window): viewed state lasts for this page only.
      return once(
        Effect.sync(() => storage(() => localStorage.setItem(viewedKey(cmd.diffId), JSON.stringify(cmd.fileIds)))),
      );
    case 'Navigate':
      // The page scrolls itself: the router's default scroll reset would undo every jump.
      return once(
        Effect.sync(() => {
          void router.navigate({
            to: '.',
            search: (prev: Record<string, unknown>) => ({ ...prev, ...cmd.position }),
            replace: cmd.replace,
            resetScroll: false,
          } as never);
        }),
      );
    // `instant` overrides any `scroll-behavior: smooth` in the page's styles.
    case 'ScrollToTop':
      return once(Effect.sync(() => window.scrollTo({ top: 0, behavior: 'instant' })));
    case 'ScrollToGroup':
      return once(nextFrame.pipe(Effect.map(() => scrollToSection(groupSection(cmd.key)))));
    case 'ScrollToFile':
      return once(
        nextFrame.pipe(
          Effect.map(() => scrollToSection(fileSection(cmd.fileId))),
          Effect.andThen(cmd.line === undefined ? Effect.void : scrollToLine(cmd.fileId, cmd.line)),
        ),
      );
    case 'RestoreGroup':
      return once(restore(() => groupSection(cmd.key)));
    case 'RestoreFile':
      return once(restore(() => fileSection(cmd.fileId)));
    case 'MeasurePosition':
      return once(nextFrame.pipe(Effect.map((): Msg => ({ type: 'Scrolled', spied: spy() }))));
    case 'StepNote':
      return once(Effect.sync(() => stepNote(cmd.by)));
    case 'SaveRailAnchor':
      return once(
        Effect.sync(() => storage(() => sessionStorage.setItem(RAIL_ANCHOR_KEY, JSON.stringify(cmd.anchor)))),
      );
    case 'RestoreRailScroll': {
      // Read and cleared at once, so only the page that click opened uses it.
      const saved = storage(() => {
        const json = sessionStorage.getItem(RAIL_ANCHOR_KEY);
        sessionStorage.removeItem(RAIL_ANCHOR_KEY);
        return json ? (JSON.parse(json) as RailAnchor) : undefined;
      });
      const anchor = saved?.key === serializeRef(cmd.ref) ? saved : undefined;
      return once(nextFrame.pipe(Effect.map(() => placeRailRow(anchor))));
    }
    case 'RevealRailRow':
      return once(nextFrame.pipe(Effect.map(() => placeRailRow(undefined))));
    case 'FetchStack':
      // No stack (the lookup failed) just means no stack row and no Shift+J/K.
      return once(
        request((client) => client.stack(cmd.ref)).pipe(
          Effect.map((stack): Msg => {
            for (const ref of stackRefs(stack)) {
              knownStacks.set(serializeRef(ref), stack);
            }
            return { type: 'StackLoaded', stack };
          }),
        ),
      );
    case 'OpenRef':
      return once(Effect.sync(() => void navigateToRef(router, cmd.ref)));
    case 'OpenPipeline':
      return once(Effect.sync(() => void navigateToPipeline(router, cmd.ref, { job: cmd.jobId })));
    case 'SetTitle':
      // Held until the next title replaces it, or the page goes away.
      return once(
        Effect.sync(() => {
          document.title = cmd.title;
        }).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(
            Effect.sync(() => {
              document.title = 'gloss';
            }),
          ),
        ),
      );
  }
}

/** Starts (or attaches to) the tour and follows its events until the job ends. */
function session(ref: SourceRef, force: boolean): Stream.Stream<Msg, never, Gloss> {
  return Stream.unwrap(
    Effect.gen(function* () {
      const client = yield* Gloss;
      const started = yield* Effect.tryPromise({
        try: () => client.startTour(ref, { force }),
        catch: (error) => error,
      });
      const controller = yield* Effect.acquireRelease(
        Effect.sync(() => new AbortController()),
        (controller) => Effect.sync(() => controller.abort()),
      );
      const events = Stream.fromAsyncIterable(
        client.events(started.jobId, { signal: controller.signal }),
        (error) => error,
      );
      return Stream.concat(
        Stream.succeed<Msg>({ type: 'TourStarted', jobId: started.jobId }),
        Stream.concat(
          events.pipe(Stream.map((event): Msg => ({ type: 'EventReceived', event }))),
          Stream.succeed<Msg>({ type: 'StreamClosed' }),
        ),
      );
    }),
  ).pipe(Stream.catch((error) => Stream.succeed<Msg>({ type: 'StreamFailed', error: describeError(error) })));
}

/** Streams one answer into its turn; interrupting the stream aborts the request, which stops the model. */
function answer(turnId: string, body: Parameters<GlossClient['ask']>[0]): Stream.Stream<Msg, never, Gloss> {
  return Stream.unwrap(
    Effect.gen(function* () {
      const client = yield* Gloss;
      const controller = yield* Effect.acquireRelease(
        Effect.sync(() => new AbortController()),
        (controller) => Effect.sync(() => controller.abort()),
      );
      return Stream.fromAsyncIterable(client.ask(body, { signal: controller.signal }), (error) => error).pipe(
        Stream.map((event): Msg => ({ type: 'AskEventReceived', turnId, event })),
      );
    }),
  ).pipe(
    Stream.catch((error) =>
      Stream.succeed<Msg>({ type: 'AskStreamFailed', turnId, error: describeError(error).message }),
    ),
  );
}

/** The Ask panel's text box (`AskPanel.tsx`). */
const ASK_INPUT = '.ask-panel textarea, .ask-panel [contenteditable="true"]';

const askKey = (diffId: string) => `gloss.ask.${diffId}`;
const ASK_MODEL_KEY = 'gloss.ask.model';

/** A one-shot command: its message if it has one. A failure sends nothing. */
function once<E, R>(effect: Effect.Effect<Msg | void, E, R>): Stream.Stream<Msg, never, R> {
  return Stream.unwrap(
    effect.pipe(
      Effect.map((msg) => (msg ? Stream.succeed(msg) : Stream.empty)),
      Effect.orElseSucceed(() => Stream.empty),
    ),
  );
}

const viewedKey = (diffId: string) => `gloss.viewed.${diffId}`;
const reviewKey = (diffId: string) => `gloss.review.${diffId}`;

/** The backend answers a refused review with `{ error }`; show GitHub's reason, not the envelope. */
function reviewError(cause: unknown): string {
  if (cause instanceof GlossHttpError) {
    const parsed = storage(() => JSON.parse(cause.message) as { error?: unknown });
    return typeof parsed?.error === 'string' ? parsed.error : cause.message;
  }
  return describeError(cause).title;
}

function storage<A>(f: () => A): A | undefined {
  try {
    return f();
  } catch {
    return undefined;
  }
}

const RAIL_ANCHOR_KEY = 'gloss:rail-anchor';

/** Resolves after the next frame, when a message's render has reached the DOM. */
const nextFrame = Effect.callback<void>((resume) => {
  const frame = requestAnimationFrame(() => resume(Effect.void));
  return Effect.sync(() => cancelAnimationFrame(frame));
});

const main = () => document.querySelector<HTMLElement>('main.main');
const fileSection = (fileId: string) => document.getElementById(`file-${fileId}`);
const groupSection = (key: string) => document.getElementById(`group-${key}`);

function scrollToSection(section: HTMLElement | null) {
  section?.scrollIntoView({ block: 'start', behavior: 'instant' });
}

/**
 * A new-side line's row in a file's diff. pierre renders into an open shadow root; in a unified
 * diff a removed row carries its old line number, so it never counts.
 */
function lineRow(fileId: string, line: number): HTMLElement | undefined {
  const hosts = fileSection(fileId)?.querySelectorAll('*') ?? [];
  for (const host of hosts) {
    const row = host.shadowRoot?.querySelector<HTMLElement>(
      `[data-line="${line}"]:not([data-line-type="change-deletion"])`,
    );
    if (row) {
      return row;
    }
  }
  return undefined;
}

/**
 * Centres a line of a file's diff and flashes it, once its hunk has rendered (a file just opened
 * renders over a few frames). A line the diff doesn't show leaves the file's header in place.
 */
const scrollToLine = (fileId: string, line: number) =>
  Effect.gen(function* () {
    for (let frame = 0; frame < LINE_FRAMES; frame++) {
      const row = lineRow(fileId, line);
      if (row) {
        row.scrollIntoView({ block: 'center', behavior: 'instant' });
        // From pierre's selection colour back to the row's own.
        row.animate([{ backgroundColor: 'color-mix(in srgb, var(--diffs-selection-base) 40%, transparent)' }], {
          duration: 1600,
          easing: 'ease-out',
        });
        return;
      }
      yield* nextFrame;
    }
  });

/** About a second at 60fps: long enough for a highlighted hunk, short enough not to yank the page later. */
const LINE_FRAMES = 60;

/** The group and file whose tops last crossed the reading line, and what is on screen at the bottom. */
function spy(): Spied {
  const page = main();
  const groups = [...(page?.querySelectorAll<HTMLElement>('[data-group-key]') ?? [])];
  const files = [...(page?.querySelectorAll<HTMLElement>('[data-file-id]') ?? [])];
  const crossed = (sections: HTMLElement[]) =>
    sections.findLast((el) => el.getBoundingClientRect().top <= READING_LINE);
  const atBottom =
    window.scrollY > 0 && window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
  const onScreen = (sections: HTMLElement[]) =>
    sections.filter((el) => {
      const rect = el.getBoundingClientRect();
      return rect.bottom > READING_LINE && rect.top < window.innerHeight;
    });
  const groupKey = crossed(groups)?.dataset.groupKey;
  return {
    groupKey: groupKey === OVERVIEW ? undefined : groupKey,
    fileId: crossed(files)?.dataset.fileId,
    visible: atBottom
      ? {
          groupKeys: onScreen(groups).map((el) => el.dataset.groupKey!),
          fileIds: onScreen(files).map((el) => el.dataset.fileId!),
        }
      : undefined,
  };
}

function stepNote(by: number) {
  const notes = [...(main()?.querySelectorAll<HTMLElement>('.note') ?? [])];
  const tops = notes.map((note) => note.getBoundingClientRect().top);
  const target = by > 0 ? tops.find((top) => top > READING_LINE + 1) : tops.findLast((top) => top < READING_LINE - 1);
  if (target !== undefined) {
    window.scrollBy({ top: target - READING_LINE });
  }
}

/**
 * Scrolls to a restored group or file, then keeps it pinned while hunks above it still lay out
 * (pierre highlights asynchronously), until the reader takes over or the layout settles.
 */
const restore = (find: () => HTMLElement | null) =>
  Effect.gen(function* () {
    yield* nextFrame;
    const section = find();
    const page = main();
    if (!section || !page) {
      return;
    }
    scrollToSection(section);
    const released = yield* Deferred.make<void>();
    const release = () => Deferred.doneUnsafe(released, Effect.void);
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const pin = new ResizeObserver(() => scrollToSection(section));
        pin.observe(page);
        for (const type of RELEASE_EVENTS) {
          window.addEventListener(type, release, { passive: true });
        }
        return pin;
      }),
      (pin) =>
        Effect.sync(() => {
          pin.disconnect();
          for (const type of RELEASE_EVENTS) {
            window.removeEventListener(type, release);
          }
        }),
    );
    yield* Deferred.await(released).pipe(Effect.timeoutOption(PIN_MS));
  }).pipe(Effect.scoped);

/**
 * Scrolls the side rail to the toured PR's row: where a rail click's row was (`anchor`), then
 * just far enough that the row shows below the rail's tools. The row is sticky, so it is
 * measured with the rail at the top, where it is not pinned.
 */
function placeRailRow(anchor: RailAnchor | undefined): void {
  const rail = document.querySelector<HTMLElement>('nav.sidebar');
  const row = rail?.querySelector<HTMLElement>('[data-node="pr"]');
  if (!rail || !row) {
    return;
  }
  const was = rail.scrollTop;
  rail.scrollTop = 0;
  const top = row.getBoundingClientRect().top - rail.getBoundingClientRect().top;
  // The toured PR's groups now sit under it and the last one's are gone, so the rows above it
  // moved: put the opened PR's row where the clicked row was.
  const at = anchor ? top - anchor.offset : was;
  const tools = rail.querySelector<HTMLElement>('.side-tools')?.offsetHeight ?? 0;
  const lowest = top - tools;
  const highest = top + row.offsetHeight - rail.clientHeight;
  rail.scrollTop = Math.min(Math.max(at, highest), lowest);
}

function listen<K extends keyof WindowEventMap>(
  type: K,
  handler: (event: WindowEventMap[K]) => void,
  options?: AddEventListenerOptions,
) {
  return Effect.acquireRelease(
    Effect.sync(() => window.addEventListener(type, handler, options)),
    () => Effect.sync(() => window.removeEventListener(type, handler)),
  );
}

const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock']);

/** Keyboard shortcuts (listed in ShortcutHelp). */
const keys = Stream.callback<Msg>((queue) =>
  listen('keydown', (event) => {
    if (
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      MODIFIERS.has(event.key) ||
      (event.target instanceof Element && event.target.closest(EDITABLE))
    ) {
      return;
    }
    // Every other key goes in, so one that is not a shortcut still ends a pending chord.
    if (SHORTCUT_KEYS.has(event.key)) {
      event.preventDefault();
    }
    Queue.offerUnsafe(queue, { type: 'KeyPressed', key: event.key });
  }),
);

/** Scroll-spy: where the reader is on the page, at most once a frame. */
const scrollSpy = Stream.callback<Msg>((queue) => {
  let frame = 0;
  return Effect.gen(function* () {
    yield* listen(
      'scroll',
      () => {
        frame ||= requestAnimationFrame(() => {
          frame = 0;
          Queue.offerUnsafe(queue, { type: 'Scrolled', spied: spy() });
        });
      },
      { passive: true },
    );
    yield* Effect.addFinalizer(() => Effect.sync(() => cancelAnimationFrame(frame)));
  });
});

/** Back/forward. The page's own navigations are already in the model. */
const history = (router: AnyRouter) =>
  Stream.callback<Msg>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() =>
        router.history.subscribe(({ location, action }: { location: { search: string }; action: { type: string } }) => {
          if (action.type !== 'PUSH' && action.type !== 'REPLACE') {
            Queue.offerUnsafe(queue, {
              type: 'UrlChanged',
              position: readPosition(defaultParseSearch(location.search)),
            });
          }
        }),
      ),
      (unsubscribe) => Effect.sync(unsubscribe),
    ),
  );

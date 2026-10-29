import type { SourceRef } from '@gloss/protocol';
import { GlossHttpError } from '@gloss/protocol';
import { type AnyRouter, defaultParseSearch } from '@tanstack/react-router';
import { Deferred, Effect, Queue, Stream } from 'effect';
import * as v from 'valibot';
import { Gloss, glossRuntime, request } from './client.ts';
import type { SavedReview } from './review-draft.ts';
import { makeProgram } from './tea.ts';
import {
  type Cmd,
  type ConnectionError,
  EDITABLE,
  init,
  type Msg,
  type Position,
  SHORTCUT_KEYS,
  update,
} from './tour-model.ts';
import { STICKY_OFFSET } from './tour-view.ts';

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

/** The tour page's program for one ref. The page creates one per mount, so two tours never share state. */
export function tourProgram(ref: SourceRef, router: AnyRouter) {
  return makeProgram(glossRuntime, {
    init: init(ref, readPosition(router.state.location.search)),
    update,
    run: (cmd) => run(cmd, router),
    key: (cmd) =>
      cmd.type === 'StartTour'
        ? 'session'
        : cmd.type === 'FetchDiff'
          ? 'diff'
          : cmd.type === 'RestoreFile'
            ? 'pin'
            : cmd.type === 'SetTitle'
              ? 'title'
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
            onSuccess: ({ url }): Msg => ({ type: 'ReviewSent', verdict: cmd.request.verdict, url }),
            onFailure: ({ cause }): Msg => ({ type: 'ReviewFailed', error: reviewError(cause) }),
          }),
        ),
      );
    case 'SaveViewed':
      // Storage unavailable (private window): viewed state lasts for this page only.
      return once(
        Effect.sync(() => storage(() => localStorage.setItem(viewedKey(cmd.diffId), JSON.stringify(cmd.fileIds)))),
      );
    case 'Navigate':
      // The page scrolls itself (top for a group, the file's header for a file): the router's
      // default scroll reset would undo a file update mid-scroll.
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
    case 'ScrollToTop':
      return once(Effect.sync(() => window.scrollTo({ top: 0 })));
    case 'ScrollToFile':
      return once(nextFrame.pipe(Effect.map(() => fileSection(cmd.fileId)?.scrollIntoView({ block: 'start' }))));
    case 'RestoreFile':
      return once(restore(cmd.fileId));
    case 'MeasureActiveFile':
      return once(nextFrame.pipe(Effect.map((): Msg => ({ type: 'ActiveFileChanged', fileId: fileInView() }))));
    case 'StepNote':
      return once(Effect.sync(() => stepNote(cmd.by)));
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

/** Resolves after the next frame, when a message's render has reached the DOM. */
const nextFrame = Effect.callback<void>((resume) => {
  const frame = requestAnimationFrame(() => resume(Effect.void));
  return Effect.sync(() => cancelAnimationFrame(frame));
});

const main = () => document.querySelector<HTMLElement>('main.main');
const fileSection = (fileId: string) => document.getElementById(`file-${fileId}`);

/** The current file: the last one whose top has crossed the reading line. */
function fileInView(): string | undefined {
  const sections = main()?.querySelectorAll<HTMLElement>('[data-file-id]') ?? [];
  // At the bottom of the page the last files can never reach the line, so the line drops
  // to the viewport's bottom edge: jumping to the last file then keeps it current.
  const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
  const line = atBottom && window.scrollY > 0 ? window.innerHeight - 1 : READING_LINE;
  let active: string | undefined;
  for (const section of sections) {
    if (section.getBoundingClientRect().top <= line) {
      active = section.dataset.fileId;
    }
  }
  return active ?? sections[0]?.dataset.fileId;
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
 * Scrolls to a restored file, then keeps it pinned while hunks above it still lay out
 * (pierre highlights asynchronously), until the reader takes over or the layout settles.
 */
const restore = (fileId: string) =>
  Effect.gen(function* () {
    yield* nextFrame;
    const section = fileSection(fileId);
    const page = main();
    if (!section || !page) {
      return;
    }
    section.scrollIntoView({ block: 'start' });
    const released = yield* Deferred.make<void>();
    const release = () => Deferred.doneUnsafe(released, Effect.void);
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const pin = new ResizeObserver(() => section.scrollIntoView({ block: 'start' }));
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

/** Scroll-spy: the file at the reading line, at most once a frame. */
const scrollSpy = Stream.callback<Msg>((queue) => {
  let frame = 0;
  return Effect.gen(function* () {
    yield* listen(
      'scroll',
      () => {
        frame ||= requestAnimationFrame(() => {
          frame = 0;
          Queue.offerUnsafe(queue, { type: 'ActiveFileChanged', fileId: fileInView() });
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

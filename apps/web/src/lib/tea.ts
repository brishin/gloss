import { Effect, Fiber, FiberSet, Stream } from 'effect';
import { Atom } from 'effect/reactivity';

/**
 * An Elm program: all of a page's state in one `Model`, changed only by `update`, which
 * answers each `Msg` with the next model and the commands to run. Commands are the only
 * side effects; their results come back as messages.
 */
export interface Program<Model, Msg, Cmd, R> {
  readonly init: readonly [Model, readonly Cmd[]];
  readonly update: (model: Model, msg: Msg) => readonly [Model, readonly Cmd[]];
  /** Performs a command. `model` reads the current model, for commands that decide late. */
  readonly run: (cmd: Cmd, model: () => Model) => Stream.Stream<Msg, never, R>;
  /** A keyed command replaces the running one with the same key, once that one has stopped. */
  readonly key?: (cmd: Cmd) => string | undefined;
  /** Inputs that last while the program is mounted: keyboard, scrolling, history. */
  readonly subscriptions?: (model: () => Model) => Stream.Stream<Msg, never, R>;
}

export interface ProgramAtoms<Model, Msg> {
  readonly model: Atom.Atom<Model>;
  readonly dispatch: Atom.Writable<null, Msg>;
  /** Commands and subscriptions run while this is mounted (`useAtomMount`); unmounting interrupts them. */
  readonly runner: Atom.Atom<unknown>;
}

export function makeProgram<Model, Msg, Cmd, R>(
  runtime: Atom.AtomRuntime<R>,
  program: Program<Model, Msg, Cmd, R>,
): ProgramAtoms<Model, Msg> {
  const [initial, initialCmds] = program.init;
  const model = Atom.make(initial);
  // Commands from before the runner mounts (the first ones from `init`) wait here.
  const pending: Cmd[] = [...initialCmds];
  let perform: ((cmd: Cmd) => void) | undefined;

  const dispatch = Atom.writable<null, Msg>(
    () => null,
    (ctx, msg) => {
      const [next, cmds] = program.update(ctx.get(model), msg);
      ctx.set(model, next);
      for (const cmd of cmds) {
        if (perform) {
          perform(cmd);
        } else {
          pending.push(cmd);
        }
      }
    },
  );

  const runner = runtime.atom((get) =>
    Effect.gen(function* () {
      get.mount(model);
      const registry = get.registry;
      const fork = yield* FiberSet.makeRuntime<R>();
      const current = () => registry.get(model);
      const deliver = (stream: Stream.Stream<Msg, never, R>) =>
        Stream.runForEach(stream, (msg) => Effect.sync(() => registry.set(dispatch, msg)));
      const keyed = new Map<string, Fiber.Fiber<void>>();

      perform = (cmd) => {
        const key = program.key?.(cmd);
        const previous = key === undefined ? undefined : keyed.get(key);
        const work = deliver(program.run(cmd, current));
        const fiber = fork(previous ? Fiber.interrupt(previous).pipe(Effect.andThen(work)) : work);
        if (key !== undefined) {
          keyed.set(key, fiber);
          fiber.addObserver(() => {
            if (keyed.get(key) === fiber) {
              keyed.delete(key);
            }
          });
        }
      };
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          perform = undefined;
        }),
      );
      if (program.subscriptions) {
        fork(deliver(program.subscriptions(current)));
      }
      for (const cmd of pending.splice(0)) {
        perform(cmd);
      }
    }),
  );

  return { model, dispatch, runner };
}

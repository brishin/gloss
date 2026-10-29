import { Effect, Layer, Stream } from 'effect';
import { Atom, AtomRegistry } from 'effect/reactivity';
import { expect, test } from 'vitest';
import { makeProgram } from './tea.ts';

type Msg = { type: 'add'; by: number } | { type: 'hold'; id: string } | { type: 'held'; id: string };
type Cmd = { type: 'echo'; by: number } | { type: 'hold'; id: string };

/** A counter whose `echo` command replies with an `add`, and whose `hold` commands share one key. */
function counter(log: string[]) {
  return makeProgram(Atom.runtime(Layer.empty), {
    init: [0, [{ type: 'echo', by: 1 }]],
    update: (count: number, msg: Msg): readonly [number, Cmd[]] =>
      msg.type === 'add'
        ? [count + msg.by, []]
        : msg.type === 'hold'
          ? [count, [{ type: 'hold', id: msg.id }]]
          : [count, []],
    run: (cmd: Cmd) =>
      cmd.type === 'echo'
        ? Stream.succeed<Msg>({ type: 'add', by: cmd.by })
        : Stream.fromEffect(
            Effect.sync(() => log.push(`start ${cmd.id}`)).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(Effect.sync(() => log.push(`stop ${cmd.id}`))),
            ),
          ),
    key: (cmd: Cmd) => (cmd.type === 'hold' ? 'hold' : undefined),
  });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

test('init commands wait for the runner, and their replies go through update', async () => {
  const registry = AtomRegistry.make();
  const program = counter([]);
  registry.set(program.dispatch, { type: 'add', by: 10 });
  expect(registry.get(program.model)).toBe(10);
  const unmount = registry.mount(program.runner);
  await settle();
  expect(registry.get(program.model)).toBe(11);
  unmount();
});

test('a keyed command stops the running one before it starts; unmounting stops the rest', async () => {
  const registry = AtomRegistry.make();
  const log: string[] = [];
  const program = counter(log);
  const unmount = registry.mount(program.runner);
  registry.set(program.dispatch, { type: 'hold', id: 'a' });
  await settle();
  registry.set(program.dispatch, { type: 'hold', id: 'b' });
  await settle();
  expect(log).toEqual(['start a', 'stop a', 'start b']);
  unmount();
  await settle();
  expect(log.at(-1)).toBe('stop b');
});

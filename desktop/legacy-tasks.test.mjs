import assert from 'node:assert/strict';
import test from 'node:test';
import { legacyTasks, stopLegacyTasks } from './legacy-tasks.mjs';

function fakeTasks(initial, failedChanges = []) {
  const state = new Map(Object.entries(initial));
  const calls = [];
  const run = (args) => {
    calls.push(args);
    const name = args[2];
    if (args[0] === '/Query') {
      const current = state.get(name);
      return current === undefined
        ? { status: 1, stderr: 'ERROR: The system cannot find the file specified.' }
        : { status: 0, stdout: `<Task><Settings><Enabled>${current}</Enabled></Settings></Task>` };
    }
    if (args[0] === '/Change') {
      if (failedChanges.includes(name)) return { status: 1, stderr: 'Access denied' };
      state.set(name, false);
    }
    return { status: 0 };
  };
  return { state, calls, run };
}

test('migration ignores absent tasks and confirms installed tasks are disabled', () => {
  const tasks = fakeTasks({ [legacyTasks[0]]: true, [legacyTasks[3]]: true });
  assert.deepEqual(stopLegacyTasks(tasks.run), []);
  assert.equal(tasks.state.get(legacyTasks[0]), false);
  assert.equal(tasks.state.get(legacyTasks[3]), false);
  assert.ok(tasks.calls.some((args) => args[0] === '/End' && args[2] === legacyTasks[3]));
});

test('migration retains a blocker when an installed task cannot be disabled', () => {
  const tasks = fakeTasks({ [legacyTasks[0]]: true }, [legacyTasks[0]]);
  assert.deepEqual(stopLegacyTasks(tasks.run), [legacyTasks[0]]);
});

test('migration treats an unverified task as a blocker', () => {
  const tasks = fakeTasks({});
  const run = (args) => args[2] === legacyTasks[1]
    ? { status: 1, stderr: 'Access denied' } : tasks.run(args);
  assert.deepEqual(stopLegacyTasks(run), [legacyTasks[1]]);
});

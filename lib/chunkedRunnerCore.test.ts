import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createChunkedRunner,
  type RunnerEvents,
  type RunnerOptions,
  type RunnerProgress,
  type RunnerItemError,
  type RunnerStatus,
} from './chunkedRunnerCore.ts';

/**
 * Collects everything the core publishes, so the invariants can be checked
 * against the recorded streams rather than against the core's own counters.
 */
function harness<TItem, TResult>(options: Partial<RunnerOptions<TItem, TResult>> = {}) {
  const results: TResult[] = [];
  const errors: RunnerItemError[] = [];
  const progress: RunnerProgress[] = [];
  const statuses: RunnerStatus[] = [];
  const messages: string[] = [];
  const labels: string[] = [];
  const slept: number[] = [];

  const events: RunnerEvents<TResult> = {
    onStatus: s => statuses.push(s),
    onProgress: p => progress.push(p),
    onResult: r => results.push(r),
    onError: e => errors.push(e),
    onLabel: l => labels.push(l),
    onMessage: m => messages.push(m),
    onClear: () => { results.length = 0; errors.length = 0; },
  };

  const full: RunnerOptions<TItem, TResult> = {
    chunkSize: 10,
    delayMs: 0,
    labelFor: item => String(item),
    processItem: async item => item as unknown as TResult,
    ...options,
  };

  const core = createChunkedRunner<TItem, TResult>(
    () => full,
    events,
    async ms => { slept.push(ms); },
  );

  const last = () => progress[progress.length - 1];
  return { core, results, errors, progress, statuses, messages, labels, slept, last };
}

const items = (n: number) => Array.from({ length: n }, (_, i) => `i${i}`);

/** The two invariants the counter block exists to protect. */
function assertInvariants(h: ReturnType<typeof harness<string, string>>) {
  const p = h.last();
  assert.equal(p.succeeded, h.results.length, 'succeeded === results.length');
  assert.equal(p.failed, h.errors.length, 'failed === errors.length');
}

// ── C4: the new report parameter ──────────────────────────────────────────────

test('C4: report publishes a message without touching the counters', async () => {
  const h = harness<string, string>({
    processItem: async (item, _i, _signal, report) => {
      report(`${item} step 1`);
      report(`${item} step 2`);
      return item;
    },
  });

  await h.core.start(items(3));

  assert.ok(h.messages.includes('i0 step 1'));
  assert.ok(h.messages.includes('i2 step 2'));
  assert.equal(h.last().succeeded, 3);
  assertInvariants(h);
});

test('C4: the invariant holds when report fires many times per item', async () => {
  const h = harness<string, string>({
    chunkSize: 5,
    processItem: async (item, _i, _signal, report) => {
      // 50 sub-progress calls for one item — the shape of an 18-batch hashtag.
      for (let n = 0; n < 50; n++) report(`${item} batch ${n}`);
      if (item === 'i7') throw new Error('boom');
      return item;
    },
  });

  await h.core.start(items(20));

  assert.equal(h.results.length, 19);
  assert.equal(h.errors.length, 1);
  assert.equal(h.last().succeeded, 19);
  assert.equal(h.last().failed, 1);
  assert.equal(h.last().done, 20);
  assertInvariants(h);
  // 20 items x 50 reports, plus the core's own per-item and lifecycle messages.
  assert.ok(h.messages.length > 1000, 'report really did fire ~1000 times');
});

test('C4: reporting from an item that then throws still counts it once, as failed', async () => {
  const h = harness<string, string>({
    processItem: async (item, _i, _signal, report) => {
      report(`${item} working`);
      throw new Error(`failed ${item}`);
    },
  });

  await h.core.start(items(4));

  assert.equal(h.results.length, 0);
  assert.equal(h.errors.length, 4);
  assert.equal(h.last().failed, 4);
  assertInvariants(h);
});

test('C4: onItemProgress observes item and message', async () => {
  const seen: [string, string][] = [];
  const h = harness<string, string>({
    onItemProgress: (item, message) => seen.push([item, message]),
    processItem: async (item, _i, _signal, report) => {
      report(`${item} a`);
      report(`${item} b`);
      return item;
    },
  });

  await h.core.start(items(2));

  assert.deepEqual(seen, [
    ['i0', 'i0 a'], ['i0', 'i0 b'],
    ['i1', 'i1 a'], ['i1', 'i1 b'],
  ]);
});

// ── C4: existing callers are untouched ────────────────────────────────────────

test('C4: a three-argument processItem still works — brand-feed is unchanged', async () => {
  // Written exactly as app/brand-feed/page.tsx writes it, before `report`
  // existed. JavaScript discards the extra argument.
  const processItem = async (item: string, _index: number, signal: AbortSignal) => {
    assert.ok(signal instanceof AbortSignal, 'signal is still the third parameter');
    return item.toUpperCase();
  };

  const h = harness<string, string>({ processItem, chunkSize: 10 });
  await h.core.start(items(25));

  assert.deepEqual(h.results, items(25).map(i => i.toUpperCase()));
  assert.equal(h.last().succeeded, 25);
  assert.equal(h.last().failed, 0);
  assertInvariants(h);
});

test('C4: omitting onItemProgress changes nothing observable', async () => {
  const run = async (withHook: boolean) => {
    const seen: string[] = [];
    const h = harness<string, string>({
      chunkSize: 4,
      ...(withHook ? { onItemProgress: (_i, m) => seen.push(m) } : {}),
      processItem: async (item, _i, _s, report) => {
        report(`${item} mid`);
        if (item === 'i5') throw new Error('nope');
        return item;
      },
    });
    await h.core.start(items(12));
    return { h, seen };
  };

  const without = await run(false);
  const with_ = await run(true);

  assert.deepEqual(without.h.results, with_.h.results);
  assert.deepEqual(without.h.errors, with_.h.errors);
  assert.deepEqual(without.h.last(), with_.h.last());
  assert.deepEqual(without.h.messages, with_.h.messages);
  assert.deepEqual(without.h.statuses, with_.h.statuses);
  assert.equal(without.seen.length, 0);
  assert.equal(with_.seen.length, 12);
});

// ── Baseline behaviour, so "unchanged" is assertable ──────────────────────────

test('items are chunked and paused between chunks, but not after the last', async () => {
  const h = harness<string, string>({ chunkSize: 10, delayMs: 2000 });
  await h.core.start(items(25));

  assert.equal(h.last().done, 25);
  assert.deepEqual(h.slept, [2000, 2000], 'two pauses for three chunks');
});

test('the re-entrancy guard stops a second concurrent run', async () => {
  let running = 0;
  let maxConcurrent = 0;
  const h = harness<string, string>({
    processItem: async item => {
      maxConcurrent = Math.max(maxConcurrent, ++running);
      await new Promise(r => setTimeout(r, 1));
      running--;
      return item;
    },
  });

  await Promise.all([h.core.start(items(5)), h.core.start(items(5))]);

  assert.equal(maxConcurrent, 1, 'never two loops at once');
  assert.equal(h.results.length, 5, 'each item processed once, not twice');
  assertInvariants(h);
});

test('stop() ends the run and the remainder is reported as not attempted', async () => {
  const h = harness<string, string>({
    chunkSize: 2,
    processItem: async item => {
      if (item === 'i1') h.core.stop();
      return item;
    },
  });

  await h.core.start(items(10));

  assert.equal(h.statuses[h.statuses.length - 1], 'stopped');
  assert.ok(h.last().done < 10);
  assert.ok(h.messages.some(m => m.includes('not attempted')));
  assertInvariants(h);
});

test('an abort is a cancellation, not a failure — it is counted in neither tally', async () => {
  const h = harness<string, string>({
    processItem: async item => {
      if (item === 'i2') {
        h.core.stop();
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }
      return item;
    },
  });

  await h.core.start(items(10));

  assert.equal(h.results.length, 2, 'i0 and i1 succeeded');
  assert.equal(h.errors.length, 0, 'the aborted item is not an error');
  assert.equal(h.last().failed, 0);
  assertInvariants(h);
});

test('an empty item list finishes without running anything', async () => {
  const h = harness<string, string>();
  await h.core.start([]);

  assert.equal(h.statuses[h.statuses.length - 1], 'done');
  assert.ok(h.messages.includes('Nothing to run.'));
  assert.equal(h.results.length, 0);
});

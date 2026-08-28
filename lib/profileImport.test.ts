import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runProfileImport } from './profileImportCore.ts';
import { DEFAULT_MIN_FOLLOWERS, DEFAULT_MAX_FOLLOWERS } from './followerRange.ts';
import type { ImportableCreator, ImportResult } from './creatorImport.ts';

const BAND = { min: DEFAULT_MIN_FOLLOWERS, max: DEFAULT_MAX_FOLLOWERS };

/** Minimal Instagram profile item, as apify/instagram-profile-scraper emits. */
const igProfile = (username: string, followersCount: number) => ({
  username, fullName: username, biography: '', followersCount,
  followsCount: 0, postsCount: 0, verified: false,
});

const handles = (n: number, prefix = 'h') =>
  Array.from({ length: n }, (_, i) => `${prefix}${i}`);

/**
 * Records every scrape call. Each call to this fake corresponds 1:1 with a
 * `startProfileScraper` call in the real implementation — defaultScrapeBatch
 * starts exactly one Apify run per invocation — so counting these counts
 * billable runs.
 */
function scrapeSpy(
  respond: (batch: string[]) => unknown[] = batch => batch.map(h => igProfile(h, 100_000)),
) {
  const calls: string[][] = [];
  const fn = async (batch: string[]) => {
    calls.push([...batch]);
    return respond(batch);
  };
  return { calls, fn };
}

function saveSpy() {
  const calls: { creators: ImportableCreator[]; platform: string }[] = [];
  const fn = async (creators: ImportableCreator[], platform: string): Promise<ImportResult> => {
    calls.push({ creators: [...creators], platform });
    return {
      saved: creators.length, failed: 0, total: creators.length,
      savedHandles: creators.map(c => c.handle), errors: [],
    };
  };
  return { calls, fn };
}

const base = (scrape: ReturnType<typeof scrapeSpy>, save: ReturnType<typeof saveSpy>) => ({
  range: BAND,
  platform: 'instagram' as const,
  discoveredViaHashtags: ['test'],
  scrapeBatch: scrape.fn,
  saveCreators: save.fn,
});

// ── batchSize ─────────────────────────────────────────────────────────────────

test('default batchSize is Infinity — brand-feed stays on ONE Apify run', async () => {
  const scrape = scrapeSpy(), save = saveSpy();
  await runProfileImport(handles(60), base(scrape, save));

  assert.equal(scrape.calls.length, 1, 'exactly one scrape run');
  assert.equal(scrape.calls[0].length, 60, 'all handles in that one run');
  assert.equal(save.calls.length, 1, 'and one save');
});

test('batchSize 50 over 130 handles splits into 50 / 50 / 30', async () => {
  const scrape = scrapeSpy(), save = saveSpy();
  await runProfileImport(handles(130), { ...base(scrape, save), batchSize: 50 });

  assert.deepEqual(scrape.calls.map(c => c.length), [50, 50, 30]);
  assert.equal(save.calls.length, 3, 'saved per batch, not once at the end');
});

test('every handle appears exactly once across the batches', async () => {
  const scrape = scrapeSpy(), save = saveSpy();
  const input = handles(130);
  await runProfileImport(input, { ...base(scrape, save), batchSize: 50 });

  assert.deepEqual(scrape.calls.flat(), input);
});

test('a batchSize larger than the input, or a nonsense one, gives a single batch', async () => {
  for (const batchSize of [500, 0, -1, NaN]) {
    const scrape = scrapeSpy(), save = saveSpy();
    await runProfileImport(handles(30), { ...base(scrape, save), batchSize });
    assert.equal(scrape.calls.length, 1, `batchSize ${batchSize}`);
  }
});

test('no handles means no scrape run at all', async () => {
  const scrape = scrapeSpy(), save = saveSpy();
  const out = await runProfileImport([], base(scrape, save));

  assert.equal(scrape.calls.length, 0);
  assert.equal(save.calls.length, 0);
  assert.equal(out.attempted, 0);
});

// ── Cancellation: the billable-run guard ──────────────────────────────────────

test('F2: once the signal aborts, NO further scrape run is started', async () => {
  const controller = new AbortController();
  const save = saveSpy();

  // Aborts partway through the first batch's work, as pressing Stop would.
  const scrape = scrapeSpy(batch => {
    controller.abort();
    return batch.map(h => igProfile(h, 100_000));
  });

  const out = await runProfileImport(handles(500), {
    ...base(scrape, save), batchSize: 50, signal: controller.signal,
  });

  // 500 handles at 50 per batch is 10 runs. Without the guard, nine more
  // billable Apify runs would start after Stop was pressed.
  assert.equal(scrape.calls.length, 1, 'exactly one scrape run was started');
  assert.equal(out.cancelled, true);
  assert.equal(out.attempted, 50, 'only the paid-for batch counts as attempted');
});

test('F2: aborting before the first batch starts zero scrape runs', async () => {
  const controller = new AbortController();
  controller.abort();
  const scrape = scrapeSpy(), save = saveSpy();

  const out = await runProfileImport(handles(200), {
    ...base(scrape, save), batchSize: 50, signal: controller.signal,
  });

  assert.equal(scrape.calls.length, 0, 'nothing was scraped');
  assert.equal(save.calls.length, 0);
  assert.equal(out.cancelled, true);
  assert.equal(out.attempted, 0);
});

test('F2: an abort thrown mid-scrape stops the loop, it is not retried as a failure', async () => {
  const controller = new AbortController();
  const save = saveSpy();
  const calls: string[][] = [];
  const scrapeBatch = async (batch: string[]) => {
    calls.push(batch);
    controller.abort();
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    throw err;
  };

  const out = await runProfileImport(handles(200), {
    ...base(scrapeSpy(), save), batchSize: 50, signal: controller.signal, scrapeBatch,
  });

  assert.equal(calls.length, 1, 'the throwing batch is not followed by another');
  assert.equal(out.cancelled, true);
  assert.equal(out.errors.length, 0, 'an abort is a cancellation, not an error');
});

test('work completed before the abort is kept, not discarded', async () => {
  const controller = new AbortController();
  const save = saveSpy();
  let n = 0;
  const scrapeBatch = async (batch: string[]) => {
    if (++n === 2) controller.abort();
    return batch.map(h => igProfile(h, 100_000));
  };

  const out = await runProfileImport(handles(200), {
    ...base(scrapeSpy(), save), batchSize: 50, signal: controller.signal, scrapeBatch,
  });

  assert.equal(save.calls.length, 2, 'both completed batches were saved');
  assert.equal(out.saved, 100);
  assert.equal(out.cancelled, true);
});

test('an unaborted run reports cancelled false', async () => {
  const scrape = scrapeSpy(), save = saveSpy();
  const out = await runProfileImport(handles(100), { ...base(scrape, save), batchSize: 50 });
  assert.equal(out.cancelled, false);
  assert.equal(scrape.calls.length, 2);
});

// ── Failure isolation ─────────────────────────────────────────────────────────

test('one failing batch does not stop the batches after it', async () => {
  const save = saveSpy();
  const calls: string[][] = [];
  const scrapeBatch = async (batch: string[]) => {
    calls.push(batch);
    if (calls.length === 2) throw new Error('actor run failed');
    return batch.map(h => igProfile(h, 100_000));
  };

  const out = await runProfileImport(handles(150), {
    ...base(scrapeSpy(), save), batchSize: 50, scrapeBatch,
  });

  assert.equal(calls.length, 3, 'all three batches were attempted');
  assert.equal(out.failed, 50, 'the failed batch counts its handles as failed');
  assert.equal(out.saved, 100);
  assert.ok(out.errors.some(e => e.includes('actor run failed')));
  assert.equal(out.cancelled, false, 'a failure is not a cancellation');
});

// ── Progress ──────────────────────────────────────────────────────────────────

test('onProgress reports cumulative handles against the total, once per batch', async () => {
  const scrape = scrapeSpy(), save = saveSpy();
  const seen: [number, number][] = [];

  await runProfileImport(handles(130), {
    ...base(scrape, save), batchSize: 50,
    onProgress: (done, total) => seen.push([done, total]),
  });

  assert.deepEqual(seen, [[50, 130], [100, 130], [130, 130]]);
});

test('onProgress is optional', async () => {
  const scrape = scrapeSpy(), save = saveSpy();
  await runProfileImport(handles(60), { ...base(scrape, save), batchSize: 20 });
  assert.equal(scrape.calls.length, 3);
});

// ── Classification across batches ─────────────────────────────────────────────

test('counters accumulate across batches and cover all four statuses', async () => {
  const save = saveSpy();
  // Keyed off the handle's own index, not the position within the batch —
  // the callback receives one batch at a time, so a batch-local index would
  // restart at 0 each time and skew the distribution.
  const scrapeBatch = async (batch: string[]) => batch.map(h => {
    const n = Number(h.replace('h', '')) % 4;
    if (n === 0) return igProfile(h, 100_000);   // active
    if (n === 1) return igProfile(h, 1_000);     // below min
    if (n === 2) return igProfile(h, 900_000);   // above max
    return igProfile(h, 0);                      // unmeasured
  });

  const out = await runProfileImport(handles(40), {
    ...base(scrapeSpy(), save), batchSize: 10, scrapeBatch,
  });

  assert.equal(out.inRange, 10);
  assert.equal(out.outOfRangeLow, 10);
  assert.equal(out.outOfRangeHigh, 10);
  assert.equal(out.unknownSize, 10);
  assert.equal(out.attempted, 40);
  assert.equal(out.inRange + out.outOfRangeLow + out.outOfRangeHigh + out.unknownSize, 40);
});

test('the sample cap is per direction and holds across batches', async () => {
  const save = saveSpy();
  const scrapeBatch = async (batch: string[]) => batch.map(h => igProfile(h, 1_000));

  const out = await runProfileImport(handles(100), {
    ...base(scrapeSpy(), save), batchSize: 10, scrapeBatch,
  });

  const low = out.outOfRangeSamples.filter(s => s.status === 'out_of_range_low');
  assert.equal(low.length, 12, 'capped at SAMPLES_PER_DIRECTION, not 12 per batch');
});

test('provenance and platform are passed through to the save', async () => {
  const scrape = scrapeSpy(), save = saveSpy();
  await runProfileImport(handles(3), {
    ...base(scrape, save),
    platform: 'instagram',
    discoveredViaHashtags: ['ootd', 'streetstyle'],
  });

  assert.equal(save.calls[0].platform, 'instagram');
  for (const c of save.calls[0].creators) {
    assert.deepEqual(c.discoveredViaHashtags, ['ootd', 'streetstyle']);
  }
});

test('TikTok profiles route through the TikTok mapper', async () => {
  const save = saveSpy();
  const scrapeBatch = async () => [{
    username: 'CreatorOne', displayName: 'Creator One', bio: 'hi',
    followers: { raw: 120_000 }, following: { raw: 10 }, videos: { raw: 5 },
  }];

  await runProfileImport(['creatorone'], {
    ...base(scrapeSpy(), save), platform: 'tiktok', scrapeBatch,
  });

  const c = save.calls[0].creators[0];
  assert.equal(save.calls[0].platform, 'tiktok');
  assert.equal(c.handle, 'creatorone', 'handle lowercased by the mapper');
  assert.equal(c.followerCount, 120_000);
  assert.equal(c.importStatus, 'active');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runProfileImport, UNKNOWN_SIZE_SAMPLE_CAP } from './profileImportCore.ts';
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

// ── G2: brand-feed omits `policy` and is unaffected by C3c ────────────────────

test('G2: omitting policy imports everything — brand-feed is unchanged by C3c', async () => {
  const save = saveSpy();
  // One of each status, the mix brand-feed actually sees.
  const scrapeBatch = async () => [
    igProfile('inband', 100_000),
    igProfile('tiny', 800),        // below min AND below the near-miss floor
    igProfile('mega', 900_000),
    igProfile('unmeasured', 0),
  ];

  const out = await runProfileImport(['a', 'b', 'c', 'd'], {
    range: BAND,
    platform: 'instagram',
    discoveredViaHashtags: ['brand_feed'],
    scrapeBatch,
    saveCreators: save.fn,
    // No `policy` — exactly how app/api/brand-feed/process/route.ts calls it.
  });

  // Counters identical to C3b.
  assert.equal(out.inRange, 1);
  assert.equal(out.outOfRangeLow, 1);
  assert.equal(out.outOfRangeHigh, 1);
  assert.equal(out.unknownSize, 1);

  // Every profile imported, including the 800-follower one that Discovery
  // would cache. Brand-feed's below-min creators are qualified by the brand's
  // own selection, so the floor must not reach them.
  assert.equal(out.cacheOnly.length, 0, 'brand-feed caches nothing');
  assert.equal(out.saved, 4, 'all four written, none diverted');
  assert.deepEqual(
    save.calls[0].creators.map(c => c.importStatus).sort(),
    ['active', 'out_of_range_high', 'out_of_range_low', 'unknown_size'],
  );
});

test('G2: omitting policy leaves the samples as C3b produced them', async () => {
  const save = saveSpy();
  const scrapeBatch = async (batch: string[]) =>
    batch.map((h, i) => igProfile(h, i % 2 === 0 ? 800 : 900_000));

  const out = await runProfileImport(handles(40), {
    range: BAND, platform: 'instagram', discoveredViaHashtags: ['brand_feed'],
    scrapeBatch, saveCreators: save.fn,
  });

  const low = out.outOfRangeSamples.filter(s => s.status === 'out_of_range_low');
  const high = out.outOfRangeSamples.filter(s => s.status === 'out_of_range_high');
  assert.equal(low.length, 12);
  assert.equal(high.length, 12);
  assert.equal(out.unknownSizeSamples.length, 0);
});

// ── G2 / E2: the unknown_size bucket is independent ───────────────────────────

test('G2: unknown_size samples do NOT consume high/low slots', async () => {
  const save = saveSpy();
  // 60 unmeasured handles first, then 12 of each measured direction. Under the
  // shared-bucket behaviour the unmeasured ones would fill the cap and the
  // below-min samples — the informative ones — would never be recorded.
  const scrapeBatch = async (batch: string[]) => batch.map(h => {
    const n = Number(h.replace('h', ''));
    if (n < 60) return igProfile(h, 0);
    if (n < 72) return igProfile(h, 800);
    return igProfile(h, 900_000);
  });

  const out = await runProfileImport(handles(84), {
    range: BAND, platform: 'instagram', discoveredViaHashtags: ['x'],
    scrapeBatch, saveCreators: save.fn,
  });

  assert.equal(out.unknownSize, 60);
  assert.equal(out.unknownSizeSamples.length, 12, 'own cap, not 60');

  const low = out.outOfRangeSamples.filter(s => s.status === 'out_of_range_low');
  const high = out.outOfRangeSamples.filter(s => s.status === 'out_of_range_high');
  assert.equal(low.length, 12, 'below-min samples survive the flood of unmeasured ones');
  assert.equal(high.length, 12);

  assert.ok(
    out.outOfRangeSamples.every(s => s.status !== 'unknown_size'),
    'unknown_size never appears in the out-of-range bucket',
  );
});

test('G2: each bucket caps independently at its own constant', async () => {
  const save = saveSpy();
  const scrapeBatch = async (batch: string[]) => batch.map(h => igProfile(h, 0));

  const out = await runProfileImport(handles(100), {
    range: BAND, platform: 'instagram', discoveredViaHashtags: ['x'],
    scrapeBatch, saveCreators: save.fn,
  });

  assert.equal(out.unknownSizeSamples.length, UNKNOWN_SIZE_SAMPLE_CAP);
  assert.equal(out.outOfRangeSamples.length, 0, 'nothing measured, so nothing to sample');
});

// ── C6: the run budget, tested the same way cancellation is ───────────────────

test('C6: once the deadline passes, NO further scrape run is started', async () => {
  const save = saveSpy();
  let clock = 1_000_000;
  const calls: string[][] = [];
  const scrapeBatch = async (batch: string[]) => {
    calls.push([...batch]);
    clock += 60_000; // this batch took a minute
    return batch.map(h => igProfile(h, 100_000));
  };

  // 500 handles at 50 per batch is 10 runs; the budget allows one.
  const out = await runProfileImport(handles(500), {
    range: BAND, platform: 'instagram', discoveredViaHashtags: ['x'],
    batchSize: 50, scrapeBatch, saveCreators: save.fn,
    deadlineAt: clock + 30_000,
    now: () => clock,
  });

  assert.equal(calls.length, 1, 'nine further billable runs prevented');
  assert.equal(out.timedOut, true);
  assert.equal(out.cancelled, false, 'a timeout is not a cancellation');
});

test('C6: a timeout returns the same honest partial counts a cancellation does', async () => {
  const build = async (mode: 'timeout' | 'cancel') => {
    const save = saveSpy();
    const controller = new AbortController();
    let clock = 0;
    let n = 0;
    const scrapeBatch = async (batch: string[]) => {
      if (++n === 3) {
        if (mode === 'cancel') controller.abort();
        else clock = 10_000;
      }
      return batch.map(h => igProfile(h, 100_000));
    };

    return runProfileImport(handles(200), {
      range: BAND, platform: 'instagram', discoveredViaHashtags: ['x'],
      batchSize: 50, scrapeBatch, saveCreators: save.fn,
      ...(mode === 'cancel'
        ? { signal: controller.signal }
        : { deadlineAt: 5_000, now: () => clock }),
    });
  };

  const timedOut = await build('timeout');
  const cancelled = await build('cancel');

  // Identical partial results — only the reason differs.
  assert.equal(timedOut.attempted, cancelled.attempted);
  assert.equal(timedOut.saved, cancelled.saved);
  assert.equal(timedOut.inRange, cancelled.inRange);
  assert.equal(timedOut.attempted, 150, 'three batches completed, one skipped');
  assert.equal(timedOut.saved, 150, 'every measured profile was kept');

  assert.equal(timedOut.timedOut, true);
  assert.equal(timedOut.cancelled, false);
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.timedOut, false);
});

test('C6: a deadline that never passes runs everything', async () => {
  const scrape = scrapeSpy(), save = saveSpy();
  const out = await runProfileImport(handles(150), {
    ...base(scrape, save), batchSize: 50,
    deadlineAt: Number.MAX_SAFE_INTEGER, now: () => 0,
  });

  assert.equal(scrape.calls.length, 3);
  assert.equal(out.timedOut, false);
  assert.equal(out.attempted, 150);
});

test('C6: an explicit Stop is reported as cancelled even when the budget is also spent', async () => {
  const save = saveSpy();
  const controller = new AbortController();
  controller.abort();

  const out = await runProfileImport(handles(100), {
    range: BAND, platform: 'instagram', discoveredViaHashtags: ['x'],
    batchSize: 50, saveCreators: save.fn,
    scrapeBatch: async () => [],
    signal: controller.signal,
    deadlineAt: 0, now: () => 1_000_000, // budget also long gone
  });

  assert.equal(out.cancelled, true, 'user intent beats the clock');
  assert.equal(out.timedOut, false);
});

test('C6: omitting deadlineAt leaves timedOut false and changes nothing', async () => {
  const scrape = scrapeSpy(), save = saveSpy();
  const out = await runProfileImport(handles(100), { ...base(scrape, save), batchSize: 50 });
  assert.equal(out.timedOut, false);
  assert.equal(scrape.calls.length, 2);
});

// ── K3: missing is distinguishable from never-reached ─────────────────────────

test('K3: scrapedHandles covers only batches that actually returned', async () => {
  const save = saveSpy();
  const scrapeBatch = async (batch: string[]) => batch.map(h => igProfile(h, 100_000));

  const out = await runProfileImport(handles(120), {
    range: BAND, platform: 'instagram', discoveredViaHashtags: ['x'],
    batchSize: 50, scrapeBatch, saveCreators: save.fn,
  });

  assert.deepEqual(out.scrapedHandles, handles(120));
});

test('K3: handles never reached after a cancel are NOT reported as scraped', async () => {
  const controller = new AbortController();
  const save = saveSpy();
  const scrapeBatch = async (batch: string[]) => {
    controller.abort();
    return batch.map(h => igProfile(h, 100_000));
  };

  const out = await runProfileImport(handles(200), {
    range: BAND, platform: 'instagram', discoveredViaHashtags: ['x'],
    batchSize: 50, scrapeBatch, saveCreators: save.fn, signal: controller.signal,
  });

  assert.equal(out.scrapedHandles.length, 50, 'only the one completed batch');
  // The 150 unreached handles are absent, so the route cannot mislabel them
  // scrape_missing — they keep their not_scraped row.
  const returned = new Set(out.measured.map(m => m.handle));
  assert.deepEqual(out.scrapedHandles.filter(h => !returned.has(h)), []);
});

test('K3: a batch that threw does not count its handles as scraped', async () => {
  const save = saveSpy();
  let n = 0;
  const scrapeBatch = async (batch: string[]) => {
    if (++n === 2) throw new Error('actor run failed');
    return batch.map(h => igProfile(h, 100_000));
  };

  const out = await runProfileImport(handles(150), {
    range: BAND, platform: 'instagram', discoveredViaHashtags: ['x'],
    batchSize: 50, scrapeBatch, saveCreators: save.fn,
  });

  assert.equal(out.attempted, 150, 'all three batches were billed');
  assert.equal(out.scrapedHandles.length, 100, 'but only two returned data');
  assert.equal(out.failed, 50);
});

test('K3: a genuinely missing profile IS reported, exactly', async () => {
  const save = saveSpy();
  // The actor omits h1 and h3 — private or deleted accounts.
  const scrapeBatch = async (batch: string[]) =>
    batch.filter(h => !['h1', 'h3'].includes(h)).map(h => igProfile(h, 100_000));

  const out = await runProfileImport(handles(10), {
    range: BAND, platform: 'instagram', discoveredViaHashtags: ['x'],
    scrapeBatch, saveCreators: save.fn,
  });

  const returned = new Set(out.measured.map(m => m.handle));
  const missing = out.scrapedHandles.filter(h => !returned.has(h));
  assert.deepEqual(missing.sort(), ['h1', 'h3']);
});

// ── HH1/II2: outcomes reflect a confirmed save, not an intention ──────────────

/** A save that succeeds for everything except the named handles. */
function partialSaveSpy(failing: string[]) {
  const calls: { creators: ImportableCreator[]; platform: string }[] = [];
  const fn = async (creators: ImportableCreator[], platform: string): Promise<ImportResult> => {
    calls.push({ creators: [...creators], platform });
    const ok = creators.filter(c => !failing.includes(c.handle));
    const bad = creators.filter(c => failing.includes(c.handle));
    return {
      saved: ok.length,
      failed: bad.length,
      total: creators.length,
      savedHandles: ok.map(c => c.handle),
      errors: bad.map(c => `${c.handle}: duplicate key`),
    };
  };
  return { calls, fn };
}

test('II2: a handle whose save FAILS is not reported as imported', async () => {
  const save = partialSaveSpy(['h3']);
  const out = await runProfileImport(handles(6), {
    range: BAND, platform: 'instagram', discoveredViaHashtags: ['x'],
    scrapeBatch: async batch => batch.map(h => igProfile(h, 100_000)),
    saveCreators: save.fn,
  });

  const failed = out.measured.find(m => m.handle === 'h3');
  assert.ok(failed, 'it is still measured — it was scraped and billed');
  assert.equal(failed.saved, false, 'but NOT recorded as written');
  assert.equal(failed.status, 'active', 'its measurement is unchanged');

  for (const m of out.measured.filter(m => m.handle !== 'h3')) {
    assert.equal(m.saved, true);
  }
  assert.equal(out.saved, 5);
  assert.equal(out.failed, 1);
});

test('II2: saved counts and the measured list agree', async () => {
  const save = partialSaveSpy(['h1', 'h4', 'h7']);
  const out = await runProfileImport(handles(10), {
    range: BAND, platform: 'instagram', discoveredViaHashtags: ['x'],
    scrapeBatch: async batch => batch.map(h => igProfile(h, 100_000)),
    saveCreators: save.fn,
  });

  assert.equal(out.measured.filter(m => m.saved).length, out.saved);
  assert.equal(out.measured.filter(m => !m.saved && m.decision === 'import').length, out.failed);
});

test('II2: a cache-only handle is saved:false by design, not by failure', async () => {
  const save = saveSpy();
  const out = await runProfileImport(handles(4), {
    range: BAND, platform: 'instagram', discoveredViaHashtags: ['x'],
    policy: () => 'cache_only',
    scrapeBatch: async batch => batch.map(h => igProfile(h, 100_000)),
    saveCreators: save.fn,
  });

  assert.equal(out.measured.length, 4);
  for (const m of out.measured) {
    assert.equal(m.saved, false);
    assert.equal(m.decision, 'cache_only', 'distinguishable from an import that failed');
  }
  assert.equal(out.cacheOnly.length, 4);
  assert.equal(out.failed, 0, 'nothing was attempted, so nothing failed');
});

test('II2: reconciliation is per batch, so a later failure cannot unmark an earlier save', async () => {
  const calls: string[][] = [];
  const fn = async (creators: ImportableCreator[]): Promise<ImportResult> => {
    calls.push(creators.map(c => c.handle));
    // The second batch fails entirely.
    const ok = calls.length === 2 ? [] : creators;
    return {
      saved: ok.length, failed: creators.length - ok.length, total: creators.length,
      savedHandles: ok.map(c => c.handle), errors: [],
    };
  };

  const out = await runProfileImport(handles(30), {
    range: BAND, platform: 'instagram', discoveredViaHashtags: ['x'],
    batchSize: 10,
    scrapeBatch: async batch => batch.map(h => igProfile(h, 100_000)),
    saveCreators: fn,
  });

  assert.equal(calls.length, 3);
  assert.equal(out.measured.filter(m => m.saved).length, 20, 'batches 1 and 3');
  assert.equal(out.measured.filter(m => !m.saved).length, 10, 'batch 2');
  assert.equal(out.saved, 20);
});

test('II2: every measured handle is reconciled — none left pending', async () => {
  const save = partialSaveSpy(['h2']);
  const out = await runProfileImport(handles(5), {
    range: BAND, platform: 'instagram', discoveredViaHashtags: ['x'],
    batchSize: 2,
    scrapeBatch: async batch => batch.map(h => igProfile(h, 100_000)),
    saveCreators: save.fn,
  });
  assert.equal(out.measured.length, 5, 'nothing was dropped between batches');
});

test('II2: a handle the save silently omits is treated as failed, not imported', async () => {
  // savedHandles shorter than the input, with no error reported. Trusting the
  // count rather than the list would have called this a success.
  const fn = async (creators: ImportableCreator[]): Promise<ImportResult> => ({
    saved: creators.length, failed: 0, total: creators.length,
    savedHandles: creators.slice(1).map(c => c.handle),
    errors: [],
  });

  const out = await runProfileImport(handles(4), {
    range: BAND, platform: 'instagram', discoveredViaHashtags: ['x'],
    scrapeBatch: async batch => batch.map(h => igProfile(h, 100_000)),
    saveCreators: fn,
  });

  assert.equal(out.measured.find(m => m.handle === 'h0')?.saved, false);
});

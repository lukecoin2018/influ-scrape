'use client';

import { useCallback, useEffect, useState } from 'react';
import { useChunkedRunner } from '@/lib/useChunkedRunner';
import { DEFAULT_MIN_FOLLOWERS, DEFAULT_MAX_FOLLOWERS } from '@/lib/followerRange';
import { parseHandleList } from '@/lib/handles';

// Chunks of 10, 2s apart — the cadence the other batch runners in this app use.
const CHUNK_SIZE = 10;
const CHUNK_DELAY_MS = 2000;

type Scope = 'verified_brands' | 'classified_brands' | 'all_brands';
type Order = 'never_scraped' | 'stale_first' | 'top_creators' | 'casting_fit';

interface QueueItem {
  handle: string;
  brandId: string | null;
  feedScrapedAt: string | null;
  feedPostCount: number | null;
  castingInRange: number | null;
  castingSampleSize: number | null;
  creatorsCount: number | null;
}

interface ScopeStats {
  total: number;
  neverScraped: number;
  scraped: number;
  orphans: number;
}

interface StatusData {
  migrationsApplied?: boolean;
  error?: string;
  scopes: Record<Scope, ScopeStats>;
  brandFeedEdges: number;
}

interface FieldCoverage {
  posts: number;
  withTaggedUsers: number;
  withCoauthorProducers: number;
  withMentions: number;
  withCaption: number;
}

interface BrandResult {
  handle: string;
  brandCreated: boolean;
  postsScraped: number;
  candidatesFound: number;
  candidatesExcluded: number;
  entityExcluded: number;
  knownCreators: number;
  newHandles: number;
  newHandlesSkipped: number;
  importedInRange: number;
  importedOutOfRangeHigh: number;
  importedOutOfRangeLow: number;
  importedOutOfRange: number;
  outOfRangeSamples: { handle: string; followerCount: number; status: string }[];
  creatorsImported: number;
  creatorsFailed: number;
  edgesBuilt: number;
  edgesWritten: number;
  edgesDuplicate: number;
  edgesFromEntityExcluded: number;
  fieldCoverage: FieldCoverage;
  durationMs: number;
}

const SCOPE_OPTIONS: { value: Scope; label: string; desc: string }[] = [
  { value: 'verified_brands', label: 'Verified brands only', desc: 'brand_aliases: entity_type=brand and verified' },
  { value: 'classified_brands', label: 'All classified brands', desc: 'brand_aliases: entity_type=brand, verified or not' },
  { value: 'all_brands', label: 'All brands', desc: 'Every row in brands, classified or not — includes enrich-pipeline stubs' },
];

const ORDER_OPTIONS: { value: Order; label: string; desc: string }[] = [
  { value: 'never_scraped', label: 'Never scraped first', desc: 'Only brands with no feed_scraped_at, most-referenced first' },
  { value: 'stale_first', label: 'Stale first', desc: 'Oldest feed_scraped_at first; never-scraped counts as most stale' },
  { value: 'top_creators', label: 'Most creators first', desc: 'Highest brand_aliases.creators_count first, regardless of scrape state' },
  { value: 'casting_fit', label: 'Best casting fit first', desc: 'Most partnered creators inside your follower band; thin samples sort last' },
];

export default function BrandFeedPage() {
  const [scope, setScope] = useState<Scope>('verified_brands');
  const [order, setOrder] = useState<Order>('never_scraped');
  const [batchSize, setBatchSize] = useState(25);
  const [postsPerBrand, setPostsPerBrand] = useState(12);
  const [detailed, setDetailed] = useState(false);
  const [minFollowers, setMinFollowers] = useState(DEFAULT_MIN_FOLLOWERS);
  const [maxFollowers, setMaxFollowers] = useState(DEFAULT_MAX_FOLLOWERS);
  const [handlesInput, setHandlesInput] = useState('');
  const [status, setStatus] = useState<StatusData | null>(null);
  const [queueInfo, setQueueInfo] = useState<string>('');
  const [startError, setStartError] = useState<string | null>(null);
  const [invalidHandles, setInvalidHandles] = useState<{ input: string; reason: string }[]>([]);
  const [skipLowYield, setSkipLowYield] = useState(false);
  const [minLastPostCount, setMinLastPostCount] = useState(2);
  const [castingSampleFloor, setCastingSampleFloor] = useState(5);
  // Covers the gap between the click and runner.isRunning going true. The
  // queue build is a ~1s round trip, and until it resolves the runner has not
  // started, so a button disabled only on isRunning stays live and a second
  // click starts a second run. The core's re-entrancy guard is the real
  // defence; this stops the click from being accepted in the first place.
  const [isStarting, setIsStarting] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/brand-feed/status');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setStatus(data);
    } catch (err) {
      console.error('Failed to fetch brand feed status:', err);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  const processItem = useCallback(
    async (item: QueueItem, _index: number, signal: AbortSignal): Promise<BrandResult> => {
      const res = await fetch('/api/brand-feed/process', {
        method: 'POST',
        // Stop aborts this, which both frees the loop immediately and lets the
        // route see the disconnect and skip the profile scrape it has not
        // started yet.
        signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          handle: item.handle,
          brandId: item.brandId,
          postsPerBrand,
          dataDetailLevel: detailed ? 'detailedData' : 'basicData',
          minFollowers,
          maxFollowers,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      return data as BrandResult;
    },
    [postsPerBrand, detailed, minFollowers, maxFollowers]
  );

  const labelFor = useCallback((item: QueueItem) => `@${item.handle}`, []);

  const runner = useChunkedRunner<QueueItem, BrandResult>({
    chunkSize: CHUNK_SIZE,
    delayMs: CHUNK_DELAY_MS,
    processItem,
    labelFor,
  });

  const handleStart = async () => {
    if (isStarting || runner.isRunning) return;
    setIsStarting(true);
    setStartError(null);
    setQueueInfo('');
    setInvalidHandles([]);
    runner.reset();

    // Any mix of newlines, spaces, commas and semicolons. Rejected tokens are
    // shown individually rather than failing or silently shrinking the batch.
    const { valid: handles, invalid } = parseHandleList(handlesInput);
    setInvalidHandles(invalid);

    if (handlesInput.trim() && handles.length === 0) {
      setStartError('No valid handles in that list.');
      setIsStarting(false);
      return;
    }

    try {
      const res = await fetch('/api/brand-feed/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope, order, batchSize, handles,
          minLastPostCount: skipLowYield ? minLastPostCount : undefined,
          castingSampleFloor,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

      if (!data.items?.length) {
        setQueueInfo('Queue is empty for this scope and ordering.');
        return;
      }

      setQueueInfo(
        `${data.count} of ${data.poolSize} in pool · ` +
          `${data.neverScrapedInQueue} never scraped · ` +
          `${data.rescrapesInQueue} re-scrapes · ` +
          `${data.orphansInQueue} orphan alias${data.orphansInQueue === 1 ? '' : 'es'} (stub rows will be created)` +
          (data.lowYieldSkipped ? ` · ${data.lowYieldSkipped} skipped as low-yield` : '')
      );

      // Released before the run so the button reflects runner.isRunning from
      // here on; the core's guard covers the handover.
      setIsStarting(false);
      await runner.start(data.items as QueueItem[]);
      fetchStatus();
    } catch (err) {
      setStartError(err instanceof Error ? err.message : 'Failed to build queue');
    } finally {
      setIsStarting(false);
    }
  };

  // ── Aggregates: the numbers that decide whether a full sweep is worth it ──
  const results = runner.results;
  const totals = results.reduce(
    (acc, r) => ({
      posts: acc.posts + r.postsScraped,
      candidates: acc.candidates + r.candidatesFound,
      newHandles: acc.newHandles + r.newHandles,
      inRange: acc.inRange + r.importedInRange,
      outOfRangeHigh: acc.outOfRangeHigh + r.importedOutOfRangeHigh,
      outOfRangeLow: acc.outOfRangeLow + r.importedOutOfRangeLow,
      outOfRange: acc.outOfRange + r.importedOutOfRange,
      entityExcluded: acc.entityExcluded + r.entityExcluded,
      edges: acc.edges + r.edgesWritten,
      edgesFromExcluded: acc.edgesFromExcluded + r.edgesFromEntityExcluded,
      known: acc.known + r.knownCreators,
      stubs: acc.stubs + (r.brandCreated ? 1 : 0),
    }),
    { posts: 0, candidates: 0, newHandles: 0, inRange: 0, outOfRange: 0,
      outOfRangeHigh: 0, outOfRangeLow: 0,
      entityExcluded: 0, edges: 0, edgesFromExcluded: 0, known: 0, stubs: 0 }
  );

  // Kept apart rather than one ranked list: an eight-million-follower account
  // and a 600-follower one are different problems, and sorting them together
  // buries every small account below the celebrities.
  const samplesFor = (status: string) => results
    .flatMap(r => r.outOfRangeSamples || [])
    .filter(c => c.status === status)
    .sort((a, b) => b.followerCount - a.followerCount)
    .slice(0, 15);

  const samplesHigh = samplesFor('out_of_range_high');
  const samplesLow = samplesFor('out_of_range_low');

  const coverage = results.reduce(
    (acc, r) => ({
      posts: acc.posts + r.fieldCoverage.posts,
      withTaggedUsers: acc.withTaggedUsers + r.fieldCoverage.withTaggedUsers,
      withCoauthorProducers: acc.withCoauthorProducers + r.fieldCoverage.withCoauthorProducers,
      withMentions: acc.withMentions + r.fieldCoverage.withMentions,
      withCaption: acc.withCaption + r.fieldCoverage.withCaption,
    }),
    { posts: 0, withTaggedUsers: 0, withCoauthorProducers: 0, withMentions: 0, withCaption: 0 }
  );

  const busy = isStarting || runner.isRunning;
  const per = (n: number) => (results.length > 0 ? (n / results.length).toFixed(1) : '—');
  const pct = (n: number, d: number) => (d > 0 ? `${Math.round((n / d) * 100)}%` : '—');
  const activeScope = status?.scopes?.[scope];

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100">
      <div className="max-w-5xl mx-auto px-4 py-8">
        <div className="mb-8">
          <h1 className="text-4xl font-bold bg-gradient-to-r from-violet-600 to-purple-600 bg-clip-text text-transparent mb-2">
            Brand Feed Discovery
          </h1>
          <p className="text-slate-600">
            Scrape brands&apos; own Instagram feeds to find the creators they collaborate with
          </p>
        </div>

        {/* Navigation */}
        <div className="flex gap-2 mb-6 flex-wrap">
          <a href="/" className="px-4 py-2 bg-slate-200 text-slate-700 rounded-lg font-medium hover:bg-slate-300 transition-colors">Discovery</a>
          <a href="/add" className="px-4 py-2 bg-slate-200 text-slate-700 rounded-lg font-medium hover:bg-slate-300 transition-colors">Add Creators</a>
          <a href="/import" className="px-4 py-2 bg-slate-200 text-slate-700 rounded-lg font-medium hover:bg-slate-300 transition-colors">Import</a>
          <a href="/brand-feed" className="px-4 py-2 bg-violet-600 text-white rounded-lg font-medium">Brand Feed</a>
          <a href="/enrich" className="px-4 py-2 bg-slate-200 text-slate-700 rounded-lg font-medium hover:bg-slate-300 transition-colors">Enrich</a>
          <a href="/embeddings" className="px-4 py-2 bg-slate-200 text-slate-700 rounded-lg font-medium hover:bg-slate-300 transition-colors">Embeddings</a>
          <a href="/intelligence" className="px-4 py-2 bg-slate-200 text-slate-700 rounded-lg font-medium hover:bg-slate-300 transition-colors">Intelligence</a>
          <a href="/database" className="px-4 py-2 bg-slate-200 text-slate-700 rounded-lg font-medium hover:bg-slate-300 transition-colors">Creators</a>
          <a href="/brands" className="px-4 py-2 bg-slate-200 text-slate-700 rounded-lg font-medium hover:bg-slate-300 transition-colors">Brands</a>
        </div>

        {status?.migrationsApplied === false && (
          <div className="bg-amber-50 border-2 border-amber-300 rounded-xl p-5 mb-6">
            <h2 className="text-base font-bold text-amber-900 mb-1">Migrations not applied</h2>
            <p className="text-sm text-amber-800">{status.error}</p>
          </div>
        )}

        {/* Status */}
        {status?.scopes && (
          <div className="bg-white rounded-xl shadow-sm p-6 mb-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold text-slate-800">Queue Pools</h2>
              <span className="text-sm text-slate-500">
                {status.brandFeedEdges.toLocaleString()} brand-feed edges recorded
              </span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {SCOPE_OPTIONS.map(opt => {
                const s = status.scopes?.[opt.value];
                if (!s) return null;
                return (
                  <div
                    key={opt.value}
                    className={`rounded-lg p-4 border-2 ${
                      scope === opt.value ? 'border-violet-400 bg-violet-50' : 'border-slate-100 bg-slate-50'
                    }`}
                  >
                    <div className="text-sm font-semibold text-slate-700 mb-2">{opt.label}</div>
                    <div className="text-2xl font-bold text-slate-800">{s.total.toLocaleString()}</div>
                    <div className="text-xs text-slate-500 mt-1">
                      {s.neverScraped.toLocaleString()} never scraped · {s.orphans.toLocaleString()} orphan
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Config */}
        <div className="bg-white rounded-xl shadow-sm p-6 mb-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-5">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">Scope</label>
              <div className="space-y-2">
                {SCOPE_OPTIONS.map(opt => (
                  <label key={opt.value} className="flex items-start gap-3 cursor-pointer p-2 rounded-lg hover:bg-slate-50">
                    <input
                      type="radio"
                      name="scope"
                      checked={scope === opt.value}
                      onChange={() => setScope(opt.value)}
                      className="mt-0.5 accent-violet-600"
                      disabled={busy}
                    />
                    <div>
                      <div className="font-medium text-sm text-slate-800">{opt.label}</div>
                      <div className="text-xs text-slate-500">{opt.desc}</div>
                    </div>
                  </label>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">Ordering</label>
              <div className="space-y-2">
                {ORDER_OPTIONS.map(opt => (
                  <label key={opt.value} className="flex items-start gap-3 cursor-pointer p-2 rounded-lg hover:bg-slate-50">
                    <input
                      type="radio"
                      name="order"
                      checked={order === opt.value}
                      onChange={() => setOrder(opt.value)}
                      className="mt-0.5 accent-violet-600"
                      disabled={busy}
                    />
                    <div>
                      <div className="font-medium text-sm text-slate-800">{opt.label}</div>
                      <div className="text-xs text-slate-500">{opt.desc}</div>
                    </div>
                  </label>
                ))}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-5">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">Brands this run</label>
              <input
                type="number"
                value={batchSize}
                onChange={e => setBatchSize(parseInt(e.target.value) || 25)}
                min={1}
                max={2000}
                className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-violet-500"
                disabled={busy}
              />
              {activeScope && (
                <p className="text-xs text-slate-500 mt-1">
                  {activeScope.total.toLocaleString()} in this scope
                </p>
              )}
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">Posts per brand</label>
              <input
                type="number"
                value={postsPerBrand}
                onChange={e => setPostsPerBrand(parseInt(e.target.value) || 12)}
                min={1}
                max={50}
                className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-violet-500"
                disabled={busy}
              />
              <p className="text-xs text-slate-500 mt-1">
                Est. ~${(batchSize * postsPerBrand * 0.0027).toFixed(2)} of post scraping
              </p>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">Data detail</label>
              <label className="flex items-start gap-2 cursor-pointer mt-2">
                <input
                  type="checkbox"
                  checked={detailed}
                  onChange={e => setDetailed(e.target.checked)}
                  className="mt-0.5 accent-violet-600"
                  disabled={busy}
                />
                <span className="text-sm text-slate-700">
                  Use detailedData
                  <span className="block text-xs text-slate-500">
                    Paid add-on. Leave off unless field coverage below shows basicData is dropping tags.
                  </span>
                </span>
              </label>
            </div>
          </div>

          {order === 'casting_fit' && (
            <div className="mb-5 p-4 bg-violet-50 border border-violet-200 rounded-lg">
              <label className="block text-sm font-medium text-violet-900 mb-1">
                Minimum casting sample
                <input
                  type="number"
                  value={castingSampleFloor}
                  onChange={e => setCastingSampleFloor(Math.max(1, parseInt(e.target.value) || 1))}
                  min={1}
                  max={100}
                  className="ml-2 w-20 px-2 py-0.5 border border-violet-300 rounded text-sm"
                  disabled={busy}
                />
              </label>
              <p className="text-xs text-violet-800">
                Brands with fewer than this many partnered creators sort last rather than being
                ranked. A brand that is 100% in-band across 4 creators is noise; one with 9 in-band
                out of 17 is signal. Nothing is excluded &mdash; a thin sample only delays a brand.
              </p>
            </div>
          )}

          <div className="mb-5 p-4 bg-slate-50 border border-slate-200 rounded-lg">
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={skipLowYield}
                onChange={e => setSkipLowYield(e.target.checked)}
                className="mt-0.5 accent-violet-600"
                disabled={busy}
              />
              <span className="text-sm font-medium text-slate-700">
                Skip brands whose last scrape returned fewer than
                <input
                  type="number"
                  value={minLastPostCount}
                  onChange={e => setMinLastPostCount(Math.max(1, parseInt(e.target.value) || 1))}
                  min={1}
                  max={50}
                  className="mx-2 w-16 px-2 py-0.5 border border-slate-300 rounded text-sm"
                  disabled={busy || !skipLowYield}
                />
                posts
                <span className="block text-xs font-normal text-slate-500 mt-1">
                  Dormant, renamed and placeholder handles return 1 post and no candidates, but
                  still cost a scrape. Off by default &mdash; a brand can have a quiet period, and
                  brands never scraped before are always kept.
                </span>
              </span>
            </label>
          </div>

          <div className="mb-5 p-4 bg-slate-50 border border-slate-200 rounded-lg">
            <label className="block text-sm font-medium text-slate-700 mb-1">Follower range</label>
            <p className="text-xs text-slate-500 mb-3">
              Applied after the profile scrape. Creators outside this range are still imported and
              still get their partnership edges &mdash; they are just marked so enrichment,
              intelligence and embeddings skip them. A follower count of 0 means a failed or private
              scrape and is treated as unknown, not out of range.
            </p>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-slate-500 mb-1">Min followers</label>
                <input
                  type="number"
                  value={minFollowers}
                  onChange={e => setMinFollowers(parseInt(e.target.value) || 0)}
                  min={0}
                  step={1000}
                  className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-violet-500"
                  disabled={busy}
                />
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-1">Max followers</label>
                <input
                  type="number"
                  value={maxFollowers}
                  onChange={e => setMaxFollowers(parseInt(e.target.value) || 0)}
                  min={1}
                  step={1000}
                  className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-violet-500"
                  disabled={busy}
                />
              </div>
            </div>
          </div>

          <div className="mb-5">
            <label className="block text-sm font-medium text-slate-700 mb-2">
              Specific brand handles (optional — overrides scope &amp; ordering)
            </label>
            <p className="text-xs text-slate-500 mb-2">
              Separate with spaces, commas or new lines. The @ is optional.
            </p>
            <textarea
              value={handlesInput}
              onChange={e => setHandlesInput(e.target.value)}
              placeholder="@loccitane glossier, tatcha&#10;fenty"
              rows={3}
              className="w-full px-4 py-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-violet-500 font-mono text-sm"
              disabled={busy}
            />
          </div>

          <div className="flex gap-3">
            <button
              onClick={handleStart}
              disabled={busy}
              className="flex-1 px-6 py-4 bg-violet-600 text-white rounded-lg font-medium hover:bg-violet-700 transition-colors disabled:bg-slate-300 disabled:cursor-not-allowed"
            >
              {isStarting ? 'Building queue…' : runner.isRunning ? 'Scraping brand feeds…' : 'Start Brand Feed Discovery'}
            </button>
            {runner.isRunning && (
              <button
                onClick={runner.stop}
                className="px-6 py-4 bg-slate-700 text-white rounded-lg font-medium hover:bg-slate-800 transition-colors"
              >
                Stop
              </button>
            )}
          </div>

          {invalidHandles.length > 0 && (
            <div className="mt-3 p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-900">
              <div className="font-semibold mb-1">
                Skipped {invalidHandles.length} invalid handle{invalidHandles.length === 1 ? '' : 's'} —
                the rest of the list ran normally:
              </div>
              <div className="space-y-0.5">
                {invalidHandles.map((h, i) => (
                  <div key={i}>
                    <span className="font-mono">{h.input.slice(0, 60)}{h.input.length > 60 ? '…' : ''}</span>
                    <span className="opacity-70"> — {h.reason}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {startError && (
            <div className="mt-3 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
              {startError}
            </div>
          )}
          {queueInfo && (
            <div className="mt-3 p-3 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-600">
              {queueInfo}
            </div>
          )}
        </div>

        {/* Progress */}
        {runner.status !== 'idle' && (
          <div className="bg-white rounded-xl shadow-sm p-6 mb-6">
            <h2 className="text-lg font-bold text-slate-800 mb-3">Progress</h2>
            <p className="text-slate-700 mb-3">{runner.message}</p>
            <div className="h-2 bg-slate-100 rounded-full overflow-hidden mb-3">
              <div
                className="h-full bg-violet-500 rounded-full transition-all"
                style={{
                  width: runner.progress.total > 0
                    ? `${(runner.progress.done / runner.progress.total) * 100}%`
                    : '0%',
                }}
              />
            </div>
            <div className="flex gap-4 text-sm">
              <span className="text-green-600 font-medium">✓ {runner.progress.succeeded} done</span>
              {runner.progress.failed > 0 && (
                <span className="text-red-500 font-medium">✗ {runner.progress.failed} failed</span>
              )}
              <span className="text-slate-400">
                {runner.progress.done} / {runner.progress.total}
              </span>
            </div>
          </div>
        )}

        {/* Yield — the number that decides a full sweep */}
        {results.length > 0 && (
          <div className="bg-white rounded-xl shadow-sm p-6 mb-6">
            <h2 className="text-lg font-bold text-slate-800 mb-1">Yield</h2>
            <p className="text-xs text-slate-500 mb-4">
              Averages across {results.length} brand{results.length === 1 ? '' : 's'} scraped this run.
            </p>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
              <div className="text-center">
                <div className="text-3xl font-bold text-green-600">{per(totals.inRange)}</div>
                <div className="text-xs text-slate-500">In range, imported</div>
                <div className="text-xs text-slate-400">{totals.inRange} queued for enrichment</div>
              </div>
              <div className="text-center">
                <div className="text-3xl font-bold text-amber-500">{per(totals.outOfRangeHigh)}</div>
                <div className="text-xs text-slate-500">Above max, recorded only</div>
                <div className="text-xs text-slate-400">{totals.outOfRangeHigh} too big</div>
              </div>
              <div className="text-center">
                <div className="text-3xl font-bold text-sky-500">{per(totals.outOfRangeLow)}</div>
                <div className="text-xs text-slate-500">Below min, recorded only</div>
                <div className="text-xs text-slate-400">{totals.outOfRangeLow} may grow in</div>
              </div>
              <div className="text-center">
                <div className="text-3xl font-bold text-slate-400">{per(totals.entityExcluded)}</div>
                <div className="text-xs text-slate-500">Entity-excluded</div>
                <div className="text-xs text-slate-400">{totals.entityExcluded} never scraped</div>
              </div>
              <div className="text-center">
                <div className="text-3xl font-bold text-violet-600">{per(totals.edges)}</div>
                <div className="text-xs text-slate-500">Edges / brand</div>
                <div className="text-xs text-slate-400">
                  {totals.edges} total{totals.edgesFromExcluded > 0 ? `, ${totals.edgesFromExcluded} from excluded` : ''}
                </div>
              </div>
              <div className="text-center">
                <div className="text-3xl font-bold text-slate-800">{per(totals.known)}</div>
                <div className="text-xs text-slate-500">Known creators / brand</div>
                <div className="text-xs text-slate-400">{totals.stubs} brand stubs created</div>
              </div>
            </div>

            <div className="mt-4 pt-4 border-t border-slate-100 text-xs text-slate-500">
              Of {totals.candidates} candidates across {results.length} brand{results.length === 1 ? '' : 's'}:{' '}
              <strong className="text-slate-700">{totals.entityExcluded}</strong> dropped by the entity filter before any
              scrape, <strong className="text-slate-700">{totals.known}</strong> already known,{' '}
              <strong className="text-green-700">{totals.inRange}</strong> newly imported inside{' '}
              {minFollowers.toLocaleString()}–{maxFollowers.toLocaleString()}, and{' '}
              <strong className="text-amber-600">{totals.outOfRangeHigh}</strong> above it and{' '}
              <strong className="text-sky-600">{totals.outOfRangeLow}</strong> below
              (edges kept, pipelines skipped).
            </div>
          </div>
        )}

        {/* What got skipped on size — visible, not silent, and not conflated */}
        {(samplesHigh.length > 0 || samplesLow.length > 0) && (
          <div className="bg-white rounded-xl shadow-sm p-6 mb-6">
            <h2 className="text-lg font-bold text-slate-800 mb-1">Out-of-range imports</h2>
            <p className="text-xs text-slate-500 mb-5">
              All of these were imported and credited with their partnership edges. They are
              marked so enrichment, intelligence and embeddings skip them.
            </p>

            {samplesHigh.length > 0 && (
              <div className="mb-5">
                <div className="flex items-baseline gap-2 mb-2">
                  <h3 className="text-sm font-semibold text-amber-700">Above max</h3>
                  <span className="text-xs text-slate-400">
                    {totals.outOfRangeHigh} this run &middot; celebrities, brand accounts and mega-creators
                  </span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {samplesHigh.map((c, i) => (
                    <span key={i} className="text-xs bg-amber-50 border border-amber-200 text-amber-800 px-2 py-1 rounded">
                      @{c.handle} &middot; {c.followerCount.toLocaleString()}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {samplesLow.length > 0 && (
              <div>
                <div className="flex items-baseline gap-2 mb-2">
                  <h3 className="text-sm font-semibold text-sky-700">Below min</h3>
                  <span className="text-xs text-slate-400">
                    {totals.outOfRangeLow} this run &middot; may grow into range and be promoted later
                  </span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {samplesLow.map((c, i) => (
                    <span key={i} className="text-xs bg-sky-50 border border-sky-200 text-sky-800 px-2 py-1 rounded">
                      @{c.handle} &middot; {c.followerCount.toLocaleString()}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Field coverage — verifies the basicData decision */}
        {coverage.posts > 0 && (
          <div className="bg-white rounded-xl shadow-sm p-6 mb-6">
            <h2 className="text-lg font-bold text-slate-800 mb-1">
              Field coverage · {detailed ? 'detailedData' : 'basicData'}
            </h2>
            <p className="text-xs text-slate-500 mb-4">
              Share of the {coverage.posts} scraped posts that carried each collaboration field.
              If coauthors and tags are present on basicData, there is no reason to pay for detailedData.
            </p>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {[
                ['coauthorProducers', coverage.withCoauthorProducers],
                ['taggedUsers', coverage.withTaggedUsers],
                ['mentions', coverage.withMentions],
                ['caption', coverage.withCaption],
              ].map(([label, value]) => (
                <div key={label as string} className="text-center">
                  <div className={`text-2xl font-bold ${(value as number) > 0 ? 'text-green-600' : 'text-slate-300'}`}>
                    {pct(value as number, coverage.posts)}
                  </div>
                  <div className="text-xs text-slate-500 font-mono">{label as string}</div>
                  <div className="text-xs text-slate-400">{value as number} posts</div>
                </div>
              ))}
            </div>
            {coverage.withTaggedUsers === 0 && coverage.withCoauthorProducers === 0 && (
              <div className="mt-4 p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800">
                No tags or coauthors came back on any post. If this run used basicData, re-run a
                small batch with detailedData before concluding the brands simply don&apos;t tag.
              </div>
            )}
          </div>
        )}

        {/* Errors */}
        {runner.errors.length > 0 && (
          <div className="bg-white rounded-xl shadow-sm p-6 mb-6">
            <h2 className="text-lg font-bold text-slate-800 mb-3">
              Failures ({runner.errors.length}) — the run continued past these
            </h2>
            <div className="space-y-1 text-sm">
              {runner.errors.map((e, i) => (
                <div key={i} className="text-red-600">
                  <span className="font-mono">{e.item}</span>: {e.message}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Per-brand results */}
        {results.length > 0 && (
          <div className="bg-white rounded-xl shadow-sm p-6">
            <h2 className="text-lg font-bold text-slate-800 mb-4">Results ({results.length})</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200">
                    <th className="text-left py-2 px-3 font-semibold text-slate-700">Brand</th>
                    <th className="text-right py-2 px-3 font-semibold text-slate-700">Posts</th>
                    <th className="text-right py-2 px-3 font-semibold text-slate-700">Candidates</th>
                    <th className="text-right py-2 px-3 font-semibold text-slate-700" title="Dropped by brand_aliases / brands classification, before any profile scrape">Entity&nbsp;excl.</th>
                    <th className="text-right py-2 px-3 font-semibold text-slate-700">Known</th>
                    <th className="text-right py-2 px-3 font-semibold text-slate-700" title="New handles inside the follower range — imported and queued for enrichment">In&nbsp;range</th>
                    <th className="text-right py-2 px-3 font-semibold text-slate-700" title="New handles above the follower max — imported with edges, excluded from pipelines">Above&nbsp;max</th>
                    <th className="text-right py-2 px-3 font-semibold text-slate-700" title="New handles below the follower min — imported with edges, excluded from pipelines; may grow into range later">Below&nbsp;min</th>
                    <th className="text-right py-2 px-3 font-semibold text-slate-700">Edges</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((r, i) => (
                    <tr key={i} className="border-b border-slate-100 hover:bg-slate-50">
                      <td className="py-2 px-3">
                        <a
                          href={`https://instagram.com/${r.handle}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-violet-600 hover:text-violet-800 font-medium"
                        >
                          @{r.handle}
                        </a>
                        {r.brandCreated && (
                          <span className="ml-2 text-xs bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded">
                            stub created
                          </span>
                        )}
                      </td>
                      <td className={`py-2 px-3 text-right ${r.postsScraped <= 1 ? 'text-red-600 font-medium' : 'text-slate-600'}`}>
                        {r.postsScraped}
                        {r.postsScraped <= 1 && (
                          <span className="ml-1 text-xs" title="Returned almost nothing — likely a dormant, renamed or placeholder handle">⚠</span>
                        )}
                      </td>
                      <td className="py-2 px-3 text-right text-slate-600">{r.candidatesFound}</td>
                      <td className="py-2 px-3 text-right text-slate-500">
                        {r.entityExcluded > 0 ? `−${r.entityExcluded}` : '—'}
                      </td>
                      <td className="py-2 px-3 text-right text-slate-600">{r.knownCreators}</td>
                      <td className="py-2 px-3 text-right text-green-600 font-medium">{r.importedInRange}</td>
                      <td className="py-2 px-3 text-right text-amber-600 font-medium">
                        {r.importedOutOfRangeHigh > 0 ? `−${r.importedOutOfRangeHigh}` : '—'}
                      </td>
                      <td className="py-2 px-3 text-right text-sky-600 font-medium">
                        {r.importedOutOfRangeLow > 0 ? `−${r.importedOutOfRangeLow}` : '—'}
                      </td>
                      <td className="py-2 px-3 text-right text-green-600 font-medium">
                        {r.edgesWritten}
                        {r.edgesFromEntityExcluded > 0 && (
                          <span className="text-slate-400" title="Edges from entity-excluded candidates already in the database">
                            {' '}({r.edgesFromEntityExcluded} excl.)
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

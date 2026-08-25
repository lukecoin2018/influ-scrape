'use client';

import { useCallback, useEffect, useState } from 'react';
import { useChunkedRunner } from '@/lib/useChunkedRunner';

// Chunks of 10, 2s apart — the cadence the other batch runners in this app use.
const CHUNK_SIZE = 10;
const CHUNK_DELAY_MS = 2000;

type Scope = 'verified_brands' | 'classified_brands' | 'all_brands';
type Order = 'never_scraped' | 'stale_first' | 'top_creators';

interface QueueItem {
  handle: string;
  brandId: string | null;
  feedScrapedAt: string | null;
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
  knownCreators: number;
  newHandles: number;
  newHandlesSkipped: number;
  creatorsImported: number;
  creatorsFailed: number;
  edgesBuilt: number;
  edgesWritten: number;
  edgesDuplicate: number;
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
];

export default function BrandFeedPage() {
  const [scope, setScope] = useState<Scope>('verified_brands');
  const [order, setOrder] = useState<Order>('never_scraped');
  const [batchSize, setBatchSize] = useState(25);
  const [postsPerBrand, setPostsPerBrand] = useState(12);
  const [detailed, setDetailed] = useState(false);
  const [handlesInput, setHandlesInput] = useState('');
  const [status, setStatus] = useState<StatusData | null>(null);
  const [queueInfo, setQueueInfo] = useState<string>('');
  const [startError, setStartError] = useState<string | null>(null);

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
    async (item: QueueItem): Promise<BrandResult> => {
      const res = await fetch('/api/brand-feed/process', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          handle: item.handle,
          brandId: item.brandId,
          postsPerBrand,
          dataDetailLevel: detailed ? 'detailedData' : 'basicData',
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      return data as BrandResult;
    },
    [postsPerBrand, detailed]
  );

  const labelFor = useCallback((item: QueueItem) => `@${item.handle}`, []);

  const runner = useChunkedRunner<QueueItem, BrandResult>({
    chunkSize: CHUNK_SIZE,
    delayMs: CHUNK_DELAY_MS,
    processItem,
    labelFor,
  });

  const handleStart = async () => {
    setStartError(null);
    setQueueInfo('');
    runner.reset();

    const handles = handlesInput
      .split('\n')
      .map(h => h.trim())
      .filter(Boolean);

    try {
      const res = await fetch('/api/brand-feed/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope, order, batchSize, handles }),
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
          `${data.orphansInQueue} orphan alias${data.orphansInQueue === 1 ? '' : 'es'} (stub rows will be created)`
      );

      await runner.start(data.items as QueueItem[]);
      fetchStatus();
    } catch (err) {
      setStartError(err instanceof Error ? err.message : 'Failed to build queue');
    }
  };

  // ── Aggregates: the numbers that decide whether a full sweep is worth it ──
  const results = runner.results;
  const totals = results.reduce(
    (acc, r) => ({
      posts: acc.posts + r.postsScraped,
      newHandles: acc.newHandles + r.newHandles,
      imported: acc.imported + r.creatorsImported,
      edges: acc.edges + r.edgesWritten,
      known: acc.known + r.knownCreators,
      excluded: acc.excluded + r.candidatesExcluded,
      stubs: acc.stubs + (r.brandCreated ? 1 : 0),
    }),
    { posts: 0, newHandles: 0, imported: 0, edges: 0, known: 0, excluded: 0, stubs: 0 }
  );

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
                      disabled={runner.isRunning}
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
                      disabled={runner.isRunning}
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
                disabled={runner.isRunning}
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
                disabled={runner.isRunning}
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
                  disabled={runner.isRunning}
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

          <div className="mb-5">
            <label className="block text-sm font-medium text-slate-700 mb-2">
              Specific brand handles (optional — overrides scope &amp; ordering)
            </label>
            <textarea
              value={handlesInput}
              onChange={e => setHandlesInput(e.target.value)}
              placeholder="@loccitane&#10;glossier"
              rows={3}
              className="w-full px-4 py-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-violet-500 font-mono text-sm"
              disabled={runner.isRunning}
            />
          </div>

          <div className="flex gap-3">
            <button
              onClick={handleStart}
              disabled={runner.isRunning}
              className="flex-1 px-6 py-4 bg-violet-600 text-white rounded-lg font-medium hover:bg-violet-700 transition-colors disabled:bg-slate-300 disabled:cursor-not-allowed"
            >
              {runner.isRunning ? 'Scraping brand feeds…' : 'Start Brand Feed Discovery'}
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
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="text-center">
                <div className="text-3xl font-bold text-violet-600">{per(totals.newHandles)}</div>
                <div className="text-xs text-slate-500">New handles / brand</div>
                <div className="text-xs text-slate-400">{totals.newHandles} total</div>
              </div>
              <div className="text-center">
                <div className="text-3xl font-bold text-green-600">{per(totals.edges)}</div>
                <div className="text-xs text-slate-500">Edges / brand</div>
                <div className="text-xs text-slate-400">{totals.edges} total</div>
              </div>
              <div className="text-center">
                <div className="text-3xl font-bold text-slate-800">{per(totals.known)}</div>
                <div className="text-xs text-slate-500">Known creators / brand</div>
                <div className="text-xs text-slate-400">{totals.known} total</div>
              </div>
              <div className="text-center">
                <div className="text-3xl font-bold text-amber-500">{totals.imported}</div>
                <div className="text-xs text-slate-500">Creators imported</div>
                <div className="text-xs text-slate-400">{totals.stubs} brand stubs created</div>
              </div>
            </div>
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
                    <th className="text-right py-2 px-3 font-semibold text-slate-700">Known</th>
                    <th className="text-right py-2 px-3 font-semibold text-slate-700">New</th>
                    <th className="text-right py-2 px-3 font-semibold text-slate-700">Imported</th>
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
                      <td className="py-2 px-3 text-right text-slate-600">{r.postsScraped}</td>
                      <td className="py-2 px-3 text-right text-slate-600">
                        {r.candidatesFound}
                        {r.candidatesExcluded > 0 && (
                          <span className="text-slate-400"> (−{r.candidatesExcluded})</span>
                        )}
                      </td>
                      <td className="py-2 px-3 text-right text-slate-600">{r.knownCreators}</td>
                      <td className="py-2 px-3 text-right text-violet-600 font-medium">{r.newHandles}</td>
                      <td className="py-2 px-3 text-right text-slate-600">{r.creatorsImported}</td>
                      <td className="py-2 px-3 text-right text-green-600 font-medium">
                        {r.edgesWritten}
                        {r.edgesDuplicate > 0 && (
                          <span className="text-slate-400"> (+{r.edgesDuplicate} dup)</span>
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

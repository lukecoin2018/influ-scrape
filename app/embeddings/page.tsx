'use client';

import { useState, useEffect } from 'react';

type Mode = 'not_embedded' | 'enriched_first' | 'needs_reembedding' | 're_embed' | 'has_ai_summary' | 'specific';

// Chunk size for /api/embeddings/generate — each HTTP call must stay well
// under Vercel's function duration limit and nginx's proxy timeout, so a
// large run is split into many small requests instead of one huge one.
//
// not_embedded/enriched_first/needs_reembedding/has_ai_summary are
// queue-based: embedded_at (or ai_embedded) is set on every processed
// creator, so each chunk naturally sees the next still-pending batch with no
// offset needed. re_embed has no natural queue-exit filter and is paginated
// via an explicit offset; specific mode is paginated by slicing the handle
// list client-side.
const EMBED_CHUNK = 10;
const EMBED_CHUNK_DELAY_MS = 2000;

interface EmbedStatus {
  total: number;
  embedded: number;
  pending: number;
  enriched_not_embedded: number;
  needs_reembedding: number;
}

interface EmbedResult {
  handle: string;
  status: 'success' | 'error' | 'skipped';
  textLength?: number;
  reason?: string;
}

export default function EmbeddingsPage() {
  const [mode, setMode] = useState<Mode>('not_embedded');
  const [batchSize, setBatchSize] = useState(50);
  const [handlesInput, setHandlesInput] = useState('');
  const [status, setStatus] = useState<EmbedStatus | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [results, setResults] = useState<EmbedResult[]>([]);
  const [progress, setProgress] = useState({ succeeded: 0, failed: 0, skipped: 0, total: 0 });
  const [targetTotal, setTargetTotal] = useState(0);
  const [attemptedCount, setAttemptedCount] = useState(0);
  const [chunkErrors, setChunkErrors] = useState<string[]>([]);
  const [progressMessage, setProgressMessage] = useState('');

  useEffect(() => {
    fetchStatus();
  }, []);

  const fetchStatus = async () => {
    try {
      const res = await fetch('/api/embeddings/status');
      const data = await res.json();
      setStatus(data);
    } catch (err) {
      console.error('Failed to fetch embedding status:', err);
    }
  };

  const startEmbedding = async () => {
    setIsRunning(true);
    setResults([]);
    setChunkErrors([]);
    setProgressMessage('Generating embeddings...');

    const isSpecific = mode === 'specific';
    let pendingHandles = isSpecific
      ? handlesInput.split('\n').map(h => h.trim()).filter(Boolean)
      : [];

    // batchSize is the total the user wants processed this run; requests are
    // split into EMBED_CHUNK-sized calls so no single HTTP request risks a
    // platform timeout. For specific mode the target is capped to the handle
    // count, matching the pre-existing (single-request) truncation behavior.
    const totalTarget = isSpecific ? Math.min(pendingHandles.length, batchSize) : batchSize;

    if (totalTarget === 0) {
      setProgressMessage('No handles to process.');
      setIsRunning(false);
      return;
    }

    setTargetTotal(totalTarget);
    setAttemptedCount(0);
    setProgress({ succeeded: 0, failed: 0, skipped: 0, total: 0 });

    // `attempted` drives progress/pagination (how many slots we've asked
    // for); `processed` is the actual result count. These can differ for
    // specific mode — creators.creator_id dedup (two handles from the same
    // creator) or a not-found handle both yield fewer results than
    // requested — so pagination must advance by what was requested, not by
    // what came back, or a chunk with a few misses would look like "end of
    // data" and stop the run before the remaining handles are processed.
    let attempted = 0;
    let processed = 0;
    let succeeded = 0;
    let failed = 0;
    let skipped = 0;
    let allResults: EmbedResult[] = [];
    const errors: string[] = [];
    let offset = 0;

    const numChunks = Math.ceil(totalTarget / EMBED_CHUNK);

    for (let i = 0; i < numChunks; i++) {
      const remaining = totalTarget - attempted;
      if (remaining <= 0) break;
      const thisChunkSize = Math.min(EMBED_CHUNK, remaining);
      const chunkHandles = isSpecific ? pendingHandles.slice(0, thisChunkSize) : [];

      try {
        const res = await fetch('/api/embeddings/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mode,
            batchSize: thisChunkSize,
            offset,
            handles: chunkHandles,
          }),
        });

        const data = await res.json();

        if (!res.ok) {
          throw new Error(data.error || `HTTP ${res.status}`);
        }

        const chunkResults: EmbedResult[] = data.results || [];
        const chunkCount = chunkResults.length;

        succeeded += data.succeeded || 0;
        failed += data.failed || 0;
        skipped += data.skipped || 0;
        allResults = [...allResults, ...chunkResults];
        processed += chunkCount;
        attempted += thisChunkSize;
        offset += thisChunkSize;

        setResults(allResults);
        setProgress({ succeeded, failed, skipped, total: processed });
        setAttemptedCount(Math.min(attempted, totalTarget));

        if (isSpecific) {
          pendingHandles = pendingHandles.slice(thisChunkSize);
        } else if (chunkCount === 0 || chunkCount < thisChunkSize) {
          // Queue-based/offset modes only: fewer came back than requested
          // means the queue is empty — stop instead of looping through more
          // empty chunks. Specific mode is bounded by pendingHandles instead.
          break;
        }
      } catch (err: any) {
        const msg = `chunk ${i + 1}: ${err.message || 'Unknown error'}`;
        errors.push(msg);
        setChunkErrors([...errors]);
      }

      if (i < numChunks - 1 && attempted < totalTarget) {
        await new Promise(r => setTimeout(r, EMBED_CHUNK_DELAY_MS));
      }
    }

    setProgressMessage(`Complete! ${succeeded} embedded, ${failed} failed, ${skipped} skipped.`);
    setIsRunning(false);
    await fetchStatus();
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100">
      <div className="max-w-4xl mx-auto px-4 py-8">
        <div className="mb-8">
          <h1 className="text-4xl font-bold bg-gradient-to-r from-violet-600 to-purple-600 bg-clip-text text-transparent mb-2">
            Generate Embeddings
          </h1>
          <p className="text-slate-600">Create semantic profiles for AI-powered creator matching</p>
        </div>

        {/* Navigation */}
        <div className="flex gap-2 mb-6 flex-wrap">
          <a href="/" className="px-4 py-2 bg-slate-200 text-slate-700 rounded-lg font-medium hover:bg-slate-300 transition-colors">Discovery</a>
          <a href="/add" className="px-4 py-2 bg-slate-200 text-slate-700 rounded-lg font-medium hover:bg-slate-300 transition-colors">Add Creators</a>
          <a href="/import" className="px-4 py-2 bg-slate-200 text-slate-700 rounded-lg font-medium hover:bg-slate-300 transition-colors">Import</a>
          <a href="/enrich" className="px-4 py-2 bg-slate-200 text-slate-700 rounded-lg font-medium hover:bg-slate-300 transition-colors">Enrich</a>
          <a href="/embeddings" className="px-4 py-2 bg-violet-600 text-white rounded-lg font-medium">Embeddings</a>
          <a href="/intelligence" className="px-4 py-2 bg-slate-200 text-slate-700 rounded-lg font-medium hover:bg-slate-300 transition-colors">Intelligence</a>
          <a href="/database" className="px-4 py-2 bg-slate-200 text-slate-700 rounded-lg font-medium hover:bg-slate-300 transition-colors">Creators</a>
          <a href="/brands" className="px-4 py-2 bg-slate-200 text-slate-700 rounded-lg font-medium hover:bg-slate-300 transition-colors">Brands</a>
        </div>

        {/* Status Card */}
        {status && (
          <div className="bg-white rounded-xl shadow-sm p-6 mb-6">
            <h2 className="text-lg font-bold text-slate-800 mb-4">Database Status</h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
              <div className="text-center">
                <div className="text-3xl font-bold text-slate-800">{status.total.toLocaleString()}</div>
                <div className="text-sm text-slate-500">Total Creators</div>
              </div>
              <div className="text-center">
                <div className="text-3xl font-bold text-green-600">{status.embedded.toLocaleString()}</div>
                <div className="text-sm text-slate-500">Embedded</div>
              </div>
              <div className="text-center">
                <div className="text-3xl font-bold text-amber-500">{status.pending.toLocaleString()}</div>
                <div className="text-sm text-slate-500">Pending</div>
              </div>
              <div className="text-center">
                <div className="text-3xl font-bold text-violet-600">{status.enriched_not_embedded.toLocaleString()}</div>
                <div className="text-sm text-slate-500">Enriched & Pending</div>
              </div>
            </div>
            <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
              <div
                className="h-full bg-violet-500 rounded-full transition-all"
                style={{ width: status.total > 0 ? `${(status.embedded / status.total) * 100}%` : '0%' }}
              />
            </div>
            {status.enriched_not_embedded > 0 && (
              <p className="text-xs text-violet-600 mt-2">
                💡 {status.enriched_not_embedded} enriched creators are waiting — use "Enriched first" for better quality embeddings
              </p>
            )}
          </div>
        )}

        {/* Config Panel */}
        <div className="bg-white rounded-xl shadow-sm p-6 mb-6">
          {/* Mode */}
          <div className="mb-5">
            <label className="block text-sm font-medium text-slate-700 mb-2">Mode</label>
            <div className="space-y-2">
              {([
                { value: 'not_embedded', label: 'Not yet embedded', desc: 'Creators without embeddings, highest followers first' },
                { value: 'enriched_first', label: 'Enriched first', desc: 'Prioritize creators with post data — produces better embeddings' },
                { value: 'needs_reembedding', label: 'Needs re-embedding (stale)', desc: 'Re-analyzed more recently than their last embedding' },
                { value: 'has_ai_summary', label: 'Re-embed with AI summary', desc: 'Re-embed creators that have an AI summary — includes language, location & summary for richer search', highlight: true },
                { value: 're_embed', label: 'Re-embed all', desc: 'Regenerate all existing embeddings' },
                { value: 'specific', label: 'Specific creators', desc: 'Paste handles below' },
              ] as { value: Mode; label: string; desc: string; highlight?: boolean }[]).map(opt => (
                <label key={opt.value} className={`flex items-start gap-3 cursor-pointer p-3 rounded-lg hover:bg-slate-50 ${opt.highlight ? 'border border-violet-200 bg-violet-50 hover:bg-violet-50' : ''}`}>
                  <input
                    type="radio"
                    name="mode"
                    value={opt.value}
                    checked={mode === opt.value}
                    onChange={() => setMode(opt.value)}
                    className="mt-0.5 accent-violet-600"
                    disabled={isRunning}
                  />
                  <div className="flex-1">
                    <div className={`font-medium text-sm flex items-center gap-2 ${opt.highlight ? 'text-violet-700' : 'text-slate-800'}`}>
                      {opt.label}
                      {opt.highlight && <span className="text-xs bg-violet-100 text-violet-600 px-1.5 py-0.5 rounded font-medium">recommended</span>}
                    </div>
                    <div className="text-xs text-slate-500">{opt.desc}</div>
                  </div>
                  {opt.value === 'needs_reembedding' && status && (
                    <span className="text-xs font-medium text-amber-600 bg-amber-50 px-2 py-0.5 rounded-full mt-0.5">
                      {status.needs_reembedding.toLocaleString()} stale
                    </span>
                  )}
                </label>
              ))}
            </div>
          </div>

          {/* Specific handles */}
          {mode === 'specific' && (
            <div className="mb-5">
              <label className="block text-sm font-medium text-slate-700 mb-2">Handles (one per line)</label>
              <textarea
                value={handlesInput}
                onChange={e => setHandlesInput(e.target.value)}
                placeholder="@fashiongirl&#10;styleblogger"
                rows={5}
                className="w-full px-4 py-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-violet-500 font-mono text-sm"
                disabled={isRunning}
              />
            </div>
          )}

          {/* Batch size */}
          {mode !== 'specific' && (
            <div className="mb-5">
              <label className="block text-sm font-medium text-slate-700 mb-2">Batch Size</label>
              <input
                type="number"
                value={batchSize}
                onChange={e => setBatchSize(parseInt(e.target.value) || 50)}
                min={1}
                max={500}
                className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-violet-500"
                disabled={isRunning}
              />
              <p className="text-xs text-slate-500 mt-1">
                Est. cost: ~${((batchSize * 300) / 1000000 * 0.02).toFixed(4)} (negligible)
              </p>
              <p className="text-xs text-slate-500 mt-1">
                Processed in chunks of {EMBED_CHUNK}, {EMBED_CHUNK_DELAY_MS / 1000}s apart — a large batch runs as several short requests instead of one long one.
              </p>
            </div>
          )}

          {mode === 'has_ai_summary' && (
            <div className="mb-5 p-3 bg-violet-50 border border-violet-200 rounded-lg text-xs text-violet-800">
              <strong>What's included in each embedding:</strong> bio, followers, engagement, content mix, hashtags, brand partnerships, <strong>+ AI summary, language, and location</strong>. This produces significantly richer semantic search results.
            </div>
          )}

          <button
            onClick={startEmbedding}
            disabled={isRunning || (mode === 'specific' && !handlesInput.trim())}
            className="w-full px-6 py-4 bg-violet-600 text-white rounded-lg font-medium hover:bg-violet-700 transition-colors disabled:bg-slate-300 disabled:cursor-not-allowed"
          >
            {isRunning ? 'Generating embeddings...' : 'Generate Embeddings'}
          </button>
        </div>

        {/* Progress */}
        {progressMessage && (
          <div className="bg-white rounded-xl shadow-sm p-6 mb-6">
            <h2 className="text-lg font-bold text-slate-800 mb-3">Progress</h2>
            <p className="text-slate-700 mb-3">{progressMessage}</p>
            {isRunning && targetTotal > 0 && (
              <>
                <div className="flex justify-between text-xs text-slate-500 mb-1">
                  <span>Processing {attemptedCount}/{targetTotal}…</span>
                  <span>{Math.round((attemptedCount / targetTotal) * 100)}%</span>
                </div>
                <div className="h-2 bg-slate-100 rounded-full overflow-hidden mb-3">
                  <div
                    className="h-full bg-violet-500 rounded-full transition-all duration-500"
                    style={{ width: `${Math.round((attemptedCount / targetTotal) * 100)}%` }}
                  />
                </div>
              </>
            )}
            {progress.total > 0 && (
              <div className="flex gap-4 text-sm">
                <span className="text-green-600 font-medium">✓ {progress.succeeded} embedded</span>
                {progress.failed > 0 && <span className="text-red-500 font-medium">✗ {progress.failed} failed</span>}
                {progress.skipped > 0 && <span className="text-slate-500">⚡ {progress.skipped} skipped</span>}
              </div>
            )}
          </div>
        )}

        {chunkErrors.length > 0 && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3 mb-6 text-xs text-red-700 space-y-0.5">
            <div className="font-semibold mb-1">Chunk errors (run continued):</div>
            {chunkErrors.map((e, i) => <div key={i}>{e}</div>)}
          </div>
        )}

        {/* Results */}
        {results.length > 0 && (
          <div className="bg-white rounded-xl shadow-sm p-6">
            <h2 className="text-lg font-bold text-slate-800 mb-4">Results ({results.length})</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200">
                    <th className="text-left py-2 px-3 font-semibold text-slate-700">Handle</th>
                    <th className="text-right py-2 px-3 font-semibold text-slate-700">Text Length</th>
                    <th className="text-left py-2 px-3 font-semibold text-slate-700">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((r, i) => (
                    <tr key={i} className="border-b border-slate-100 hover:bg-slate-50">
                      <td className="py-2 px-3 text-violet-600 font-medium">@{r.handle}</td>
                      <td className="py-2 px-3 text-right text-slate-500">
                        {r.textLength ? `${r.textLength} chars` : '-'}
                      </td>
                      <td className="py-2 px-3">
                        {r.status === 'success' && <span className="text-green-600 text-xs">✓ Embedded</span>}
                        {r.status === 'error' && <span className="text-red-500 text-xs">✗ {r.reason}</span>}
                        {r.status === 'skipped' && <span className="text-slate-400 text-xs">⚡ {r.reason}</span>}
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

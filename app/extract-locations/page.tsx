'use client';

import { useState } from 'react';

interface DebugRow {
  handle: string;
  country: string | null;
  city: string | null;
  confidence: number | null;
  status: 'updated' | 'skipped' | 'failed';
}

interface ChunkResult {
  updated: number;
  skipped: number;
  failed: number;
  total: number;
  byCountry: Record<string, number>;
  debug?: DebugRow[];
}

interface AggResult {
  updated: number;
  skipped: number;
  failed: number;
  processed: number;
  byCountry: Record<string, number>;
  debugRows: DebugRow[];
}

const CHUNK_SIZE = 20;
const BATCH_SIZE = 40; // creators per Full Run click (2 chunks of 20)

export default function ExtractLocationsPage() {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [agg, setAgg] = useState<AggResult | null>(null);
  const [chunkErrors, setChunkErrors] = useState<string[]>([]);
  const [done, setDone] = useState(false);
  // Tracks the next offset for "Run Next 100"
  const [nextOffset, setNextOffset] = useState(0);

  const reset = () => {
    setAgg(null);
    setChunkErrors([]);
    setProgress(null);
    setDone(false);
    setNextOffset(0);
  };

  const runSingle = async (dryRun: boolean, limit: number, offset = 0, random = false): Promise<ChunkResult | null> => {
    const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    if (dryRun) params.set('dryRun', 'true');
    if (random) params.set('random', 'true');
    const res = await fetch(`/api/extract-locations?${params}`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    return res.json();
  };

  const mergeCountries = (
    base: Record<string, number>,
    incoming: Record<string, number>
  ): Record<string, number> => {
    const merged = { ...base };
    for (const [country, count] of Object.entries(incoming)) {
      merged[country] = (merged[country] || 0) + count;
    }
    return merged;
  };

  const runDry = async () => {
    reset();
    setRunning(true);
    try {
      const result = await runSingle(true, 10);
      if (result) {
        setAgg({
          updated: result.updated,
          skipped: result.skipped,
          failed: result.failed,
          processed: result.total,
          byCountry: result.byCountry,
          debugRows: result.debug ?? [],
        });
      }
    } catch (err) {
      setChunkErrors([err instanceof Error ? err.message : 'Unknown error']);
    } finally {
      setRunning(false);
      setDone(true);
    }
  };

  const runTest = async () => {
    reset();
    setRunning(true);
    try {
      const result = await runSingle(false, 20, 0, true); // random=true
      if (result) {
        setAgg({
          updated: result.updated,
          skipped: result.skipped,
          failed: result.failed,
          processed: result.total,
          byCountry: result.byCountry,
          debugRows: result.debug ?? [],
        });
      }
    } catch (err) {
      setChunkErrors([err instanceof Error ? err.message : 'Unknown error']);
    } finally {
      setRunning(false);
      setDone(true);
    }
  };

  const runBatch = async (startOffset: number) => {
    setRunning(true);
    setDone(false);
    setProgress({ done: 0, total: BATCH_SIZE });

    const endOffset = startOffset + BATCH_SIZE;
    const errors: string[] = [];
    let exhausted = false;

    for (let offset = startOffset; offset < endOffset; offset += CHUNK_SIZE) {
      try {
        const result = await runSingle(false, CHUNK_SIZE, offset);
        if (result) {
          setAgg((prev) => {
            const base = prev ?? { updated: 0, skipped: 0, failed: 0, processed: 0, byCountry: {}, debugRows: [] };
            return {
              updated: base.updated + result.updated,
              skipped: base.skipped + result.skipped,
              failed: base.failed + result.failed,
              processed: base.processed + result.total,
              byCountry: mergeCountries(base.byCountry, result.byCountry),
              debugRows: [...base.debugRows, ...(result.debug ?? [])],
            };
          });
          if (result.total < CHUNK_SIZE) {
            exhausted = true;
            setProgress({ done: BATCH_SIZE, total: BATCH_SIZE });
            break;
          }
        }
      } catch (err) {
        const msg = `offset ${offset}: ${err instanceof Error ? err.message : 'Unknown error'}`;
        errors.push(msg);
        setChunkErrors((prev) => [...prev, msg]);
      }

      const doneInBatch = offset - startOffset + CHUNK_SIZE;
      setProgress({ done: Math.min(doneInBatch, BATCH_SIZE), total: BATCH_SIZE });

      // 3s pause between chunks (skip after last)
      if (offset + CHUNK_SIZE < endOffset && !exhausted) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }

    setNextOffset(exhausted ? -1 : endOffset);
    setRunning(false);
    setDone(true);
  };

  const runFull = () => {
    setChunkErrors([]);
    setProgress(null);
    runBatch(nextOffset);
  };

  const sortedCountries = agg
    ? Object.entries(agg.byCountry).sort((a, b) => b[1] - a[1])
    : [];

  const progressPct =
    progress && progress.total > 0
      ? Math.round((progress.done / progress.total) * 100)
      : 0;

  return (
    <div className="min-h-screen bg-gray-950 text-white p-8">
      <div className="max-w-3xl mx-auto">
        <h1 className="text-2xl font-bold mb-2">Extract Locations</h1>
        <p className="text-gray-400 mb-8 text-sm">
          Uses Claude to extract country/city from AI summaries where{' '}
          <code className="text-gray-300">detected_country</code> is NULL.
          Test Run picks 20 random creators. Full Run processes 40 sequentially per click.
        </p>

        <div className="flex gap-3 mb-8 flex-wrap">
          <button
            onClick={runDry}
            disabled={running}
            className="px-4 py-2 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 rounded font-medium text-sm"
          >
            Dry Run (10)
          </button>
          <button
            onClick={runTest}
            disabled={running}
            className="px-4 py-2 bg-blue-700 hover:bg-blue-600 disabled:opacity-50 rounded font-medium text-sm"
          >
            Test Run (20)
          </button>
          {/* First run: "Run 100" / subsequent: "Run Next 100" */}
          {nextOffset !== -1 && (
            <button
              onClick={runFull}
              disabled={running}
              className="px-4 py-2 bg-green-700 hover:bg-green-600 disabled:opacity-50 rounded font-medium text-sm"
            >
              {nextOffset === 0 ? 'Run 40' : `Run Next 40 (offset ${nextOffset})`}
            </button>
          )}
          {/* Reset button shown once a run has started */}
          {(agg || nextOffset > 0) && (
            <button
              onClick={reset}
              disabled={running}
              className="px-4 py-2 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 rounded font-medium text-sm text-gray-400"
            >
              Reset
            </button>
          )}
        </div>

        {/* Progress bar */}
        {running && progress && (
          <div className="mb-6">
            <div className="flex justify-between text-sm text-gray-400 mb-1">
              <span>Processing {progress.done}/{progress.total} in this batch...</span>
              <span>{progressPct}%</span>
            </div>
            <div className="w-full bg-gray-800 rounded-full h-2">
              <div
                className="bg-green-500 h-2 rounded-full transition-all duration-500"
                style={{ width: `${progressPct}%` }}
              />
            </div>
          </div>
        )}

        {running && !progress && (
          <div className="text-yellow-400 text-sm mb-6 animate-pulse">Running...</div>
        )}

        {done && !running && (
          <div className="text-green-400 text-sm mb-4">
            {nextOffset === -1 ? 'Done — no more creators to process.' : `Batch done. Click "Run Next 40" to continue.`}
          </div>
        )}

        {chunkErrors.length > 0 && (
          <div className="bg-red-900/40 border border-red-700 rounded p-4 mb-6 text-red-300 text-sm space-y-1">
            <div className="font-semibold mb-1">Chunk errors (run continued past these):</div>
            {chunkErrors.map((e, i) => <div key={i}>{e}</div>)}
          </div>
        )}

        {agg && (
          <div className="space-y-6">
            <div className="grid grid-cols-3 gap-4">
              <div className="bg-gray-800 rounded p-4 text-center">
                <div className="text-3xl font-bold text-green-400">{agg.updated}</div>
                <div className="text-gray-400 text-sm mt-1">Updated</div>
              </div>
              <div className="bg-gray-800 rounded p-4 text-center">
                <div className="text-3xl font-bold text-yellow-400">{agg.skipped}</div>
                <div className="text-gray-400 text-sm mt-1">Skipped</div>
              </div>
              <div className="bg-gray-800 rounded p-4 text-center">
                <div className="text-3xl font-bold text-red-400">{agg.failed}</div>
                <div className="text-gray-400 text-sm mt-1">Failed</div>
              </div>
            </div>

            <div className="text-gray-400 text-sm">
              Processed {agg.processed} profiles so far.
            </div>

            {sortedCountries.length > 0 && (
              <div>
                <h2 className="text-lg font-semibold mb-3">Country Breakdown</h2>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-gray-400 border-b border-gray-700">
                      <th className="text-left py-2">Country</th>
                      <th className="text-right py-2">Count</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedCountries.map(([country, count]) => (
                      <tr key={country} className="border-b border-gray-800">
                        <td className="py-2">{country}</td>
                        <td className="py-2 text-right text-gray-300">{count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {agg.debugRows.length > 0 && (
              <div>
                <h2 className="text-lg font-semibold mb-3">Per-Creator Debug</h2>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-gray-400 border-b border-gray-700">
                      <th className="text-left py-2">Handle</th>
                      <th className="text-left py-2">Country</th>
                      <th className="text-left py-2">City</th>
                      <th className="text-right py-2">Confidence</th>
                      <th className="text-right py-2">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {agg.debugRows.map((row, i) => (
                      <tr key={i} className="border-b border-gray-800">
                        <td className="py-1.5 text-gray-300">@{row.handle}</td>
                        <td className="py-1.5">{row.country ?? <span className="text-gray-600">—</span>}</td>
                        <td className="py-1.5 text-gray-400">{row.city ?? <span className="text-gray-600">—</span>}</td>
                        <td className="py-1.5 text-right font-mono text-xs">
                          {row.confidence !== null ? row.confidence.toFixed(2) : <span className="text-gray-600">—</span>}
                        </td>
                        <td className="py-1.5 text-right">
                          <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${
                            row.status === 'updated' ? 'bg-green-900 text-green-300' :
                            row.status === 'skipped' ? 'bg-yellow-900 text-yellow-300' :
                            'bg-red-900 text-red-300'
                          }`}>
                            {row.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

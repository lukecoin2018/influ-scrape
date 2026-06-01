'use client';

import { useState } from 'react';

interface ChunkResult {
  updated: number;
  skipped: number;
  failed: number;
  total: number;
  byCountry: Record<string, number>;
}

interface AggResult {
  updated: number;
  skipped: number;
  failed: number;
  processed: number;
  byCountry: Record<string, number>;
}

const CHUNK_SIZE = 20;
const FULL_RUN_TOTAL = 2316;

export default function ExtractLocationsPage() {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [agg, setAgg] = useState<AggResult | null>(null);
  const [chunkErrors, setChunkErrors] = useState<string[]>([]);
  const [done, setDone] = useState(false);

  const reset = () => {
    setAgg(null);
    setChunkErrors([]);
    setProgress(null);
    setDone(false);
  };

  const runSingle = async (dryRun: boolean, limit: number, offset = 0): Promise<ChunkResult | null> => {
    const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    if (dryRun) params.set('dryRun', 'true');
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
      const result = await runSingle(false, 20);
      if (result) {
        setAgg({
          updated: result.updated,
          skipped: result.skipped,
          failed: result.failed,
          processed: result.total,
          byCountry: result.byCountry,
        });
      }
    } catch (err) {
      setChunkErrors([err instanceof Error ? err.message : 'Unknown error']);
    } finally {
      setRunning(false);
      setDone(true);
    }
  };

  const runFull = async () => {
    reset();
    setRunning(true);
    setProgress({ done: 0, total: FULL_RUN_TOTAL });

    let accumulated: AggResult = { updated: 0, skipped: 0, failed: 0, processed: 0, byCountry: {} };
    const errors: string[] = [];

    for (let offset = 0; offset < FULL_RUN_TOTAL; offset += CHUNK_SIZE) {
      try {
        const result = await runSingle(false, CHUNK_SIZE, offset);
        if (result) {
          accumulated = {
            updated: accumulated.updated + result.updated,
            skipped: accumulated.skipped + result.skipped,
            failed: accumulated.failed + result.failed,
            processed: accumulated.processed + result.total,
            byCountry: mergeCountries(accumulated.byCountry, result.byCountry),
          };
          setAgg({ ...accumulated });
        }
        // If this chunk returned fewer rows than requested, we've exhausted the table
        if (!result || result.total < CHUNK_SIZE) {
          setProgress({ done: FULL_RUN_TOTAL, total: FULL_RUN_TOTAL });
          break;
        }
      } catch (err) {
        const msg = `offset ${offset}: ${err instanceof Error ? err.message : 'Unknown error'}`;
        errors.push(msg);
        setChunkErrors([...errors]);
      }

      setProgress({ done: Math.min(offset + CHUNK_SIZE, FULL_RUN_TOTAL), total: FULL_RUN_TOTAL });

      // 2s pause between chunks (skip after last)
      if (offset + CHUNK_SIZE < FULL_RUN_TOTAL) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }

    setRunning(false);
    setDone(true);
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
          Each API call processes 20 creators (4 batches of 5).
        </p>

        <div className="flex gap-3 mb-8">
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
          <button
            onClick={runFull}
            disabled={running}
            className="px-4 py-2 bg-green-700 hover:bg-green-600 disabled:opacity-50 rounded font-medium text-sm"
          >
            Full Run
          </button>
        </div>

        {/* Progress bar */}
        {running && progress && (
          <div className="mb-6">
            <div className="flex justify-between text-sm text-gray-400 mb-1">
              <span>Processing {progress.done}/{progress.total}...</span>
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
          <div className="text-green-400 text-sm mb-4">Done.</div>
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
          </div>
        )}
      </div>
    </div>
  );
}

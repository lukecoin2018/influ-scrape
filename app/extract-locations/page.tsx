'use client';

import { useState } from 'react';

interface RunResult {
  updated: number;
  skipped: number;
  failed: number;
  total: number;
  byCountry: Record<string, number>;
  dryRun?: boolean;
}

export default function ExtractLocationsPage() {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (dryRun: boolean, limit: number) => {
    setRunning(true);
    setResult(null);
    setError(null);

    try {
      const params = new URLSearchParams({ limit: String(limit) });
      if (dryRun) params.set('dryRun', 'true');

      const res = await fetch(`/api/extract-locations?${params}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      setResult(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setRunning(false);
    }
  };

  const sortedCountries = result
    ? Object.entries(result.byCountry).sort((a, b) => b[1] - a[1])
    : [];

  return (
    <div className="min-h-screen bg-gray-950 text-white p-8">
      <div className="max-w-3xl mx-auto">
        <h1 className="text-2xl font-bold mb-2">Extract Locations</h1>
        <p className="text-gray-400 mb-8 text-sm">
          Uses Claude to extract country/city from AI summaries where{' '}
          <code className="text-gray-300">detected_country</code> is NULL.
        </p>

        <div className="flex gap-3 mb-8">
          <button
            onClick={() => run(true, 10)}
            disabled={running}
            className="px-4 py-2 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 rounded font-medium text-sm"
          >
            Dry Run (10)
          </button>
          <button
            onClick={() => run(false, 50)}
            disabled={running}
            className="px-4 py-2 bg-blue-700 hover:bg-blue-600 disabled:opacity-50 rounded font-medium text-sm"
          >
            Test Run (50)
          </button>
          <button
            onClick={() => run(false, 2316)}
            disabled={running}
            className="px-4 py-2 bg-green-700 hover:bg-green-600 disabled:opacity-50 rounded font-medium text-sm"
          >
            Full Run (2316)
          </button>
        </div>

        {running && (
          <div className="text-yellow-400 text-sm mb-6 animate-pulse">Running... this may take a while.</div>
        )}

        {error && (
          <div className="bg-red-900/40 border border-red-700 rounded p-4 mb-6 text-red-300 text-sm">
            {error}
          </div>
        )}

        {result && (
          <div className="space-y-6">
            {result.dryRun && (
              <div className="bg-yellow-900/30 border border-yellow-700 rounded p-3 text-yellow-300 text-sm">
                Dry run — no changes written to database.
              </div>
            )}

            <div className="grid grid-cols-3 gap-4">
              <div className="bg-gray-800 rounded p-4 text-center">
                <div className="text-3xl font-bold text-green-400">{result.updated}</div>
                <div className="text-gray-400 text-sm mt-1">Updated</div>
              </div>
              <div className="bg-gray-800 rounded p-4 text-center">
                <div className="text-3xl font-bold text-yellow-400">{result.skipped}</div>
                <div className="text-gray-400 text-sm mt-1">Skipped</div>
              </div>
              <div className="bg-gray-800 rounded p-4 text-center">
                <div className="text-3xl font-bold text-red-400">{result.failed}</div>
                <div className="text-gray-400 text-sm mt-1">Failed</div>
              </div>
            </div>

            <div className="text-gray-400 text-sm">
              Processed {result.total} profiles total.
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

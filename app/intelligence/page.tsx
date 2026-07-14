'use client';

import { useState, useEffect, useRef } from 'react';

// ---------------------------------------------------------------------------
// Location extraction types (mirrors app/api/extract-locations/route.ts)
// ---------------------------------------------------------------------------
interface LocChunkResult {
  updated: number;
  skipped: number;
  failed: number;
  total: number;
  byCountry: Record<string, number>;
}

interface LocAgg {
  updated: number;
  skipped: number;
  failed: number;
  processed: number;
  byCountry: Record<string, number>;
}

const LOC_CHUNK = 20;
const LOC_FULL_TOTAL = 2316;

interface StatusData {
  total: number;
  analyzed: number;
  pending: number;
  with_email: number;
  with_location: number;
  with_ai_summary: number;
  needs_reanalysis: number;
}

interface ResultRow {
  handle: string;
  platform: string;
  language: string | null;
  country: string | null;
  city: string | null;
  email: string | null;
  website: string | null;
  aiSummary: boolean;
  error?: string;
}

interface RunResult {
  succeeded: number;
  failed: number;
  total: number;
  results: ResultRow[];
}

export default function IntelligencePage() {
  const [status, setStatus] = useState<StatusData | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);

  // Options
  const [mode, setMode] = useState<'not_analyzed' | 'enriched_first' | 'needs_reanalysis' | 're_analyze_all' | 'missing_ai_summary' | 'specific'>('not_analyzed');
  const [batchSize, setBatchSize] = useState(50);
  const [doEmails, setDoEmails] = useState(true);
  const [doLanguage, setDoLanguage] = useState(true);
  const [doLocation, setDoLocation] = useState(true);
  const [doAI, setDoAI] = useState(false);
  const [specificHandles, setSpecificHandles] = useState('');

  // Run state
  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState<RunResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [currentBatch, setCurrentBatch] = useState(0);
  const [totalBatches, setTotalBatches] = useState(0);
  const resultsEndRef = useRef<HTMLDivElement>(null);

  // Location extraction state
  const [locRunning, setLocRunning] = useState(false);
  const [locAgg, setLocAgg] = useState<LocAgg | null>(null);
  const [locProgress, setLocProgress] = useState<{ done: number; total: number } | null>(null);
  const [locErrors, setLocErrors] = useState<string[]>([]);
  const [locDone, setLocDone] = useState(false);

  const fetchStatus = async () => {
    setLoadingStatus(true);
    try {
      const res = await fetch('/api/intelligence/status');
      const data = await res.json();
      setStatus(data);
    } catch {
      // silently fail — UI still usable
    } finally {
      setLoadingStatus(false);
    }
  };

  useEffect(() => {
    fetchStatus();
  }, []);

  const handleRun = async () => {
    setRunning(true);
    setError(null);
    setRunResult(null);

    const handles = mode === 'specific'
      ? specificHandles.split(',').map((h) => h.trim().replace(/^@/, '')).filter(Boolean)
      : [];

    // Calculate how many batches to run (for pending count estimation)
    const pending = status?.pending ?? 0;
    const batches = Math.ceil(Math.min(pending, batchSize) / batchSize) || 1;
    setTotalBatches(batches);
    setCurrentBatch(1);

    try {
      const res = await fetch('/api/intelligence/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode,
          batchSize,
          extractEmails: doEmails,
          detectLanguage: doLanguage,
          detectLocation: doLocation,
          generateAISummary: doAI,
          handles,
        }),
      });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || `HTTP ${res.status}`);
      }

      const data: RunResult = await res.json();
      setRunResult(data);
      await fetchStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error occurred');
    } finally {
      setRunning(false);
      setCurrentBatch(0);
      setTotalBatches(0);
    }
  };

  // ---------------------------------------------------------------------------
  // Location extraction helpers
  // ---------------------------------------------------------------------------
  const locMergeCountries = (
    base: Record<string, number>,
    inc: Record<string, number>
  ): Record<string, number> => {
    const merged = { ...base };
    for (const [c, n] of Object.entries(inc)) merged[c] = (merged[c] || 0) + n;
    return merged;
  };

  const locFetchChunk = async (
    dryRun: boolean,
    limit: number,
    offset: number
  ): Promise<LocChunkResult> => {
    const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    if (dryRun) params.set('dryRun', 'true');
    const res = await fetch(`/api/extract-locations?${params}`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    return res.json();
  };

  const runLocDry = async () => {
    setLocAgg(null); setLocErrors([]); setLocProgress(null); setLocDone(false);
    setLocRunning(true);
    try {
      const r = await locFetchChunk(true, 10, 0);
      setLocAgg({ updated: r.updated, skipped: r.skipped, failed: r.failed, processed: r.total, byCountry: r.byCountry });
    } catch (err) {
      setLocErrors([err instanceof Error ? err.message : 'Unknown error']);
    } finally {
      setLocRunning(false); setLocDone(true);
    }
  };

  const runLocTest = async () => {
    setLocAgg(null); setLocErrors([]); setLocProgress(null); setLocDone(false);
    setLocRunning(true);
    try {
      const r = await locFetchChunk(false, 20, 0);
      setLocAgg({ updated: r.updated, skipped: r.skipped, failed: r.failed, processed: r.total, byCountry: r.byCountry });
    } catch (err) {
      setLocErrors([err instanceof Error ? err.message : 'Unknown error']);
    } finally {
      setLocRunning(false); setLocDone(true);
    }
  };

  const runLocFull = async () => {
    setLocAgg(null); setLocErrors([]); setLocProgress({ done: 0, total: LOC_FULL_TOTAL }); setLocDone(false);
    setLocRunning(true);
    let acc: LocAgg = { updated: 0, skipped: 0, failed: 0, processed: 0, byCountry: {} };
    const errors: string[] = [];
    for (let offset = 0; offset < LOC_FULL_TOTAL; offset += LOC_CHUNK) {
      try {
        const r = await locFetchChunk(false, LOC_CHUNK, offset);
        acc = { updated: acc.updated + r.updated, skipped: acc.skipped + r.skipped, failed: acc.failed + r.failed, processed: acc.processed + r.total, byCountry: locMergeCountries(acc.byCountry, r.byCountry) };
        setLocAgg({ ...acc });
        if (!r || r.total < LOC_CHUNK) { setLocProgress({ done: LOC_FULL_TOTAL, total: LOC_FULL_TOTAL }); break; }
      } catch (err) {
        const msg = `offset ${offset}: ${err instanceof Error ? err.message : 'Unknown error'}`;
        errors.push(msg); setLocErrors([...errors]);
      }
      setLocProgress({ done: Math.min(offset + LOC_CHUNK, LOC_FULL_TOTAL), total: LOC_FULL_TOTAL });
      if (offset + LOC_CHUNK < LOC_FULL_TOTAL) await new Promise((r) => setTimeout(r, 2000));
    }
    setLocRunning(false); setLocDone(true);
  };

  const locationDetected = (status?.with_location ?? 0);
  const emailDetected = (status?.with_email ?? 0);
  const aiGenerated = (status?.with_ai_summary ?? 0);
  const pctAnalyzed = status?.total ? Math.round(((status.analyzed) / status.total) * 100) : 0;

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100">
      <div className="max-w-7xl mx-auto px-4 py-8">

        {/* Header */}
        <div className="mb-8">
          <h1 className="text-4xl font-bold text-slate-900 mb-2">Creator Intelligence</h1>
          <p className="text-slate-600">
            Extract language, location, contact info, and AI summaries from existing data.
          </p>
        </div>

        {/* Nav */}
        <div className="flex flex-wrap gap-2 mb-6">
          <a href="/" className="px-4 py-2 bg-slate-200 text-slate-700 rounded-lg font-medium hover:bg-slate-300 transition-colors">Discovery</a>
          <a href="/database" className="px-4 py-2 bg-slate-200 text-slate-700 rounded-lg font-medium hover:bg-slate-300 transition-colors">Creators</a>
          <a href="/brands" className="px-4 py-2 bg-slate-200 text-slate-700 rounded-lg font-medium hover:bg-slate-300 transition-colors">Brands</a>
          <a href="/import" className="px-4 py-2 bg-slate-200 text-slate-700 rounded-lg font-medium hover:bg-slate-300 transition-colors">Import</a>
          <a href="/add" className="px-4 py-2 bg-slate-200 text-slate-700 rounded-lg font-medium hover:bg-slate-300 transition-colors">Add Creators</a>
          <a href="/enrich" className="px-4 py-2 bg-slate-200 text-slate-700 rounded-lg font-medium hover:bg-slate-300 transition-colors">Enrich</a>
          <a href="/embeddings" className="px-4 py-2 bg-slate-200 text-slate-700 rounded-lg font-medium hover:bg-slate-300 transition-colors">Embeddings</a>
          <a href="/intelligence" className="px-4 py-2 bg-violet-600 text-white rounded-lg font-medium">Intelligence</a>
        </div>

        {/* Stats */}
        <div className="bg-white rounded-xl border border-slate-200 p-6 mb-6 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-slate-800">Database Stats</h2>
            <button
              onClick={fetchStatus}
              disabled={loadingStatus}
              className="text-sm text-violet-600 hover:text-violet-700 font-medium disabled:opacity-40"
            >
              {loadingStatus ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>

          {loadingStatus && !status ? (
            <div className="text-slate-400 text-sm">Loading…</div>
          ) : status ? (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4 mb-4">
                <StatCard label="Total Profiles" value={status.total} />
                <StatCard label="Analyzed" value={status.analyzed} highlight />
                <StatCard label="Pending" value={status.pending} />
                <StatCard label="With Email" value={emailDetected} />
                <StatCard label="With Location" value={locationDetected} />
                <StatCard label="AI Summaries" value={aiGenerated} />
              </div>

              {/* Progress bar */}
              <div>
                <div className="flex justify-between text-xs text-slate-500 mb-1">
                  <span>Analysis progress</span>
                  <span>{pctAnalyzed}%</span>
                </div>
                <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-violet-500 rounded-full transition-all duration-500"
                    style={{ width: `${pctAnalyzed}%` }}
                  />
                </div>
              </div>
            </>
          ) : null}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Options panel */}
          <div className="lg:col-span-1">
            <div className="bg-white rounded-xl border border-slate-200 p-6 shadow-sm">
              <h2 className="text-lg font-semibold text-slate-800 mb-5">Options</h2>

              {/* Mode */}
              <div className="mb-5">
                <label className="block text-sm font-medium text-slate-700 mb-2">Mode</label>
                <div className="space-y-2">
                  {[
                    { value: 'not_analyzed', label: 'Not yet analyzed' },
                    { value: 'enriched_first', label: 'Enriched creators first' },
                    { value: 'needs_reanalysis', label: 'Needs re-analysis (re-enriched)' },
                    { value: 'missing_ai_summary', label: 'Missing AI summary' },
                    { value: 're_analyze_all', label: 'Re-analyze all' },
                    { value: 'specific', label: 'Specific creators' },
                  ].map(({ value, label }) => (
                    <label key={value} className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="mode"
                        value={value}
                        checked={mode === value}
                        onChange={() => setMode(value as typeof mode)}
                        className="accent-violet-600"
                      />
                      <span className="text-sm text-slate-700 flex-1">{label}</span>
                      {value === 'needs_reanalysis' && status && (
                        <span className="text-xs font-medium text-amber-600 bg-amber-50 px-2 py-0.5 rounded-full">
                          {status.needs_reanalysis.toLocaleString()} ready
                        </span>
                      )}
                    </label>
                  ))}
                </div>

                {mode === 'specific' && (
                  <textarea
                    value={specificHandles}
                    onChange={(e) => setSpecificHandles(e.target.value)}
                    placeholder="@handle1, @handle2, handle3"
                    rows={3}
                    className="mt-3 w-full text-sm border border-slate-200 rounded-lg px-3 py-2 text-slate-700 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-400 resize-none"
                  />
                )}
              </div>

              {/* Batch size */}
              <div className="mb-5">
                <label className="block text-sm font-medium text-slate-700 mb-2">
                  Batch size: <span className="text-violet-600 font-semibold">{batchSize}</span>
                </label>
                <input
                  type="range"
                  min={5}
                  max={200}
                  step={5}
                  value={batchSize}
                  onChange={(e) => setBatchSize(Number(e.target.value))}
                  className="w-full accent-violet-600"
                />
                <div className="flex justify-between text-xs text-slate-400 mt-1">
                  <span>5</span><span>200</span>
                </div>
              </div>

              {/* Checkboxes */}
              <div className="mb-6 space-y-3">
                <label className="block text-sm font-medium text-slate-700 mb-1">Extract</label>
                <CheckOption checked={doEmails} onChange={setDoEmails} label="Extract emails" free />
                <CheckOption checked={doLanguage} onChange={setDoLanguage} label="Detect language" free />
                <CheckOption checked={doLocation} onChange={setDoLocation} label="Detect location" free />
                <CheckOption
                  checked={doAI}
                  onChange={setDoAI}
                  label="Generate AI summary"
                  badge="~$0.01/creator"
                  badgeColor="amber"
                />
              </div>

              {/* Cost estimate */}
              {doAI && (
                <div className="mb-5 p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800">
                  <strong>Estimated cost:</strong>{' '}
                  ~${(batchSize * 0.01).toFixed(2)} for {batchSize} creators (Claude API)
                </div>
              )}

              <button
                onClick={handleRun}
                disabled={running}
                className="w-full py-3 bg-violet-600 hover:bg-violet-700 disabled:bg-violet-300 text-white rounded-lg font-semibold text-sm transition-colors"
              >
                {running ? 'Running…' : 'Run Intelligence Analysis'}
              </button>

              {error && (
                <div className="mt-3 p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700">
                  {error}
                </div>
              )}
            </div>

            {/* Tips */}
            <div className="mt-4 bg-violet-50 border border-violet-100 rounded-xl p-4 text-xs text-violet-800 space-y-2">
              <p className="font-semibold text-violet-900">💡 Recommended order</p>
              <p>1. Run email / location / language first — it&apos;s free and instant.</p>
              <p>2. Enable AI summaries only after confirming extraction works.</p>
              <p>3. After intelligence runs, re-run Embeddings for richer semantic search.</p>
            </div>
          </div>

          {/* Results panel */}
          <div className="lg:col-span-2">
            {running && (
              <div className="bg-white rounded-xl border border-slate-200 p-6 shadow-sm mb-4">
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-4 h-4 border-2 border-violet-500 border-t-transparent rounded-full animate-spin" />
                  <span className="text-sm font-medium text-slate-700">
                    Processing batch{totalBatches > 1 ? ` ${currentBatch} of ${totalBatches}` : ''}…
                  </span>
                </div>
                <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
                  <div className="h-full bg-violet-400 rounded-full animate-pulse w-3/4" />
                </div>
              </div>
            )}

            {runResult && !running && (
              <>
                {/* Summary row */}
                <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm mb-4">
                  <div className="flex flex-wrap gap-4 text-sm">
                    <span className="flex items-center gap-1.5 text-green-700 font-medium">
                      <span className="text-base">✓</span> {runResult.succeeded} analyzed
                    </span>
                    {runResult.failed > 0 && (
                      <span className="flex items-center gap-1.5 text-red-600 font-medium">
                        <span className="text-base">✗</span> {runResult.failed} failed
                      </span>
                    )}
                    <span className="text-slate-400">
                      {runResult.total} total in batch
                    </span>
                    {runResult.results.filter((r) => r.email).length > 0 && (
                      <span className="text-slate-600">
                        📧 {runResult.results.filter((r) => r.email).length} emails found
                      </span>
                    )}
                    {runResult.results.filter((r) => r.country).length > 0 && (
                      <span className="text-slate-600">
                        📍 {runResult.results.filter((r) => r.country).length} locations detected
                      </span>
                    )}
                    {runResult.results.filter((r) => r.aiSummary).length > 0 && (
                      <span className="text-slate-600">
                        ✨ {runResult.results.filter((r) => r.aiSummary).length} AI summaries
                      </span>
                    )}
                  </div>
                </div>

                {/* Results table */}
                <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-slate-100 bg-slate-50">
                          <th className="text-left px-4 py-3 font-semibold text-slate-600">Handle</th>
                          <th className="text-left px-4 py-3 font-semibold text-slate-600">Platform</th>
                          <th className="text-left px-4 py-3 font-semibold text-slate-600">Lang</th>
                          <th className="text-left px-4 py-3 font-semibold text-slate-600">Location</th>
                          <th className="text-left px-4 py-3 font-semibold text-slate-600">Email</th>
                          <th className="text-left px-4 py-3 font-semibold text-slate-600">AI</th>
                          <th className="text-left px-4 py-3 font-semibold text-slate-600">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {runResult.results.map((row, i) => (
                          <tr
                            key={i}
                            className={`border-b border-slate-50 hover:bg-slate-50 transition-colors ${
                              row.error ? 'bg-red-50' : ''
                            }`}
                          >
                            <td className="px-4 py-3 font-medium text-slate-800">
                              @{row.handle}
                            </td>
                            <td className="px-4 py-3">
                              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                                row.platform === 'instagram'
                                  ? 'bg-pink-100 text-pink-700'
                                  : 'bg-sky-100 text-sky-700'
                              }`}>
                                {row.platform}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-slate-600">
                              {row.language
                                ? <span className="font-mono text-xs bg-slate-100 px-1.5 py-0.5 rounded">{row.language}</span>
                                : <span className="text-slate-300">—</span>}
                            </td>
                            <td className="px-4 py-3 text-slate-600 text-xs">
                              {row.city && row.country
                                ? `${row.city}, ${row.country}`
                                : row.country || <span className="text-slate-300">—</span>}
                            </td>
                            <td className="px-4 py-3">
                              {row.email
                                ? <span className="text-green-600 font-medium text-xs">✓ found</span>
                                : <span className="text-slate-300 text-xs">—</span>}
                            </td>
                            <td className="px-4 py-3">
                              {row.aiSummary
                                ? <span className="text-violet-600 font-medium text-xs">✓</span>
                                : <span className="text-slate-300 text-xs">—</span>}
                            </td>
                            <td className="px-4 py-3">
                              {row.error
                                ? <span className="text-red-500 text-xs" title={row.error}>✗ error</span>
                                : <span className="text-green-500 text-xs">✓ done</span>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
                <div ref={resultsEndRef} />
              </>
            )}

            {!runResult && !running && (
              <div className="bg-white rounded-xl border border-slate-200 p-12 shadow-sm text-center text-slate-400">
                <div className="text-4xl mb-3">🧠</div>
                <p className="font-medium text-slate-600 mb-1">Ready to analyze</p>
                <p className="text-sm">
                  Configure options and click <strong>Run Intelligence Analysis</strong> to begin.
                </p>
              </div>
            )}
          </div>
        </div>

        {/* ------------------------------------------------------------------ */}
        {/* Location Extraction Section                                         */}
        {/* ------------------------------------------------------------------ */}
        <div className="mt-8">
          <div className="mb-4">
            <h2 className="text-2xl font-bold text-slate-900 mb-1">AI Location Extraction</h2>
            <p className="text-slate-600 text-sm">
              Uses Claude to extract country/city from AI summaries for creators still missing{' '}
              <code className="text-slate-700 bg-slate-100 px-1 rounded">detected_country</code>.
              Each API call processes 20 creators (4 × 5 in parallel, 1.5 s gap).
            </p>
          </div>

          {/* Missing country stat */}
          {status && (
            <div className="bg-white rounded-xl border border-slate-200 p-4 mb-4 shadow-sm flex items-center gap-6">
              <div className="bg-amber-50 border border-amber-100 rounded-lg p-3 text-center min-w-[100px]">
                <div className="text-2xl font-bold text-amber-700">
                  {(status.total - locationDetected).toLocaleString()}
                </div>
                <div className="text-xs text-slate-500 mt-0.5">Missing country</div>
              </div>
              <div className="text-sm text-slate-500">
                {locationDetected.toLocaleString()} of {status.total.toLocaleString()} profiles already have a detected country.
              </div>
            </div>
          )}

          {/* Buttons */}
          <div className="flex gap-3 mb-4">
            <button
              onClick={runLocDry}
              disabled={locRunning}
              className="px-4 py-2 bg-slate-200 hover:bg-slate-300 disabled:opacity-50 text-slate-700 rounded-lg font-medium text-sm transition-colors"
            >
              Dry Run (10)
            </button>
            <button
              onClick={runLocTest}
              disabled={locRunning}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg font-medium text-sm transition-colors"
            >
              Test Run (20)
            </button>
            <button
              onClick={runLocFull}
              disabled={locRunning}
              className="px-4 py-2 bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white rounded-lg font-medium text-sm transition-colors"
            >
              Full Run
            </button>
          </div>

          {/* Progress bar */}
          {locRunning && locProgress && (
            <div className="mb-4">
              <div className="flex justify-between text-xs text-slate-500 mb-1">
                <span>Processing {locProgress.done}/{locProgress.total}…</span>
                <span>{Math.round((locProgress.done / locProgress.total) * 100)}%</span>
              </div>
              <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                <div
                  className="h-full bg-green-500 rounded-full transition-all duration-500"
                  style={{ width: `${Math.round((locProgress.done / locProgress.total) * 100)}%` }}
                />
              </div>
            </div>
          )}

          {locRunning && !locProgress && (
            <div className="text-sm text-slate-500 animate-pulse mb-4">Running…</div>
          )}

          {locDone && !locRunning && (
            <div className="text-sm text-green-600 font-medium mb-4">Done.</div>
          )}

          {locErrors.length > 0 && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3 mb-4 text-xs text-red-700 space-y-0.5">
              <div className="font-semibold mb-1">Chunk errors (run continued):</div>
              {locErrors.map((e, i) => <div key={i}>{e}</div>)}
            </div>
          )}

          {/* Results */}
          {locAgg && (
            <div className="bg-white rounded-xl border border-slate-200 p-6 shadow-sm">
              <div className="grid grid-cols-3 gap-4 mb-5">
                <StatCard label="Updated" value={locAgg.updated} highlight />
                <StatCard label="Skipped (low conf.)" value={locAgg.skipped} />
                <StatCard label="Failed" value={locAgg.failed} />
              </div>
              <p className="text-xs text-slate-400 mb-4">
                {locAgg.processed} profiles processed so far.
              </p>

              {Object.keys(locAgg.byCountry).length > 0 && (
                <>
                  <h3 className="text-sm font-semibold text-slate-700 mb-2">Country Breakdown</h3>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-slate-100 bg-slate-50">
                          <th className="text-left px-3 py-2 font-semibold text-slate-600">Country</th>
                          <th className="text-right px-3 py-2 font-semibold text-slate-600">Count</th>
                        </tr>
                      </thead>
                      <tbody>
                        {Object.entries(locAgg.byCountry)
                          .sort((a, b) => b[1] - a[1])
                          .map(([country, count]) => (
                            <tr key={country} className="border-b border-slate-50 hover:bg-slate-50">
                              <td className="px-3 py-2 text-slate-700">{country}</td>
                              <td className="px-3 py-2 text-right text-slate-500">{count}</td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>
          )}

          {!locAgg && !locRunning && (
            <div className="bg-white rounded-xl border border-slate-200 p-10 shadow-sm text-center text-slate-400">
              <div className="text-3xl mb-2">📍</div>
              <p className="font-medium text-slate-600 mb-1">Ready to extract locations</p>
              <p className="text-sm">Requires <code className="bg-slate-100 px-1 rounded">ai_summary</code> to be set — run Intelligence Analysis first if needed.</p>
            </div>
          )}
        </div>

      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------
function StatCard({ label, value, highlight }: { label: string; value: number; highlight?: boolean }) {
  return (
    <div className={`rounded-lg p-3 ${highlight ? 'bg-violet-50 border border-violet-100' : 'bg-slate-50'}`}>
      <div className={`text-2xl font-bold ${highlight ? 'text-violet-700' : 'text-slate-800'}`}>
        {value.toLocaleString()}
      </div>
      <div className="text-xs text-slate-500 mt-0.5">{label}</div>
    </div>
  );
}

function CheckOption({
  checked,
  onChange,
  label,
  free,
  badge,
  badgeColor,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  free?: boolean;
  badge?: string;
  badgeColor?: 'amber' | 'green';
}) {
  return (
    <label className="flex items-center gap-2 cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="accent-violet-600 w-4 h-4"
      />
      <span className="text-sm text-slate-700 flex-1">{label}</span>
      {free && (
        <span className="text-xs px-1.5 py-0.5 bg-green-100 text-green-700 rounded font-medium">free</span>
      )}
      {badge && (
        <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${
          badgeColor === 'amber' ? 'bg-amber-100 text-amber-700' : 'bg-green-100 text-green-700'
        }`}>
          {badge}
        </span>
      )}
    </label>
  );
}

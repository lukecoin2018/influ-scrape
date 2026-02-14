'use client';

import { useState, useEffect } from 'react';

type Platform = 'instagram' | 'tiktok';
type Mode = 'not_enriched' | 'featured_first' | 'specific';

interface EnrichStatus {
  instagram: { total: number; enriched: number; pending: number };
  tiktok: { total: number; enriched: number; pending: number };
}

interface EnrichResult {
  handle: string;
  postsFound: number;
  postsSaved: number;
  enrichmentData: any;
  error?: string;
}

export default function EnrichPage() {
  const [platform, setPlatform] = useState<Platform>('instagram');
  const [mode, setMode] = useState<Mode>('not_enriched');
  const [batchSize, setBatchSize] = useState(25);
  const [postsPerCreator, setPostsPerCreator] = useState(15);
  const [handlesInput, setHandlesInput] = useState('');
  const [status, setStatus] = useState<EnrichStatus | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [currentHandle, setCurrentHandle] = useState('');
  const [progress, setProgress] = useState({ enriched: 0, failed: 0, remaining: 0, total: 0 });
  const [results, setResults] = useState<EnrichResult[]>([]);
  const [progressMessage, setProgressMessage] = useState('');

  useEffect(() => {
    fetchStatus();
  }, []);

  const fetchStatus = async () => {
    try {
      const res = await fetch('/api/enrich/status');
      const data = await res.json();
      setStatus(data);
    } catch (err) {
      console.error('Failed to fetch enrich status:', err);
    }
  };

  const startEnrichment = async () => {
    setIsRunning(true);
    setResults([]);
    setProgress({ enriched: 0, failed: 0, remaining: 0, total: 0 });
    setProgressMessage('Getting creators to enrich...');

    try {
      // Get batch of handles
      const startRes = await fetch('/api/enrich/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          platform,
          mode,
          batchSize,
          handles: mode === 'specific'
            ? handlesInput.split('\n').map(h => h.trim()).filter(Boolean)
            : [],
        }),
      });

      const { handles, count } = await startRes.json();

      if (!handles || handles.length === 0) {
        setProgressMessage('No creators found to enrich.');
        setIsRunning(false);
        return;
      }

      setProgress({ enriched: 0, failed: 0, remaining: count, total: count });
      setProgressMessage(`Starting enrichment for ${count} creators...`);

      let enriched = 0;
      let failed = 0;

      // Process one at a time
      for (const handle of handles) {
        setCurrentHandle(handle);
        setProgressMessage(`Enriching @${handle}...`);

        try {
          const processRes = await fetch('/api/enrich/process', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ handle, platform, postsPerCreator }),
          });

          const result = await processRes.json();

          if (processRes.ok) {
            enriched++;
            setResults(prev => [...prev, { handle, ...result }]);
          } else {
            failed++;
            setResults(prev => [...prev, { handle, postsFound: 0, postsSaved: 0, enrichmentData: null, error: result.error }]);
          }
        } catch (err: any) {
          failed++;
          setResults(prev => [...prev, { handle, postsFound: 0, postsSaved: 0, enrichmentData: null, error: err.message }]);
        }

        const remaining = count - enriched - failed;
        setProgress({ enriched, failed, remaining, total: count });
        setProgressMessage(`Enriched ${enriched} of ${count}${failed > 0 ? `, ${failed} failed` : ''}...`);
      }

      setCurrentHandle('');
      setProgressMessage(`Complete! ${enriched} enriched, ${failed} failed.`);
      fetchStatus();

    } catch (error: any) {
      setProgressMessage(`Error: ${error.message}`);
    } finally {
      setIsRunning(false);
    }
  };

  const formatNumber = (n: number) => n.toLocaleString();

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100">
      <div className="max-w-5xl mx-auto px-4 py-8">
        <div className="mb-8">
          <h1 className="text-4xl font-bold bg-gradient-to-r from-violet-600 to-purple-600 bg-clip-text text-transparent mb-2">
            Enrich Creators
          </h1>
          <p className="text-slate-600">Scrape recent posts and calculate engagement metrics</p>
        </div>

        {/* Navigation */}
        <div className="flex gap-2 mb-6 flex-wrap">
          <a href="/" className="px-4 py-2 bg-slate-200 text-slate-700 rounded-lg font-medium hover:bg-slate-300 transition-colors">Discovery</a>
          <a href="/add" className="px-4 py-2 bg-slate-200 text-slate-700 rounded-lg font-medium hover:bg-slate-300 transition-colors">Add Creators</a>
          <a href="/import" className="px-4 py-2 bg-slate-200 text-slate-700 rounded-lg font-medium hover:bg-slate-300 transition-colors">Import</a>
          <a href="/enrich" className="px-4 py-2 bg-violet-600 text-white rounded-lg font-medium">Enrich</a>
          <a href="/database" className="px-4 py-2 bg-slate-200 text-slate-700 rounded-lg font-medium hover:bg-slate-300 transition-colors">Creators</a>
          <a href="/brands" className="px-4 py-2 bg-slate-200 text-slate-700 rounded-lg font-medium hover:bg-slate-300 transition-colors">Brands</a>
        </div>

        {/* Status Cards */}
        {status && (
          <div className="grid grid-cols-2 gap-4 mb-6">
            {(['instagram', 'tiktok'] as Platform[]).map(p => (
              <div key={p} className="bg-white rounded-xl shadow-sm p-5">
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-lg">{p === 'instagram' ? '📸' : '🎵'}</span>
                  <span className="font-semibold text-slate-800 capitalize">{p}</span>
                </div>
                <div className="grid grid-cols-3 gap-2 text-center">
                  <div>
                    <div className="text-2xl font-bold text-slate-800">{formatNumber(status[p].total)}</div>
                    <div className="text-xs text-slate-500">Total</div>
                  </div>
                  <div>
                    <div className="text-2xl font-bold text-green-600">{formatNumber(status[p].enriched)}</div>
                    <div className="text-xs text-slate-500">Enriched</div>
                  </div>
                  <div>
                    <div className="text-2xl font-bold text-amber-500">{formatNumber(status[p].pending)}</div>
                    <div className="text-xs text-slate-500">Pending</div>
                  </div>
                </div>
                <div className="mt-3 h-2 bg-slate-100 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-violet-500 rounded-full transition-all"
                    style={{ width: status[p].total > 0 ? `${(status[p].enriched / status[p].total) * 100}%` : '0%' }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Config Panel */}
        <div className="bg-white rounded-xl shadow-sm p-6 mb-6">
          {/* Platform Toggle */}
          <div className="mb-5">
            <label className="block text-sm font-medium text-slate-700 mb-2">Platform</label>
            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={() => setPlatform('instagram')}
                className={`px-4 py-3 rounded-lg font-medium transition-all border-2 ${
                  platform === 'instagram'
                    ? 'bg-pink-50 border-pink-500 text-pink-700'
                    : 'bg-white border-slate-200 text-slate-600 hover:border-slate-300'
                }`}
              >
                📸 Instagram
              </button>
              <button
                onClick={() => setPlatform('tiktok')}
                className={`px-4 py-3 rounded-lg font-medium transition-all border-2 ${
                  platform === 'tiktok'
                    ? 'bg-black border-black text-white'
                    : 'bg-white border-slate-200 text-slate-600 hover:border-slate-300'
                }`}
              >
                🎵 TikTok
              </button>
            </div>
          </div>

          {/* Enrich Mode */}
          <div className="mb-5">
            <label className="block text-sm font-medium text-slate-700 mb-2">Enrich Mode</label>
            <div className="space-y-2">
              {([
                { value: 'not_enriched', label: 'Not yet enriched', desc: 'Creators missing post data' },
                { value: 'featured_first', label: 'Featured first', desc: 'Prioritize featured creators' },
                { value: 'specific', label: 'Specific creators', desc: 'Paste handles below' },
              ] as { value: Mode; label: string; desc: string }[]).map(opt => (
                <label key={opt.value} className="flex items-start gap-3 cursor-pointer p-3 rounded-lg hover:bg-slate-50">
                  <input
                    type="radio"
                    name="mode"
                    value={opt.value}
                    checked={mode === opt.value}
                    onChange={() => setMode(opt.value)}
                    className="mt-0.5"
                  />
                  <div>
                    <div className="font-medium text-slate-800 text-sm">{opt.label}</div>
                    <div className="text-xs text-slate-500">{opt.desc}</div>
                  </div>
                </label>
              ))}
            </div>
          </div>

          {/* Specific handles textarea */}
          {mode === 'specific' && (
            <div className="mb-5">
              <label className="block text-sm font-medium text-slate-700 mb-2">
                Handles (one per line)
              </label>
              <textarea
                value={handlesInput}
                onChange={e => setHandlesInput(e.target.value)}
                placeholder="@fashiongirl&#10;styleblogger&#10;@creator3"
                rows={5}
                className="w-full px-4 py-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-violet-500 focus:border-transparent font-mono text-sm"
                disabled={isRunning}
              />
            </div>
          )}

          {/* Batch size + posts per creator */}
          <div className="grid grid-cols-2 gap-4 mb-5">
            {mode !== 'specific' && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">
                  Batch Size
                </label>
                <input
                  type="number"
                  value={batchSize}
                  onChange={e => setBatchSize(parseInt(e.target.value) || 25)}
                  min={1}
                  max={100}
                  className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-violet-500"
                  disabled={isRunning}
                />
                <p className="text-xs text-slate-500 mt-1">
                  Est. cost: ~${((batchSize * postsPerCreator) * (platform === 'instagram' ? 0.0027 : 0.001)).toFixed(2)}
                </p>
              </div>
            )}
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">
                Posts Per Creator
              </label>
              <input
                type="number"
                value={postsPerCreator}
                onChange={e => setPostsPerCreator(parseInt(e.target.value) || 15)}
                min={5}
                max={50}
                className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-violet-500"
                disabled={isRunning}
              />
            </div>
          </div>

          <button
            onClick={startEnrichment}
            disabled={isRunning || (mode === 'specific' && !handlesInput.trim())}
            className="w-full px-6 py-4 bg-violet-600 text-white rounded-lg font-medium hover:bg-violet-700 transition-colors disabled:bg-slate-300 disabled:cursor-not-allowed"
          >
            {isRunning ? `Enriching @${currentHandle}...` : 'Start Enrichment'}
          </button>
        </div>

        {/* Progress */}
        {progressMessage && (
          <div className="bg-white rounded-xl shadow-sm p-6 mb-6">
            <h2 className="text-lg font-bold text-slate-800 mb-3">Progress</h2>
            <p className="text-slate-700 mb-4">{progressMessage}</p>
            {progress.total > 0 && (
              <>
                <div className="flex gap-4 text-sm mb-3">
                  <span className="text-green-600 font-medium">✓ {progress.enriched} enriched</span>
                  {progress.failed > 0 && <span className="text-red-500 font-medium">✗ {progress.failed} failed</span>}
                  <span className="text-slate-500">⏳ {progress.remaining} remaining</span>
                </div>
                <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-violet-500 rounded-full transition-all"
                    style={{ width: `${((progress.enriched + progress.failed) / progress.total) * 100}%` }}
                  />
                </div>
              </>
            )}
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
                    <th className="text-right py-2 px-3 font-semibold text-slate-700">Posts</th>
                    <th className="text-right py-2 px-3 font-semibold text-slate-700">Eng. Rate</th>
                    <th className="text-right py-2 px-3 font-semibold text-slate-700">Last Post</th>
                    <th className="text-right py-2 px-3 font-semibold text-slate-700">Sponsors</th>
                    <th className="text-left py-2 px-3 font-semibold text-slate-700">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((r, i) => (
                    <tr key={i} className="border-b border-slate-100 hover:bg-slate-50">
                      <td className="py-2 px-3 text-violet-600 font-medium">@{r.handle}</td>
                      <td className="py-2 px-3 text-right text-slate-700">{r.postsSaved || 0}</td>
                      <td className="py-2 px-3 text-right text-slate-700">
                        {r.enrichmentData?.calculated_engagement_rate != null
                          ? `${r.enrichmentData.calculated_engagement_rate}%`
                          : '-'}
                      </td>
                      <td className="py-2 px-3 text-right text-slate-700">
                        {r.enrichmentData?.days_since_last_post != null
                          ? `${r.enrichmentData.days_since_last_post}d ago`
                          : '-'}
                      </td>
                      <td className="py-2 px-3 text-right text-slate-700">
                        {r.enrichmentData?.brand_partnership_count != null
                          ? `${r.enrichmentData.brand_partnership_count} found`
                          : '-'}
                      </td>
                      <td className="py-2 px-3">
                        {r.error
                          ? <span className="text-red-500 text-xs">✗ {r.error}</span>
                          : <span className="text-green-600 text-xs">✓ Done</span>}
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

'use client';

import { useMemo, useState } from 'react';
import { parseHandleList } from '@/lib/handles';
import { ACTOR_PRICES_USD } from '@/lib/discoveryCost';

type Platform = 'instagram' | 'tiktok';

/** Mirrors LookupRow in app/api/add/lookup/route.ts. */
interface LookupRow {
  handle: string;
  status: 'saved' | 'existing' | 'not_found' | 'error';
  message?: string;
  displayName: string | null;
  followerCount: number | null;
  engagementRate: number | null;
  profileUrl: string | null;
  hasPic: boolean;
  importStatus: string | null;
}

interface LookupResponse {
  platform: Platform;
  rows: LookupRow[];
  invalid: { input: string; reason: string }[];
  summary: {
    attempted: number;
    saved: number;
    existing: number;
    notFound: number;
    errors: number;
    unknownSize: number;
    timedOut: boolean;
  };
  estimatedCostUsd: number;
}

const STATUS_LABEL: Record<LookupRow['status'], { text: string; className: string }> = {
  saved: { text: 'Saved', className: 'bg-green-100 text-green-800' },
  existing: { text: 'Already existed', className: 'bg-blue-100 text-blue-800' },
  not_found: { text: 'Not found', className: 'bg-amber-100 text-amber-800' },
  error: { text: 'Error', className: 'bg-red-100 text-red-800' },
};

/**
 * Add Creators by Handle.
 *
 * The page no longer talks to Apify. It parses the pasted list (URLs
 * accepted), posts it once to /api/add/lookup, and renders what that route
 * read back from the database. The route waits on the actor run itself, so
 * one request covers scrape, map and save for either platform.
 */
export default function AddByHandlePage() {
  const [platform, setPlatform] = useState<Platform>('instagram');
  const [handlesInput, setHandlesInput] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState('');
  const [result, setResult] = useState<LookupResponse | null>(null);

  // Parsed live, so the count and the rejects are visible before spending.
  const parsed = useMemo(() => parseHandleList(handlesInput), [handlesInput]);
  const pricePerProfile = ACTOR_PRICES_USD[platform].profileResult;

  const processHandles = async () => {
    if (parsed.valid.length === 0) {
      alert('Please enter at least one valid handle');
      return;
    }

    setIsProcessing(true);
    setResult(null);
    setProgress(
      `Looking up ${parsed.valid.length} ${platform === 'instagram' ? 'Instagram' : 'TikTok'} ` +
      `handle${parsed.valid.length === 1 ? '' : 's'}… this waits for the Apify run, usually under a minute.`,
    );

    try {
      const response = await fetch('/api/add/lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform, handles: parsed.valid }),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data?.error || `Lookup failed (${response.status})`);
      }

      const r = data as LookupResponse;
      setResult(r);
      const parts = [
        `${r.summary.saved} saved`,
        `${r.summary.existing} already existed`,
        `${r.summary.notFound} not found`,
      ];
      if (r.summary.errors > 0) parts.push(`${r.summary.errors} failed`);
      if (r.summary.timedOut) parts.push('stopped early: run budget exhausted');
      setProgress(`Complete. ${parts.join(', ')}.`);
    } catch (error: unknown) {
      setProgress(`Error: ${error instanceof Error ? error.message : String(error)}`);
      console.error('Add by handle error:', error);
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100">
      <div className="max-w-4xl mx-auto px-4 py-8">
        <div className="mb-8">
          <h1 className="text-4xl font-bold bg-gradient-to-r from-violet-600 to-purple-600 bg-clip-text text-transparent mb-2">
            Add Creators by Handle
          </h1>
          <p className="text-slate-600">Manually add creators you find while browsing</p>
        </div>

        <div className="flex gap-2 mb-6">
          <a href="/" className="px-4 py-2 bg-slate-200 text-slate-700 rounded-lg font-medium hover:bg-slate-300 transition-colors">Discovery</a>
          <a href="/database" className="px-4 py-2 bg-slate-200 text-slate-700 rounded-lg font-medium hover:bg-slate-300 transition-colors">Creators</a>
          <a href="/brands" className="px-4 py-2 bg-slate-200 text-slate-700 rounded-lg font-medium hover:bg-slate-300 transition-colors">Brands</a>
          <a href="/import" className="px-4 py-2 bg-slate-200 text-slate-700 rounded-lg font-medium hover:bg-slate-300 transition-colors">Import</a>
          <a href="/brand-feed" className="px-4 py-2 bg-slate-200 text-slate-700 rounded-lg font-medium hover:bg-slate-300 transition-colors">Brand Feed</a>
          <a href="/add" className="px-4 py-2 bg-violet-600 text-white rounded-lg font-medium">Add Creators</a>
          <a href="/enrich" className="px-4 py-2 bg-slate-200 text-slate-700 rounded-lg font-medium hover:bg-slate-300 transition-colors">Enrich</a>
        </div>

        <div className="bg-white rounded-xl shadow-lg p-8 mb-6">
          {/* Platform Toggle */}
          <div className="mb-6">
            <label className="block text-sm font-medium text-slate-700 mb-2">Platform</label>
            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={() => setPlatform('instagram')}
                disabled={isProcessing}
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
                disabled={isProcessing}
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

          <div className="mb-6">
            <label className="block text-sm font-medium text-slate-700 mb-2">
              {platform === 'instagram' ? 'Instagram' : 'TikTok'} handles or profile URLs (one per line)
            </label>
            <textarea
              value={handlesInput}
              onChange={(e) => setHandlesInput(e.target.value)}
              placeholder={platform === 'instagram'
                ? '@fashionista\nstyleinfluencer\nhttps://www.instagram.com/beautyblogger/'
                : '@tiktokcreator\ndancequeen\nhttps://www.tiktok.com/@foodie?lang=en'
              }
              rows={8}
              className="w-full px-4 py-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-violet-500 focus:border-transparent font-mono text-sm"
              disabled={isProcessing}
            />
            <p className="text-xs text-slate-500 mt-2">
              Cost: ~${pricePerProfile.toFixed(4)} per {platform === 'instagram' ? 'Instagram' : 'TikTok'} profile
              {parsed.valid.length > 0 && (
                <> · {parsed.valid.length} handle{parsed.valid.length === 1 ? '' : 's'} ≈ ${(parsed.valid.length * pricePerProfile).toFixed(3)}</>
              )}
              . With or without @, or a profile URL.
            </p>
            {parsed.invalid.length > 0 && (
              <ul className="mt-2 text-xs text-amber-700 space-y-0.5">
                {parsed.invalid.map((entry) => (
                  <li key={entry.input}>
                    <span className="font-mono">{entry.input}</span> — {entry.reason} (skipped)
                  </li>
                ))}
              </ul>
            )}
          </div>

          <button
            onClick={processHandles}
            disabled={isProcessing || parsed.valid.length === 0}
            className="w-full px-6 py-4 bg-violet-600 text-white rounded-lg font-medium hover:bg-violet-700 transition-colors disabled:bg-slate-300 disabled:cursor-not-allowed"
          >
            {isProcessing ? 'Processing...' : 'Look Up & Save'}
          </button>
        </div>

        {progress && (
          <div className="bg-white rounded-xl shadow-lg p-8 mb-6">
            <h2 className="text-2xl font-bold text-slate-800 mb-4">Progress</h2>
            <p className="text-lg text-slate-700">{progress}</p>
          </div>
        )}

        {result && result.rows.length > 0 && (
          <div className="bg-white rounded-xl shadow-lg p-8">
            <h2 className="text-2xl font-bold text-slate-800 mb-4">
              Results ({result.rows.length})
            </h2>

            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-slate-200">
                    <th className="text-left py-3 px-4 text-sm font-semibold text-slate-700">Handle</th>
                    <th className="text-left py-3 px-4 text-sm font-semibold text-slate-700">Status</th>
                    <th className="text-left py-3 px-4 text-sm font-semibold text-slate-700">Name</th>
                    <th className="text-right py-3 px-4 text-sm font-semibold text-slate-700">Followers</th>
                    {result.platform === 'instagram' && (
                      <th className="text-right py-3 px-4 text-sm font-semibold text-slate-700">Engagement</th>
                    )}
                    <th className="text-center py-3 px-4 text-sm font-semibold text-slate-700">Pic</th>
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((row) => {
                    const label = STATUS_LABEL[row.status];
                    return (
                      <tr key={row.handle} className="border-b border-slate-100 hover:bg-slate-50">
                        <td className="py-3 px-4">
                          {row.profileUrl ? (
                            <a
                              href={row.profileUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-violet-600 hover:text-violet-800 font-medium"
                            >
                              @{row.handle}
                            </a>
                          ) : (
                            <span className="text-slate-700 font-medium">@{row.handle}</span>
                          )}
                        </td>
                        <td className="py-3 px-4">
                          <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${label.className}`}>
                            {label.text}
                          </span>
                          {row.importStatus && row.importStatus !== 'active' && (
                            <span className="ml-2 text-xs text-slate-500">{row.importStatus}</span>
                          )}
                          {row.message && (
                            <div className="text-xs text-slate-500 mt-1">{row.message}</div>
                          )}
                        </td>
                        <td className="py-3 px-4 text-slate-700">{row.displayName ?? ''}</td>
                        <td className="py-3 px-4 text-right text-slate-700">
                          {row.followerCount != null ? row.followerCount.toLocaleString() : '-'}
                        </td>
                        {result.platform === 'instagram' && (
                          <td className="py-3 px-4 text-right text-slate-700">
                            {row.engagementRate != null ? `${Number(row.engagementRate).toFixed(2)}%` : '-'}
                          </td>
                        )}
                        <td className="py-3 px-4 text-center text-slate-700">{row.hasPic ? '✓' : '-'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {result.summary.saved + result.summary.existing > 0 && (
              <div className="mt-6 p-4 bg-green-50 border border-green-200 rounded-lg">
                <p className="text-green-900 font-medium">
                  ✅ {result.summary.saved} new creator{result.summary.saved !== 1 ? 's' : ''} saved
                  {result.summary.existing > 0 && <>, {result.summary.existing} existing profile{result.summary.existing !== 1 ? 's' : ''} refreshed</>}
                  . New rows appear in the Enrich page&apos;s &ldquo;Not yet enriched&rdquo; queue for {result.platform === 'instagram' ? 'Instagram' : 'TikTok'}.
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

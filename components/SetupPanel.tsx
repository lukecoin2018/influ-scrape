'use client';

import { useState, useEffect, useCallback } from 'react';
import type { DiscoveryConfig, DiscoveryMode, SearchSource } from '@/lib/types';
import { DEFAULT_MIN_FOLLOWERS, DEFAULT_MAX_FOLLOWERS } from '@/lib/followerRange';
import { estimateDiscoveryCost, TIKTOK_SEARCH_RESULT_CAP } from '@/lib/discoveryCost';

const PRESET_HASHTAGS = [
  '#beautyblogger', '#makeuptutorial', '#skincare', '#lifestyleblogger',
  '#fashionweek', '#vintag efashion', '#minimaliststyle', '#plussize'
];

const SPONSORSHIP_HASHTAGS = [
  // Universal
  'ad', 'sponsored', 'gifted', 'paidpartnership', 'brandambassador',
  'collab', 'brandpartner', 'prpackage', 'prhaul',
  // German
  'werbung', 'anzeige', 'kooperation', 'gesponsert', 'produktplatzierung',
  // Spanish
  'publicidad', 'publi', 'patrocinado', 'colaboracion', 'embajadora',
  // French
  'partenariat', 'sponsorise', 'offert', 'partenaire',
  // Italian
  'adv', 'sponsorizzato', 'collaborazione', 'omaggio',
  // Portuguese
  'publipost', 'parceria', 'publicidade',
  // Dutch
  'samenwerking', 'gesponsord', 'reclame',
  // Swedish / Norwegian / Danish
  'reklam', 'samarbete', 'annons', 'betaltsamarbete',
  'reklame', 'samarbeid', 'samarbejde',
  // Polish / Estonian
  'reklama', 'wspolpraca', 'reklaam', 'koostoo',
];

/**
 * One row of the seed queue, as /api/discover/seed-candidates returns it.
 *
 * followingCount is the seed's CEILING: asking 200 of an account following 16
 * returns 16, which is not a failure and is why it is shown per row rather than
 * left implicit in the total.
 */
interface SeedCandidate {
  handle: string;
  followerCount: number | null;
  followingCount: number | null;
  postLanguage: string | null;
  postLanguageConfidence: number | null;
  placeCountryCode: string | null;
  detectedCountry: string | null;
  bio: string | null;
}

const SEED_LANGUAGES = [
  { code: 'any', label: 'Any' },
  { code: 'es', label: 'Spanish' },
  { code: 'en', label: 'English' },
  { code: 'pt', label: 'Portuguese' },
] as const;

interface SetupPanelProps {
  onStartDiscovery: (config: DiscoveryConfig) => void;
  isRunning: boolean;
  /** Priced per platform: the TikTok actors cost roughly twice the Instagram ones. */
  platform?: 'instagram' | 'tiktok';
}

export default function SetupPanel({ onStartDiscovery, isRunning, platform = 'instagram' }: SetupPanelProps) {
  const [mode, setMode] = useState<DiscoveryMode>('niche');
  const [searchSource, setSearchSource] = useState<SearchSource>('hashtag');
  const [haltOnLowCoverage, setHaltOnLowCoverage] = useState(true);
  const [hashtags, setHashtags] = useState('fashionblogger, sustainablefashion, ootd, streetstyle, fashionista, styleinspo');
  const [nicheKeywords, setNicheKeywords] = useState('');
  const [minFollowers, setMinFollowers] = useState(DEFAULT_MIN_FOLLOWERS);
  const [maxFollowers, setMaxFollowers] = useState(DEFAULT_MAX_FOLLOWERS);
  const [resultsPerHashtag, setResultsPerHashtag] = useState(200);

  // ── Seed queue ──────────────────────────────────────────────────────────
  const [seedLanguage, setSeedLanguage] = useState<'any' | 'es' | 'en' | 'pt'>('es');
  const [seedCandidates, setSeedCandidates] = useState<SeedCandidate[]>([]);
  const [seedTotal, setSeedTotal] = useState<number | null>(null);
  const [seedLoading, setSeedLoading] = useState(false);
  const [seedError, setSeedError] = useState<string | null>(null);
  const [selectedSeeds, setSelectedSeeds] = useState<string[]>([]);

  const loadSeeds = useCallback(async (language: string) => {
    setSeedLoading(true);
    setSeedError(null);
    try {
      const res = await fetch(`/api/discover/seed-candidates?language=${language}&limit=100`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setSeedCandidates(data.seeds || []);
      setSeedTotal(typeof data.totalEligible === 'number' ? data.totalEligible : null);
    } catch (err) {
      // Surfaced, not swallowed into an empty list. An empty queue and a failed
      // lookup look identical otherwise, and they call for opposite responses.
      setSeedError(err instanceof Error ? err.message : 'Failed to load seed candidates');
      setSeedCandidates([]);
      setSeedTotal(null);
    } finally {
      setSeedLoading(false);
    }
  }, []);

  useEffect(() => {
    if (mode === 'niche' && searchSource === 'seed' && platform === 'tiktok') {
      void loadSeeds(seedLanguage);
    }
  }, [mode, searchSource, platform, seedLanguage, loadSeeds]);

  const toggleSeed = (handle: string) => {
    setSelectedSeeds(prev =>
      prev.includes(handle) ? prev.filter(h => h !== handle) : [...prev, handle],
    );
  };

  const handleModeChange = (newMode: DiscoveryMode) => {
    setMode(newMode);
    if (newMode === 'sponsorship') {
      setHashtags(SPONSORSHIP_HASHTAGS.join(', '));
    } else {
      setHashtags('fashionblogger, sustainablefashion, ootd, streetstyle, fashionista, styleinspo');
    }
  };

  const handleAddPreset = (tag: string) => {
    const current = hashtags.split(',').map(h => h.trim()).filter(Boolean);
    const cleanTag = tag.replace('#', '');
    if (!current.includes(cleanTag)) {
      setHashtags([...current, cleanTag].join(', '));
    }
  };

  // Seed expansion is niche + TikTok only, matching the two guards in
  // /api/discover/start. Computed rather than enforced by disabling the button,
  // so the UI cannot offer a combination the route would reject.
  const seedAvailable = mode === 'niche' && platform === 'tiktok';
  const effectiveSource: SearchSource =
    mode !== 'niche' ? 'hashtag'
      : searchSource === 'seed' && !seedAvailable ? 'hashtag'
      : searchSource;
  const isSeed = effectiveSource === 'seed';

  /** The terms this run will actually send, whichever source is selected. */
  const terms = isSeed
    ? selectedSeeds
    : hashtags.split(',').map(h => h.trim()).filter(Boolean);

  const handleStart = () => {
    const keywordsArray = nicheKeywords.split(',').map(k => k.trim()).filter(Boolean);

    onStartDiscovery({
      hashtags: terms,
      minFollowers,
      maxFollowers,
      resultsPerHashtag: effectiveResults,
      mode,
      // Keyword search is niche-only and Instagram-only for now, so anything
      // else is forced back to hashtags rather than silently sending a flag
      // down a path it has not been verified on.
      searchSource: effectiveSource,
      haltOnLowCoverage,
      nicheKeywords: keywordsArray
    });
  };

  // TikTok SEARCH caps a query at ~200 results, so offering 500 would promise
  // depth the platform will not sell. That cap does not apply to a following
  // list, which is not a search — its ceiling is the seed's own
  // following_count, shown per row in the queue.
  const resultsCap = isSeed ? 500 : platform === 'tiktok' ? TIKTOK_SEARCH_RESULT_CAP : 500;
  const effectiveResults = Math.min(resultsPerHashtag, resultsCap);
  const cost = estimateDiscoveryCost(terms.length, effectiveResults, mode, platform, effectiveSource);

  /**
   * What the selected seeds can actually return, against what is being asked.
   *
   * A seed following 16 accounts returns 16 however deep the slider goes, so
   * the estimate above reads high whenever the selection includes small
   * accounts. Shown rather than folded into the estimate silently.
   */
  const seedCeiling = isSeed
    ? seedCandidates
        .filter(c => selectedSeeds.includes(c.handle))
        .reduce((sum, c) => sum + Math.min(c.followingCount ?? 0, effectiveResults), 0)
    : 0;

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-8">
      <h2 className="text-2xl font-bold text-slate-900 mb-6">Discovery Setup</h2>

      {/* Mode Toggle */}
      <div className="mb-6">
        <label className="block text-sm font-medium text-slate-700 mb-3">Discovery Mode</label>
        <div className="grid grid-cols-2 gap-3">
          <button
            onClick={() => handleModeChange('niche')}
            disabled={isRunning}
            className={`px-4 py-3 rounded-lg font-medium transition-all ${
              mode === 'niche'
                ? 'bg-violet-600 text-white shadow-md'
                : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
            } ${isRunning ? 'opacity-50 cursor-not-allowed' : ''}`}
          >
            <div className="text-sm">🎯 Niche Discovery</div>
            <div className="text-xs opacity-80 mt-1">Find creators by topic</div>
          </button>
          <button
            onClick={() => handleModeChange('sponsorship')}
            disabled={isRunning}
            className={`px-4 py-3 rounded-lg font-medium transition-all ${
              mode === 'sponsorship'
                ? 'bg-violet-600 text-white shadow-md'
                : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
            } ${isRunning ? 'opacity-50 cursor-not-allowed' : ''}`}
          >
            <div className="text-sm">💼 Sponsorship Discovery</div>
            <div className="text-xs opacity-80 mt-1">Detect brands & partnerships</div>
          </button>
        </div>
      </div>

      {/* Search source — niche only; seed additionally TikTok only */}
      {mode === 'niche' && (
        <div className="mb-6">
          <label className="block text-sm font-medium text-slate-700 mb-3">Search Source</label>
          <div className={`grid gap-3 ${seedAvailable ? 'grid-cols-3' : 'grid-cols-2'}`}>
            <button
              onClick={() => setSearchSource('hashtag')}
              disabled={isRunning}
              className={`px-4 py-3 rounded-lg font-medium transition-all ${
                searchSource === 'hashtag'
                  ? 'bg-violet-600 text-white shadow-md'
                  : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
              } ${isRunning ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              <div className="text-sm"># Hashtag</div>
              <div className="text-xs opacity-80 mt-1">Posts carrying the tag</div>
            </button>
            <button
              onClick={() => setSearchSource('keyword')}
              disabled={isRunning}
              className={`px-4 py-3 rounded-lg font-medium transition-all ${
                searchSource === 'keyword'
                  ? 'bg-violet-600 text-white shadow-md'
                  : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
              } ${isRunning ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              <div className="text-sm">🔎 Keyword</div>
              <div className="text-xs opacity-80 mt-1">Free text, multi-word</div>
            </button>
            {seedAvailable && (
              <button
                onClick={() => setSearchSource('seed')}
                disabled={isRunning}
                className={`px-4 py-3 rounded-lg font-medium transition-all ${
                  searchSource === 'seed'
                    ? 'bg-violet-600 text-white shadow-md'
                    : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                } ${isRunning ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                <div className="text-sm">🌱 Seed</div>
                <div className="text-xs opacity-80 mt-1">Who a creator follows</div>
              </button>
            )}
          </div>
          {searchSource === 'keyword' && (
            <p className="text-xs text-slate-500 mt-2">
              Multi-word terms are supported. Both platforms return a different dataset for
              keywords than for hashtags, so a term that finds posts but no creators is reported
              as an error rather than as an empty result.
            </p>
          )}
        </div>
      )}

      {/* The free follower reading is the whole economic case for TikTok
          search. Halting when it is absent stops a silent fallback to scraping
          every author; turning that off is how you measure it once. */}
      {platform === 'tiktok' && (
        <div className="mb-6">
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={haltOnLowCoverage}
              onChange={e => setHaltOnLowCoverage(e.target.checked)}
              disabled={isRunning}
              className="mt-1 h-4 w-4 rounded border-slate-300 text-violet-600 focus:ring-violet-500"
            />
            <span>
              <span className="block text-sm font-medium text-slate-700">
                Halt if the search results carry no follower count
              </span>
              <span className="block text-xs text-slate-500 mt-1">
                On by default. Without a follower count on the search item, every author needs a
                paid profile scrape to find out — roughly $0.75 a term instead of $0.08. Turn it
                off only to measure coverage on a deliberately small probe.
              </span>
            </span>
          </label>
        </div>
      )}

      {/* ── The seed queue ───────────────────────────────────────────────────
          Creators already held, eligible to have their FOLLOWING list
          traversed. A flat source: nothing discovered here is promoted to a
          seed, because expansion was measured and does not concentrate by
          place. See docs/seed-expansion-investigation.md. */}
      {isSeed && (
        <div className="mb-6">
          <div className="flex items-center justify-between mb-2">
            <label className="block text-sm font-medium text-slate-700">Seed Queue</label>
            <div className="flex gap-1">
              {SEED_LANGUAGES.map(l => (
                <button
                  key={l.code}
                  onClick={() => setSeedLanguage(l.code)}
                  disabled={isRunning}
                  className={`px-3 py-1 text-xs rounded-full transition-colors ${
                    seedLanguage === l.code
                      ? 'bg-violet-600 text-white'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  } ${isRunning ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  {l.label}
                </button>
              ))}
            </div>
          </div>

          <p className="text-xs text-slate-500 mb-3">
            Selected on post language, an in-band follower count and 150+ following — not on
            place. Expansion surfaces on-market creators cheaply but does not cluster them by
            city or country, so place is a filter on creators you already hold, never the way
            to find more.
          </p>

          {seedError && (
            <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3 mb-3">
              {seedError}
            </div>
          )}

          <div className="border border-slate-200 rounded-lg divide-y divide-slate-100 max-h-80 overflow-y-auto">
            {seedLoading && (
              <div className="p-4 text-sm text-slate-500">Loading seeds…</div>
            )}
            {!seedLoading && seedCandidates.length === 0 && !seedError && (
              <div className="p-4 text-sm text-slate-500">
                No eligible seeds. The queue needs post_language, which comes from enrichment —
                enrich some TikTok creators first, or widen the language filter.
              </div>
            )}
            {seedCandidates.map(seed => {
              const checked = selectedSeeds.includes(seed.handle);
              return (
                <label
                  key={seed.handle}
                  className={`flex items-start gap-3 p-3 cursor-pointer hover:bg-slate-50 ${
                    checked ? 'bg-violet-50' : ''
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleSeed(seed.handle)}
                    disabled={isRunning}
                    className="mt-1 h-4 w-4 rounded border-slate-300 text-violet-600 focus:ring-violet-500"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-slate-800">
                      @{seed.handle}
                      <span className="ml-2 text-xs font-normal text-slate-500">
                        {seed.postLanguage} ·{' '}
                        {(seed.followerCount ?? 0).toLocaleString()} followers · follows{' '}
                        {(seed.followingCount ?? 0).toLocaleString()}
                      </span>
                    </span>
                    {seed.bio && (
                      <span className="block text-xs text-slate-500 truncate">{seed.bio}</span>
                    )}
                  </span>
                </label>
              );
            })}
          </div>

          <div className="flex items-center justify-between mt-2">
            <p className="text-sm text-slate-500">
              {selectedSeeds.length} selected
              {seedTotal !== null && (
                <> · {seedTotal.toLocaleString()} eligible{seedTotal > seedCandidates.length && `, showing ${seedCandidates.length}`}</>
              )}
            </p>
            {selectedSeeds.length > 0 && (
              <button
                onClick={() => setSelectedSeeds([])}
                disabled={isRunning}
                className="text-xs text-slate-500 hover:text-slate-700 disabled:opacity-50"
              >
                Clear selection
              </button>
            )}
          </div>
        </div>
      )}

      {/* Search terms */}
      {!isSeed && (
      <div className="mb-6">
        <label className="block text-sm font-medium text-slate-700 mb-2">
          {mode === 'sponsorship'
            ? 'Sponsorship Hashtags (comma-separated)'
            : searchSource === 'keyword'
              ? 'Keywords (comma-separated)'
              : 'Hashtags (comma-separated)'}
        </label>
        <textarea
          value={hashtags}
          onChange={(e) => setHashtags(e.target.value)}
          disabled={isRunning}
          rows={3}
          className="w-full px-4 py-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-violet-500 focus:border-transparent disabled:bg-slate-50 disabled:text-slate-500"
          placeholder={
            searchSource === 'keyword' && mode === 'niche'
              ? 'e.g., try on haul, grwm, unboxing, restock'
              : 'e.g., fashionblogger, streetstyle, ootd'
          }
        />
        <p className="text-sm text-slate-500 mt-2">
          {terms.length}{' '}
          {searchSource === 'keyword' && mode === 'niche' ? 'keywords' : 'hashtags'}
        </p>
      </div>
      )}

      {/* Niche Keywords (only in sponsorship mode) */}
      {mode === 'sponsorship' && (
        <div className="mb-6">
          <label className="block text-sm font-medium text-slate-700 mb-2">
            Niche Filter Keywords (optional, comma-separated)
          </label>
          <input
            type="text"
            value={nicheKeywords}
            onChange={(e) => setNicheKeywords(e.target.value)}
            disabled={isRunning}
            className="w-full px-4 py-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-violet-500 focus:border-transparent disabled:bg-slate-50 disabled:text-slate-500"
            placeholder="e.g., fashion, style, beauty, clothing, outfit"
          />
          <p className="text-sm text-slate-500 mt-2">
            Leave empty to search all niches, or add keywords to filter sponsored posts by topic
          </p>
        </div>
      )}

      {/* Quick Add (only in niche mode, and not for seeds — a seed is picked
          from the queue above, never typed as a preset) */}
      {mode === 'niche' && !isSeed && (
        <div className="mb-6">
          <label className="block text-sm font-medium text-slate-700 mb-2">Quick Add</label>
          <div className="flex flex-wrap gap-2">
            {PRESET_HASHTAGS.map((tag) => (
              <button
                key={tag}
                onClick={() => handleAddPreset(tag)}
                disabled={isRunning}
                className="px-3 py-1 text-sm bg-slate-100 text-slate-700 rounded-full hover:bg-violet-100 hover:text-violet-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {tag}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Follower Range */}
      <div className="grid grid-cols-2 gap-4 mb-6">
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-2">Min Followers</label>
          <input
            type="number"
            value={minFollowers}
            onChange={(e) => setMinFollowers(parseInt(e.target.value))}
            disabled={isRunning}
            className="w-full px-4 py-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-violet-500 focus:border-transparent disabled:bg-slate-50 disabled:text-slate-500"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-2">Max Followers</label>
          <input
            type="number"
            value={maxFollowers}
            onChange={(e) => setMaxFollowers(parseInt(e.target.value))}
            disabled={isRunning}
            className="w-full px-4 py-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-violet-500 focus:border-transparent disabled:bg-slate-50 disabled:text-slate-500"
          />
        </div>
      </div>

      {/* Results Per Hashtag */}
      <div className="mb-6">
        <label className="block text-sm font-medium text-slate-700 mb-2">
          {isSeed ? 'Following Entries Per Seed' : 'Results Per Term'}: {effectiveResults}
        </label>
        <input
          type="range"
          min="20"
          max={resultsCap}
          step="10"
          value={effectiveResults}
          onChange={(e) => setResultsPerHashtag(parseInt(e.target.value))}
          disabled={isRunning}
          className="w-full h-2 bg-gradient-to-r from-violet-200 to-violet-600 rounded-lg appearance-none cursor-pointer disabled:opacity-50"
        />
        <div className="flex justify-between text-xs text-slate-500 mt-1">
          <span>20</span>
          <span>{resultsCap}</span>
        </div>
        {platform === 'tiktok' && !isSeed && (
          <p className="text-xs text-slate-500 mt-2">
            TikTok caps a search term at about {TIKTOK_SEARCH_RESULT_CAP} unique results, so the
            shape is many terms shallow rather than few terms deep.
          </p>
        )}
        {isSeed && (
          <p className="text-xs text-slate-500 mt-2">
            The search cap does not apply — a following list is not a search. Each seed&apos;s own
            following count is the ceiling: an account following 40 returns 40 however deep this
            goes, which is why the queue shows the count per seed.
            {selectedSeeds.length > 0 && (
              <> Selected seeds can return at most{' '}
                <span className="font-medium">{seedCeiling.toLocaleString()}</span> entries between
                them.
              </>
            )}
          </p>
        )}
      </div>

      {/* Estimated Cost */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-6">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium text-blue-900">Estimated Cost</div>
            <div className="text-xs text-blue-700">
              {cost.posts.toLocaleString()} {isSeed ? 'following entries' : 'posts'} ${cost.hashtagUsd.toFixed(2)} ·{' '}
              {cost.authorProfiles.toLocaleString()} creator profiles ${cost.profileUsd.toFixed(2)}
              {cost.brandProfiles > 0 && (
                <> · {cost.brandProfiles.toLocaleString()} brand profiles ${cost.brandUsd.toFixed(2)}</>
              )}
            </div>
            {/* The pre-scrape filter's value, shown rather than buried in a
                total: these are authors rejected on the search item's own
                follower count, which costs nothing. */}
            {cost.freeRejections > 0 && (
              <div className="text-xs text-blue-600 mt-1">
                {cost.authors.toLocaleString()} {isSeed ? 'accounts' : 'authors'} expected ·{' '}
                <span className="font-medium">
                  {cost.freeRejections.toLocaleString()} rejected free
                </span>{' '}
                on the search item, saving ~$
                {(cost.freeRejections * 0.005).toFixed(2)}
              </div>
            )}
            {cost.brandProfiles > 0 && (
              <div className="text-xs text-blue-600 mt-1">
                Brand profile count is an upper bound — the run de-duplicates brands, so actual spend will be lower.
              </div>
            )}
          </div>
          <div className="text-2xl font-bold text-blue-600">${cost.totalUsd.toFixed(2)}</div>
        </div>
      </div>

      {/* Start Button */}
      <button
        onClick={handleStart}
        disabled={isRunning || terms.length === 0}
        className="w-full bg-gradient-to-r from-violet-600 to-purple-600 text-white font-semibold py-4 rounded-lg hover:from-violet-700 hover:to-purple-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-lg hover:shadow-xl"
      >
        {isRunning
          ? 'Discovery Running...'
          : isSeed
            ? `Expand ${selectedSeeds.length} Seed${selectedSeeds.length === 1 ? '' : 's'}`
            : 'Start Discovery'}
      </button>
    </div>
  );
}
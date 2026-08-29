'use client';

/**
 * Per-hashtag funnel for a converted Discovery run.
 *
 * Replaces the four fixed stages the old client pipeline showed. Stages were a
 * property of one long linear run; the converted path is one item per search
 * term, each with its own funnel, so the useful view is per term.
 *
 * Every column is a spend decision made visible: entity-excluded and cached
 * handles cost nothing, and the gap between "candidates" and "scraped" is what
 * the free filters saved.
 */

export interface HashtagResult {
  hashtag: string;
  platform: string;
  searchSource?: 'hashtag' | 'keyword';
  cancelled: boolean;
  timedOut: boolean;
  /** Posts came back but no author handle could be read from any of them. */
  extractionFailed?: boolean;
  extractionError?: string;
  /** Stopped before the profile scrape: the free follower reading was absent. */
  halted?: boolean;
  haltReason?: string;
  authorMetaCoverage?: {
    items: number;
    withFollowerCount: number;
    withSignature: number;
    withTtSeller: number;
    withVerified: number;
    followerCountRate: number;
    rawItems: number;
    rawWithAuthorMeta: number;
    rawWithFans: number;
    rawAds: number;
    rawAdsWithFans: number;
    rawPrivateAuthors: number;
  };
  importedSamples?: {
    handle: string;
    followerCount: number;
    signature: string | null;
    ttSeller: boolean | null;
    verified: boolean | null;
  }[];
  preScrapeOutOfBand?: number;
  postsFound: number;
  candidatesFound: number;
  entityExcluded: number;
  alreadyKnown: number;
  cachedReject: number;
  toScrape: number;
  scrapeMissing?: number;
  imported: {
    attempted: number;
    saved: number;
    failed: number;
    inRange: number;
    outOfRangeHigh: number;
    outOfRangeLow: number;
    unknownSize: number;
    cachedBelowFloor: number;
    outOfRangeSamples: { handle: string; followerCount: number; status: string }[];
    unknownSizeSamples: { handle: string; followerCount: number }[];
    errors: string[];
  } | null;
  durationMs: number;
}

const sum = (rows: HashtagResult[], pick: (r: HashtagResult) => number) =>
  rows.reduce((total, row) => total + pick(row), 0);

const cell = 'px-3 py-2 text-right tabular-nums';
const head = 'px-3 py-2 text-right font-medium text-slate-600';

export default function DiscoveryFunnel({ results }: { results: HashtagResult[] }) {
  if (results.length === 0) return null;

  const totals = {
    posts: sum(results, r => r.postsFound),
    candidates: sum(results, r => r.candidatesFound),
    entity: sum(results, r => r.entityExcluded),
    known: sum(results, r => r.alreadyKnown),
    cached: sum(results, r => r.cachedReject),
    scraped: sum(results, r => r.imported?.attempted ?? 0),
    missing: sum(results, r => r.scrapeMissing ?? 0),
    inRange: sum(results, r => r.imported?.inRange ?? 0),
    archived: sum(results, r => (r.imported?.outOfRangeHigh ?? 0) + (r.imported?.outOfRangeLow ?? 0)),
    belowFloor: sum(results, r => r.imported?.cachedBelowFloor ?? 0),
    unknown: sum(results, r => r.imported?.unknownSize ?? 0),
  };

  const saved = totals.entity + totals.known + totals.cached;
  const broken = results.filter(r => r.extractionFailed);
  const halted = results.filter(r => r.halted);
  const coverage = results.find(r => r.authorMetaCoverage && r.authorMetaCoverage.items > 0)
    ?.authorMetaCoverage;
  const samples = results.flatMap(r => r.importedSamples ?? []);
  const isKeyword = results.some(r => r.searchSource === 'keyword');
  const termWord = isKeyword ? 'keyword' : 'hashtag';

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
      {/* A term that returned posts but no handles is a scraper-shape failure,
          not a term nobody posted under. It must not read as an empty result. */}
      {broken.length > 0 && (
        <div className="px-6 py-4 bg-red-50 border-b border-red-200">
          <p className="font-semibold text-red-800">
            {broken.length} {termWord}
            {broken.length === 1 ? '' : 's'} returned posts but no creators — extraction failed
          </p>
          <p className="text-sm text-red-700 mt-1">
            This is not &ldquo;no creators found&rdquo;. The scraper returned posts whose author
            field could not be read, so nothing was scraped and nothing was charged beyond the
            search itself.
          </p>
          <ul className="mt-2 space-y-1 text-sm text-red-700">
            {broken.map(r => (
              <li key={r.hashtag}>
                <span className="font-medium">{isKeyword ? '' : '#'}{r.hashtag}</span>
                {' — '}{r.extractionError}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* FF1: the thing the first TikTok run exists to answer, on its own line. */}
      {coverage && (
        <div className="px-6 py-4 bg-slate-50 border-b border-slate-200">
          <p className="font-semibold text-slate-900">
            Author metadata on the search item — {coverage.items} authors
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-2 text-sm">
            <div>
              <div className={`font-semibold ${coverage.followerCountRate >= 0.5 ? 'text-green-700' : 'text-red-700'}`}>
                {(coverage.followerCountRate * 100).toFixed(0)}%
              </div>
              <div className="text-slate-600">follower count</div>
            </div>
            <div>
              <div className="font-semibold text-slate-900">{coverage.withSignature}</div>
              <div className="text-slate-600">bio</div>
            </div>
            <div>
              <div className="font-semibold text-slate-900">{coverage.withTtSeller}</div>
              <div className="text-slate-600">shop-seller flag</div>
            </div>
            <div>
              <div className="font-semibold text-slate-900">{coverage.withVerified}</div>
              <div className="text-slate-600">verified flag</div>
            </div>
          </div>
          <p className="text-xs text-slate-500 mt-2">
            A follower count on the search item is what lets the band be applied before paying for
            a profile scrape. Bio and shop-seller flag are recorded but filtered on by nothing yet.
          </p>

          {/* Partial coverage has two causes and the percentage above cannot
              tell them apart. These counts can. */}
          {coverage.followerCountRate > 0 && coverage.followerCountRate < 1 && (
            <div className="mt-3 pt-3 border-t border-slate-200 text-xs text-slate-600">
              <p className="font-medium text-slate-800 mb-1">
                Coverage is partial — which of these two is it?
              </p>
              <p>
                <span className="font-mono">{coverage.rawWithAuthorMeta}</span> of{' '}
                <span className="font-mono">{coverage.rawItems}</span> posts carried an authorMeta
                object at all;{' '}
                <span className="font-mono">{coverage.rawWithFans}</span> carried a follower count.
              </p>
              <p className="mt-1">
                {coverage.rawWithAuthorMeta < coverage.rawItems
                  ? 'authorMeta is ABSENT on some posts — a class of item the actor treats differently.'
                  : 'authorMeta is present on every post but the follower count is conditional.'}
              </p>
              <p className="mt-1">
                Ads: <span className="font-mono">{coverage.rawAds}</span>
                {coverage.rawAds > 0 && (
                  <> , of which <span className="font-mono">{coverage.rawAdsWithFans}</span> carried a count</>
                )}
                {' · '}private authors: <span className="font-mono">{coverage.rawPrivateAuthors}</span>
              </p>
            </div>
          )}
        </div>
      )}

      {halted.length > 0 && (
        <div className="px-6 py-4 bg-amber-50 border-b border-amber-200">
          <p className="font-semibold text-amber-900">
            {halted.length} {termWord}{halted.length === 1 ? '' : 's'} halted before scraping
          </p>
          <ul className="mt-2 space-y-1 text-sm text-amber-800">
            {halted.map(r => (
              <li key={r.hashtag}>
                <span className="font-medium">{r.hashtag}</span> — {r.haltReason}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="px-6 py-4 border-b border-slate-200">
        <h3 className="font-semibold text-slate-900">Per-{termWord} funnel</h3>
        <p className="text-sm text-slate-500 mt-1">
          {saved.toLocaleString()} of {totals.candidates.toLocaleString()} candidates filtered
          before any profile scrape — entity-excluded, already known, or previously measured
          below the band.
        </p>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 border-b border-slate-200">
            <tr>
              <th className="px-3 py-2 text-left font-medium text-slate-600">
                {isKeyword ? 'Keyword' : 'Hashtag'}
              </th>
              <th className={head}>Posts</th>
              <th className={head}>Candidates</th>
              <th className={head} title="Classified as a non-creator. Free.">Entity</th>
              <th className={head} title="Already in the database. Free.">Known</th>
              <th className={head} title="Measured below the band on an earlier run. Free.">Cached</th>
              <th className={head} title="Rejected on the search item's follower count. Free.">Pre-filtered</th>
              <th className={head}>Scraped</th>
              <th className={head} title="Actor returned no profile — private, deleted or renamed.">Missing</th>
              <th className={head}>In band</th>
              <th className={head} title="Out of range, kept as a creator record.">Archived</th>
              <th className={head} title="Below the near-miss floor. Cached, no creator record.">Below floor</th>
              <th className={head} title="Follower count not measured.">Unknown</th>
            </tr>
          </thead>
          <tbody>
            {results.map(r => (
              <tr
                key={r.hashtag}
                className={`border-b border-slate-100 ${r.extractionFailed ? 'bg-red-50' : ''}`}
              >
                <td className="px-3 py-2 font-medium text-slate-900">
                  {r.searchSource === 'keyword' ? '' : '#'}{r.hashtag}
                  {r.extractionFailed && (
                    <span className="ml-2 text-xs font-semibold text-red-700">extraction failed</span>
                  )}
                  {r.cancelled && <span className="ml-2 text-xs text-amber-600">stopped</span>}
                  {r.timedOut && <span className="ml-2 text-xs text-amber-600">timed out</span>}
                </td>
                <td className={cell}>{r.postsFound}</td>
                <td className={cell}>{r.candidatesFound}</td>
                <td className={`${cell} text-slate-400`}>{r.entityExcluded}</td>
                <td className={`${cell} text-slate-400`}>{r.alreadyKnown}</td>
                <td className={`${cell} text-slate-400`}>{r.cachedReject}</td>
                <td className={`${cell} text-slate-400`}>{r.preScrapeOutOfBand ?? 0}</td>
                <td className={cell}>{r.imported?.attempted ?? 0}</td>
                <td className={`${cell} text-slate-400`}>{r.scrapeMissing ?? 0}</td>
                <td className={`${cell} font-semibold text-violet-700`}>{r.imported?.inRange ?? 0}</td>
                <td className={cell}>
                  {(r.imported?.outOfRangeHigh ?? 0) + (r.imported?.outOfRangeLow ?? 0)}
                </td>
                <td className={cell}>{r.imported?.cachedBelowFloor ?? 0}</td>
                <td className={cell}>{r.imported?.unknownSize ?? 0}</td>
              </tr>
            ))}
          </tbody>
          <tfoot className="bg-slate-50 font-semibold">
            <tr>
              <td className="px-3 py-2 text-left">Total</td>
              <td className={cell}>{totals.posts}</td>
              <td className={cell}>{totals.candidates}</td>
              <td className={cell}>{totals.entity}</td>
              <td className={cell}>{totals.known}</td>
              <td className={cell}>{totals.cached}</td>
              <td className={cell}>{sum(results, r => r.preScrapeOutOfBand ?? 0)}</td>
              <td className={cell}>{totals.scraped}</td>
              <td className={cell}>{totals.missing}</td>
              <td className={`${cell} text-violet-700`}>{totals.inRange}</td>
              <td className={cell}>{totals.archived}</td>
              <td className={cell}>{totals.belowFloor}</td>
              <td className={cell}>{totals.unknown}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      {/* DD2a: an in-band import is not a result. Judge these directly. */}
      {samples.length > 0 && (
        <div className="px-6 py-4 border-t border-slate-200">
          <h4 className="font-semibold text-slate-900">Imported creators — sample</h4>
          <p className="text-sm text-slate-500 mt-1 mb-3">
            The measure is whether these are people you would contact, not how many were in band.
            Country is absent because neither platform&rsquo;s profile payload carries it — it
            appears only after the intelligence pass.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50">
                <tr>
                  <th className="px-3 py-2 text-left font-medium text-slate-600">Handle</th>
                  <th className={head}>Followers</th>
                  <th className="px-3 py-2 text-left font-medium text-slate-600">Bio</th>
                  <th className="px-3 py-2 text-left font-medium text-slate-600">Flags</th>
                </tr>
              </thead>
              <tbody>
                {samples.map(sample => (
                  <tr key={sample.handle} className="border-b border-slate-100">
                    <td className="px-3 py-2 font-medium text-slate-900">@{sample.handle}</td>
                    <td className={cell}>{sample.followerCount.toLocaleString()}</td>
                    <td className="px-3 py-2 text-slate-600 max-w-md truncate">
                      {sample.signature || <span className="text-slate-400">—</span>}
                    </td>
                    <td className="px-3 py-2 text-slate-600">
                      {sample.ttSeller && (
                        <span className="mr-2 text-xs px-2 py-0.5 rounded bg-amber-100 text-amber-800">
                          shop seller
                        </span>
                      )}
                      {sample.verified && (
                        <span className="text-xs px-2 py-0.5 rounded bg-blue-100 text-blue-800">
                          verified
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
  );
}

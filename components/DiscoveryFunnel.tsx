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
  cancelled: boolean;
  timedOut: boolean;
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

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
      <div className="px-6 py-4 border-b border-slate-200">
        <h3 className="font-semibold text-slate-900">Per-hashtag funnel</h3>
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
              <th className="px-3 py-2 text-left font-medium text-slate-600">Hashtag</th>
              <th className={head}>Posts</th>
              <th className={head}>Candidates</th>
              <th className={head} title="Classified as a non-creator. Free.">Entity</th>
              <th className={head} title="Already in the database. Free.">Known</th>
              <th className={head} title="Measured below the band on an earlier run. Free.">Cached</th>
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
              <tr key={r.hashtag} className="border-b border-slate-100">
                <td className="px-3 py-2 font-medium text-slate-900">
                  #{r.hashtag}
                  {r.cancelled && <span className="ml-2 text-xs text-amber-600">stopped</span>}
                  {r.timedOut && <span className="ml-2 text-xs text-amber-600">timed out</span>}
                </td>
                <td className={cell}>{r.postsFound}</td>
                <td className={cell}>{r.candidatesFound}</td>
                <td className={`${cell} text-slate-400`}>{r.entityExcluded}</td>
                <td className={`${cell} text-slate-400`}>{r.alreadyKnown}</td>
                <td className={`${cell} text-slate-400`}>{r.cachedReject}</td>
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
    </div>
  );
}

'use client';

import type { PipelineStatus, DiscoveryMode, SponsorshipStats } from '@/lib/types';

interface ProgressPanelProps {
  status: PipelineStatus;
  mode: DiscoveryMode;
  sponsorshipStats?: SponsorshipStats;
}

export default function ProgressPanel({ status, mode, sponsorshipStats }: ProgressPanelProps) {
  const getStageColor = (stage: string) => {
    if (status.stage === stage) return 'bg-violet-600 text-white';
    const stages = ['idle', 'hashtags', 'profiles', 'filtering', 'complete', 'error'];
    const currentIndex = stages.indexOf(status.stage);
    const stageIndex = stages.indexOf(stage);
    return stageIndex < currentIndex ? 'bg-green-500 text-white' : 'bg-slate-200 text-slate-500';
  };

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-8">
      <h2 className="text-2xl font-bold text-slate-900 mb-6">Discovery Progress</h2>

      {/* Stage Indicators */}
      <div className="flex items-center justify-between mb-8">
        <div className="flex-1">
          <div className={`w-12 h-12 rounded-full ${getStageColor('hashtags')} flex items-center justify-center font-bold mx-auto`}>
            1
          </div>
          <div className="text-xs text-center mt-2 text-slate-600">Hashtags</div>
        </div>
        <div className="flex-1 h-1 bg-slate-200 mx-2">
          <div
            className="h-full bg-violet-600 transition-all duration-500"
            style={{ width: status.stage === 'hashtags' || status.stage === 'idle' ? '0%' : '100%' }}
          />
        </div>
        <div className="flex-1">
          <div className={`w-12 h-12 rounded-full ${getStageColor('profiles')} flex items-center justify-center font-bold mx-auto`}>
            2
          </div>
          <div className="text-xs text-center mt-2 text-slate-600">Profiles</div>
        </div>
        <div className="flex-1 h-1 bg-slate-200 mx-2">
          <div
            className="h-full bg-violet-600 transition-all duration-500"
            style={{ width: status.stage === 'filtering' || status.stage === 'complete' ? '100%' : '0%' }}
          />
        </div>
        <div className="flex-1">
          <div className={`w-12 h-12 rounded-full ${getStageColor('filtering')} flex items-center justify-center font-bold mx-auto`}>
            3
          </div>
          <div className="text-xs text-center mt-2 text-slate-600">Filtering</div>
        </div>
      </div>

      {/* Progress Bar */}
      <div className="mb-6">
        <div className="flex justify-between text-sm text-slate-600 mb-2">
          <span>{status.message}</span>
          <span>{status.progress}%</span>
        </div>
        <div className="w-full h-3 bg-slate-200 rounded-full overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-violet-600 to-purple-600 transition-all duration-300"
            style={{ width: `${status.progress}%` }}
          />
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-blue-50 rounded-lg p-4">
          <div className="text-2xl font-bold text-blue-900">{status.stats?.postsFound || 0}</div>
          <div className="text-xs text-blue-700">Posts Found</div>
        </div>
        <div className="bg-indigo-50 rounded-lg p-4">
          <div className="text-2xl font-bold text-indigo-900">{status.stats?.uniqueHandles || 0}</div>
          <div className="text-xs text-indigo-700">Unique Handles</div>
        </div>
        <div className="bg-purple-50 rounded-lg p-4">
          <div className="text-2xl font-bold text-purple-900">{status.stats?.profilesScraped || 0}</div>
          <div className="text-xs text-purple-700">Profiles Scraped</div>
        </div>
        <div className="bg-violet-50 rounded-lg p-4">
          <div className="text-2xl font-bold text-violet-900">{status.stats?.creatorsInRange || 0}</div>
          <div className="text-xs text-violet-700">In Range</div>
        </div>
      </div>

      {/* Sponsorship Stats (only in sponsorship mode) */}
      {mode === 'sponsorship' && sponsorshipStats && (
        <div className="mt-4 grid grid-cols-3 gap-4">
          <div className="bg-green-50 rounded-lg p-4">
            <div className="text-2xl font-bold text-green-900">{sponsorshipStats.sponsoredPostsFound}</div>
            <div className="text-xs text-green-700">Sponsored Posts</div>
          </div>
          <div className="bg-teal-50 rounded-lg p-4">
            <div className="text-2xl font-bold text-teal-900">{sponsorshipStats.brandsDetected}</div>
            <div className="text-xs text-teal-700">Brands Detected</div>
          </div>
          <div className="bg-cyan-50 rounded-lg p-4">
            <div className="text-2xl font-bold text-cyan-900">{sponsorshipStats.partnershipsLogged}</div>
            <div className="text-xs text-cyan-700">Partnerships Logged</div>
          </div>
        </div>
      )}

      {/* Error Message */}
      {status.error && (
        <div className="mt-4 bg-red-50 border border-red-200 rounded-lg p-4">
          <div className="text-sm font-medium text-red-900">Error</div>
          <div className="text-sm text-red-700 mt-1">{status.error}</div>
        </div>
      )}
    </div>
  );
}
'use client';

import type { PipelineStatus } from '@/lib/types';

interface ProgressPanelProps {
  status: PipelineStatus;
  onStop: () => void;
}

export default function ProgressPanel({ status, onStop }: ProgressPanelProps) {
  const getStageLabel = (stage: string) => {
    switch (stage) {
      case 'hashtags':
        return 'Scraping Hashtag Posts';
      case 'profiles':
        return 'Scraping Creator Profiles';
      case 'filtering':
        return 'Filtering Results';
      case 'complete':
        return 'Discovery Complete';
      case 'error':
        return 'Error';
      default:
        return 'Initializing';
    }
  };

  const stages = ['hashtags', 'profiles', 'filtering', 'complete'];
  const currentStageIndex = stages.indexOf(status.stage);

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-8">
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-2xl font-bold text-slate-900">Discovery Progress</h2>
        {status.stage !== 'complete' && status.stage !== 'error' && (
          <button
            onClick={onStop}
            className="px-4 py-2 bg-red-50 hover:bg-red-100 text-red-600 font-medium rounded-lg transition-colors"
          >
            Stop Discovery
          </button>
        )}
      </div>

      <div className="mb-8">
        <div className="flex justify-between items-center mb-2">
          <span className="text-sm font-medium text-slate-700">{getStageLabel(status.stage)}</span>
          <span className="text-sm font-bold text-slate-900">{Math.round(status.progress)}%</span>
        </div>
        <div className="w-full h-3 bg-slate-100 rounded-full overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-blue-600 to-violet-600 transition-all duration-500 ease-out"
            style={{ width: `${status.progress}%` }}
          />
        </div>
        <p className="text-sm text-slate-600 mt-2">{status.message}</p>
      </div>

      <div className="grid grid-cols-4 gap-4 mb-8">
        {stages.map((stage, index) => {
          const isActive = index === currentStageIndex;
          const isComplete = index < currentStageIndex || status.stage === 'complete';
          
          return (
            <div key={stage} className="text-center">
              <div
                className={`w-full h-2 rounded-full mb-2 transition-colors ${
                  isComplete
                    ? 'bg-gradient-to-r from-blue-600 to-violet-600'
                    : isActive
                    ? 'bg-gradient-to-r from-blue-400 to-violet-400'
                    : 'bg-slate-200'
                }`}
              />
              <p
                className={`text-xs font-medium ${
                  isActive || isComplete ? 'text-slate-900' : 'text-slate-500'
                }`}
              >
                {getStageLabel(stage)}
              </p>
            </div>
          );
        })}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-gradient-to-br from-blue-50 to-blue-100 rounded-xl p-4">
          <div className="text-2xl font-bold text-blue-900">
            {status.stats.postsFound.toLocaleString()}
          </div>
          <div className="text-sm text-blue-700 mt-1">Posts Found</div>
        </div>
        
        <div className="bg-gradient-to-br from-violet-50 to-violet-100 rounded-xl p-4">
          <div className="text-2xl font-bold text-violet-900">
            {status.stats.uniqueHandles.toLocaleString()}
          </div>
          <div className="text-sm text-violet-700 mt-1">Unique Creators</div>
        </div>
        
        <div className="bg-gradient-to-br from-indigo-50 to-indigo-100 rounded-xl p-4">
          <div className="text-2xl font-bold text-indigo-900">
            {status.stats.profilesScraped.toLocaleString()}
          </div>
          <div className="text-sm text-indigo-700 mt-1">Profiles Scraped</div>
        </div>
        
        <div className="bg-gradient-to-br from-purple-50 to-purple-100 rounded-xl p-4">
          <div className="text-2xl font-bold text-purple-900">
            {status.stats.creatorsInRange.toLocaleString()}
          </div>
          <div className="text-sm text-purple-700 mt-1">In Range</div>
        </div>
      </div>

      {status.error && (
        <div className="mt-6 bg-red-50 border border-red-200 rounded-xl p-4">
          <div className="flex items-start">
            <svg className="w-5 h-5 text-red-600 mt-0.5 mr-3" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
            </svg>
            <div>
              <h4 className="text-sm font-semibold text-red-900 mb-1">Error</h4>
              <p className="text-sm text-red-700">{status.error}</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
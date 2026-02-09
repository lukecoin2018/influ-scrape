'use client';

import { useState } from 'react';
import type { DiscoveryConfig, DiscoveryMode } from '@/lib/types';

const PRESET_HASHTAGS = [
  '#beautyblogger', '#makeuptutorial', '#skincare', '#lifestyleblogger',
  '#fashionweek', '#vintag efashion', '#minimaliststyle', '#plussize'
];

const SPONSORSHIP_HASHTAGS = [
  'ad', 'sponsored', 'gifted', 'brandpartner', 'collab', 
  'brandambassador', 'paidpartnership'
];

interface SetupPanelProps {
  onStartDiscovery: (config: DiscoveryConfig) => void;
  isRunning: boolean;
}

export default function SetupPanel({ onStartDiscovery, isRunning }: SetupPanelProps) {
  const [mode, setMode] = useState<DiscoveryMode>('niche');
  const [hashtags, setHashtags] = useState('fashionblogger, sustainablefashion, ootd, streetstyle, fashionista, styleinspo');
  const [nicheKeywords, setNicheKeywords] = useState('');
  const [minFollowers, setMinFollowers] = useState(50000);
  const [maxFollowers, setMaxFollowers] = useState(500000);
  const [resultsPerHashtag, setResultsPerHashtag] = useState(200);

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

  const handleStart = () => {
    const hashtagArray = hashtags.split(',').map(h => h.trim()).filter(Boolean);
    const keywordsArray = nicheKeywords.split(',').map(k => k.trim()).filter(Boolean);
    
    onStartDiscovery({
      hashtags: hashtagArray,
      minFollowers,
      maxFollowers,
      resultsPerHashtag,
      mode,
      nicheKeywords: keywordsArray
    });
  };

  const estimatedCost = hashtags.split(',').length * 0.5 + (resultsPerHashtag / 20) * 3;

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

      {/* Hashtags */}
      <div className="mb-6">
        <label className="block text-sm font-medium text-slate-700 mb-2">
          {mode === 'sponsorship' ? 'Sponsorship Hashtags (comma-separated)' : 'Hashtags (comma-separated)'}
        </label>
        <textarea
          value={hashtags}
          onChange={(e) => setHashtags(e.target.value)}
          disabled={isRunning}
          rows={3}
          className="w-full px-4 py-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-violet-500 focus:border-transparent disabled:bg-slate-50 disabled:text-slate-500"
          placeholder="e.g., fashionblogger, streetstyle, ootd"
        />
        <p className="text-sm text-slate-500 mt-2">{hashtags.split(',').filter(h => h.trim()).length} hashtags</p>
      </div>

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

      {/* Quick Add (only in niche mode) */}
      {mode === 'niche' && (
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
          Results Per Hashtag: {resultsPerHashtag}
        </label>
        <input
          type="range"
          min="20"
          max="500"
          step="10"
          value={resultsPerHashtag}
          onChange={(e) => setResultsPerHashtag(parseInt(e.target.value))}
          disabled={isRunning}
          className="w-full h-2 bg-gradient-to-r from-violet-200 to-violet-600 rounded-lg appearance-none cursor-pointer disabled:opacity-50"
        />
        <div className="flex justify-between text-xs text-slate-500 mt-1">
          <span>20</span>
          <span>500</span>
        </div>
      </div>

      {/* Estimated Cost */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-6">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium text-blue-900">Estimated Cost</div>
            <div className="text-xs text-blue-700">
              Hashtag scraping: ${(hashtags.split(',').length * 0.5).toFixed(2)} · Profile scraping: ${((resultsPerHashtag / 20) * 3).toFixed(2)}
            </div>
          </div>
          <div className="text-2xl font-bold text-blue-600">${estimatedCost.toFixed(2)}</div>
        </div>
      </div>

      {/* Start Button */}
      <button
        onClick={handleStart}
        disabled={isRunning || hashtags.trim().length === 0}
        className="w-full bg-gradient-to-r from-violet-600 to-purple-600 text-white font-semibold py-4 rounded-lg hover:from-violet-700 hover:to-purple-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-lg hover:shadow-xl"
      >
        {isRunning ? 'Discovery Running...' : 'Start Discovery'}
      </button>
    </div>
  );
}
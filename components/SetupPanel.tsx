'use client';

import { useState } from 'react';
import type { DiscoveryConfig } from '@/lib/types';

interface SetupPanelProps {
  onStartDiscovery: (config: DiscoveryConfig) => void;
  isRunning: boolean;
}

const DEFAULT_HASHTAGS = [
  'fashionblogger',
  'sustainablefashion',
  'ootd',
  'streetstyle',
  'fashionista',
  'styleinspo'
];

const SUGGESTED_HASHTAGS = [
  'beautyblogger',
  'makeuptutorial',
  'skincare',
  'lifestyleblogger',
  'fashionweek',
  'vintagefashion',
  'minimaliststyle',
  'plussize',
];

export default function SetupPanel({ onStartDiscovery, isRunning }: SetupPanelProps) {
  const [hashtagInput, setHashtagInput] = useState(DEFAULT_HASHTAGS.join(', '));
  const [minFollowers, setMinFollowers] = useState(50000);
  const [maxFollowers, setMaxFollowers] = useState(500000);
  const [resultsPerHashtag, setResultsPerHashtag] = useState(100);

  const handleAddHashtag = (hashtag: string) => {
    const currentTags = hashtagInput.split(',').map(t => t.trim()).filter(Boolean);
    if (!currentTags.includes(hashtag)) {
      setHashtagInput([...currentTags, hashtag].join(', '));
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    const hashtags = hashtagInput
      .split(',')
      .map(tag => tag.trim().replace(/^#/, ''))
      .filter(Boolean);

    if (hashtags.length === 0) {
      alert('Please enter at least one hashtag');
      return;
    }

    const config: DiscoveryConfig = {
      hashtags,
      minFollowers,
      maxFollowers,
      resultsPerHashtag,
    };

    onStartDiscovery(config);
  };

  const estimatedHashtagCost = (hashtagInput.split(',').filter(Boolean).length * resultsPerHashtag * 2.5) / 1000;
  const estimatedProfileCost = (resultsPerHashtag * hashtagInput.split(',').filter(Boolean).length * 0.01);
  const totalEstimatedCost = estimatedHashtagCost + estimatedProfileCost;

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-8">
      <h2 className="text-2xl font-bold text-slate-900 mb-6">Discovery Setup</h2>
      
      <form onSubmit={handleSubmit} className="space-y-6">
        <div>
          <label htmlFor="hashtags" className="block text-sm font-medium text-slate-700 mb-2">
            Hashtags (comma-separated)
          </label>
          <textarea
            id="hashtags"
            value={hashtagInput}
            onChange={(e) => setHashtagInput(e.target.value)}
            placeholder="fashionblogger, sustainablefashion, ootd"
            className="w-full px-4 py-3 border border-slate-300 rounded-xl focus:ring-2 focus:ring-violet-500 focus:border-transparent resize-none"
            rows={3}
            disabled={isRunning}
          />
          <p className="mt-2 text-xs text-slate-500">
            {hashtagInput.split(',').filter(Boolean).length} hashtags
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700 mb-2">
            Quick Add
          </label>
          <div className="flex flex-wrap gap-2">
            {SUGGESTED_HASHTAGS.map(tag => (
              <button
                key={tag}
                type="button"
                onClick={() => handleAddHashtag(tag)}
                disabled={isRunning}
                className="px-3 py-1.5 text-sm bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                #{tag}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor="minFollowers" className="block text-sm font-medium text-slate-700 mb-2">
              Min Followers
            </label>
            <input
              id="minFollowers"
              type="number"
              value={minFollowers}
              onChange={(e) => setMinFollowers(Number(e.target.value))}
              className="w-full px-4 py-3 border border-slate-300 rounded-xl focus:ring-2 focus:ring-violet-500 focus:border-transparent"
              min={0}
              step={1000}
              disabled={isRunning}
            />
          </div>
          <div>
            <label htmlFor="maxFollowers" className="block text-sm font-medium text-slate-700 mb-2">
              Max Followers
            </label>
            <input
              id="maxFollowers"
              type="number"
              value={maxFollowers}
              onChange={(e) => setMaxFollowers(Number(e.target.value))}
              className="w-full px-4 py-3 border border-slate-300 rounded-xl focus:ring-2 focus:ring-violet-500 focus:border-transparent"
              min={0}
              step={1000}
              disabled={isRunning}
            />
          </div>
        </div>

        <div>
          <label htmlFor="resultsPerHashtag" className="block text-sm font-medium text-slate-700 mb-2">
            Results Per Hashtag: {resultsPerHashtag}
          </label>
          <input
            id="resultsPerHashtag"
            type="range"
            value={resultsPerHashtag}
            onChange={(e) => setResultsPerHashtag(Number(e.target.value))}
            className="w-full"
            min={20}
            max={500}
            step={10}
            disabled={isRunning}
          />
          <div className="flex justify-between text-xs text-slate-500 mt-1">
            <span>20</span>
            <span>500</span>
          </div>
        </div>

        <div className="bg-gradient-to-r from-blue-50 to-violet-50 rounded-xl p-4">
          <div className="flex justify-between items-center">
            <span className="text-sm font-medium text-slate-700">Estimated Cost</span>
            <span className="text-lg font-bold bg-gradient-to-r from-blue-600 to-violet-600 bg-clip-text text-transparent">
              ${totalEstimatedCost.toFixed(2)}
            </span>
          </div>
          <p className="text-xs text-slate-600 mt-1">
            Hashtag scraping: ${estimatedHashtagCost.toFixed(2)} · Profile scraping: ${estimatedProfileCost.toFixed(2)}
          </p>
        </div>

        <button
          type="submit"
          disabled={isRunning}
          className="w-full bg-gradient-to-r from-blue-600 to-violet-600 hover:from-blue-700 hover:to-violet-700 text-white font-semibold py-4 px-6 rounded-xl transition-all shadow-lg shadow-violet-500/30 disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none"
        >
          {isRunning ? 'Discovery Running...' : 'Start Discovery'}
        </button>
      </form>
    </div>
  );
}
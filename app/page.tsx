'use client';

import { useState } from 'react';
import SetupPanel from '@/components/SetupPanel';
import ProgressPanel from '@/components/ProgressPanel';
import ResultsTable from '@/components/ResultsTable';
import ExportButton from '@/components/ExportButton';
import type { DiscoveryConfig, PipelineStatus, DiscoveredCreator, InstagramProfile } from '@/lib/types';
import { extractUniqueUsernames, mapProfileToCreator } from '@/lib/apify';

export default function Home() {
  const [activeTab, setActiveTab] = useState<'setup' | 'progress' | 'results'>('setup');
  const [isRunning, setIsRunning] = useState(false);
  const [shouldStop, setShouldStop] = useState(false);
  const [status, setStatus] = useState<PipelineStatus>({
    stage: 'idle',
    progress: 0,
    message: 'Ready to start discovery',
    stats: {
      postsFound: 0,
      uniqueHandles: 0,
      profilesScraped: 0,
      creatorsInRange: 0,
    },
  });
  const [creators, setCreators] = useState<DiscoveredCreator[]>([]);

  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  const pollRunStatus = async (runId: string): Promise<{ status: string; datasetId?: string }> => {
    while (true) {
      if (shouldStop) {
        throw new Error('Discovery stopped by user');
      }

      const response = await fetch(`/api/discover/run-status/${runId}`);
      const data = await response.json();

      if (data.error) {
        throw new Error(data.error);
      }

      if (data.status === 'SUCCEEDED') {
        return data;
      } else if (data.status === 'FAILED' || data.status === 'ABORTED') {
        throw new Error(`Actor run ${data.status.toLowerCase()}`);
      }

      await sleep(3000);
    }
  };

  const startDiscovery = async (discoveryConfig: DiscoveryConfig) => {
    setIsRunning(true);
    setShouldStop(false);
    setCreators([]);
    setActiveTab('progress');

    try {
      setStatus({
        stage: 'hashtags',
        progress: 10,
        message: `Starting to scrape ${discoveryConfig.hashtags.length} hashtags...`,
        stats: { postsFound: 0, uniqueHandles: 0, profilesScraped: 0, creatorsInRange: 0 },
      });

      const hashtagResponse = await fetch('/api/discover/start-hashtag-scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hashtags: discoveryConfig.hashtags,
          resultsPerHashtag: discoveryConfig.resultsPerHashtag,
        }),
      });

      const hashtagData = await hashtagResponse.json();
      if (hashtagData.error) {
        throw new Error(hashtagData.error);
      }

      setStatus(prev => ({
        ...prev,
        progress: 20,
        message: 'Scraping hashtag posts...',
      }));

      const hashtagResult = await pollRunStatus(hashtagData.runId);

      if (!hashtagResult.datasetId) {
        throw new Error('No dataset ID returned from hashtag scraper');
      }

      setStatus(prev => ({
        ...prev,
        progress: 40,
        message: 'Fetching hashtag results...',
      }));

      const postsResponse = await fetch(`/api/discover/dataset/${hashtagResult.datasetId}`);
      const postsData = await postsResponse.json();

      if (postsData.error) {
        throw new Error(postsData.error);
      }

      const posts = postsData.items || [];
      const uniqueUsernames = extractUniqueUsernames(posts);

      setStatus(prev => ({
        ...prev,
        progress: 50,
        message: `Found ${posts.length} posts from ${uniqueUsernames.length} unique creators`,
        stats: {
          ...prev.stats,
          postsFound: posts.length,
          uniqueHandles: uniqueUsernames.length,
        },
      }));

      if (uniqueUsernames.length === 0) {
        throw new Error('No creators found in hashtag results');
      }

      await sleep(1000);

      setStatus(prev => ({
        ...prev,
        stage: 'profiles',
        progress: 50,
        message: 'Starting to scrape creator profiles...',
      }));

      const batchSize = 50;
      const batches = [];
      for (let i = 0; i < uniqueUsernames.length; i += batchSize) {
        batches.push(uniqueUsernames.slice(i, i + batchSize));
      }

      let allProfiles: unknown[] = [];

      for (let i = 0; i < batches.length; i++) {
        if (shouldStop) {
          throw new Error('Discovery stopped by user');
        }

        const batch = batches[i];
        const batchProgress = 50 + (i / batches.length) * 30;

        setStatus(prev => ({
          ...prev,
          progress: batchProgress,
          message: `Scraping batch ${i + 1} of ${batches.length} (${batch.length} profiles)...`,
        }));

        const profileResponse = await fetch('/api/discover/start-profile-scrape', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ usernames: batch }),
        });

        const profileData = await profileResponse.json();
        if (profileData.error) {
          console.error(`Error in batch ${i + 1}:`, profileData.error);
          continue;
        }

        const profileResult = await pollRunStatus(profileData.runId);

        if (profileResult.datasetId) {
          const batchProfilesResponse = await fetch(`/api/discover/dataset/${profileResult.datasetId}`);
          const batchProfilesData = await batchProfilesResponse.json();

          if (!batchProfilesData.error && batchProfilesData.items) {
            allProfiles = allProfiles.concat(batchProfilesData.items);
            
            setStatus(prev => ({
              ...prev,
              stats: {
                ...prev.stats,
                profilesScraped: allProfiles.length,
              },
            }));
          }
        }

        if (i < batches.length - 1) {
          await sleep(2000);
        }
      }

      setStatus(prev => ({
        ...prev,
        progress: 80,
        message: `Scraped ${allProfiles.length} profiles. Filtering results...`,
      }));

      setStatus(prev => ({
        ...prev,
        stage: 'filtering',
        progress: 85,
        message: 'Filtering creators by follower count...',
      }));

      const filteredCreators = (allProfiles as InstagramProfile[])
        .map(mapProfileToCreator)
        .filter(creator => {
          return (
            creator.followerCount >= discoveryConfig.minFollowers &&
            creator.followerCount <= discoveryConfig.maxFollowers
          );
        });

      setStatus(prev => ({
        ...prev,
        progress: 95,
        message: `Found ${filteredCreators.length} creators in range!`,
        stats: {
          ...prev.stats,
          creatorsInRange: filteredCreators.length,
        },
      }));

      await sleep(500);

      setCreators(filteredCreators);

      setStatus(prev => ({
        ...prev,
        stage: 'complete',
        progress: 100,
        message: `Discovery complete! Found ${filteredCreators.length} creators.`,
      }));

      setActiveTab('results');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
      console.error('Discovery error:', error);
      setStatus(prev => ({
        ...prev,
        stage: 'error',
        message: 'Discovery failed',
        error: errorMessage,
      }));
    } finally {
      setIsRunning(false);
      setShouldStop(false);
    }
  };

  const handleStop = () => {
    setShouldStop(true);
    setStatus(prev => ({
      ...prev,
      message: 'Stopping discovery...',
    }));
  };

  return (
    <div className="min-h-screen py-8 px-4">
      <div className="max-w-7xl mx-auto">
        <div className="text-center mb-12">
          <h1 className="text-5xl font-bold bg-gradient-to-r from-blue-600 to-violet-600 bg-clip-text text-transparent mb-4">
            InfluenceAI Discovery
          </h1>
          <p className="text-slate-600 text-lg">
            Discover Instagram influencers by hashtag and follower count
          </p>
        </div>

        <div className="flex gap-2 mb-6">
          <button
            onClick={() => setActiveTab('setup')}
            disabled={isRunning}
            className={`px-6 py-3 font-semibold rounded-xl transition-all ${
              activeTab === 'setup'
                ? 'bg-white text-slate-900 shadow-md'
                : 'text-slate-600 hover:text-slate-900 hover:bg-white/50'
            } disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            Setup
          </button>
          <button
            onClick={() => setActiveTab('progress')}
            disabled={!isRunning && status.stage === 'idle'}
            className={`px-6 py-3 font-semibold rounded-xl transition-all ${
              activeTab === 'progress'
                ? 'bg-white text-slate-900 shadow-md'
                : 'text-slate-600 hover:text-slate-900 hover:bg-white/50'
            } disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            Progress
          </button>
          <button
            onClick={() => setActiveTab('results')}
            disabled={creators.length === 0}
            className={`px-6 py-3 font-semibold rounded-xl transition-all ${
              activeTab === 'results'
                ? 'bg-white text-slate-900 shadow-md'
                : 'text-slate-600 hover:text-slate-900 hover:bg-white/50'
            } disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            Results ({creators.length})
          </button>
        </div>

        <div className="mb-6">
          {activeTab === 'setup' && (
            <SetupPanel onStartDiscovery={startDiscovery} isRunning={isRunning} />
          )}
          {activeTab === 'progress' && (
            <ProgressPanel status={status} onStop={handleStop} />
          )}
          {activeTab === 'results' && (
            <div className="space-y-6">
              <div className="flex justify-between items-center">
                <h2 className="text-2xl font-bold text-slate-900">
                  Discovered Creators
                </h2>
                <ExportButton creators={creators} />
              </div>
              <ResultsTable creators={creators} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
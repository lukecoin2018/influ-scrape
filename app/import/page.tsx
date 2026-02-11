'use client';

import { useState } from 'react';
import type { DiscoveredCreator } from '@/lib/types';

interface ImportStats {
  datasetsProcessed: number;
  totalDatasets: number;
  profilesFound: number;
  uniqueCreators: number;
  inRange: number;
  saved: number;
  failed: number;
}

function slimCreator(creator: any) {
  return {
    handle: creator.handle,
    fullName: creator.fullName || '',
    bio: (creator.bio || '').slice(0, 500),
    followerCount: creator.followerCount,
    followingCount: creator.followingCount,
    postsCount: creator.postsCount,
    engagementRate: creator.engagementRate,
    isVerified: creator.isVerified || false,
    isBusinessAccount: creator.isBusinessAccount || false,
    categoryName: creator.categoryName || '',
    profileUrl: creator.profileUrl || '',
    website: creator.website || '',
  };
}

export default function ImportPage() {
  const [datasetIds, setDatasetIds] = useState('');
  const [minFollowers, setMinFollowers] = useState(30000);
  const [maxFollowers, setMaxFollowers] = useState(500000);
  const [isImporting, setIsImporting] = useState(false);
  const [progress, setProgress] = useState('');
  const [stats, setStats] = useState<ImportStats>({
    datasetsProcessed: 0,
    totalDatasets: 0,
    profilesFound: 0,
    uniqueCreators: 0,
    inRange: 0,
    saved: 0,
    failed: 0,
  });

  const mapApifyProfile = (profile: any) => {
    return {
      handle: (profile.username || profile.profileName || '').toLowerCase().replace(/^@/, ''),
      fullName: profile.fullName || profile.displayName || '',
      bio: (profile.biography || profile.bio || '').slice(0, 500),
      followerCount: profile.followersCount || profile.followedByCount || profile.subscribersCount || 0,
      followingCount: profile.followsCount || profile.followingCount || 0,
      postsCount: profile.postsCount || profile.mediaCount || 0,
      engagementRate: profile.engagementRate || null,
      isVerified: profile.verified || profile.isVerified || false,
      isBusinessAccount: profile.isBusinessAccount || false,
      categoryName: profile.businessCategoryName || profile.categoryName || '',
      profileUrl: `https://instagram.com/${profile.username || profile.profileName}`,
      website: profile.externalUrl || profile.website || '',
    };
  };

  const startImport = async () => {
    const ids = datasetIds
      .split(/[\n,]/)
      .map(id => id.trim())
      .filter(id => id.length > 0);

    if (ids.length === 0) {
      alert('Please enter at least one dataset ID');
      return;
    }

    setIsImporting(true);
    setProgress('Starting import...');
    setStats({
      datasetsProcessed: 0,
      totalDatasets: ids.length,
      profilesFound: 0,
      uniqueCreators: 0,
      inRange: 0,
      saved: 0,
      failed: 0,
    });

    const uniqueCreatorsMap = new Map();

    for (let i = 0; i < ids.length; i++) {
      const datasetId = ids[i];
      setProgress(`Fetching dataset ${i + 1}/${ids.length}: ${datasetId}`);

      try {
        const response = await fetch(`/api/import/fetch-dataset?datasetId=${datasetId}`);
        
        if (!response.ok) {
          console.error(`Failed to fetch dataset ${datasetId}:`, response.statusText);
          continue;
        }

        const { items, count } = await response.json();
        
        setStats(prev => ({
          ...prev,
          datasetsProcessed: i + 1,
          profilesFound: prev.profilesFound + count,
        }));

        items.forEach((profile: any) => {
          const creator = mapApifyProfile(profile);
          if (creator.handle && !uniqueCreatorsMap.has(creator.handle)) {
            uniqueCreatorsMap.set(creator.handle, creator);
          }
        });

        setStats(prev => ({
          ...prev,
          uniqueCreators: uniqueCreatorsMap.size,
        }));

      } catch (err) {
        console.error(`Error fetching dataset ${datasetId}:`, err);
      }
    }

    setProgress('Filtering by follower range...');
    const allCreators = Array.from(uniqueCreatorsMap.values());
    const filteredCreators = allCreators.filter(
      c => c.followerCount >= minFollowers && c.followerCount <= maxFollowers
    );

    setStats(prev => ({
      ...prev,
      inRange: filteredCreators.length,
    }));

    setProgress('Saving to database...');
    const BATCH_SIZE = 3;
    let saved = 0;
    let failed = 0;

    const slimmedCreators = filteredCreators.map(slimCreator);

    for (let i = 0; i < slimmedCreators.length; i += BATCH_SIZE) {
      const batch = slimmedCreators.slice(i, i + BATCH_SIZE);

      try {
        const response = await fetch('/api/database/save-creators', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ creators: batch }),
        });

        if (response.ok) {
          const result = await response.json();
          saved += result.saved || 0;
          failed += result.failed || 0;
        } else {
          console.error(`Batch ${Math.floor(i/BATCH_SIZE) + 1} failed`);
          failed += batch.length;
        }
      } catch (err) {
        console.error(`Batch ${Math.floor(i/BATCH_SIZE) + 1} error:`, err);
        failed += batch.length;
      }

      setStats(prev => ({
        ...prev,
        saved,
        failed,
      }));

      setProgress(`Saving... ${saved} saved, ${failed} failed of ${slimmedCreators.length}`);

      await new Promise(r => setTimeout(r, 200));
    }

    setProgress(`Import complete! ${saved} creators saved, ${failed} failed.`);
    setIsImporting(false);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100">
      <div className="max-w-4xl mx-auto px-4 py-8">
        <div className="mb-8">
          <h1 className="text-4xl font-bold bg-gradient-to-r from-violet-600 to-purple-600 bg-clip-text text-transparent mb-2">
            Import Apify Data
          </h1>
          <p className="text-slate-600">Import creators from existing Apify datasets (no credits used)</p>
        </div>

        <div className="flex gap-2 mb-6">
          <a href="/" className="px-4 py-2 bg-slate-200 text-slate-700 rounded-lg font-medium hover:bg-slate-300 transition-colors">
            Discovery
          </a>
          <a href="/database" className="px-4 py-2 bg-slate-200 text-slate-700 rounded-lg font-medium hover:bg-slate-300 transition-colors">
            Creators
          </a>
          <a href="/brands" className="px-4 py-2 bg-slate-200 text-slate-700 rounded-lg font-medium hover:bg-slate-300 transition-colors">
            Brands
          </a>
          <a href="/import" className="px-4 py-2 bg-violet-600 text-white rounded-lg font-medium">
            Import
          </a>
          <a href="/add" className="px-4 py-2 bg-slate-200 text-slate-700 rounded-lg font-medium hover:bg-slate-300 transition-colors">
            Add Creators
          </a>
        </div>

        <div className="bg-white rounded-xl shadow-lg p-8 mb-6">
          <h2 className="text-2xl font-bold text-slate-800 mb-4">Import Configuration</h2>

          <div className="mb-6">
            <label className="block text-sm font-medium text-slate-700 mb-2">
              Dataset IDs (one per line or comma-separated)
            </label>
            <textarea
              value={datasetIds}
              onChange={(e) => setDatasetIds(e.target.value)}
              placeholder="L4w9xSC6nZwzkbQ5j&#10;yehk7ZnU6fKfwxfX6&#10;XDpFikr0ePMigNWmH"
              rows={8}
              className="w-full px-4 py-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-violet-500 focus:border-transparent font-mono text-sm"
              disabled={isImporting}
            />
          </div>

          <div className="grid grid-cols-2 gap-4 mb-6">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">
                Min Followers
              </label>
              <input
                type="number"
                value={minFollowers}
                onChange={(e) => setMinFollowers(parseInt(e.target.value))}
                className="w-full px-4 py-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-violet-500 focus:border-transparent"
                disabled={isImporting}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">
                Max Followers
              </label>
              <input
                type="number"
                value={maxFollowers}
                onChange={(e) => setMaxFollowers(parseInt(e.target.value))}
                className="w-full px-4 py-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-violet-500 focus:border-transparent"
                disabled={isImporting}
              />
            </div>
          </div>

          <button
            onClick={startImport}
            disabled={isImporting}
            className="w-full px-6 py-4 bg-violet-600 text-white rounded-lg font-medium hover:bg-violet-700 transition-colors disabled:bg-slate-300 disabled:cursor-not-allowed"
          >
            {isImporting ? 'Importing...' : 'Start Import'}
          </button>
        </div>

        {(progress || stats.totalDatasets > 0) && (
          <div className="bg-white rounded-xl shadow-lg p-8">
            <h2 className="text-2xl font-bold text-slate-800 mb-4">Progress</h2>
            
            <div className="mb-4">
              <p className="text-lg text-slate-700">{progress}</p>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="bg-slate-50 rounded-lg p-4">
                <p className="text-sm text-slate-600">Datasets Processed</p>
                <p className="text-2xl font-bold text-slate-900">{stats.datasetsProcessed} / {stats.totalDatasets}</p>
              </div>
              <div className="bg-slate-50 rounded-lg p-4">
                <p className="text-sm text-slate-600">Profiles Found</p>
                <p className="text-2xl font-bold text-slate-900">{stats.profilesFound}</p>
              </div>
              <div className="bg-slate-50 rounded-lg p-4">
                <p className="text-sm text-slate-600">Unique Creators</p>
                <p className="text-2xl font-bold text-slate-900">{stats.uniqueCreators}</p>
              </div>
              <div className="bg-slate-50 rounded-lg p-4">
                <p className="text-sm text-slate-600">In Range</p>
                <p className="text-2xl font-bold text-slate-900">{stats.inRange}</p>
              </div>
              <div className="bg-green-50 rounded-lg p-4">
                <p className="text-sm text-green-600">Saved</p>
                <p className="text-2xl font-bold text-green-900">{stats.saved}</p>
              </div>
              <div className="bg-red-50 rounded-lg p-4">
                <p className="text-sm text-red-600">Failed</p>
                <p className="text-2xl font-bold text-red-900">{stats.failed}</p>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

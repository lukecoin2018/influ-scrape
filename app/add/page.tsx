'use client';

import { useState } from 'react';

type Platform = 'instagram' | 'tiktok';

function slimInstagramCreator(creator: any) {
  return {
    handle: creator.handle,
    fullName: creator.fullName || '',
    bio: (creator.bio || '').slice(0, 500),
    followerCount: creator.followerCount,
    followingCount: creator.followingCount,
    postsCount: creator.postsCount,
    engagementRate: creator.engagementRate,
    isVerified: creator.isVerified || false,
    profilePicUrl: creator.profilePicUrl || '',
    profileUrl: creator.profileUrl || '',
    website: creator.website || '',
    discoveredViaHashtags: ['manual_entry'],
    platformData: {
      is_business_account: creator.isBusinessAccount || false,
      category_name: creator.categoryName || null,
    },
  };
}

function mapTikTokProfile(profile: any) {
  const handle = (profile.username || '').toLowerCase();
  return {
    handle,
    fullName: profile.displayName || '',
    bio: (profile.bio || '').slice(0, 500),
    followerCount: profile.followers || 0,
    followingCount: profile.following || 0,
    postsCount: profile.videos || 0,
    engagementRate: null,
    isVerified: false,
    profilePicUrl: profile.profileImage || '',
    profileUrl: profile.profileUrl || `https://tiktok.com/@${handle}`,
    website: '',
    discoveredViaHashtags: ['manual_entry'],
    platformData: {
      likes_count: profile.likes || 0,
      video_count: profile.videos || 0,
      tagline: profile.tagline || '',
    },
  };
}

export default function AddByHandlePage() {
  const [platform, setPlatform] = useState<Platform>('instagram');
  const [handlesInput, setHandlesInput] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState('');
  const [creators, setCreators] = useState<any[]>([]);
  const [savedCount, setSavedCount] = useState(0);

  const processHandles = async () => {
    const handles = handlesInput
      .split('\n')
      .map(h => h.trim().toLowerCase().replace(/^@/, ''))
      .filter(h => h.length > 0);

    const uniqueHandles = Array.from(new Set(handles));

    if (uniqueHandles.length === 0) {
      alert('Please enter at least one handle');
      return;
    }

    setIsProcessing(true);
    setProgress(`Starting lookup for ${uniqueHandles.length} handles...`);
    setCreators([]);
    setSavedCount(0);

    try {
      // Start scrape using platform-specific route
      const scrapeRoute = platform === 'instagram'
        ? '/api/discover/start-profile-scrape'
        : '/api/tiktok/start-profile-scrape';

      const profileResponse = await fetch(scrapeRoute, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ usernames: uniqueHandles }),
      });

      const { runId } = await profileResponse.json();

      // Poll for completion
      let complete = false;
      let runStatus: any = null;

      while (!complete) {
        await new Promise(resolve => setTimeout(resolve, 3000));

        const statusResponse = await fetch(`/api/discover/run-status/${runId}`);
        runStatus = await statusResponse.json();

        if (runStatus.status === 'SUCCEEDED') {
          complete = true;
        } else if (runStatus.status === 'FAILED') {
          throw new Error('Profile scraping failed');
        }

        setProgress(`Scraping profiles... ${runStatus.status}`);
      }

      const datasetId = runStatus.datasetId;
      if (!datasetId) throw new Error('No dataset ID returned from scraper');

      const resultsResponse = await fetch(`/api/discover/dataset/${datasetId}`);
      const profiles = await resultsResponse.json();

      setProgress(`Found ${profiles.length} profiles. Mapping data...`);

      // Map to creator format
      let mappedCreators: any[];
      if (platform === 'instagram') {
        const { mapProfileToCreator } = await import('@/lib/apify');
        mappedCreators = profiles.map((p: any) => {
          const creator = mapProfileToCreator(p);
          return slimInstagramCreator(creator);
        });
      } else {
        const allMapped = profiles.map(mapTikTokProfile);
        const seen = new Set<string>();
        mappedCreators = allMapped.filter((c: any) => {
          if (!c.handle || seen.has(c.handle)) return false;
          seen.add(c.handle);
          return true;
        });
      }

      setCreators(mappedCreators);

      // Save to database
      setProgress('Saving to database...');
      const BATCH_SIZE = 3;
      let saved = 0;
      let failed = 0;

      for (let i = 0; i < mappedCreators.length; i += BATCH_SIZE) {
        const batch = mappedCreators.slice(i, i + BATCH_SIZE);

        try {
          const response = await fetch('/api/database/save-creators', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ creators: batch, platform }),
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
          console.error(`Batch error:`, err);
          failed += batch.length;
        }

        setProgress(`Saving... ${saved} saved, ${failed} failed of ${mappedCreators.length}`);
        await new Promise(r => setTimeout(r, 200));
      }

      setSavedCount(saved);
      setProgress(`Complete! ${saved} creators saved.${failed > 0 ? ` ${failed} failed.` : ''}`);

    } catch (error: any) {
      setProgress(`Error: ${error.message}`);
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
          <a href="/add" className="px-4 py-2 bg-violet-600 text-white rounded-lg font-medium">Add Creators</a>
        </div>

        <div className="bg-white rounded-xl shadow-lg p-8 mb-6">
          {/* Platform Toggle */}
          <div className="mb-6">
            <label className="block text-sm font-medium text-slate-700 mb-2">Platform</label>
            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={() => setPlatform('instagram')}
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
              {platform === 'instagram' ? 'Instagram' : 'TikTok'} Handles (one per line)
            </label>
            <textarea
              value={handlesInput}
              onChange={(e) => setHandlesInput(e.target.value)}
              placeholder={platform === 'instagram'
                ? '@fashionista\nstyleinfluencer\n@beautyblogger'
                : '@tiktokcreator\ndancequeen\n@foodie'
              }
              rows={8}
              className="w-full px-4 py-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-violet-500 focus:border-transparent font-mono text-sm"
              disabled={isProcessing}
            />
            <p className="text-xs text-slate-500 mt-2">
              Cost: ~$0.01 per profile. With or without @ prefix is fine.
            </p>
          </div>

          <button
            onClick={processHandles}
            disabled={isProcessing || !handlesInput.trim()}
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

        {creators.length > 0 && (
          <div className="bg-white rounded-xl shadow-lg p-8">
            <h2 className="text-2xl font-bold text-slate-800 mb-4">
              Results ({creators.length})
            </h2>

            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-slate-200">
                    <th className="text-left py-3 px-4 text-sm font-semibold text-slate-700">Handle</th>
                    <th className="text-left py-3 px-4 text-sm font-semibold text-slate-700">Name</th>
                    <th className="text-right py-3 px-4 text-sm font-semibold text-slate-700">Followers</th>
                    <th className="text-right py-3 px-4 text-sm font-semibold text-slate-700">Engagement</th>
                  </tr>
                </thead>
                <tbody>
                  {creators.map((creator, i) => (
                    <tr key={i} className="border-b border-slate-100 hover:bg-slate-50">
                      <td className="py-3 px-4">
                        <a
                          href={creator.profileUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-violet-600 hover:text-violet-800 font-medium"
                        >
                          @{creator.handle}
                        </a>
                      </td>
                      <td className="py-3 px-4 text-slate-700">{creator.fullName}</td>
                      <td className="py-3 px-4 text-right text-slate-700">
                        {creator.followerCount?.toLocaleString()}
                      </td>
                      <td className="py-3 px-4 text-right text-slate-700">
                        {creator.engagementRate ? `${creator.engagementRate.toFixed(2)}%` : '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {savedCount > 0 && (
              <div className="mt-6 p-4 bg-green-50 border border-green-200 rounded-lg">
                <p className="text-green-900 font-medium">
                  ✅ {savedCount} creator{savedCount !== 1 ? 's' : ''} saved to database
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

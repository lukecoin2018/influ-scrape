'use client';

import { useState } from 'react';
import SetupPanel from '@/components/SetupPanel';
import ProgressPanel from '@/components/ProgressPanel';
import ResultsTable from '@/components/ResultsTable';
import BrandsTable from '@/components/BrandsTable';
import type { DiscoveryConfig, PipelineStatus, DiscoveredCreator, DetectedBrand, Partnership, SponsorshipStats } from '@/lib/types';
import { detectBrandsInPost, filterPostsByNiche, createPartnershipRecords } from '@/lib/brandDetection';

export default function Home() {
  const [activeTab, setActiveTab] = useState<'setup' | 'progress' | 'results'>('setup');
  const [resultsTab, setResultsTab] = useState<'creators' | 'brands'>('creators');
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
  const [discoveryConfig, setDiscoveryConfig] = useState<DiscoveryConfig | null>(null);
  const [creators, setCreators] = useState<DiscoveredCreator[]>([]);
  const [brands, setBrands] = useState<DetectedBrand[]>([]);
  const [sponsorshipStats, setSponsorshipStats] = useState<SponsorshipStats>({
    sponsoredPostsFound: 0,
    brandsDetected: 0,
    partnershipsLogged: 0,
  });

  const startDiscovery = async (config: DiscoveryConfig) => {
    setDiscoveryConfig(config);
    setActiveTab('progress');
    setCreators([]);
    setBrands([]);
    setSponsorshipStats({
      sponsoredPostsFound: 0,
      brandsDetected: 0,
      partnershipsLogged: 0,
    });

    try {
      // Stage 1: Scrape hashtags
      setStatus({
        stage: 'hashtags',
        progress: 10,
        message: 'Scraping hashtag posts...',
        stats: { postsFound: 0, uniqueHandles: 0, profilesScraped: 0, creatorsInRange: 0 },
      });

      const hashtagResponse = await fetch('/api/discover/start-hashtag-scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hashtags: config.hashtags,
          resultsPerHashtag: config.resultsPerHashtag,
        }),
      });

      const { runId } = await hashtagResponse.json();

      // Poll hashtag scrape
      let hashtagComplete = false;
      while (!hashtagComplete) {
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        const statusResponse = await fetch(`/api/discover/run-status/${runId}`);
        const runStatus = await statusResponse.json();

        if (runStatus.status === 'SUCCEEDED') {
          hashtagComplete = true;
        } else if (runStatus.status === 'FAILED') {
          throw new Error('Hashtag scraping failed');
        }

        setStatus(prev => ({
          ...prev,
          progress: 20,
          message: `Scraping hashtags... ${runStatus.status}`,
        }));
      }

      // Fetch hashtag results
      const resultsResponse = await fetch(`/api/discover/dataset/${runId}`);
      let allPosts = await resultsResponse.json();

      // Sponsorship mode: filter by niche and detect brands
      let allPartnerships: Partnership[] = [];
      let detectedBrandHandles = new Set<string>();

      if (config.mode === 'sponsorship') {
        // Filter posts by niche keywords
        if (config.nicheKeywords && config.nicheKeywords.length > 0) {
          allPosts = filterPostsByNiche(allPosts, config.nicheKeywords);
        }

        // Detect brands in each post
        allPosts.forEach((post: any) => {
          const brandDetection = detectBrandsInPost(post);
          
          if (brandDetection.isSponsoredContent && brandDetection.brandHandles.length > 0) {
            const partnerships = createPartnershipRecords(
              post,
              brandDetection,
              config.hashtags[0] || 'unknown'
            );
            allPartnerships.push(...partnerships);
            brandDetection.brandHandles.forEach(handle => detectedBrandHandles.add(handle));
          }
        });

        setSponsorshipStats({
          sponsoredPostsFound: allPosts.length,
          brandsDetected: detectedBrandHandles.size,
          partnershipsLogged: allPartnerships.length,
        });
      }

      const uniqueCreatorHandles = Array.from(new Set(allPosts.map((p: any) => p.ownerUsername)));

      setStatus(prev => ({
        ...prev,
        progress: 30,
        message: `Found ${allPosts.length} posts from ${uniqueCreatorHandles.length} creators`,
        stats: {
          ...prev.stats,
          postsFound: allPosts.length,
          uniqueHandles: uniqueCreatorHandles.length,
        },
      }));

      // Stage 2: Scrape creator profiles
      setStatus(prev => ({ ...prev, stage: 'profiles', progress: 40, message: 'Scraping creator profiles...' }));

      const batchSize = 50;
      const batches = [];
      for (let i = 0; i < uniqueCreatorHandles.length; i += batchSize) {
        batches.push(uniqueCreatorHandles.slice(i, i + batchSize));
      }

      let allProfiles: any[] = [];

      for (let i = 0; i < batches.length; i++) {
        const batch = batches[i];
        
        const profileResponse = await fetch('/api/discover/start-profile-scrape', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ usernames: batch }),
        });

        const { runId: profileRunId } = await profileResponse.json();

        let profileComplete = false;
        while (!profileComplete) {
          await new Promise(resolve => setTimeout(resolve, 3000));
          
          const statusResponse = await fetch(`/api/discover/run-status/${profileRunId}`);
          const runStatus = await statusResponse.json();

          if (runStatus.status === 'SUCCEEDED') {
            profileComplete = true;
          } else if (runStatus.status === 'FAILED') {
            throw new Error('Profile scraping failed');
          }

          const progress = 40 + ((i + 1) / batches.length) * 30;
          setStatus(prev => ({
            ...prev,
            progress,
            message: `Scraping profiles (batch ${i + 1}/${batches.length})...`,
          }));
        }

        const batchResultsResponse = await fetch(`/api/discover/dataset/${profileRunId}`);
        const batchProfiles = await batchResultsResponse.json();
        allProfiles = allProfiles.concat(batchProfiles);
      }

      setStatus(prev => ({
        ...prev,
        progress: 70,
        stats: { ...prev.stats, profilesScraped: allProfiles.length },
      }));

      // Stage 3: Filter and save creators
      setStatus(prev => ({
        ...prev,
        stage: 'filtering',
        progress: 80,
        message: 'Filtering creators by follower count...',
      }));

      const { mapProfileToCreator } = await import('@/lib/apify');
      const filteredCreators = (allProfiles as any[])
        .map(mapProfileToCreator)
        .filter(creator => {
          return (
            creator.followerCount >= config.minFollowers &&
            creator.followerCount <= config.maxFollowers
          );
        });

      setCreators(filteredCreators);

      setStatus(prev => ({
        ...prev,
        progress: 90,
        message: `Found ${filteredCreators.length} creators in range`,
        stats: { ...prev.stats, creatorsInRange: filteredCreators.length },
      }));

      // Save creators to database
      await fetch('/api/database/save-creators', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          creators: filteredCreators,
          runMetadata: {
            hashtags: config.hashtags,
            resultsPerHashtag: config.resultsPerHashtag,
            minFollowers: config.minFollowers,
            maxFollowers: config.maxFollowers,
            totalPostsFound: allPosts.length,
            uniqueHandlesFound: uniqueCreatorHandles.length,
            profilesScraped: allProfiles.length,
            creatorsInRange: filteredCreators.length,
          },
        }),
      });

      // Sponsorship mode: scrape and save brands
      if (config.mode === 'sponsorship' && detectedBrandHandles.size > 0) {
        setStatus(prev => ({
          ...prev,
          progress: 92,
          message: 'Scraping brand profiles...',
        }));

        const brandHandlesArray = Array.from(detectedBrandHandles);
        const brandBatches = [];
        for (let i = 0; i < brandHandlesArray.length; i += batchSize) {
          brandBatches.push(brandHandlesArray.slice(i, i + batchSize));
        }

        let allBrandProfiles: any[] = [];

        for (const batch of brandBatches) {
          const brandResponse = await fetch('/api/discover/start-profile-scrape', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ usernames: batch }),
          });

          const { runId: brandRunId } = await brandResponse.json();

          let brandComplete = false;
          while (!brandComplete) {
            await new Promise(resolve => setTimeout(resolve, 3000));
            
            const statusResponse = await fetch(`/api/discover/run-status/${brandRunId}`);
            const runStatus = await statusResponse.json();

            if (runStatus.status === 'SUCCEEDED') {
              brandComplete = true;
            } else if (runStatus.status === 'FAILED') {
              console.error('Brand profile scraping failed');
              break;
            }
          }

          const batchResultsResponse = await fetch(`/api/discover/dataset/${brandRunId}`);
          const batchBrands = await batchResultsResponse.json();
          allBrandProfiles = allBrandProfiles.concat(batchBrands);
        }

        // Convert to DetectedBrand format
        const detectedBrands: DetectedBrand[] = allBrandProfiles.map(profile => ({
          handle: profile.username || profile.profileName || '',
          brandName: profile.fullName || profile.username || '',
          bio: profile.biography || profile.bio || '',
          followerCount: profile.followersCount || profile.followedByCount || 0,
          followingCount: profile.followsCount || profile.followingCount || 0,
          isVerified: profile.verified || false,
          categoryName: profile.businessCategoryName || '',
          website: profile.externalUrl || profile.url || '',
          profilePicUrl: profile.profilePicUrl || '',
          profileUrl: `https://instagram.com/${profile.username || profile.profileName}`,
        }));

        setBrands(detectedBrands);

        // Save brands to database
        await fetch('/api/database/save-brands', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ brands: detectedBrands }),
        });

        // Save partnerships to database
        await fetch('/api/database/save-partnerships', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ partnerships: allPartnerships }),
        });
      }

      // Complete
      setStatus({
        stage: 'complete',
        progress: 100,
        message: 'Discovery complete!',
        stats: {
          postsFound: allPosts.length,
          uniqueHandles: uniqueCreatorHandles.length,
          profilesScraped: allProfiles.length,
          creatorsInRange: filteredCreators.length,
        },
      });

      setActiveTab('results');
    } catch (error: any) {
      setStatus({
        stage: 'error',
        progress: 0,
        message: 'Discovery failed',
        error: error.message,
        stats: { postsFound: 0, uniqueHandles: 0, profilesScraped: 0, creatorsInRange: 0 },
      });
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100">
      <div className="max-w-7xl mx-auto px-4 py-8">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-4xl font-bold bg-gradient-to-r from-violet-600 to-purple-600 bg-clip-text text-transparent mb-2">
            InfluenceAI Discovery
          </h1>
          <p className="text-slate-600">Discover Instagram creators and brand partnerships through hashtag analysis</p>
        </div>

        {/* Navigation */}
        <div className="flex gap-2 mb-6">
        <a
            href="/"
            className="px-4 py-2 bg-violet-600 text-white rounded-lg font-medium"
          >
            Discovery
          </a>
          <a
            href="/database"
            className="px-4 py-2 bg-slate-200 text-slate-700 rounded-lg font-medium hover:bg-slate-300 transition-colors"
          >
            Creators
          </a>
          <a
            href="/brands"
            className="px-4 py-2 bg-slate-200 text-slate-700 rounded-lg font-medium hover:bg-slate-300 transition-colors"
          >
            Brands
          </a>
        </div>

        {/* Tabs */}
        <div className="flex gap-4 mb-6">
          <button
            onClick={() => setActiveTab('setup')}
            className={`px-6 py-3 rounded-lg font-medium transition-all ${
              activeTab === 'setup'
                ? 'bg-white text-violet-600 shadow-md'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Setup
          </button>
          <button
            onClick={() => setActiveTab('progress')}
            className={`px-6 py-3 rounded-lg font-medium transition-all ${
              activeTab === 'progress'
                ? 'bg-white text-violet-600 shadow-md'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Progress
          </button>
          <button
            onClick={() => setActiveTab('results')}
            className={`px-6 py-3 rounded-lg font-medium transition-all ${
              activeTab === 'results'
                ? 'bg-white text-violet-600 shadow-md'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Results ({creators.length})
          </button>
        </div>

        {/* Content */}
        {activeTab === 'setup' && (
          <SetupPanel onStartDiscovery={startDiscovery} isRunning={status.stage !== 'idle' && status.stage !== 'complete' && status.stage !== 'error'} />
        )}

        {activeTab === 'progress' && (
          <ProgressPanel status={status} mode={discoveryConfig?.mode || 'niche'} sponsorshipStats={sponsorshipStats} />
        )}

        {activeTab === 'results' && (
          <>
            {discoveryConfig?.mode === 'sponsorship' && (
              <div className="flex gap-2 mb-6">
                <button
                  onClick={() => setResultsTab('creators')}
                  className={`px-6 py-3 rounded-lg font-medium transition-all ${
                    resultsTab === 'creators'
                      ? 'bg-white text-violet-600 shadow-md'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Creators ({creators.length})
                </button>
                <button
                  onClick={() => setResultsTab('brands')}
                  className={`px-6 py-3 rounded-lg font-medium transition-all ${
                    resultsTab === 'brands'
                      ? 'bg-white text-violet-600 shadow-md'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Brands Detected ({brands.length})
                </button>
              </div>
            )}

            {resultsTab === 'creators' && <ResultsTable creators={creators} />}
            {resultsTab === 'brands' && <BrandsTable brands={brands} />}
          </>
        )}
      </div>
    </div>
  );
}
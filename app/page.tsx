'use client';

import { useState } from 'react';
import SetupPanel from '@/components/SetupPanel';
import ProgressPanel from '@/components/ProgressPanel';
import ResultsTable from '@/components/ResultsTable';
import BrandsTable from '@/components/BrandsTable';
import type { DiscoveryConfig, PipelineStatus, DiscoveredCreator, DetectedBrand, Partnership, SponsorshipStats } from '@/lib/types';
import { detectBrandsInPost, filterPostsByNiche, createPartnershipRecords } from '@/lib/brandDetection';

function slimCreator(creator: DiscoveredCreator) {
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
    profilePicUrl: creator.profilePicUrl || '',
  };
}

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
      let hashtagRunStatus: any = null;

      while (!hashtagComplete) {
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        const statusResponse = await fetch(`/api/discover/run-status/${runId}`);
        hashtagRunStatus = await statusResponse.json();

        if (hashtagRunStatus.status === 'SUCCEEDED') {
          hashtagComplete = true;
        } else if (hashtagRunStatus.status === 'FAILED') {
          throw new Error('Hashtag scraping failed');
        }

        setStatus(prev => ({
          ...prev,
          progress: 20,
          message: `Scraping hashtags... ${hashtagRunStatus.status}`,
        }));
      }

      // Fetch hashtag results using datasetId from run status
      const datasetId = hashtagRunStatus.datasetId;
      if (!datasetId) {
        throw new Error('No dataset ID returned from hashtag scraper');
      }
      const resultsResponse = await fetch(`/api/discover/dataset/${datasetId}`);
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
        let profileRunStatus: any = null;

        while (!profileComplete) {
          await new Promise(resolve => setTimeout(resolve, 3000));
          
          const statusResponse = await fetch(`/api/discover/run-status/${profileRunId}`);
          profileRunStatus = await statusResponse.json();

          if (profileRunStatus.status === 'SUCCEEDED') {
            profileComplete = true;
          } else if (profileRunStatus.status === 'FAILED') {
            throw new Error('Profile scraping failed');
          }

          const progress = 40 + ((i + 1) / batches.length) * 30;
          setStatus(prev => ({
            ...prev,
            progress,
            message: `Scraping profiles (batch ${i + 1}/${batches.length})...`,
          }));
        }

        const profileDatasetId = profileRunStatus.datasetId;
        if (!profileDatasetId) {
          throw new Error('No dataset ID returned from profile scraper');
        }
        const batchResultsResponse = await fetch(`/api/discover/dataset/${profileDatasetId}`);
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

      // === SAVE RESULTS TO DATABASE ===
      
      // Track save progress
      let savedCount = 0;
      let failedCount = 0;
      const BATCH_SIZE = 3;

      // 1. Save discovery run metadata FIRST
      try {
        const runMetaResponse = await fetch('/api/database/save-discovery-run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            hashtags: config.hashtags,
            resultsPerHashtag: config.resultsPerHashtag,
            minFollowers: config.minFollowers,
            maxFollowers: config.maxFollowers,
            totalPostsFound: allPosts.length,
            uniqueHandlesFound: uniqueCreatorHandles.length,
            profilesScraped: allProfiles.length,
            creatorsInRange: filteredCreators.length,
          }),
        });
        
        if (!runMetaResponse.ok) {
          console.error('Failed to save run metadata:', await runMetaResponse.text());
        }
      } catch (err) {
        console.error('Error saving run metadata:', err);
      }

      // 2. Save creators in small batches
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
            savedCount += result.saved || batch.length;
          } else {
            const errorText = await response.text();
            console.error(`Batch ${Math.floor(i/BATCH_SIZE) + 1} failed:`, errorText);
            failedCount += batch.length;
          }
        } catch (err) {
          console.error(`Batch ${Math.floor(i/BATCH_SIZE) + 1} error:`, err);
          failedCount += batch.length;
        }
        
        setStatus(prev => ({
          ...prev,
          message: `Saving to database... ${savedCount} saved, ${failedCount} failed of ${slimmedCreators.length}`,
        }));
        
        await new Promise(r => setTimeout(r, 200));
      }

      setStatus(prev => ({
        ...prev,
        stage: 'complete',
        message: `Done! ${savedCount} creators saved to database.${failedCount > 0 ? ` ${failedCount} failed.` : ''}`,
      }));

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
          let brandRunStatus: any = null;

          while (!brandComplete) {
            await new Promise(resolve => setTimeout(resolve, 3000));
            
            const statusResponse = await fetch(`/api/discover/run-status/${brandRunId}`);
            brandRunStatus = await statusResponse.json();

            if (brandRunStatus.status === 'SUCCEEDED') {
              brandComplete = true;
            } else if (brandRunStatus.status === 'FAILED') {
              console.error('Brand profile scraping failed');
              break;
            }
          }

          const brandDatasetId = brandRunStatus?.datasetId;
          if (!brandDatasetId) {
            console.error('No dataset ID returned from brand scraper');
            continue;
          }
          const batchResultsResponse = await fetch(`/api/discover/dataset/${brandDatasetId}`);
          const batchBrands = await batchResultsResponse.json();
          allBrandProfiles = allBrandProfiles.concat(batchBrands);
        }

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

        console.log('Saving brands to database:', detectedBrands.length);
        const brandsResponse = await fetch('/api/database/save-brands', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ brands: detectedBrands }),
        });
        const brandsResult = await brandsResponse.json();
        console.log('Brands save result:', brandsResult);

        console.log('Saving partnerships to database:', allPartnerships.length);
        const partnershipsResponse = await fetch('/api/database/save-partnerships', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ partnerships: allPartnerships }),
        });
        const partnershipsResult = await partnershipsResponse.json();
        console.log('Partnerships save result:', partnershipsResult);
      }

      // Complete
      setStatus({
        stage: 'complete',
        progress: 100,
        message: `Discovery complete! ${savedCount} creators saved.`,
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

  const testSaveLogic = async () => {
    console.log('Starting fake data test...');
    
    const fakeCreators = Array.from({ length: 50 }, (_, i) => ({
      handle: `test_creator_${i + 1}`,
      fullName: `Test Creator ${i + 1}`,
      bio: `This is a test bio for creator ${i + 1}. `.repeat(10),
      followerCount: 50000 + Math.floor(Math.random() * 450000),
      followingCount: Math.floor(Math.random() * 2000),
      postsCount: Math.floor(Math.random() * 1000),
      engagementRate: Math.round(Math.random() * 80) / 10,
      isVerified: Math.random() > 0.9,
      isBusinessAccount: Math.random() > 0.5,
      categoryName: ['Fashion', 'Beauty', 'Lifestyle', 'Art'][Math.floor(Math.random() * 4)],
      profileUrl: `https://instagram.com/test_creator_${i + 1}`,
      website: '',
    }));

    const BATCH_SIZE = 3;
    let saved = 0;
    let failed = 0;

    console.log(`Testing with ${fakeCreators.length} fake creators...`);

    for (let i = 0; i < fakeCreators.length; i += BATCH_SIZE) {
      const batch = fakeCreators.slice(i, i + BATCH_SIZE);
      
      console.log(`Saving batch ${Math.floor(i/BATCH_SIZE) + 1}...`);
      
      try {
        const res = await fetch('/api/database/save-creators', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ creators: batch }),
        });
        
        const result = await res.json();
        
        if (res.ok) {
          saved += result.saved || 0;
          failed += result.failed || 0;
          console.log(`Batch ${Math.floor(i/BATCH_SIZE) + 1}: ${result.saved} saved, ${result.failed || 0} failed`);
        } else {
          console.error('Batch failed:', result);
          failed += batch.length;
        }
      } catch (err) {
        console.error('Batch error:', err);
        failed += batch.length;
      }

      setStatus(prev => ({
        ...prev,
        stage: 'filtering',
        message: `Test: ${saved} saved, ${failed} failed of ${fakeCreators.length}`,
      }));
    }

    const message = `Test complete: ${saved} saved, ${failed} failed out of ${fakeCreators.length}`;
    alert(message);
    console.log(message);
    
    setStatus(prev => ({
      ...prev,
      stage: 'complete',
      message: message,
    }));
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100">
      <div className="max-w-7xl mx-auto px-4 py-8">
        <div className="mb-8">
          <h1 className="text-4xl font-bold bg-gradient-to-r from-violet-600 to-purple-600 bg-clip-text text-transparent mb-2">
            InfluenceAI Discovery
          </h1>
          <p className="text-slate-600">Discover Instagram creators and brand partnerships through hashtag analysis</p>
        </div>

        <div className="flex gap-2 mb-6">
          <a href="/" className="px-4 py-2 bg-violet-600 text-white rounded-lg font-medium">
            Discovery
          </a>
          <a href="/database" className="px-4 py-2 bg-slate-200 text-slate-700 rounded-lg font-medium hover:bg-slate-300 transition-colors">
            Creators
          </a>
          <a href="/brands" className="px-4 py-2 bg-slate-200 text-slate-700 rounded-lg font-medium hover:bg-slate-300 transition-colors">
            Brands
          </a>
          <a href="/add" className="px-4 py-2 bg-slate-200 text-slate-700 rounded-lg font-medium hover:bg-slate-300 transition-colors">
            Add Creators
          </a>
        </div>

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

        {activeTab === 'setup' && (
  <SetupPanel 
    onStartDiscovery={startDiscovery} 
    isRunning={status.stage !== 'idle' && status.stage !== 'complete' && status.stage !== 'error'} 
  />
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

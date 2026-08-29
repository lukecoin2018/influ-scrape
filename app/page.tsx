'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import SetupPanel from '@/components/SetupPanel';
import ProgressPanel from '@/components/ProgressPanel';
import ResultsTable from '@/components/ResultsTable';
import BrandsTable from '@/components/BrandsTable';
import type { DiscoveryConfig, PipelineStatus, DiscoveredCreator, DetectedBrand, Partnership, SponsorshipStats } from '@/lib/types';
import { detectBrandsInPost, filterPostsByNiche, createPartnershipRecords } from '@/lib/brandDetection';
import { mapTikTokProfile } from '@/lib/apify';
import { useChunkedRunner } from '@/lib/useChunkedRunner';
import DiscoveryFunnel, { type HashtagResult } from '@/components/DiscoveryFunnel';

type Platform = 'instagram' | 'tiktok';

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
    platformData: (creator as any).platformData || {
      is_business_account: creator.isBusinessAccount || false,
      category_name: creator.categoryName || null,
    },
  };
}

/**
 * One row of /api/database/get-creators, which reads v_creator_summary.
 *
 * That view is per-CREATOR with platform-prefixed columns, while ResultsTable
 * renders a per-PROFILE shape. Without this mapping the table renders blank
 * rows, and worse, it calls .toLocaleString() on counts the view does not carry
 * at all — so every numeric field has to resolve to a number, not undefined.
 */
interface CreatorSummaryRow {
  name?: string | null;
  total_followers?: number | null;
  instagram_handle?: string | null;
  instagram_followers?: number | null;
  instagram_engagement?: number | null;
  instagram_verified?: boolean | null;
  instagram_pic?: string | null;
  instagram_bio?: string | null;
  instagram_data?: Record<string, unknown> | null;
  tiktok_handle?: string | null;
  tiktok_followers?: number | null;
  tiktok_engagement?: number | null;
  tiktok_verified?: boolean | null;
  tiktok_pic?: string | null;
  tiktok_bio?: string | null;
  tiktok_data?: Record<string, unknown> | null;
}

function summaryRowToCreator(row: CreatorSummaryRow, platform: Platform): DiscoveredCreator {
  const isTikTok = platform === 'tiktok';
  const handle = (isTikTok ? row.tiktok_handle : row.instagram_handle) || '';
  const data = (isTikTok ? row.tiktok_data : row.instagram_data) || {};

  return {
    handle,
    fullName: row.name || '',
    bio: (isTikTok ? row.tiktok_bio : row.instagram_bio) || '',
    followerCount:
      (isTikTok ? row.tiktok_followers : row.instagram_followers) ?? row.total_followers ?? 0,
    // The view aggregates per creator and carries neither of these. Zero rather
    // than undefined because ResultsTable formats them unconditionally.
    followingCount: 0,
    postsCount: 0,
    engagementRate: (isTikTok ? row.tiktok_engagement : row.instagram_engagement) ?? null,
    isVerified: Boolean(isTikTok ? row.tiktok_verified : row.instagram_verified),
    profileUrl: handle
      ? `https://${isTikTok ? 'tiktok.com/@' : 'instagram.com/'}${handle}`
      : '',
    profilePicUrl: (isTikTok ? row.tiktok_pic : row.instagram_pic) || '',
    website: '',
    isBusinessAccount: Boolean((data as Record<string, unknown>).is_business_account),
    categoryName: String((data as Record<string, unknown>).category_name ?? ''),
    latestPosts: [],
  };
}

export default function Home() {
  const [platform, setPlatform] = useState<Platform>('instagram');
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

  // ── Niche mode: the converted path ──────────────────────────────────────
  //
  // One item per hashtag, each a call to /api/discover/process, which does both
  // scrape phases server-side. Sponsorship mode still runs the client pipeline
  // below; converting it needs the brand-extraction work that is out of scope
  // here, so the two coexist rather than one being half-migrated.
  const [runId, setRunId] = useState<string | null>(null);
  // The runner's results live in React state, which is stale inside the
  // closure that runs the moment start() resolves. Refs give the finish
  // handler the settled values rather than the ones from its render.
  const runnerResultsRef = useRef<HashtagResult[]>([]);
  const runnerStoppedRef = useRef(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);

  const processHashtag = useCallback(
    async (
      item: {
        hashtag: string; runId: string; config: DiscoveryConfig;
        platform: Platform; searchSource: DiscoveryConfig['searchSource'];
      },
      _index: number,
      signal: AbortSignal,
      report: (message: string) => void,
    ): Promise<HashtagResult> => {
      const label = item.searchSource === 'keyword' ? item.hashtag : `#${item.hashtag}`;
      report(`${label} — scraping posts…`);

      const res = await fetch('/api/discover/process', {
        method: 'POST',
        // Stop aborts this, which frees the loop and lets the route skip the
        // profile batches it has not started yet.
        signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          runId: item.runId,
          hashtag: item.hashtag,
          platform: item.platform,
          searchSource: item.searchSource,
          resultsPerHashtag: item.config.resultsPerHashtag,
          minFollowers: item.config.minFollowers,
          maxFollowers: item.config.maxFollowers,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      return data as HashtagResult;
    },
    [],
  );

  const runner = useChunkedRunner<
    {
      hashtag: string; runId: string; config: DiscoveryConfig;
      platform: Platform; searchSource: DiscoveryConfig['searchSource'];
    },
    HashtagResult
  >({
    // One hashtag at a time: each is already several Apify runs, so there is
    // nothing to gain from a wider chunk and a pause between them is polite.
    chunkSize: 1,
    delayMs: 1000,
    processItem: processHashtag,
    labelFor: item => (item.searchSource === 'keyword' ? item.hashtag : `#${item.hashtag}`),
  });

  useEffect(() => {
    runnerResultsRef.current = runner.results;
  }, [runner.results]);

  useEffect(() => {
    if (runner.status === 'stopped') runnerStoppedRef.current = true;
  }, [runner.status]);

  const startNicheDiscovery = async (config: DiscoveryConfig) => {
    if (isStarting || runner.isRunning) return;
    setIsStarting(true);
    setRunError(null);
    setCreators([]);
    runnerResultsRef.current = [];
    runnerStoppedRef.current = false;
    runner.reset();
    setActiveTab('progress');

    try {
      const res = await fetch('/api/discover/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          platform,
          mode: config.mode,
          hashtags: config.hashtags,
          searchSource: config.searchSource,
          resultsPerHashtag: config.resultsPerHashtag,
          minFollowers: config.minFollowers,
          maxFollowers: config.maxFollowers,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

      setRunId(data.runId);
      await runner.start(
        data.items.map((item: { hashtag: string }) => ({
          hashtag: item.hashtag,
          runId: data.runId,
          config,
          platform,
          searchSource: data.searchSource ?? 'hashtag',
        })),
      );

      // start() resolves when the loop ends, however it ended, so this runs for
      // a stopped run too. Closing the row is the client's job because a run
      // spans many per-hashtag calls and none of them knows it was the last.
      await finishRun(data.runId);
    } catch (err) {
      setRunError(err instanceof Error ? err.message : 'Failed to start discovery');
    } finally {
      setIsStarting(false);
    }
  };

  /**
   * Closes the run row and loads the creators it imported.
   *
   * The route responses carry counts and samples, not creator rows — returning
   * 900 profiles per hashtag mid-run would be a heavy payload for a progress
   * display. The full table is read from the database once, at the end.
   */
  const finishRun = async (id: string) => {
    const rows = runnerResultsRef.current;
    const totals = {
      totalPostsFound: rows.reduce((n, r) => n + r.postsFound, 0),
      uniqueHandlesFound: rows.reduce((n, r) => n + r.candidatesFound, 0),
      profilesScraped: rows.reduce((n, r) => n + (r.imported?.attempted ?? 0), 0),
      creatorsInRange: rows.reduce((n, r) => n + (r.imported?.inRange ?? 0), 0),
      newCreatorsAdded: rows.reduce((n, r) => n + (r.imported?.saved ?? 0), 0),
      existingCreatorsUpdated: rows.reduce((n, r) => n + r.alreadyKnown, 0),
    };

    try {
      await fetch('/api/discover/finish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          runId: id,
          status: runnerStoppedRef.current ? 'cancelled' : 'complete',
          ...totals,
        }),
      });
    } catch (err) {
      console.error('Failed to close discovery run:', err);
    }

    if (totals.creatorsInRange === 0) return;

    try {
      // Scoped to THIS run via discovery_candidates, not to the follower band.
      // A band query has no run dimension and would show the pre-existing
      // database slice as though it were the run's output.
      const res = await fetch(`/api/discover/run-results/${id}`);
      if (res.ok) {
        const data = await res.json();
        const rows: CreatorSummaryRow[] = data.creators || [];
        const runPlatform: Platform = data.platform === 'tiktok' ? 'tiktok' : 'instagram';
        setCreators(
          rows.map(row => summaryRowToCreator(row, runPlatform)).filter(c => c.handle),
        );
        if (data.missing > 0) {
          console.warn(
            `${data.missing} imported handle(s) were not found in v_creator_summary for run ${id}`,
          );
        }
      }
    } catch (err) {
      console.error('Failed to load imported creators:', err);
    }

    setActiveTab('results');
  };

  const startDiscovery = async (config: DiscoveryConfig) => {
    setDiscoveryConfig(config);
    if (config.mode !== 'sponsorship') {
      await startNicheDiscovery(config);
      return;
    }
    await startLegacyDiscovery(config);
  };

  const startLegacyDiscovery = async (config: DiscoveryConfig) => {
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

      const hashtagRoute = platform === 'instagram'
        ? '/api/discover/start-hashtag-scrape'
        : '/api/tiktok/start-hashtag-scrape';

      const hashtagResponse = await fetch(hashtagRoute, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hashtags: config.hashtags,
          resultsPerHashtag: config.resultsPerHashtag,
        }),
      });

      const hashtagData = await hashtagResponse.json();
if (!hashtagResponse.ok || !hashtagData.runId) {
  throw new Error(`Failed to start hashtag scrape: ${JSON.stringify(hashtagData)}`);
}
const { runId } = hashtagData;

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

      const datasetId = hashtagRunStatus.datasetId;
      if (!datasetId) {
        throw new Error('No dataset ID returned from hashtag scraper');
      }
      const resultsResponse = await fetch(`/api/discover/dataset/${datasetId}`);
      let allPosts = await resultsResponse.json();

      // Sponsorship mode: filter by niche and detect brands (Instagram only)
      let allPartnerships: Partnership[] = [];
      let detectedBrandHandles = new Set<string>();

      if (platform === 'instagram' && config.mode === 'sponsorship') {
        if (config.nicheKeywords && config.nicheKeywords.length > 0) {
          allPosts = filterPostsByNiche(allPosts, config.nicheKeywords);
        }

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

      // For TikTok, ownerUsername field may differ
      const handleField = platform === 'instagram' ? 'ownerUsername' : 'authorMeta.name';
      const uniqueCreatorHandles = Array.from(new Set(
        allPosts.map((p: any) => p.ownerUsername || p.authorMeta?.name || p.uniqueId || '')
          .filter(Boolean)
      ));

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

      const profileRoute = platform === 'instagram'
        ? '/api/discover/start-profile-scrape'
        : '/api/tiktok/start-profile-scrape';

      const batchSize = 50;
      const batches = [];
      for (let i = 0; i < uniqueCreatorHandles.length; i += batchSize) {
        batches.push(uniqueCreatorHandles.slice(i, i + batchSize));
      }

      let allProfiles: any[] = [];

      for (let i = 0; i < batches.length; i++) {
        const batch = batches[i];
        
        const profileResponse = await fetch(profileRoute, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ usernames: batch }),
        });

        const profileData = await profileResponse.json();
if (!profileResponse.ok || !profileData.runId) {
  throw new Error(`Failed to start profile scrape: ${JSON.stringify(profileData)}`);
}
const profileRunId = profileData.runId;

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
      .map((p: any) => platform === 'tiktok' ? mapTikTokProfile(p) : mapProfileToCreator(p))
        .filter(creator => {
          return (
            creator.followerCount >= config.minFollowers &&
            creator.followerCount <= config.maxFollowers
          );
        });

        setCreators(filteredCreators as any[]);

      setStatus(prev => ({
        ...prev,
        progress: 90,
        message: `Found ${filteredCreators.length} creators in range`,
        stats: { ...prev.stats, creatorsInRange: filteredCreators.length },
      }));

      // === SAVE RESULTS TO DATABASE ===
      let savedCount = 0;
      let failedCount = 0;
      const BATCH_SIZE = 3;

      // 1. Save discovery run metadata
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
      const slimmedCreators = filteredCreators.map((c: any) => slimCreator(c));

      for (let i = 0; i < slimmedCreators.length; i += BATCH_SIZE) {
        const batch = slimmedCreators.slice(i, i + BATCH_SIZE);
        
        try {
          const response = await fetch('/api/database/save-creators', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ creators: batch, platform }),
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

      // Sponsorship mode: scrape and save brands (Instagram only)
      if (platform === 'instagram' && config.mode === 'sponsorship' && detectedBrandHandles.size > 0) {
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

          const brandData = await brandResponse.json();
if (!brandData.runId) throw new Error(`Failed to start brand scrape: ${JSON.stringify(brandData)}`);
const brandRunId = brandData.runId;

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

        const brandsResponse = await fetch('/api/database/save-brands', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ brands: detectedBrands }),
        });
        const brandsResult = await brandsResponse.json();
        console.log('Brands save result:', brandsResult);

        const partnershipsResponse = await fetch('/api/database/save-partnerships', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ partnerships: allPartnerships }),
        });
        const partnershipsResult = await partnershipsResponse.json();
        console.log('Partnerships save result:', partnershipsResult);
      }

      setStatus({
        stage: 'complete',
        progress: 100,
        message: `Discovery complete! ${savedCount} creators saved.${failedCount > 0 ? ` ${failedCount} failed.` : ''}`,
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
        <div className="mb-8">
          <h1 className="text-4xl font-bold bg-gradient-to-r from-violet-600 to-purple-600 bg-clip-text text-transparent mb-2">
            InfluenceAI Discovery
          </h1>
          <p className="text-slate-600">Discover creators and brand partnerships through hashtag analysis</p>
        </div>

        <div className="flex gap-2 mb-6">
          <a href="/" className="px-4 py-2 bg-violet-600 text-white rounded-lg font-medium">Discovery</a>
          <a href="/database" className="px-4 py-2 bg-slate-200 text-slate-700 rounded-lg font-medium hover:bg-slate-300 transition-colors">Creators</a>
          <a href="/brands" className="px-4 py-2 bg-slate-200 text-slate-700 rounded-lg font-medium hover:bg-slate-300 transition-colors">Brands</a>
          <a href="/import" className="px-4 py-2 bg-slate-200 text-slate-700 rounded-lg font-medium hover:bg-slate-300 transition-colors">Import</a>
          <a href="/brand-feed" className="px-4 py-2 bg-slate-200 text-slate-700 rounded-lg font-medium hover:bg-slate-300 transition-colors">Brand Feed</a>
          <a href="/add" className="px-4 py-2 bg-slate-200 text-slate-700 rounded-lg font-medium hover:bg-slate-300 transition-colors">Add Creators</a>
          <a href="/enrich" className="px-4 py-2 bg-slate-200 text-slate-700 rounded-lg font-medium hover:bg-slate-300 transition-colors">Enrich</a>
          <a href="/intelligence" className="px-4 py-2 bg-slate-200 text-slate-700 rounded-lg font-medium hover:bg-slate-300 transition-colors">Intelligence</a>
        <a href="/embeddings" className="px-4 py-2 bg-slate-200 text-slate-700 rounded-lg font-medium hover:bg-slate-300 transition-colors">Embeddings</a>
        <a href="#" 
         onClick={async (e) => {
          e.preventDefault();
          await fetch('/api/auth/logout', { method: 'POST' });
          window.location.href = '/login';
        }}
        className="px-4 py-2 bg-red-600 text-white rounded-lg font-medium"
        >Logout</a>
        </div>

        <div className="flex gap-4 mb-6">
          <button
            onClick={() => setActiveTab('setup')}
            className={`px-6 py-3 rounded-lg font-medium transition-all ${
              activeTab === 'setup' ? 'bg-white text-violet-600 shadow-md' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Setup
          </button>
          <button
            onClick={() => setActiveTab('progress')}
            className={`px-6 py-3 rounded-lg font-medium transition-all ${
              activeTab === 'progress' ? 'bg-white text-violet-600 shadow-md' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Progress
          </button>
          <button
            onClick={() => setActiveTab('results')}
            className={`px-6 py-3 rounded-lg font-medium transition-all ${
              activeTab === 'results' ? 'bg-white text-violet-600 shadow-md' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Results ({creators.length})
          </button>
        </div>

        {activeTab === 'setup' && (
          <div className="space-y-4">
            {/* Platform Toggle */}
            <div className="bg-white rounded-xl shadow-sm p-6">
              <label className="block text-sm font-medium text-slate-700 mb-3">Platform</label>
              <div className="grid grid-cols-2 gap-3">
                <button
                  onClick={() => setPlatform('instagram')}
                  disabled={isStarting || runner.isRunning}
                  className={`px-4 py-3 rounded-lg font-medium transition-all border-2 disabled:opacity-50 disabled:cursor-not-allowed ${
                    platform === 'instagram'
                      ? 'bg-pink-50 border-pink-500 text-pink-700'
                      : 'bg-white border-slate-200 text-slate-600 hover:border-slate-300'
                  }`}
                >
                  📸 Instagram
                </button>
                <button
                  onClick={() => setPlatform('tiktok')}
                  disabled={isStarting || runner.isRunning}
                  className={`px-4 py-3 rounded-lg font-medium transition-all border-2 disabled:opacity-50 disabled:cursor-not-allowed ${
                    platform === 'tiktok'
                      ? 'bg-black border-black text-white'
                      : 'bg-white border-slate-200 text-slate-600 hover:border-slate-300'
                  }`}
                >
                  🎵 TikTok
                </button>
              </div>
              {platform === 'tiktok' && (
                <p className="text-xs text-slate-500 mt-2">
                  Niche discovery runs on both platforms. Sponsorship discovery is Instagram only.
                </p>
              )}
            </div>

            <SetupPanel
              platform={platform}
              onStartDiscovery={startDiscovery}
              isRunning={
                isStarting || runner.isRunning ||
                (status.stage !== 'idle' && status.stage !== 'complete' && status.stage !== 'error')
              }
            />
          </div>
        )}

        {activeTab === 'progress' && discoveryConfig?.mode === 'sponsorship' && (
          <ProgressPanel status={status} mode="sponsorship" sponsorshipStats={sponsorshipStats} />
        )}

        {activeTab === 'progress' && discoveryConfig?.mode !== 'sponsorship' && (
          <div className="space-y-4">
            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <h2 className="text-xl font-bold text-slate-900">
                    {runner.status === 'idle' ? 'Ready' :
                     runner.status === 'running' ? 'Discovery running' :
                     runner.status === 'stopped' ? 'Stopped' : 'Complete'}
                  </h2>
                  <p className="text-sm text-slate-600 mt-1 truncate">
                    {runner.message || 'Waiting to start…'}
                  </p>
                  {runner.currentLabel && (
                    <p className="text-xs text-slate-400 mt-1">{runner.currentLabel}</p>
                  )}
                </div>

                <button
                  onClick={() => runner.stop()}
                  disabled={!runner.isRunning}
                  className="shrink-0 px-5 py-2 rounded-lg font-medium bg-red-600 text-white
                             disabled:bg-slate-200 disabled:text-slate-400 disabled:cursor-not-allowed
                             hover:bg-red-700 transition-colors"
                >
                  Stop
                </button>
              </div>

              <div className="mt-4">
                <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-violet-600 transition-all duration-300"
                    style={{
                      width: runner.progress.total
                        ? `${(runner.progress.done / runner.progress.total) * 100}%`
                        : '0%',
                    }}
                  />
                </div>
                <div className="flex justify-between text-xs text-slate-500 mt-2">
                  <span>
                    {runner.progress.done} of {runner.progress.total} hashtags
                    {runner.progress.failed > 0 && ` · ${runner.progress.failed} failed`}
                  </span>
                  {runId && <span className="font-mono">run {runId.slice(0, 8)}</span>}
                </div>
              </div>

              {/* Stopping cannot recall an Apify run already in flight; it
                  prevents the ones that have not started. Saying so avoids the
                  impression that Stop is instant and free. */}
              {runner.status === 'stopped' && (
                <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mt-4">
                  Stopped. The scrape already in flight finished and was billed; nothing further
                  was started. Everything measured before the stop was kept.
                </p>
              )}

              {runError && (
                <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mt-4">
                  {runError}
                </p>
              )}

              {runner.errors.length > 0 && (
                <div className="mt-4 text-sm">
                  <p className="font-medium text-slate-700 mb-1">Failed hashtags</p>
                  <ul className="space-y-1">
                    {runner.errors.map((e, i) => (
                      <li key={i} className="text-red-600">
                        <span className="font-medium">{e.item}</span> — {e.message}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            <DiscoveryFunnel results={runner.results} />
          </div>
        )}

        {activeTab === 'results' && (
          <>
            {discoveryConfig?.mode === 'sponsorship' && platform === 'instagram' && (
              <div className="flex gap-2 mb-6">
                <button
                  onClick={() => setResultsTab('creators')}
                  className={`px-6 py-3 rounded-lg font-medium transition-all ${
                    resultsTab === 'creators' ? 'bg-white text-violet-600 shadow-md' : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Creators ({creators.length})
                </button>
                <button
                  onClick={() => setResultsTab('brands')}
                  className={`px-6 py-3 rounded-lg font-medium transition-all ${
                    resultsTab === 'brands' ? 'bg-white text-violet-600 shadow-md' : 'text-slate-600 hover:text-slate-900'
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

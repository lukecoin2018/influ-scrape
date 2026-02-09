'use client';

import type { DiscoveredCreator } from '@/lib/types';

interface ExportButtonProps {
  creators: DiscoveredCreator[];
}

export default function ExportButton({ creators }: ExportButtonProps) {
  const handleExport = () => {
    if (creators.length === 0) {
      alert('No data to export');
      return;
    }

    const headers = [
      'instagram_handle',
      'full_name',
      'follower_count',
      'following_count',
      'posts_count',
      'engagement_rate',
      'is_verified',
      'bio',
      'website',
      'is_business',
      'category',
      'profile_url',
      'latest_posts',
    ];

    const rows = creators.map(creator => [
      creator.handle,
      creator.fullName,
      creator.followerCount,
      creator.followingCount,
      creator.postsCount,
      creator.engagementRate?.toFixed(2) || '',
      creator.isVerified ? 'Yes' : 'No',
      `"${creator.bio.replace(/"/g, '""')}"`,
      creator.website,
      creator.isBusinessAccount ? 'Yes' : 'No',
      creator.categoryName,
      creator.profileUrl,
      JSON.stringify(creator.latestPosts)
    ]);

    const csvContent = [
      headers.join(','),
      ...rows.map(row => row.join(','))
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    
    link.setAttribute('href', url);
    link.setAttribute('download', `influencers_${new Date().toISOString().split('T')[0]}.csv`);
    link.style.visibility = 'hidden';
    
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <button
      onClick={handleExport}
      disabled={creators.length === 0}
      className="flex items-center gap-2 px-6 py-3 bg-gradient-to-r from-blue-600 to-violet-600 hover:from-blue-700 hover:to-violet-700 text-white font-semibold rounded-xl transition-all shadow-lg shadow-violet-500/30 disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none"
    >
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
      </svg>
      Export CSV ({creators.length})
    </button>
  );
}
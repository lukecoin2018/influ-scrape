'use client';

import { useEffect, useState } from 'react';
import DatabaseStats from '@/components/DatabaseStats';

interface Creator {
  id: string;
  display_name: string;
  full_name: string;
  status: string;
  is_featured: boolean;
  total_followers: number;
  primary_platform: string;
  instagram_handle: string | null;
  instagram_followers: number | null;
  instagram_engagement: number | null;
  instagram_verified: boolean | null;
  instagram_pic: string | null;
  tiktok_handle: string | null;
  tiktok_followers: number | null;
  tiktok_engagement: number | null;
  tiktok_verified: boolean | null;
  tiktok_pic: string | null;
}

export default function DatabasePage() {
  const [creators, setCreators] = useState<Creator[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [platformFilter, setPlatformFilter] = useState('');
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);
  const limit = 50;

  useEffect(() => {
    fetchCreators();
  }, [offset, search, statusFilter, platformFilter]);

  const fetchCreators = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        offset: offset.toString(),
        limit: limit.toString(),
      });

      if (search) params.append('search', search);
      if (statusFilter) params.append('status', statusFilter);
      if (platformFilter) params.append('platform', platformFilter);

      const response = await fetch(`/api/database/get-creators?${params}`);
      const data = await response.json();

      setCreators(data.creators || []);
      setTotal(data.total || 0);
    } catch (error) {
      console.error('Error fetching creators:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleUpdateStatus = async (id: string, status: string) => {
    try {
      await fetch('/api/database/update-creator', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, status }),
      });
      setCreators(creators.map(c => c.id === id ? { ...c, status } : c));
    } catch (error) {
      console.error('Error updating status:', error);
    }
  };

  const handleSearchChange = (value: string) => {
    setSearch(value);
    setOffset(0);
  };

  const handleStatusChange = (value: string) => {
    setStatusFilter(value);
    setOffset(0);
  };

  const handlePlatformChange = (value: string) => {
    setPlatformFilter(value);
    setOffset(0);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100">
      <div className="max-w-7xl mx-auto px-4 py-8">
        <div className="mb-8">
          <h1 className="text-4xl font-bold text-slate-900 mb-2">Creator Database</h1>
          <p className="text-slate-600">Browse and manage all discovered creators</p>
        </div>

        <div className="flex gap-2 mb-6">
          <a href="/" className="px-4 py-2 bg-slate-200 text-slate-700 rounded-lg font-medium hover:bg-slate-300 transition-colors">Discovery</a>
          <a href="/database" className="px-4 py-2 bg-violet-600 text-white rounded-lg font-medium">Creators</a>
          <a href="/brands" className="px-4 py-2 bg-slate-200 text-slate-700 rounded-lg font-medium hover:bg-slate-300 transition-colors">Brands</a>
          <a href="/import" className="px-4 py-2 bg-slate-200 text-slate-700 rounded-lg font-medium hover:bg-slate-300 transition-colors">Import</a>
          <a href="/add" className="px-4 py-2 bg-slate-200 text-slate-700 rounded-lg font-medium hover:bg-slate-300 transition-colors">Add Creators</a>
          <a href="/enrich" className="px-4 py-2 bg-slate-200 text-slate-700 rounded-lg font-medium hover:bg-slate-300 transition-colors">Enrich</a>
        </div>

        <DatabaseStats />

        {/* Filters */}
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 mb-6">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">Search</label>
              <input
                type="text"
                value={search}
                onChange={(e) => handleSearchChange(e.target.value)}
                placeholder="Search by handle or name..."
                className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-violet-500 focus:border-transparent"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">Status</label>
              <select
                value={statusFilter}
                onChange={(e) => handleStatusChange(e.target.value)}
                className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-violet-500 focus:border-transparent"
              >
                <option value="">All Statuses</option>
                <option value="active">Active</option>
                <option value="archived">Archived</option>
                <option value="flagged">Flagged</option>
                <option value="rejected">Rejected</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">Platform</label>
              <select
                value={platformFilter}
                onChange={(e) => handlePlatformChange(e.target.value)}
                className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-violet-500 focus:border-transparent"
              >
                <option value="">All Platforms</option>
                <option value="instagram">Instagram</option>
                <option value="tiktok">TikTok</option>
              </select>
            </div>
          </div>
        </div>

        {/* Table */}
        {loading && creators.length === 0 ? (
          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-12 text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-violet-600 mx-auto"></div>
            <p className="mt-4 text-slate-600">Loading creators...</p>
          </div>
        ) : creators.length === 0 ? (
          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-12 text-center">
            <p className="text-slate-600">No creators found.</p>
          </div>
        ) : (
          <>
            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
              <table className="w-full">
                <thead className="bg-slate-50 border-b border-slate-200">
                  <tr>
                    <th className="text-left py-3 px-4 text-sm font-semibold text-slate-700">Creator</th>
                    <th className="text-left py-3 px-4 text-sm font-semibold text-slate-700">📸 Instagram</th>
                    <th className="text-left py-3 px-4 text-sm font-semibold text-slate-700">🎵 TikTok</th>
                    <th className="text-right py-3 px-4 text-sm font-semibold text-slate-700">Total Followers</th>
                    <th className="text-left py-3 px-4 text-sm font-semibold text-slate-700">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {creators.map((creator) => (
                    <tr key={creator.id} className="border-b border-slate-100 hover:bg-slate-50">
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-3">
                          {(creator.instagram_pic || creator.tiktok_pic) && (
                            <img
                              src={creator.instagram_pic || creator.tiktok_pic || ''}
                              alt={creator.display_name}
                              className="w-8 h-8 rounded-full object-cover"
                              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                            />
                          )}
                          <div>
                            <p className="font-medium text-slate-900">{creator.display_name}</p>
                            <p className="text-xs text-slate-500">{creator.primary_platform}</p>
                          </div>
                        </div>
                      </td>
                      <td className="py-3 px-4">
                        {creator.instagram_handle ? (
                          <div>
                            <a
                              href={`https://instagram.com/${creator.instagram_handle}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-pink-600 hover:text-pink-800 text-sm font-medium"
                            >
                              @{creator.instagram_handle}
                            </a>
                            <p className="text-xs text-slate-500">
                              {creator.instagram_followers?.toLocaleString()} followers
                              {creator.instagram_verified && ' ✓'}
                            </p>
                          </div>
                        ) : (
                          <span className="text-slate-300 text-sm">—</span>
                        )}
                      </td>
                      <td className="py-3 px-4">
                        {creator.tiktok_handle ? (
                          <div>
                            <a
                              href={`https://tiktok.com/@${creator.tiktok_handle}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-slate-900 hover:text-slate-600 text-sm font-medium"
                            >
                              @{creator.tiktok_handle}
                            </a>
                            <p className="text-xs text-slate-500">
                              {creator.tiktok_followers?.toLocaleString()} followers
                              {creator.tiktok_verified && ' ✓'}
                            </p>
                          </div>
                        ) : (
                          <span className="text-slate-300 text-sm">—</span>
                        )}
                      </td>
                      <td className="py-3 px-4 text-right font-medium text-slate-900">
                        {creator.total_followers?.toLocaleString()}
                      </td>
                      <td className="py-3 px-4">
                        <select
                          value={creator.status}
                          onChange={(e) => handleUpdateStatus(creator.id, e.target.value)}
                          className="text-sm border border-slate-200 rounded px-2 py-1"
                        >
                          <option value="active">Active</option>
                          <option value="archived">Archived</option>
                          <option value="flagged">Flagged</option>
                          <option value="rejected">Rejected</option>
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {offset + limit < total && (
              <div className="mt-6 text-center">
                <button
                  onClick={() => setOffset(offset + limit)}
                  disabled={loading}
                  className="px-6 py-3 bg-violet-600 text-white rounded-lg hover:bg-violet-700 disabled:opacity-50 transition-colors"
                >
                  {loading ? 'Loading...' : `Load More (${total - offset - limit} remaining)`}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

'use client';

import { useEffect, useState } from 'react';
import DatabaseStats from '@/components/DatabaseStats';
import DatabaseTable from '@/components/DatabaseTable';

interface Creator {
  id: string;
  instagram_handle: string;
  full_name: string;
  bio: string;
  follower_count: number;
  following_count: number;
  posts_count: number;
  engagement_rate: number | null;
  is_verified: boolean;
  profile_pic_url: string;
  profile_url: string;
  discovered_via_hashtags: string[];
  discovery_count: number;
  first_discovered_at: string;
  last_updated_at: string;
  status: string;
  category_name: string;
}

export default function DatabasePage() {
  const [creators, setCreators] = useState<Creator[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);
  const limit = 50;

  useEffect(() => {
    fetchCreators();
  }, [offset, search, statusFilter]);

  const fetchCreators = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        offset: offset.toString(),
        limit: limit.toString(),
      });
      
      if (search) params.append('search', search);
      if (statusFilter) params.append('status', statusFilter);

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
      
      // Update local state
      setCreators(creators.map(c => c.id === id ? { ...c, status } : c));
    } catch (error) {
      console.error('Error updating status:', error);
    }
  };

  const handleLoadMore = () => {
    setOffset(offset + limit);
  };

  const handleSearchChange = (value: string) => {
    setSearch(value);
    setOffset(0);
  };

  const handleStatusChange = (value: string) => {
    setStatusFilter(value);
    setOffset(0);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100">
      <div className="max-w-7xl mx-auto px-4 py-8">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-4xl font-bold text-slate-900 mb-2">Creator Database</h1>
          <p className="text-slate-600">Browse and manage all discovered creators</p>
        </div>

        {/* Stats */}
        <DatabaseStats />

        {/* Filters */}
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 mb-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">Search</label>
              <input
                type="text"
                value={search}
                onChange={(e) => handleSearchChange(e.target.value)}
                placeholder="Search by handle, name, or bio..."
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
            <p className="text-slate-600">No creators found. Run a discovery to add creators to the database.</p>
          </div>
        ) : (
          <>
            <DatabaseTable creators={creators} onUpdateStatus={handleUpdateStatus} />
            
            {/* Load More */}
            {offset + limit < total && (
              <div className="mt-6 text-center">
                <button
                  onClick={handleLoadMore}
                  disabled={loading}
                  className="px-6 py-3 bg-violet-600 text-white rounded-lg hover:bg-violet-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
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
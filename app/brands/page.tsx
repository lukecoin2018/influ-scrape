'use client';

import { useEffect, useState } from 'react';
import BrandStats from '@/components/BrandStats';

interface Brand {
  id: string;
  instagram_handle: string;
  brand_name: string;
  bio: string;
  follower_count: number;
  following_count: number;
  is_verified: boolean;
  category_name: string;
  website: string;
  profile_pic_url: string;
  profile_url: string;
  total_partnerships_detected: number;
  first_detected_at: string;
  last_updated_at: string;
  status: string;
}

interface BrandStatsData {
  totalBrands: number;
  addedThisWeek: number;
  avgPartnerships: number;
  topCategory: string;
}

export default function BrandsPage() {
  const [brands, setBrands] = useState<Brand[]>([]);
  const [stats, setStats] = useState<BrandStatsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);
  const limit = 50;

  useEffect(() => {
    fetchStats();
    fetchBrands();
  }, [offset, search]);

  const fetchStats = async () => {
    try {
      const response = await fetch('/api/database/get-brand-stats');
      const data = await response.json();
      setStats(data);
    } catch (error) {
      console.error('Error fetching brand stats:', error);
    }
  };

  const fetchBrands = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        offset: offset.toString(),
        limit: limit.toString(),
        sortBy: 'total_partnerships_detected',
        sortDir: 'desc',
      });
      
      if (search) params.append('search', search);

      const response = await fetch(`/api/database/get-brands?${params}`);
      const data = await response.json();
      
      setBrands(data.brands || []);
      setTotal(data.total || 0);
    } catch (error) {
      console.error('Error fetching brands:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleSearchChange = (value: string) => {
    setSearch(value);
    setOffset(0);
  };

  const handleLoadMore = () => {
    setOffset(offset + limit);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100">
      <div className="max-w-7xl mx-auto px-4 py-8">
        <div className="mb-8">
          <h1 className="text-4xl font-bold text-slate-900 mb-2">Brands Database</h1>
          <p className="text-slate-600">Browse detected brands and their partnership activity</p>
        </div>

        <div className="flex gap-2 mb-6">
          <a href="/" className="px-4 py-2 bg-slate-200 text-slate-700 rounded-lg font-medium hover:bg-slate-300 transition-colors">
            Discovery
          </a>
          <a href="/database" className="px-4 py-2 bg-slate-200 text-slate-700 rounded-lg font-medium hover:bg-slate-300 transition-colors">
            Creators
          </a>
          <a href="/brands" className="px-4 py-2 bg-violet-600 text-white rounded-lg font-medium">
            Brands
          </a>
          <a href="/add" className="px-4 py-2 bg-slate-200 text-slate-700 rounded-lg font-medium hover:bg-slate-300 transition-colors">
          Add Creators
          </a>
        </div>

        {stats && <BrandStats stats={stats} />}

        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 mb-6">
          <label className="block text-sm font-medium text-slate-700 mb-2">Search</label>
          <input
            type="text"
            value={search}
            onChange={(e) => handleSearchChange(e.target.value)}
            placeholder="Search by handle, brand name, or bio..."
            className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-violet-500 focus:border-transparent"
          />
        </div>

        {loading && brands.length === 0 ? (
          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-12 text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-violet-600 mx-auto"></div>
            <p className="mt-4 text-slate-600">Loading brands...</p>
          </div>
        ) : brands.length === 0 ? (
          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-12 text-center">
            <p className="text-slate-600">No brands found. Run a sponsorship discovery to detect brands.</p>
          </div>
        ) : (
          <>
            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-slate-50 border-b border-slate-200">
                    <tr>
                      <th className="px-6 py-4 text-left text-xs font-semibold text-slate-700 uppercase tracking-wider">Brand</th>
                      <th className="px-6 py-4 text-left text-xs font-semibold text-slate-700 uppercase tracking-wider">Category</th>
                      <th className="px-6 py-4 text-left text-xs font-semibold text-slate-700 uppercase tracking-wider">Followers</th>
                      <th className="px-6 py-4 text-left text-xs font-semibold text-slate-700 uppercase tracking-wider">Partnerships</th>
                      <th className="px-6 py-4 text-left text-xs font-semibold text-slate-700 uppercase tracking-wider">Website</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {brands.map((brand) => (
                      <tr key={brand.id} className="hover:bg-slate-50 transition-colors">
                        <td className="px-6 py-4">
                          <div className="flex items-center gap-3">
                            {brand.profile_pic_url && (
                              <img src={brand.profile_pic_url} alt={brand.instagram_handle} className="w-10 h-10 rounded-full object-cover" />
                            )}
                            <div>
                              <a href={brand.profile_url} target="_blank" rel="noopener noreferrer" className="font-semibold text-slate-900 hover:text-violet-600 transition-colors">
                                @{brand.instagram_handle}
                              </a>
                              {brand.is_verified && (
                                <svg className="w-4 h-4 text-blue-500 inline-block ml-1" fill="currentColor" viewBox="0 0 20 20">
                                  <path fillRule="evenodd" d="M6.267 3.455a3.066 3.066 0 001.745-.723 3.066 3.066 0 013.976 0 3.066 3.066 0 001.745.723 3.066 3.066 0 012.812 2.812c.051.643.304 1.254.723 1.745a3.066 3.066 0 010 3.976 3.066 3.066 0 00-.723 1.745 3.066 3.066 0 01-2.812 2.812 3.066 3.066 0 00-1.745.723 3.066 3.066 0 01-3.976 0 3.066 3.066 0 00-1.745-.723 3.066 3.066 0 01-2.812-2.812 3.066 3.066 0 00-.723-1.745 3.066 3.066 0 010-3.976 3.066 3.066 0 00.723-1.745 3.066 3.066 0 012.812-2.812zm7.44 5.252a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                                </svg>
                              )}
                              <div className="text-sm text-slate-600">{brand.brand_name}</div>
                            </div>
                          </div>
                        </td>
                        <td className="px-6 py-4 text-sm text-slate-600">{brand.category_name || 'N/A'}</td>
                        <td className="px-6 py-4 text-sm font-medium text-slate-900">{brand.follower_count.toLocaleString()}</td>
                        <td className="px-6 py-4">
                          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-violet-100 text-violet-800">
                            {brand.total_partnerships_detected} partnerships
                          </span>
                        </td>
                        <td className="px-6 py-4 text-sm text-slate-600">
                          {brand.website ? (
                            <a href={brand.website} target="_blank" rel="noopener noreferrer" className="text-violet-600 hover:text-violet-700 hover:underline">
                              Visit
                            </a>
                          ) : (
                            <span className="text-slate-400">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            
            {offset + limit < total && (
              <div className="mt-6 text-center">
                <button onClick={handleLoadMore} disabled={loading} className="px-6 py-3 bg-violet-600 text-white rounded-lg hover:bg-violet-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
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
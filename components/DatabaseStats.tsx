'use client';

import { useEffect, useState } from 'react';

interface Stats {
  totalCreators: number;
  addedThisWeek: number;
  avgEngagement: number;
  mostCommonCategory: string;
}

export default function DatabaseStats() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchStats();
  }, []);

  const fetchStats = async () => {
    try {
      const response = await fetch('/api/database/get-stats');
      const data = await response.json();
      setStats(data);
    } catch (error) {
      console.error('Error fetching stats:', error);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 animate-pulse">
            <div className="h-8 bg-slate-200 rounded mb-2"></div>
            <div className="h-4 bg-slate-100 rounded w-24"></div>
          </div>
        ))}
      </div>
    );
  }

  if (!stats) return null;

  return (
    <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
      <div className="bg-gradient-to-br from-blue-50 to-blue-100 rounded-2xl shadow-sm border border-blue-200 p-6">
        <div className="text-3xl font-bold text-blue-900">{stats.totalCreators.toLocaleString()}</div>
        <div className="text-sm text-blue-700 mt-1">Total Creators</div>
      </div>

      <div className="bg-gradient-to-br from-violet-50 to-violet-100 rounded-2xl shadow-sm border border-violet-200 p-6">
        <div className="text-3xl font-bold text-violet-900">{stats.addedThisWeek.toLocaleString()}</div>
        <div className="text-sm text-violet-700 mt-1">Added This Week</div>
      </div>

      <div className="bg-gradient-to-br from-indigo-50 to-indigo-100 rounded-2xl shadow-sm border border-indigo-200 p-6">
        <div className="text-3xl font-bold text-indigo-900">{stats.avgEngagement.toFixed(2)}%</div>
        <div className="text-sm text-indigo-700 mt-1">Avg Engagement</div>
      </div>

      <div className="bg-gradient-to-br from-purple-50 to-purple-100 rounded-2xl shadow-sm border border-purple-200 p-6">
        <div className="text-xl font-bold text-purple-900 truncate">{stats.mostCommonCategory}</div>
        <div className="text-sm text-purple-700 mt-1">Top Category</div>
      </div>
    </div>
  );
}
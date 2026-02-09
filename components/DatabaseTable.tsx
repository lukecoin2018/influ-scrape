'use client';

import { useState } from 'react';
import StatusBadge from './StatusBadge';

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

interface DatabaseTableProps {
  creators: Creator[];
  onUpdateStatus: (id: string, status: string) => void;
}

type SortField = 'follower_count' | 'engagement_rate' | 'discovery_count' | 'last_updated_at';

export default function DatabaseTable({ creators, onUpdateStatus }: DatabaseTableProps) {
  const [sortField, setSortField] = useState<SortField>('last_updated_at');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDir('desc');
    }
  };

  const sortedCreators = [...creators].sort((a, b) => {
    const aVal = a[sortField] ?? 0;
    const bVal = b[sortField] ?? 0;
    return sortDir === 'asc' ? (aVal > bVal ? 1 : -1) : (aVal < bVal ? 1 : -1);
  });

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) {
      return (
        <svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" />
        </svg>
      );
    }
    return sortDir === 'asc' ? (
      <svg className="w-4 h-4 text-violet-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
      </svg>
    ) : (
      <svg className="w-4 h-4 text-violet-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
      </svg>
    );
  };

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="bg-slate-50 border-b border-slate-200">
            <tr>
              <th className="px-6 py-4 text-left text-xs font-semibold text-slate-700 uppercase tracking-wider">
                Creator
              </th>
              <th
                className="px-6 py-4 text-left text-xs font-semibold text-slate-700 uppercase tracking-wider cursor-pointer hover:bg-slate-100 transition-colors"
                onClick={() => handleSort('follower_count')}
              >
                <div className="flex items-center gap-2">
                  Followers
                  <SortIcon field="follower_count" />
                </div>
              </th>
              <th
                className="px-6 py-4 text-left text-xs font-semibold text-slate-700 uppercase tracking-wider cursor-pointer hover:bg-slate-100 transition-colors"
                onClick={() => handleSort('engagement_rate')}
              >
                <div className="flex items-center gap-2">
                  Engagement
                  <SortIcon field="engagement_rate" />
                </div>
              </th>
              <th
                className="px-6 py-4 text-left text-xs font-semibold text-slate-700 uppercase tracking-wider cursor-pointer hover:bg-slate-100 transition-colors"
                onClick={() => handleSort('discovery_count')}
              >
                <div className="flex items-center gap-2">
                  Discoveries
                  <SortIcon field="discovery_count" />
                </div>
              </th>
              <th className="px-6 py-4 text-left text-xs font-semibold text-slate-700 uppercase tracking-wider">
                Hashtags
              </th>
              <th
                className="px-6 py-4 text-left text-xs font-semibold text-slate-700 uppercase tracking-wider cursor-pointer hover:bg-slate-100 transition-colors"
                onClick={() => handleSort('last_updated_at')}
              >
                <div className="flex items-center gap-2">
                  Last Updated
                  <SortIcon field="last_updated_at" />
                </div>
              </th>
              <th className="px-6 py-4 text-left text-xs font-semibold text-slate-700 uppercase tracking-wider">
                Status
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200">
          
{sortedCreators.map((creator) => {
    const formattedDate = new Date(creator.last_updated_at).toLocaleDateString();
    
    return (
        <tr key={creator.id} className="hover:bg-slate-50 transition-colors">
              
                <td className="px-6 py-4">
                  <div className="flex items-center gap-3">
                    {creator.profile_pic_url && (
                      <img
                        src={creator.profile_pic_url}
                        alt={creator.instagram_handle}
                        className="w-10 h-10 rounded-full object-cover"
                      />
                    )}
                    <div>
                    <a>
                        href={creator.profile_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-semibold text-slate-900 hover:text-violet-600 transition-colors"
                      
                        @{creator.instagram_handle}
                      </a> 
                      </div>
                      {creator.is_verified && (
                        <svg className="w-4 h-4 text-blue-500 inline-block ml-1" fill="currentColor" viewBox="0 0 20 20">
                          <path fillRule="evenodd" d="M6.267 3.455a3.066 3.066 0 001.745-.723 3.066 3.066 0 013.976 0 3.066 3.066 0 001.745.723 3.066 3.066 0 012.812 2.812c.051.643.304 1.254.723 1.745a3.066 3.066 0 010 3.976 3.066 3.066 0 00-.723 1.745 3.066 3.066 0 01-2.812 2.812 3.066 3.066 0 00-1.745.723 3.066 3.066 0 01-3.976 0 3.066 3.066 0 00-1.745-.723 3.066 3.066 0 01-2.812-2.812 3.066 3.066 0 00-.723-1.745 3.066 3.066 0 010-3.976 3.066 3.066 0 00.723-1.745 3.066 3.066 0 012.812-2.812zm7.44 5.252a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                        </svg>
                      )}
                      <div className="text-sm text-slate-600">{creator.full_name}</div>
                    </div>
                  
                </td>
                <td className="px-6 py-4 text-sm font-medium text-slate-900">
                  {creator.follower_count.toLocaleString()}
                </td>
                <td className="px-6 py-4 text-sm text-slate-600">
                  {creator.engagement_rate ? `${creator.engagement_rate.toFixed(2)}%` : 'N/A'}
                </td>
                <td className="px-6 py-4 text-sm font-medium text-slate-900">
                  {creator.discovery_count}
                </td>
                <td className="px-6 py-4">
                  <div className="flex flex-wrap gap-1">
                    {creator.discovered_via_hashtags?.slice(0, 3).map((tag, idx) => (
                      <span key={idx} className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-800">
                        #{tag}
                      </span>
                    ))}
                    {creator.discovered_via_hashtags?.length > 3 && (
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-slate-100 text-slate-600">
                        +{creator.discovered_via_hashtags.length - 3}
                      </span>
                    )}
                  </div>
                </td>
                <td className="px-6 py-4 text-sm text-slate-600">
                {formattedDate}
                </td>
                <td className="px-6 py-4">
                  <select
                    value={creator.status}
                    onChange={(e) => onUpdateStatus(creator.id, e.target.value)}
                    className="text-sm border border-slate-300 rounded-lg px-2 py-1 focus:ring-2 focus:ring-violet-500 focus:border-transparent"
                  >
                    <option value="active">Active</option>
                    <option value="archived">Archived</option>
                    <option value="flagged">Flagged</option>
                    <option value="rejected">Rejected</option>
                  </select>
                </td>
                </tr>
          );
        })}
      </tbody>
    </table>
  </div>
</div>
  );
}
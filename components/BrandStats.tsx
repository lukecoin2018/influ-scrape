'use client';

interface BrandStatsProps {
  stats: {
    totalBrands: number;
    addedThisWeek: number;
    avgPartnerships: number;
    topCategory: string;
  };
}

export default function BrandStats({ stats }: BrandStatsProps) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6">
        <div className="text-3xl font-bold text-slate-900 mb-1">
          {stats.totalBrands.toLocaleString()}
        </div>
        <div className="text-sm text-slate-600">Total Brands</div>
      </div>

      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6">
        <div className="text-3xl font-bold text-slate-900 mb-1">
          {stats.addedThisWeek.toLocaleString()}
        </div>
        <div className="text-sm text-slate-600">Added This Week</div>
      </div>

      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6">
        <div className="text-3xl font-bold text-slate-900 mb-1">
          {stats.avgPartnerships.toFixed(1)}
        </div>
        <div className="text-sm text-slate-600">Avg Partnerships</div>
      </div>

      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6">
        <div className="text-3xl font-bold text-slate-900 mb-1">
          {stats.topCategory}
        </div>
        <div className="text-sm text-slate-600">Top Category</div>
      </div>
    </div>
  );
}
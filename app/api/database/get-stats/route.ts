import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { fetchAllRows } from '@/lib/supabasePaging';

export async function GET() {
  try {
    // Total creators
    const { count: totalCreators } = await supabase
      .from('creators')
      .select('*', { count: 'exact', head: true });

    // Added this week
    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
    const { count: addedThisWeek } = await supabase
      .from('creators')
      .select('*', { count: 'exact', head: true })
      .gte('first_discovered_at', oneWeekAgo.toISOString());

    // Both aggregate in JS — PostgREST rejects aggregate functions, so neither
    // avg() nor a mode can be pushed server-side. Paged rather than capped:
    // small today (a few hundred rows), but the same silent-truncation class
    // as the rest, and creators grows with every sweep.
    const [avgData, categoryData] = await Promise.all([
      fetchAllRows<{ engagement_rate: number | null }>(() => supabase
        .from('creators')
        .select('engagement_rate')
        .not('engagement_rate', 'is', null)
        .order('id', { ascending: true })),
      fetchAllRows<{ category_name: string | null }>(() => supabase
        .from('creators')
        .select('category_name')
        .not('category_name', 'is', null)
        .not('category_name', 'eq', '')
        .order('id', { ascending: true })),
    ]);

    const avgEngagement = avgData.length > 0
      ? avgData.reduce((sum, c) => sum + (c.engagement_rate || 0), 0) / avgData.length
      : 0;

    const categoryCounts: { [key: string]: number } = {};
    categoryData.forEach((c) => {
      if (c.category_name) {
        categoryCounts[c.category_name] = (categoryCounts[c.category_name] || 0) + 1;
      }
    });

    const mostCommonCategory = Object.keys(categoryCounts).length > 0
      ? Object.entries(categoryCounts).sort((a, b) => b[1] - a[1])[0][0]
      : 'N/A';

    return NextResponse.json({
      totalCreators: totalCreators || 0,
      addedThisWeek: addedThisWeek || 0,
      avgEngagement: Math.round(avgEngagement * 100) / 100,
      mostCommonCategory,
    });
  } catch (error: any) {
    console.error('Error fetching stats:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to fetch stats' },
      { status: 500 }
    );
  }
}
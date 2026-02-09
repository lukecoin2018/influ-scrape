import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

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

    // Average engagement rate
    const { data: avgData } = await supabase
      .from('creators')
      .select('engagement_rate')
      .not('engagement_rate', 'is', null);

    const avgEngagement = avgData && avgData.length > 0
      ? avgData.reduce((sum, c) => sum + (c.engagement_rate || 0), 0) / avgData.length
      : 0;

    // Most common category
    const { data: categoryData } = await supabase
      .from('creators')
      .select('category_name')
      .not('category_name', 'is', null)
      .not('category_name', 'eq', '');

    const categoryCounts: { [key: string]: number } = {};
    categoryData?.forEach((c) => {
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
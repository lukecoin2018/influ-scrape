import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export async function GET(request: NextRequest) {
  try {
    // Get total brands count
    const { count: totalBrands } = await supabase
      .from('brands')
      .select('*', { count: 'exact', head: true });

    // Get brands added this week
    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
    
    const { count: addedThisWeek } = await supabase
      .from('brands')
      .select('*', { count: 'exact', head: true })
      .gte('first_detected_at', oneWeekAgo.toISOString());

    // Get average partnerships per brand
    const { data: brandsWithPartnerships } = await supabase
      .from('brands')
      .select('total_partnerships_detected')
      .not('total_partnerships_detected', 'is', null);

    const avgPartnerships = brandsWithPartnerships && brandsWithPartnerships.length > 0
      ? brandsWithPartnerships.reduce((sum, b) => sum + (b.total_partnerships_detected || 0), 0) / brandsWithPartnerships.length
      : 0;

    // Get top category
    const { data: categoryCounts } = await supabase
      .from('brands')
      .select('category_name')
      .not('category_name', 'is', null);

    const categoriesMap: Record<string, number> = {};
    categoryCounts?.forEach(b => {
      if (b.category_name) {
        categoriesMap[b.category_name] = (categoriesMap[b.category_name] || 0) + 1;
      }
    });

    const topCategory = Object.entries(categoriesMap)
      .sort(([, a], [, b]) => b - a)[0]?.[0] || 'None';

    return NextResponse.json({
      totalBrands: totalBrands || 0,
      addedThisWeek: addedThisWeek || 0,
      avgPartnerships: Number(avgPartnerships.toFixed(2)),
      topCategory,
    });
  } catch (error: any) {
    console.error('Error fetching brand stats:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to fetch brand stats' },
      { status: 500 }
    );
  }
}
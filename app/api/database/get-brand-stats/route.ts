import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { fetchAllRows } from '@/lib/supabasePaging';

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

    // Both of these aggregate in JS, so the rows are genuinely needed —
    // PostgREST rejects aggregate functions ("Use of aggregate functions is
    // not allowed"), so avg() and a mode cannot be pushed to the server.
    //
    // Paged rather than capped. This is the largest unbounded read in the
    // codebase: brands is at ~11,900 and grows with every sweep, and a plain
    // select silently stops at 50,000 rather than erroring.
    const [brandsWithPartnerships, categoryCounts] = await Promise.all([
      fetchAllRows<{ total_partnerships_detected: number | null }>(() => supabase
        .from('brands')
        .select('total_partnerships_detected')
        .not('total_partnerships_detected', 'is', null)
        .order('id', { ascending: true })),
      fetchAllRows<{ category_name: string | null }>(() => supabase
        .from('brands')
        .select('category_name')
        .not('category_name', 'is', null)
        .order('id', { ascending: true })),
    ]);

    const avgPartnerships = brandsWithPartnerships.length > 0
      ? brandsWithPartnerships.reduce((sum, b) => sum + (b.total_partnerships_detected || 0), 0) / brandsWithPartnerships.length
      : 0;

    const categoriesMap: Record<string, number> = {};
    categoryCounts.forEach(b => {
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
import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    
    const search = searchParams.get('search') || '';
    const status = searchParams.get('status') || '';
    const minFollowers = searchParams.get('minFollowers');
    const maxFollowers = searchParams.get('maxFollowers');
    const category = searchParams.get('category') || '';
    const sortBy = searchParams.get('sortBy') || 'last_updated_at';
    const sortDir = searchParams.get('sortDir') || 'desc';
    const offset = parseInt(searchParams.get('offset') || '0');
    const limit = parseInt(searchParams.get('limit') || '50');

    let query = supabase.from('creators').select('*', { count: 'exact' });

    // Search filter
    if (search) {
      query = query.or(`instagram_handle.ilike.%${search}%,full_name.ilike.%${search}%,bio.ilike.%${search}%`);
    }

    // Status filter
    if (status) {
      query = query.eq('status', status);
    }

    // Follower range filter
    if (minFollowers) {
      query = query.gte('follower_count', parseInt(minFollowers));
    }
    if (maxFollowers) {
      query = query.lte('follower_count', parseInt(maxFollowers));
    }

    // Category filter
    if (category) {
      query = query.eq('category_name', category);
    }

    // Sorting
    query = query.order(sortBy, { ascending: sortDir === 'asc' });

    // Pagination
    query = query.range(offset, offset + limit - 1);

    const { data, error, count } = await query;

    if (error) {
      throw error;
    }

    return NextResponse.json({
      creators: data,
      total: count,
      offset,
      limit,
    });
  } catch (error: any) {
    console.error('Error fetching creators:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to fetch creators' },
      { status: 500 }
    );
  }
}
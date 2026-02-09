import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    
    const search = searchParams.get('search') || '';
    const status = searchParams.get('status') || '';
    const sortBy = searchParams.get('sortBy') || 'last_updated_at';
    const sortDir = searchParams.get('sortDir') || 'desc';
    const offset = parseInt(searchParams.get('offset') || '0');
    const limit = parseInt(searchParams.get('limit') || '50');

    let query = supabase.from('brands').select('*', { count: 'exact' });

    // Search filter
    if (search) {
      query = query.or(`instagram_handle.ilike.%${search}%,brand_name.ilike.%${search}%,bio.ilike.%${search}%`);
    }

    // Status filter
    if (status) {
      query = query.eq('status', status);
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
      brands: data,
      total: count,
      offset,
      limit,
    });
  } catch (error: any) {
    console.error('Error fetching brands:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to fetch brands' },
      { status: 500 }
    );
  }
}
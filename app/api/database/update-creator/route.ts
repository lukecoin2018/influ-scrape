import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { id, status, notes } = body;

    const updateData: any = {};
    if (status !== undefined) updateData.status = status;
    if (notes !== undefined) updateData.notes = notes;
    updateData.last_updated_at = new Date().toISOString();

    const { data, error } = await supabase
      .from('creators')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      throw error;
    }

    return NextResponse.json({ success: true, creator: data });
  } catch (error: any) {
    console.error('Error updating creator:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to update creator' },
      { status: 500 }
    );
  }
}
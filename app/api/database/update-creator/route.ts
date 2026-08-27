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
      .maybeSingle();

    if (error) {
      throw error;
    }

    // Nothing updated. Out-of-range creators live in creators_archive, so an
    // edit aimed at one would otherwise no-op — the caller would see success
    // and wonder later why the change never stuck.
    //
    // maybeSingle() rather than single() is what makes this diagnosable:
    // single() raises PGRST116 ("no rows returned"), which surfaces as an
    // opaque 500 and says nothing about the creator being archived.
    if (!data) {
      const { data: archived } = await supabase
        .from('creators_archive')
        .select('id, archive_reason, display_name')
        .eq('id', id)
        .maybeSingle();

      if (archived) {
        return NextResponse.json(
          {
            error:
              `Creator ${archived.display_name || id} is archived (${archived.archive_reason}) ` +
              `and is not editable here. Archived creators are outside the active follower band. ` +
              `Promote them first with promote_creator() if they belong back in the main tables.`,
            archived: true,
            archiveReason: archived.archive_reason,
          },
          { status: 409 }
        );
      }

      return NextResponse.json(
        { error: `No creator found with id ${id}` },
        { status: 404 }
      );
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
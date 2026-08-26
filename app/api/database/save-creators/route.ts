import { NextRequest, NextResponse } from 'next/server';
import { saveDiscoveredCreators } from '@/lib/creatorImport';

export async function POST(request: NextRequest) {
  try {
    const contentLength = request.headers.get('content-length');
    if (contentLength && parseInt(contentLength) > 4000000) {
      return NextResponse.json(
        { error: 'Payload too large. Send fewer creators per batch.' },
        { status: 413 }
      );
    }

    const body = await request.json();
    const { creators, platform = 'instagram' } = body;

    if (!creators || !Array.isArray(creators) || creators.length === 0) {
      return NextResponse.json({ error: 'No creators provided' }, { status: 400 });
    }

    const { saved, failed, total, errors } = await saveDiscoveredCreators(creators, platform);

    return NextResponse.json({
      saved,
      failed,
      total,
      errors: errors.length > 0 ? errors.slice(0, 10) : undefined,
    });

  } catch (err: any) {
    console.error('Save creators error:', err);
    return NextResponse.json(
      { error: err.message || 'Internal server error' },
      { status: 500 }
    );
  }
}

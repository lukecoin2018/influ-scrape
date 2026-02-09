import { NextRequest, NextResponse } from 'next/server';
import { startProfileScraper } from '@/lib/apify';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { usernames } = body;

    if (!usernames || !Array.isArray(usernames) || usernames.length === 0) {
      return NextResponse.json(
        { error: 'Usernames array is required' },
        { status: 400 }
      );
    }

    const result = await startProfileScraper(usernames);

    return NextResponse.json(result);
  } catch (error: any) {
    console.error('Error starting profile scraper:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to start profile scraper' },
      { status: 500 }
    );
  }
}
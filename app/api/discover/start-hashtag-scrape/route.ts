import { NextRequest, NextResponse } from 'next/server';
import { startHashtagScraper } from '@/lib/apify';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { hashtags, resultsPerHashtag } = body;

    if (!hashtags || !Array.isArray(hashtags) || hashtags.length === 0) {
      return NextResponse.json(
        { error: 'Hashtags array is required' },
        { status: 400 }
      );
    }

    const result = await startHashtagScraper(hashtags, resultsPerHashtag || 100);

    return NextResponse.json(result);
  } catch (error: any) {
    console.error('Error starting hashtag scraper:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to start hashtag scraper' },
      { status: 500 }
    );
  }
}
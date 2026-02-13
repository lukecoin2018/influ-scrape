import { NextRequest, NextResponse } from 'next/server';

const APIFY_API_BASE = 'https://api.apify.com/v2';
const APIFY_TOKEN = process.env.APIFY_API_TOKEN;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { hashtags, resultsPerHashtag = 50 } = body;

    if (!hashtags || !Array.isArray(hashtags) || hashtags.length === 0) {
      return NextResponse.json(
        { error: 'Hashtags array is required' },
        { status: 400 }
      );
    }

    const actorId = 'clockworks~tiktok-scraper';
    const input = {
      hashtags,
      resultsPerPage: resultsPerHashtag,
      proxyConfiguration: { useApifyProxy: true },
    };

    const response = await fetch(
      `${APIFY_API_BASE}/acts/${actorId}/runs?token=${APIFY_TOKEN}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to start TikTok hashtag scraper: ${response.status} ${errorText}`);
    }

    const data = await response.json();

    return NextResponse.json({
      runId: data.data.id,
      datasetId: data.data.defaultDatasetId,
    });

  } catch (error: any) {
    console.error('Error starting TikTok hashtag scraper:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to start TikTok hashtag scraper' },
      { status: 500 }
    );
  }
}

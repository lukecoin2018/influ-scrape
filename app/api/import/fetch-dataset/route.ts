import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  const datasetId = request.nextUrl.searchParams.get('datasetId');
  
  if (!datasetId) {
    return NextResponse.json({ error: 'No datasetId provided' }, { status: 400 });
  }

  try {
    const response = await fetch(
      `https://api.apify.com/v2/datasets/${datasetId}/items?token=${process.env.APIFY_API_TOKEN}&format=json&limit=10000`
    );

    if (!response.ok) {
      return NextResponse.json(
        { error: `Apify returned ${response.status}` },
        { status: response.status }
      );
    }

    const items = await response.json();
    return NextResponse.json({ items, count: items.length });

  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

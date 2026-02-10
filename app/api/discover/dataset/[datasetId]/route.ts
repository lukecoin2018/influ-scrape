import { NextRequest, NextResponse } from 'next/server';
import { getDatasetItems } from '@/lib/apify';

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ datasetId: string }> }
) {
  try {
    const { datasetId } = await context.params;

    if (!datasetId) {
      return NextResponse.json(
        { error: 'Dataset ID is required' },
        { status: 400 }
      );
    }

    const items = await getDatasetItems(datasetId);

    return NextResponse.json(items);
  } catch (error: any) {
    console.error('Error getting dataset:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to get dataset' },
      { status: 500 }
    );
  }
}
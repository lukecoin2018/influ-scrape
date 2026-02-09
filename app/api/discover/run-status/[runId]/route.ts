import { NextRequest, NextResponse } from 'next/server';
import { getRunStatus } from '@/lib/apify';

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ runId: string }> }
) {
  try {
    const { runId } = await context.params;

    if (!runId) {
      return NextResponse.json(
        { error: 'Run ID is required' },
        { status: 400 }
      );
    }

    const result = await getRunStatus(runId);

    return NextResponse.json(result);
  } catch (error: any) {
    console.error('Error getting run status:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to get run status' },
      { status: 500 }
    );
  }
}
import { supabase } from './supabase';
import type { ImportStatus } from './followerRange';
import {
  rollUpCreatorImportStatusWith,
  saveDiscoveredCreatorsWith,
  type ImportableCreator,
  type ImportResult,
} from './creatorImportCore';

/**
 * Shared creator-import path.
 *
 * Extracted verbatim from app/api/database/save-creators/route.ts so that
 * server-side callers can reach it directly. An internal
 * fetch('/api/database/save-creators') does NOT work from a route handler:
 * middleware.ts guards every path except /login and /api/auth/*, and a
 * server-to-server fetch carries no session cookie, so the request is
 * redirected to /login instead of executing.
 *
 * Dedupe contract (unchanged): a creator is identified by
 * (platform, handle) in social_profiles. A hit reuses the existing
 * creator_id; a miss inserts a creators row first. This is the single
 * place new handles enter the database, regardless of which discovery
 * source found them.
 *
 * The loop itself lives in lib/creatorImportCore.ts with the client passed in,
 * so its failure paths can be tested without a database; this module binds it
 * to the service-role client and keeps the exports callers already import.
 */

export type { ImportableCreator, ImportResult };

/** See rollUpCreatorImportStatusWith in creatorImportCore.ts. */
export function rollUpCreatorImportStatus(creatorId: string): Promise<ImportStatus> {
  return rollUpCreatorImportStatusWith(supabase, creatorId);
}

export function saveDiscoveredCreators(
  creators: ImportableCreator[],
  platform: string = 'instagram'
): Promise<ImportResult> {
  return saveDiscoveredCreatorsWith(supabase, creators, platform);
}

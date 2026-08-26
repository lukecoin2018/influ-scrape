/**
 * PostgREST row-cap paging.
 *
 * This Supabase project caps every read at 5,500 rows. The cap is enforced
 * server-side and an explicit .limit() larger than that does NOT raise it —
 * a select over `brands` (11,856 rows) silently returns 5,500 and looks
 * successful. Anything that needs a whole table must page through it.
 */

const PAGE_SIZE = 5000;

/** Refuses to spin forever if a caller passes an unstable/unordered query. */
const MAX_ROWS = 200_000;

/**
 * Reads every row a query matches, one page at a time.
 *
 * `makeQuery` must return a FRESH query builder on each call and must apply a
 * deterministic .order(): without a stable sort, Postgres is free to return
 * rows in a different order per page, which would duplicate some rows and
 * drop others.
 */
export async function fetchAllRows<T>(
  makeQuery: () => any,
  pageSize: number = PAGE_SIZE
): Promise<T[]> {
  const rows: T[] = [];

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await makeQuery().range(from, from + pageSize - 1);

    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;

    rows.push(...(data as T[]));

    if (data.length < pageSize) break;
    if (rows.length >= MAX_ROWS) {
      console.warn(`fetchAllRows: stopped at ${rows.length} rows (MAX_ROWS guard)`);
      break;
    }
  }

  return rows;
}

/**
 * Request parameter parsing — honour it, or reject it. Never rewrite it.
 *
 * The rule exists because of a specific failure. A Discovery run was started
 * with searchSource: 'keyword', and the start route's guard still carried a
 * leftover `platform !== 'tiktok'` clause, so it silently rewrote the value to
 * 'hashtag'. The run executed and was recorded as a hashtag search. Nothing
 * reported the substitution — the response looked normal, the funnel looked
 * normal, and the only trace was a column reading 'hashtag' on a run the user
 * had selected as keyword.
 *
 * The shape `body.x === 'a' ? 'a' : 'b'` is the problem. It cannot distinguish
 * three different cases:
 *
 *   absent          -> use the default, correctly
 *   'a'             -> honour it, correctly
 *   'nonsense'      -> silently becomes 'b', WRONGLY
 *
 * A caller that asked for something unsupported deserves an error, not a
 * substitution it will never learn about. These helpers make the third case
 * loud while leaving the first two alone.
 */

export type ParseResult<T> =
  | { ok: true; value: T; clamped?: boolean; requested?: number }
  | { ok: false; error: string };

/**
 * An enum-valued parameter.
 *
 * Absent or empty yields the fallback. A recognised value is honoured. Anything
 * else is an error naming what was asked for and what is allowed, rather than
 * quietly becoming the fallback.
 */
export function parseEnumParam<T extends string>(
  name: string,
  raw: unknown,
  allowed: readonly T[],
  fallback: T,
): ParseResult<T> {
  if (raw === undefined || raw === null || raw === '') {
    return { ok: true, value: fallback };
  }
  if (typeof raw !== 'string') {
    return { ok: false, error: `${name} must be a string, received ${typeof raw}` };
  }
  if ((allowed as readonly string[]).includes(raw)) {
    return { ok: true, value: raw as T };
  }
  return {
    ok: false,
    error: `${name}="${raw}" is not supported. Allowed: ${allowed.join(', ')}.`,
  };
}

/**
 * A bounded integer.
 *
 * Clamping is legitimate — a platform ceiling is a fact about the world, not a
 * misunderstanding of the request — but it is REPORTED. `clamped` and
 * `requested` let the caller say what it did rather than returning a number
 * that silently differs from the one asked for.
 *
 * A non-numeric value is an error, not a fallback: `Number('abc') || 100`
 * yielding 100 is the same class of silent substitution.
 */
export function parseBoundedInt(
  name: string,
  raw: unknown,
  bounds: { min: number; max: number; fallback: number },
): ParseResult<number> {
  if (raw === undefined || raw === null || raw === '') {
    return { ok: true, value: bounds.fallback };
  }

  const parsed = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(parsed)) {
    return { ok: false, error: `${name} must be a number, received "${String(raw)}"` };
  }

  const floored = Math.floor(parsed);
  const clampedValue = Math.min(Math.max(floored, bounds.min), bounds.max);

  return clampedValue === floored
    ? { ok: true, value: clampedValue }
    : { ok: true, value: clampedValue, clamped: true, requested: floored };
}

/** A boolean that defaults when absent and errors on anything non-boolean. */
export function parseBoolParam(
  name: string,
  raw: unknown,
  fallback: boolean,
): ParseResult<boolean> {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: fallback };
  if (typeof raw === 'boolean') return { ok: true, value: raw };
  return { ok: false, error: `${name} must be a boolean, received "${String(raw)}"` };
}

/** Collects the first error from several parses, for a single 400 response. */
export function firstError(...results: ParseResult<unknown>[]): string | null {
  for (const r of results) if (!r.ok) return r.error;
  return null;
}

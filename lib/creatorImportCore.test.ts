import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import { saveDiscoveredCreatorsWith } from './creatorImportCore.ts';

/**
 * The importer's failure paths, against a fake client that records every call.
 *
 * The two bugs these pin down both ended with a profile and its creator
 * disagreeing: a failed lookup read as "new handle" (a fresh creator, and the
 * existing profile moved onto it), and a failed profile write leaving the
 * just-inserted creator behind with no profile.
 */

type Resp = { data?: unknown; error?: { message: string; code?: string } | null };
type Call = { key: string; table: string; op: string; payload?: unknown; filters: [string, unknown][] };
/** A canned response, an Error to throw, or a function of the call and how many times this key has been hit. */
type Responder = Resp | Error | ((call: Call, nth: number) => Resp | Error);

function fakeDb(responders: Record<string, Responder> = {}) {
  const calls: Call[] = [];
  const hits = new Map<string, number>();

  function respond(call: Call) {
    calls.push(call);
    const nth = (hits.get(call.key) ?? 0) + 1;
    hits.set(call.key, nth);
    const r = responders[call.key];
    const resolved = typeof r === 'function' ? r(call, nth) : r;
    if (resolved instanceof Error) throw resolved;
    return { data: resolved?.data ?? null, error: resolved?.error ?? null };
  }

  const db = {
    from(table: string) {
      const call: Call = { key: '', table, op: 'select', filters: [] };
      const finish = () => Promise.resolve().then(() => {
        call.key = `${call.op}:${table}`;
        return respond(call);
      });
      const chain = {
        // select() after insert/delete/upsert asks for rows back; it does not change the operation.
        select: () => chain,
        insert: (payload: unknown) => { call.op = 'insert'; call.payload = payload; return chain; },
        upsert: (payload: unknown) => { call.op = 'upsert'; call.payload = payload; return chain; },
        update: (payload: unknown) => { call.op = 'update'; call.payload = payload; return chain; },
        delete: () => { call.op = 'delete'; return chain; },
        eq: (column: string, value: unknown) => { call.filters.push([column, value]); return chain; },
        maybeSingle: finish,
        single: finish,
        then: (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) => finish().then(onFulfilled, onRejected),
      };
      return chain;
    },
    rpc(name: string, payload: unknown) {
      return Promise.resolve().then(() => respond({ key: `rpc:${name}`, table: name, op: 'rpc', payload, filters: [] }));
    },
  };
  return { db: db as unknown as SupabaseClient, calls };
}

/** The lookup and the roll-up both read v_social_profiles_all; only the lookup filters on handle. */
const lookup = (resp: Resp | Error): Responder => (call) =>
  call.filters.some(([column]) => column === 'handle') ? resp : { data: [] };

const ops = (calls: Call[]) => calls.map(c => c.key);

test('a lookup that errors fails the creator and writes nothing', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { db, calls } = fakeDb({
    'select:v_social_profiles_all': lookup({ error: { message: 'canceling statement due to statement timeout', code: '57014' } }),
  });

  const result = await saveDiscoveredCreatorsWith(db, [{ handle: '@GloweryFan' }], 'instagram');

  assert.equal(result.saved, 0);
  assert.equal(result.failed, 1);
  assert.deepEqual(result.savedHandles, []);
  assert.match(result.errors[0], /^gloweryfan: profile lookup failed \(canceling statement due to statement timeout\)/);
  // No creator insert and no profile write: the old code went on to do both.
  assert.deepEqual(ops(calls), ['select:v_social_profiles_all']);
});

test('a lookup that finds the handle twice (live and archive) fails instead of picking one', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { db, calls } = fakeDb({
    'select:v_social_profiles_all': lookup({ error: { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116' } }),
  });

  const result = await saveDiscoveredCreatorsWith(db, [{ handle: 'twice' }], 'tiktok');

  assert.equal(result.failed, 1);
  assert.match(result.errors[0], /^twice: profile lookup found tiktok:twice more than once/);
  assert.deepEqual(ops(calls), ['select:v_social_profiles_all']);
});

test('a failed profile write deletes the creator this call inserted, from the table it went into', async (t) => {
  t.mock.method(console, 'error', () => {});
  const cases = [
    { label: 'live', importStatus: undefined, table: 'creators', write: 'rpc:upsert_social_profile' },
    { label: 'archive', importStatus: 'out_of_range_low' as const, table: 'creators_archive', write: 'upsert:social_profiles_archive' },
  ];
  for (const c of cases) {
    const { db, calls } = fakeDb({
      'select:v_social_profiles_all': lookup({ data: null }),
      [`insert:${c.table}`]: { data: { id: 'new-creator' } },
      [c.write]: { error: { message: 'value too long for type character varying(255)' } },
      [`delete:${c.table}`]: { data: [{ id: 'new-creator' }] },
    });

    const result = await saveDiscoveredCreatorsWith(db, [{ handle: 'h', importStatus: c.importStatus }], 'tiktok');

    assert.equal(result.failed, 1, c.label);
    assert.deepEqual(ops(calls), ['select:v_social_profiles_all', `insert:${c.table}`, c.write, `delete:${c.table}`], c.label);
    const del = calls.find(call => call.op === 'delete')!;
    assert.deepEqual(del.filters, [['id', 'new-creator']], `${c.label}: deleted by its own id only`);
    assert.match(result.errors[0], new RegExp(`character varying\\(255\\) \\(creator new-creator removed again from ${c.table}\\)`), c.label);
  }
});

test('a failed profile write for a creator that already existed deletes nothing', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { db, calls } = fakeDb({
    'select:v_social_profiles_all': lookup({ data: { creator_id: 'existing-creator', population: 'active' } }),
    'rpc:upsert_social_profile': { error: { message: 'refusing to move social profile' } },
  });

  const result = await saveDiscoveredCreatorsWith(db, [{ handle: 'known' }], 'instagram');

  assert.equal(result.failed, 1);
  assert.equal(result.errors[0], 'known: refusing to move social profile');
  assert.deepEqual(ops(calls), ['select:v_social_profiles_all', 'rpc:upsert_social_profile']);
  assert.equal((calls[1].payload as { p_creator_id: string }).p_creator_id, 'existing-creator');
});

test('an exception after the insert removes the creator again, and the run carries on', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { db, calls } = fakeDb({
    'select:v_social_profiles_all': (call) => {
      if (!call.filters.some(([column]) => column === 'handle')) return { data: [] };
      const handle = call.filters.find(([column]) => column === 'handle')![1];
      return handle === 'second' ? { data: { creator_id: 'existing-creator', population: 'active' } } : { data: null };
    },
    'insert:creators': { data: { id: 'new-creator' } },
    // Thrown, not returned: a dropped connection mid-call.
    'rpc:upsert_social_profile': (_call, nth) => (nth === 1 ? new Error('fetch failed') : { data: { action: 'updated' } }),
    'delete:creators': { data: [{ id: 'new-creator' }] },
  });

  const result = await saveDiscoveredCreatorsWith(db, [{ handle: 'first' }, { handle: 'second' }], 'instagram');

  assert.equal(result.failed, 1);
  assert.equal(result.saved, 1);
  assert.deepEqual(result.savedHandles, ['second']);
  assert.match(result.errors[0], /^first: fetch failed \(creator new-creator removed again from creators\)$/);
  const deletes = calls.filter(call => call.op === 'delete');
  assert.equal(deletes.length, 1);
  assert.deepEqual(deletes[0].filters, [['id', 'new-creator']]);
});

test('a compensating delete that fails is reported as an orphan, not thrown', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { db } = fakeDb({
    'select:v_social_profiles_all': lookup({ data: null }),
    'insert:creators': { data: { id: 'new-creator' } },
    'rpc:upsert_social_profile': { error: { message: 'boom' } },
    'delete:creators': new Error('fetch failed'),
  });

  const result = await saveDiscoveredCreatorsWith(db, [{ handle: 'h' }], 'instagram');

  assert.equal(result.failed, 1);
  assert.match(result.errors[0], /^h: boom \(orphan left: creator new-creator in creators; removing it failed: fetch failed\)$/);
});

test('the normal paths are unchanged: a new handle is saved under its new creator, an existing one under its own', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { db, calls } = fakeDb({
    'select:v_social_profiles_all': (call) => {
      const handle = call.filters.find(([column]) => column === 'handle')?.[1];
      if (handle === undefined) return { data: [{ import_status: 'active' }] };
      return handle === 'old' ? { data: { creator_id: 'existing-creator', population: 'active' } } : { data: null };
    },
    'insert:creators': { data: { id: 'new-creator' } },
    'rpc:upsert_social_profile': { data: { action: 'inserted' } },
  });

  const result = await saveDiscoveredCreatorsWith(db, [{ handle: 'fresh' }, { handle: 'old' }], 'instagram');

  assert.deepEqual(result, {
    saved: 2, failed: 0, total: 2, savedHandles: ['fresh', 'old'], existingHandles: ['old'], errors: [],
  });
  const profileWrites = calls.filter(call => call.key === 'rpc:upsert_social_profile').map(call => (call.payload as { p_creator_id: string }).p_creator_id);
  assert.deepEqual(profileWrites, ['new-creator', 'existing-creator']);
  assert.equal(calls.filter(call => call.op === 'delete').length, 0);
});

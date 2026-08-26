'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createChunkedRunner,
  type ChunkedRunnerCore,
  type RunnerItemError,
  type RunnerOptions,
  type RunnerProgress,
  type RunnerStatus,
} from './chunkedRunnerCore';

export type {
  RunnerStatus,
  RunnerProgress,
  RunnerItemError,
} from './chunkedRunnerCore';

/**
 * React wrapper over the pure runner in lib/chunkedRunnerCore.
 *
 * Generalises the loop that the Intelligence location runner, the Locations
 * page and the Enrich page each hand-roll: walk a list in chunks, process one
 * item at a time (never fanned out), catch per item so one failure cannot
 * abort the batch, pause between chunks, and report progress live.
 *
 * All run state lives in the core, not in React state: the loop has to
 * observe a stop request synchronously, and a state value captured in a
 * closure would stay stale until the next render.
 *
 * The three existing runners are deliberately left alone.
 */

export type ChunkedRunnerOptions<TItem, TResult> = RunnerOptions<TItem, TResult>;

export interface ChunkedRunner<TItem, TResult> {
  status: RunnerStatus;
  isRunning: boolean;
  progress: RunnerProgress;
  results: TResult[];
  errors: RunnerItemError[];
  currentLabel: string;
  message: string;
  start: (items: TItem[]) => Promise<void>;
  stop: () => void;
  reset: () => void;
}

export function useChunkedRunner<TItem, TResult>(
  options: ChunkedRunnerOptions<TItem, TResult>
): ChunkedRunner<TItem, TResult> {
  const [status, setStatus] = useState<RunnerStatus>('idle');
  const [progress, setProgress] = useState<RunnerProgress>({
    done: 0, total: 0, succeeded: 0, failed: 0,
  });
  const [results, setResults] = useState<TResult[]>([]);
  const [errors, setErrors] = useState<RunnerItemError[]>([]);
  const [currentLabel, setCurrentLabel] = useState('');
  const [message, setMessage] = useState('');

  // Fresh options are read through a ref at the start of each run, so the
  // core never has to be rebuilt when a dependency of processItem changes.
  // Rebuilding it would drop the running flag and reopen the double-run
  // window this whole structure exists to close.
  //
  // Synced in an effect rather than assigned during render: writing to a ref
  // while rendering is unsafe under concurrent React.
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  // State setters are stable, so these never need rebuilding.
  const events = useMemo(() => ({
    onStatus: setStatus,
    onProgress: setProgress,
    onResult: (result: TResult) => setResults(prev => [...prev, result]),
    onError: (error: RunnerItemError) => setErrors(prev => [...prev, error]),
    onLabel: setCurrentLabel,
    onMessage: setMessage,
    onClear: () => { setResults([]); setErrors([]); },
  }), []);

  // Built on first use rather than during render, so the ref is only ever
  // touched from an event handler.
  const coreRef = useRef<ChunkedRunnerCore<TItem> | null>(null);
  const getCore = useCallback(() => {
    if (!coreRef.current) {
      coreRef.current = createChunkedRunner<TItem, TResult>(
        () => optionsRef.current,
        events
      );
    }
    return coreRef.current;
  }, [events]);

  const start = useCallback((items: TItem[]) => getCore().start(items), [getCore]);
  const stop = useCallback(() => getCore().stop(), [getCore]);
  const reset = useCallback(() => getCore().reset(), [getCore]);

  return {
    status,
    isRunning: status === 'running',
    progress,
    results,
    errors,
    currentLabel,
    message,
    start,
    stop,
    reset,
  };
}

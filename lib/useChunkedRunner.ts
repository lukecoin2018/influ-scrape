'use client';

import { useCallback, useRef, useState } from 'react';

/**
 * Chunked sequential runner.
 *
 * Generalises the loop that the Intelligence location runner
 * (app/intelligence/page.tsx runLocFull), the Locations page
 * (app/extract-locations/page.tsx runBatch) and the Enrich page
 * (app/enrich/page.tsx startEnrichment) each hand-roll today:
 *
 *   - walk a list of items in chunks
 *   - process each item sequentially (one Apify run at a time, never fanned out)
 *   - catch per item, so one failure never aborts the batch
 *   - pause between chunks to stay clear of rate limits
 *   - surface live progress while it runs
 *
 * This is new code. The three existing runners are deliberately left alone —
 * the Intelligence one in particular is entangled with location-specific
 * state (byCountry merging, a hardcoded LOC_FULL_TOTAL) and retrofitting it
 * belongs in its own change.
 *
 * A chunkSize of 1 gives the strictly-one-at-a-time shape the Enrich page uses.
 */

export type RunnerStatus = 'idle' | 'running' | 'done' | 'stopped';

export interface RunnerItemError {
  item: string;
  message: string;
}

export interface RunnerProgress {
  done: number;
  total: number;
  succeeded: number;
  failed: number;
}

export interface ChunkedRunnerOptions<TItem, TResult> {
  /** Items per chunk. Items within a chunk still run one after another. */
  chunkSize: number;
  /** Pause between chunks, in ms. Skipped after the final chunk. */
  delayMs: number;
  /** Processes one item. Throwing marks that item failed and continues. */
  processItem: (item: TItem, index: number) => Promise<TResult>;
  /** Label for progress display and error rows. */
  labelFor: (item: TItem) => string;
}

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
  const { chunkSize, delayMs, processItem, labelFor } = options;

  const [status, setStatus] = useState<RunnerStatus>('idle');
  const [progress, setProgress] = useState<RunnerProgress>({
    done: 0,
    total: 0,
    succeeded: 0,
    failed: 0,
  });
  const [results, setResults] = useState<TResult[]>([]);
  const [errors, setErrors] = useState<RunnerItemError[]>([]);
  const [currentLabel, setCurrentLabel] = useState('');
  const [message, setMessage] = useState('');

  // Ref, not state: the loop needs to observe a stop request mid-run, and a
  // state value captured in the closure would stay stale until the next render.
  const cancelRef = useRef(false);

  const reset = useCallback(() => {
    cancelRef.current = false;
    setStatus('idle');
    setProgress({ done: 0, total: 0, succeeded: 0, failed: 0 });
    setResults([]);
    setErrors([]);
    setCurrentLabel('');
    setMessage('');
  }, []);

  const stop = useCallback(() => {
    cancelRef.current = true;
    setMessage('Stopping after the current item…');
  }, []);

  const start = useCallback(
    async (items: TItem[]) => {
      cancelRef.current = false;
      setStatus('running');
      setResults([]);
      setErrors([]);

      const total = items.length;
      setProgress({ done: 0, total, succeeded: 0, failed: 0 });

      if (total === 0) {
        setStatus('done');
        setMessage('Nothing to run.');
        return;
      }

      let succeeded = 0;
      let failed = 0;
      let done = 0;

      const chunks: TItem[][] = [];
      for (let i = 0; i < total; i += chunkSize) {
        chunks.push(items.slice(i, i + chunkSize));
      }

      setMessage(`Starting ${total} item${total === 1 ? '' : 's'}…`);

      for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
        if (cancelRef.current) break;

        for (const item of chunks[chunkIndex]) {
          if (cancelRef.current) break;

          const label = labelFor(item);
          setCurrentLabel(label);
          setMessage(`Processing ${label} (${done + 1} of ${total})…`);

          try {
            const result = await processItem(item, done);
            succeeded++;
            setResults(prev => [...prev, result]);
          } catch (err) {
            failed++;
            const errorMessage = err instanceof Error ? err.message : 'Unknown error';
            setErrors(prev => [...prev, { item: label, message: errorMessage }]);
          }

          done++;
          setProgress({ done, total, succeeded, failed });
        }

        const isLastChunk = chunkIndex === chunks.length - 1;
        if (!isLastChunk && !cancelRef.current && delayMs > 0) {
          setMessage(`Pausing ${Math.round(delayMs / 1000)}s between chunks…`);
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
      }

      const stopped = cancelRef.current;
      setCurrentLabel('');
      setStatus(stopped ? 'stopped' : 'done');
      setMessage(
        `${stopped ? 'Stopped' : 'Complete'} — ${succeeded} succeeded, ${failed} failed` +
          `${stopped ? `, ${total - done} not attempted` : ''}.`
      );
    },
    [chunkSize, delayMs, processItem, labelFor]
  );

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

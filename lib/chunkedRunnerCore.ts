/**
 * Chunked sequential runner — pure core, no React.
 *
 * Split out from useChunkedRunner so the run loop and, critically, its
 * re-entrancy guard can be tested directly rather than through a renderer.
 * The React hook is a thin wrapper that maps the events below onto state.
 *
 * Run state (running / cancelled / counters) lives in closure variables, not
 * React state, because the loop must observe changes synchronously mid-run.
 */

export type RunnerStatus = 'idle' | 'running' | 'done' | 'stopped';

export interface RunnerProgress {
  done: number;
  total: number;
  succeeded: number;
  failed: number;
}

export interface RunnerItemError {
  item: string;
  message: string;
}

export interface RunnerOptions<TItem, TResult> {
  /** Items per chunk. Items within a chunk still run one after another. */
  chunkSize: number;
  /** Pause between chunks, in ms. Skipped after the final chunk. */
  delayMs: number;
  /**
   * Processes one item. Throwing marks it failed and the run continues.
   * The signal aborts when stop() is called, so an in-flight request can be
   * cut mid-item instead of running to completion.
   *
   * `report` publishes sub-item progress. The runner's own counters are
   * per-item, which is right when an item is one round trip — but a Discovery
   * hashtag is a hashtag scrape plus up to eighteen profile batches, and would
   * otherwise sit on one un-moving tick for minutes. Callers written before
   * this parameter existed ignore it, since JavaScript discards extra
   * arguments.
   */
  processItem: (
    item: TItem,
    index: number,
    signal: AbortSignal,
    report: (message: string) => void,
  ) => Promise<TResult>;
  /** Label for progress display and error rows. */
  labelFor: (item: TItem) => string;
  /**
   * Observes what `report` publishes, for callers that want the signal for
   * something other than display — logging, or a test.
   *
   * Display needs no wiring: `report` already routes to onMessage, which the
   * React wrapper maps onto the message it renders.
   */
  onItemProgress?: (item: TItem, message: string) => void;
}

export interface RunnerEvents<TResult> {
  onStatus: (status: RunnerStatus) => void;
  onProgress: (progress: RunnerProgress) => void;
  onResult: (result: TResult) => void;
  onError: (error: RunnerItemError) => void;
  onLabel: (label: string) => void;
  onMessage: (message: string) => void;
  onClear: () => void;
}

export interface ChunkedRunnerCore<TItem> {
  start: (items: TItem[]) => Promise<void>;
  stop: () => void;
  reset: () => void;
  isRunning: () => boolean;
  /** Completed runs, including stopped ones. Test/telemetry aid. */
  runCount: () => number;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export function createChunkedRunner<TItem, TResult>(
  getOptions: () => RunnerOptions<TItem, TResult>,
  events: RunnerEvents<TResult>,
  sleep: (ms: number) => Promise<void> = ms => new Promise(r => setTimeout(r, ms))
): ChunkedRunnerCore<TItem> {
  let running = false;
  let cancelled = false;
  let controller: AbortController | null = null;
  let runs = 0;

  // Single source of truth for the tally. Previously these were local
  // variables inside the loop, so two concurrent loops each reported their
  // own counts and the summary could disagree with the accumulated results.
  // Holding them here keeps the invariants
  //   succeeded === results.length   and   failed === errors.length
  // true no matter how the loop terminates.
  let counts: RunnerProgress = { done: 0, total: 0, succeeded: 0, failed: 0 };

  const publish = () => events.onProgress({ ...counts });

  const stop = () => {
    // Only meaningful while a run is in flight. Setting the flag when idle
    // would leave a pending cancel that the next start() has to discard.
    if (!running) return;
    cancelled = true;
    // Cut the in-flight request too, so stopping does not have to wait for
    // the current item to run to completion.
    controller?.abort();
    events.onMessage('Stopping — cancelling the current item…');
  };

  const reset = () => {
    if (running) return;
    cancelled = false;
    counts = { done: 0, total: 0, succeeded: 0, failed: 0 };
    events.onStatus('idle');
    events.onProgress({ ...counts });
    events.onClear();
    events.onLabel('');
    events.onMessage('');
  };

  const start = async (items: TItem[]) => {
    // Re-entrancy guard. Everything from here to the first await runs
    // synchronously in one task, so a second call in the same tick — or any
    // time before this run finishes — cannot get past it. Without this, two
    // calls produced two loops sharing one set of state setters, each
    // scraping every item.
    if (running) return;
    running = true;

    // Only reached when no run is active, so this can never discard a cancel
    // that belongs to a run still in flight.
    cancelled = false;

    controller = new AbortController();
    const { chunkSize, delayMs, processItem, labelFor, onItemProgress } = getOptions();

    try {
      events.onStatus('running');
      events.onClear();

      counts = { done: 0, total: items.length, succeeded: 0, failed: 0 };
      publish();

      if (items.length === 0) {
        events.onStatus('done');
        events.onMessage('Nothing to run.');
        return;
      }

      const chunks: TItem[][] = [];
      for (let i = 0; i < items.length; i += chunkSize) {
        chunks.push(items.slice(i, i + chunkSize));
      }

      events.onMessage(`Starting ${items.length} item${items.length === 1 ? '' : 's'}…`);

      outer: for (let c = 0; c < chunks.length; c++) {
        if (cancelled) break;

        for (const item of chunks[c]) {
          if (cancelled) break outer;

          const label = labelFor(item);
          events.onLabel(label);
          events.onMessage(`Processing ${label} (${counts.done + 1} of ${counts.total})…`);

          // Display-only: touches neither the counters nor onResult/onError,
          // so the succeeded === results.length invariant holds however many
          // times an item calls it.
          const report = (message: string) => {
            events.onMessage(message);
            onItemProgress?.(item, message);
          };

          try {
            const result = await processItem(item, counts.done, controller.signal, report);
            counts.succeeded++;
            counts.done++;
            events.onResult(result);
          } catch (error) {
            // An abort is a cancellation, not a failure: the item never
            // completed, so it is not counted in either tally.
            if (cancelled && isAbortError(error)) break outer;

            counts.failed++;
            counts.done++;
            events.onError({
              item: label,
              message: error instanceof Error ? error.message : 'Unknown error',
            });
          }

          publish();
        }

        const isLast = c === chunks.length - 1;
        if (!isLast && !cancelled && delayMs > 0) {
          events.onMessage(`Pausing ${Math.round(delayMs / 1000)}s between chunks…`);
          await sleep(delayMs);
        }
      }

      const stopped = cancelled;
      const notAttempted = counts.total - counts.done;

      events.onLabel('');
      events.onStatus(stopped ? 'stopped' : 'done');
      events.onMessage(
        `${stopped ? 'Stopped' : 'Complete'} — ${counts.succeeded} succeeded, ` +
        `${counts.failed} failed` +
        `${stopped && notAttempted > 0 ? `, ${notAttempted} not attempted` : ''}.`
      );
      publish();
    } finally {
      running = false;
      controller = null;
      runs++;
    }
  };

  return { start, stop, reset, isRunning: () => running, runCount: () => runs };
}

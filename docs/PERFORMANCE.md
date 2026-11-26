# Streaming and cache performance

## Compatible tuning options

`streamObject` accepts `snapshotIntervalChars`, a positive safe integer measured
in JavaScript string code units. Its default is `1`: each provider text delta
still produces an `object-delta`, including empty deltas. Larger values coalesce
object snapshots until at least that many new characters accumulate. They do not
split provider chunks. The final pending snapshot is flushed before
`object-complete`; final JSON parsing and schema validation always run.

All original stream events, including `text-delta`, retain their order and
contents. Each grouped `object-delta.textDelta` contains the text since the last
snapshot; `partialText` retains its existing cumulative-text meaning. Partial
objects are parsed at snapshot boundaries and emitted when changed. For example:

```ts
const result = streamObject({
  model,
  prompt,
  schema,
  snapshotIntervalChars: 4096
});
```

This option reduces snapshot traffic and parsing frequency, but can delay an
intermediate object update until more text arrives or the stream finishes. It is
not a timer or a byte budget. Default replay limits still apply to text events.
Lexical JSON repair is incremental even with default settings; complete JSON
parsing and snapshot serialization still depend on the accumulated document size.
Snapshot spacing reduces that cost without claiming linear complexity for all
structured outputs.

`createInMemoryGenerateCache` accepts these optional positive safe integers:

- `maxEntries`: evict least recently used entries to stay within the count.
- `maxBytes`: bound total UTF-8 JSON value bytes plus UTF-8 key bytes, measured
  when inserted. Oversized or unserializable values are skipped; a replacement
  removes any previous value for that key.
- `ttlMs`: expire since the last write, without extending the lifetime on reads.
  Expired entries are removed on access and subsequent writes, without timers.

```ts
const cache = createInMemoryGenerateCache({
  maxEntries: 1000,
  maxBytes: 16 * 1024 * 1024,
  ttlMs: 60_000
});
```

No-argument calls remain unlimited with no expiry. Values retain their original
reference identity. Byte accounting is an insertion-time serialized size, not a
heap measurement, and does not track caller mutations after insertion. Combine
TTL with a size limit when bounding retention matters; an idle cache does not run
background cleanup. Expiry order is tracked separately from LRU reads, so normal
writes prune expired entries without rescanning every live entry.

## Before/after benchmark

Measured locally with Bun 1.4.3 against baseline commit
`d3c8b682adca2df904f4f49523f34d3db183b531`. Each case uses two warmups and the
median of five samples, 64-byte ASCII chunks, a simulated provider returning a string-valued object, and assertions
that final objects, text, and concatenated object deltas are identical. The replay
tail is limited to 16 events with `drop-oldest` in both versions. Serialization
bytes are measured separately from processing latency, before SSE framing or
compression. No provider calls are made.

| Workload | Before | After | Change |
| --- | ---: | ---: | ---: |
| Object 16 KiB, defaults | 7.889 ms | 1.441 ms | 5.5× faster |
| Object 32 KiB, defaults | 27.655 ms | 3.184 ms | 8.7× faster |
| Object 64 KiB, defaults | 109.795 ms | 9.440 ms | 11.6× faster |
| Object 64 KiB, snapshots every 4096 chars | 106.639 ms | 1.400 ms | 76.2× faster |
| Serialized events, 64 KiB object, defaults | 34,011,450 bytes | 34,011,450 bytes | Unchanged |
| Serialized events, 64 KiB object, 4096-char snapshots | 34,011,450 bytes | 922,842 bytes | 97.3% fewer bytes |
| Single SSE event, 128 KiB | 8.987 ms | 0.546 ms | 16.5× faster |
| Single SSE event, 256 KiB | 33.425 ms | 0.862 ms | 38.8× faster |
| Single SSE event, 512 KiB | 125.179 ms | 1.815 ms | 69.0× faster |
| Cache retained entries, 2000 writes, bounded configuration | 2,000 | 128 | 93.6% fewer entries |
| Cache retained serialized bytes, bounded configuration | 2,085,780 | 133,632 | 93.6% fewer bytes |
| Cache write/read workload, bounded configuration | 1.652 ms | 1.904 ms | 15.3% more time |

The baseline ignores the newly added options. The bounded cache case requests
`maxEntries: 128` and `maxBytes: 256 * 1024`; the entry limit is binding here.
Its extra bookkeeping buys bounded retention, not higher throughput. Default
cache retention remains unchanged (2000 entries), with measured time changing from
1.902 to 1.198 ms. The unlimited path retains the original Map implementation. These synthetic results vary by runtime, chunk sizes, output
shape, and machine load; they are not API latency or peak-heap measurements.

Raw data: [before](./benchmarks/stream-cache-before.json),
[after](./benchmarks/stream-cache-after.json).

Run the current implementation:

```bash
bun run scripts/benchmarks/stream-cache.ts
```

Repeat the baseline on the same machine, sequentially with the current run:

```bash
bun run scripts/benchmarks/stream-cache.ts --baseline-ref=d3c8b682adca2df904f4f49523f34d3db183b531
```

This reads the three changed runtime modules from Git into a temporary directory,
resolves their relative imports to the unchanged checkout dependencies, and
removes the temporary files on exit. It does not switch branches or modify the
working tree. The same benchmark runs both implementations; its new tuning
options are ignored by the older implementation.

## Agent checkpoint copies

Agent tool loops validate and checkpoint the complete run state on every step.
Before this change, each validated copy was serialized a second time, the
in-memory run store normalized every loaded state twice, and each step compared
its history prefix by calling `JSON.stringify` on every message. With a history
that grows on every step, those repeated copies dominated long runs.

The runtime now keeps one validated copy per normalization, parses an existing
checkpoint string once more instead of revalidating it, and compares history
prefixes structurally with an exact `JSON.stringify` fallback for values outside
plain JSON data. Stored state shapes, validation, revisions, and public APIs are
unchanged.

The following measurements were taken before the serialized-state and history-comparison regression fixes, with Node 22.23.5 against baseline commit
`d0667bfea53aa22f87373cab0371ccd2c74209a9`. Each step returns one tool call
whose result is a 4 KiB string; the run ends after the configured number of
steps. Each case uses one warmup and the median of three samples. No provider
calls are made.

| Run store | Steps | Before | After | Change |
| --- | ---: | ---: | ---: | ---: |
| None | 50 | 45.2 ms | 19.4 ms | 2.3× faster |
| None | 100 | 143.3 ms | 67.2 ms | 2.1× faster |
| None | 200 | 658.5 ms | 283.3 ms | 2.3× faster |
| In-memory | 50 | 934.0 ms | 540.9 ms | 1.7× faster |
| In-memory | 100 | 3,976.6 ms | 1,807.4 ms | 2.2× faster |
| In-memory | 200 | 17,325.6 ms | 7,880.1 ms | 2.2× faster |

After adding validation of the serialized checkpoint and handling getters,
raw JSON, and proxies in history comparisons, the 100-step case was repeated
on Node 24.19.0 against the same baseline. The median fell from 157.3 ms to
78.0 ms without a store and from 3,885.6 ms to 1,798.7 ms with the in-memory store.

Full-state checkpoints still copy the whole run state on every step, so total
work grows with the square of the step count. Use compaction or offload large
tool outputs to artifacts for long runs. Durable stores benefit from the shared
copy reduction; their own I/O is not measured here.

Raw data: [before](./benchmarks/agent-checkpoint-before.json),
[after](./benchmarks/agent-checkpoint-after.json).

```bash
bun run build && node scripts/benchmarks/agent-checkpoint-scaling.mjs
```

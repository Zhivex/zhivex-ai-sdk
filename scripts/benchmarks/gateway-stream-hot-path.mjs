// Offline per-chunk overhead of the gateway stream wait. No network.
// Run: bun scripts/benchmarks/gateway-stream-hot-path.mjs
const chunks = 20_000;
const trials = 7;
const idleMs = 60_000;
const payload = new TextEncoder().encode("data: x\n\n");

const mockedFetch = () => new Response(new ReadableStream({
  start(controller) {
    for (let index = 0; index < chunks; index += 1) controller.enqueue(payload);
    controller.close();
  }
}));

const beforeNext = async (pull) => {
  const idleError = new Error(`Provider stream was idle for more than ${idleMs}ms.`);
  const timer = setTimeout(() => idleError, idleMs);
  try {
    return await new Promise((resolve, reject) => {
      pull().then(resolve, reject);
    });
  } finally {
    clearTimeout(timer);
  }
};

const createAfterNext = () => {
  let armed = false;
  let timer;
  const onIdle = () => {
    timer = undefined;
    if (!armed) return;
    armed = false;
    new Error(`Provider stream was idle for more than ${idleMs}ms.`);
  };
  const next = async (pull) => {
    armed = true;
    if (timer) timer.refresh();
    else timer = setTimeout(onIdle, idleMs);
    try {
      return await pull();
    } finally {
      armed = false;
    }
  };
  next.dispose = () => {
    armed = false;
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  return next;
};

const readWith = async (next) => {
  const response = await fetch("https://gateway.invalid/stream");
  const reader = response.body.getReader();
  const pull = () => reader.read().then((result) => result.done ? null : result.value);
  const read = [];
  for (;;) {
    const chunk = await next(pull);
    if (chunk == null) return read;
    read.push(chunk);
  }
};

const sample = async (label, next) => {
  const measurements = [];
  for (let trial = 0; trial < trials; trial += 1) {
    const started = performance.now();
    const read = await readWith(next);
    const ms = performance.now() - started;
    const bytes = read.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    if (bytes !== chunks * payload.byteLength) throw new Error(`${label} read ${bytes} bytes`);
    if (trial > 0) measurements.push(ms);
  }
  measurements.sort((left, right) => left - right);
  const medianMs = measurements[Math.floor(measurements.length / 2)];
  return {
    label,
    chunks,
    medianMs: Number(medianMs.toFixed(3)),
    usPerChunk: Number(((medianMs * 1000) / chunks).toFixed(3))
  };
};

const originalFetch = globalThis.fetch;
globalThis.fetch = mockedFetch;
try {
  const before = await sample("before", beforeNext);
  const afterNext = createAfterNext();
  const after = await sample("after", afterNext);
  afterNext.dispose();
  console.log(JSON.stringify({
    mode: "offline",
    runtime: process.version,
    bun: process.versions.bun ?? null,
    fetch: "mocked",
    before,
    after,
    usPerChunkDelta: Number((before.usPerChunk - after.usPerChunk).toFixed(3))
  }, null, 2));
} finally {
  globalThis.fetch = originalFetch;
}

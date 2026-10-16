const concat = (left: Uint8Array<ArrayBufferLike>, right: Uint8Array<ArrayBufferLike>) => {
  const out = new Uint8Array(left.length + right.length);
  out.set(left);
  out.set(right, left.length);
  return out;
};

export const encodeDockerStreamFrame = (type: 1 | 2, payload: Uint8Array): Uint8Array => {
  const frame = new Uint8Array(8 + payload.length);
  frame[0] = type;
  new DataView(frame.buffer).setUint32(4, payload.byteLength);
  frame.set(payload, 8);
  return frame;
};

export const readMultiplexedStream = async (
  chunks: AsyncIterable<Uint8Array>,
  maxBytes: number
): Promise<{ stdout: Uint8Array; stderr: Uint8Array; truncated: boolean }> => {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("Docker output cap must be a positive safe integer.");
  }
  const stdout: Uint8Array[] = [];
  const stderr: Uint8Array[] = [];
  let stdoutLen = 0;
  let stderrLen = 0;
  let pending = new Uint8Array();
  let truncated = false;

  const append = (target: Uint8Array[], used: number, payload: Uint8Array) => {
    const room = maxBytes - used;
    if (room <= 0) {
      truncated = true;
      return 0;
    }
    const slice = payload.length > room ? payload.subarray(0, room) : payload;
    if (slice.length < payload.length) truncated = true;
    if (slice.length) target.push(slice);
    return slice.length;
  };

  for await (const chunk of chunks) {
    pending = concat(pending, chunk);
    while (pending.length >= 8) {
      const size = new DataView(pending.buffer, pending.byteOffset, pending.byteLength).getUint32(4);
      if (!Number.isSafeInteger(size) || pending.length < 8 + size) break;
      const type = pending[0];
      const payload = pending.subarray(8, 8 + size);
      pending = pending.subarray(8 + size);
      if (type === 1) {
        if (stdoutLen >= maxBytes) truncated = true;
        else stdoutLen += append(stdout, stdoutLen, payload);
      } else if (type === 2) {
        if (stderrLen >= maxBytes) truncated = true;
        else stderrLen += append(stderr, stderrLen, payload);
      }
    }
    if (stdoutLen >= maxBytes && stderrLen >= maxBytes) break;
  }

  return {
    stdout: stdout.reduce(concat, new Uint8Array()),
    stderr: stderr.reduce(concat, new Uint8Array()),
    truncated
  };
};

export const decodeCappedText = (bytes: Uint8Array, maxBytes: number) => {
  const slice = bytes.length > maxBytes ? bytes.subarray(0, maxBytes) : bytes;
  return {
    text: new TextDecoder("utf-8", { fatal: false }).decode(slice),
    truncated: bytes.length > maxBytes
  };
};

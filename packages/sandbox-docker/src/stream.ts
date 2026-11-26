const concatMany = (chunks: readonly Uint8Array<ArrayBufferLike>[], totalLength: number): Uint8Array => {
  if (totalLength === 0) return new Uint8Array();
  if (chunks.length === 1) return new Uint8Array(chunks[0]!);
  const out = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
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
  let truncated = false;

  const header = new Uint8Array(8);
  const headerView = new DataView(header.buffer);
  let headerLen = 0;
  let frameType = 0;
  let frameRemaining = 0;

  const pushPayload = (type: number, slice: Uint8Array) => {
    if (type === 1) {
      const room = maxBytes - stdoutLen;
      if (room <= 0) {
        truncated = true;
        return;
      }
      const take = slice.byteLength > room ? slice.subarray(0, room) : slice;
      if (take.byteLength < slice.byteLength) truncated = true;
      if (take.byteLength > 0) {
        stdout.push(take.slice());
        stdoutLen += take.byteLength;
      }
    } else if (type === 2) {
      const room = maxBytes - stderrLen;
      if (room <= 0) {
        truncated = true;
        return;
      }
      const take = slice.byteLength > room ? slice.subarray(0, room) : slice;
      if (take.byteLength < slice.byteLength) truncated = true;
      if (take.byteLength > 0) {
        stderr.push(take.slice());
        stderrLen += take.byteLength;
      }
    }
  };

  for await (const chunk of chunks) {
    let offset = 0;
    while (offset < chunk.byteLength) {
      if (frameRemaining === 0) {
        const needed = 8 - headerLen;
        const copyLen = Math.min(needed, chunk.byteLength - offset);
        header.set(chunk.subarray(offset, offset + copyLen), headerLen);
        headerLen += copyLen;
        offset += copyLen;
        if (headerLen < 8) break;
        frameType = header[0] ?? 0;
        frameRemaining = headerView.getUint32(4);
        headerLen = 0;
        continue;
      }

      const take = Math.min(frameRemaining, chunk.byteLength - offset);
      pushPayload(frameType, chunk.subarray(offset, offset + take));
      frameRemaining -= take;
      offset += take;
    }
    if (stdoutLen >= maxBytes && stderrLen >= maxBytes) break;
  }

  return {
    stdout: concatMany(stdout, stdoutLen),
    stderr: concatMany(stderr, stderrLen),
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

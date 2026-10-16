import { SandboxError } from "./errors.js";

export interface TarEntry {
  path: string;
  type: "file" | "directory" | "symlink";
  content?: Uint8Array;
  linkTarget?: string;
  mode?: number;
  uid?: number;
  gid?: number;
}

const BLOCK = 512;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const octal = (value: number, length: number) => {
  const digits = Math.max(0, Math.floor(value)).toString(8).padStart(length - 1, "0").slice(-(length - 1));
  return encoder.encode(`${digits}\0`);
};

const writeString = (header: Uint8Array, offset: number, length: number, value: string) => {
  const bytes = encoder.encode(value);
  if (bytes.length >= length) {
    throw new SandboxError("TAR_PATH", `Tar path exceeds ${length - 1} bytes: ${value}`);
  }
  header.set(bytes, offset);
};

const checksum = (header: Uint8Array) => {
  let sum = 0;
  for (let index = 0; index < BLOCK; index += 1) {
    sum += index >= 148 && index < 156 ? 32 : header[index] ?? 0;
  }
  return sum;
};

const pad = (bytes: Uint8Array) => {
  const extra = (BLOCK - (bytes.length % BLOCK)) % BLOCK;
  if (extra === 0) return bytes;
  const out = new Uint8Array(bytes.length + extra);
  out.set(bytes);
  return out;
};

export const packTar = (entries: readonly TarEntry[]): Uint8Array => {
  const blocks: Uint8Array[] = [];
  for (const entry of entries) {
    const header = new Uint8Array(BLOCK);
    const content = entry.type === "file" ? entry.content ?? new Uint8Array() : new Uint8Array();
    writeString(header, 0, 100, entry.path);
    header.set(octal(entry.mode ?? (entry.type === "directory" ? 0o755 : 0o644), 8), 100);
    header.set(octal(entry.uid ?? 65534, 8), 108);
    header.set(octal(entry.gid ?? 65534, 8), 116);
    header.set(octal(content.byteLength, 12), 124);
    header.set(octal(0, 12), 136);
    header.set(encoder.encode("        "), 148);
    header[156] = encoder.encode(entry.type === "directory" ? "5" : entry.type === "symlink" ? "2" : "0")[0] ?? 0;
    if (entry.linkTarget) writeString(header, 157, 100, entry.linkTarget);
    writeString(header, 257, 6, "ustar");
    header.set(encoder.encode("00"), 263);
    const sum = checksum(header);
    header.set(encoder.encode(`${sum.toString(8).padStart(6, "0")}\0 `), 148);
    blocks.push(header, pad(content));
  }
  blocks.push(new Uint8Array(BLOCK * 2));
  const size = blocks.reduce((total, block) => total + block.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const block of blocks) {
    out.set(block, offset);
    offset += block.length;
  }
  return out;
};

const fieldText = (header: Uint8Array, offset: number, length: number) => {
  const field = header.subarray(offset, offset + length);
  const nul = field.indexOf(0);
  return decoder.decode(nul === -1 ? field : field.subarray(0, nul));
};

const readOctal = (header: Uint8Array, offset: number, length: number) => {
  const text = fieldText(header, offset, length).trim();
  if (!text) return 0;
  const value = Number.parseInt(text, 8);
  if (!Number.isFinite(value)) {
    throw new SandboxError("TAR_INVALID", "Tar header contains a non-octal numeric field.");
  }
  return value;
};

const readText = (header: Uint8Array, offset: number, length: number) => fieldText(header, offset, length);

const isZero = (header: Uint8Array) => header.every(byte => byte === 0);

export const unpackTar = (bytes: Uint8Array): TarEntry[] => {
  const entries: TarEntry[] = [];
  let offset = 0;
  while (offset + BLOCK <= bytes.length) {
    const header = bytes.subarray(offset, offset + BLOCK);
    offset += BLOCK;
    if (isZero(header)) break;
    const stored = readOctal(header, 148, 8);
    if (stored !== checksum(header)) {
      throw new SandboxError("TAR_INVALID", "Tar header checksum does not match.");
    }
    const name = readText(header, 0, 100);
    const prefix = readText(header, 345, 155);
    const path = prefix ? `${prefix}/${name}` : name;
    const typeFlag = String.fromCharCode(header[156] ?? 0);
    const size = readOctal(header, 124, 12);
    const content = bytes.subarray(offset, offset + size);
    offset += Math.ceil(size / BLOCK) * BLOCK;
    const type = typeFlag === "5" ? "directory" : typeFlag === "2" ? "symlink" : "file";
    entries.push({
      path: path.replace(/\/$/, ""),
      type,
      content: type === "file" ? content : undefined,
      linkTarget: type === "symlink" ? readText(header, 157, 100) : "",
      mode: readOctal(header, 100, 8),
      uid: readOctal(header, 108, 8),
      gid: readOctal(header, 116, 8)
    });
  }
  return entries;
};

export const stripTarRoot = (entries: readonly TarEntry[], rootName: string): TarEntry[] =>
  entries.flatMap(entry => {
    if (entry.path === rootName) return [];
    const prefix = `${rootName}/`;
    if (!entry.path.startsWith(prefix)) return [entry];
    return [{ ...entry, path: entry.path.slice(prefix.length) }];
  });

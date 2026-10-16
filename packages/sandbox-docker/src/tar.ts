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
const MAX_PATH_BYTES = 4096;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const octal = (value: number, length: number) => {
  const digits = Math.max(0, Math.floor(value)).toString(8).padStart(length - 1, "0").slice(-(length - 1));
  return encoder.encode(`${digits}\0`);
};

const writeField = (header: Uint8Array, offset: number, length: number, value: string) => {
  const bytes = encoder.encode(value);
  if (bytes.length > length) {
    throw new SandboxError("TAR_PATH", `Tar field exceeds ${length} bytes.`);
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

const finishHeader = (header: Uint8Array) => {
  const sum = checksum(header);
  header.set(encoder.encode(`${sum.toString(8).padStart(6, "0")}\0 `), 148);
  return header;
};

const headerShell = (name: string, size: number, typeFlag: string, prefix = "") => {
  const header = new Uint8Array(BLOCK);
  writeField(header, 0, 100, name);
  header.set(octal(typeFlag === "5" ? 0o755 : 0o644, 8), 100);
  header.set(octal(0, 8), 108);
  header.set(octal(0, 8), 116);
  header.set(octal(size, 12), 124);
  header.set(octal(0, 12), 136);
  header.set(encoder.encode("        "), 148);
  header[156] = encoder.encode(typeFlag)[0] ?? 0;
  writeField(header, 257, 6, "ustar");
  header.set(encoder.encode("00"), 263);
  if (prefix) writeField(header, 345, 155, prefix);
  return finishHeader(header);
};

const ustarSplit = (filePath: string): { name: string; prefix: string } | undefined => {
  if (encoder.encode(filePath).length <= 100) return { name: filePath, prefix: "" };
  let match: { name: string; prefix: string } | undefined;
  for (let index = 0; index < filePath.length; index += 1) {
    if (filePath[index] !== "/") continue;
    const prefix = filePath.slice(0, index);
    const name = filePath.slice(index + 1);
    if (!prefix || !name) continue;
    if (encoder.encode(prefix).length <= 155 && encoder.encode(name).length <= 100) match = { name, prefix };
  }
  return match;
};

const shortName = (filePath: string) => {
  const slash = filePath.lastIndexOf("/");
  const base = slash === -1 ? filePath : filePath.slice(slash + 1);
  return encoder.encode(base).length <= 100 ? base : "entry";
};

const paxPathRecord = (filePath: string) => {
  const payload = encoder.encode(` path=${filePath}\n`);
  let digits = 1;
  let total = digits + payload.length;
  while (String(total).length !== digits) {
    digits = String(total).length;
    total = digits + payload.length;
  }
  return encoder.encode(`${total} path=${filePath}\n`);
};

const paxBlocks = (filePath: string) => {
  const content = paxPathRecord(filePath);
  const label = `PaxHeaders.0/${shortName(filePath)}`;
  const header = headerShell(encoder.encode(label).length <= 100 ? label : "PaxHeaders.0/entry", content.byteLength, "x");
  return [header, pad(content)];
};

export const packTar = (entries: readonly TarEntry[]): Uint8Array => {
  const blocks: Uint8Array[] = [];
  for (const entry of entries) {
    if (encoder.encode(entry.path).length > MAX_PATH_BYTES) {
      throw new SandboxError("TAR_PATH", `Tar path exceeds ${MAX_PATH_BYTES} bytes.`);
    }
    if (entry.linkTarget && encoder.encode(entry.linkTarget).length > 100) {
      throw new SandboxError("TAR_PATH", "Tar link target exceeds 100 bytes.");
    }
    const split = ustarSplit(entry.path);
    if (!split) blocks.push(...paxBlocks(entry.path));
    const header = new Uint8Array(BLOCK);
    const content = entry.type === "file" ? entry.content ?? new Uint8Array() : new Uint8Array();
    writeField(header, 0, 100, split?.name ?? shortName(entry.path));
    header.set(octal(entry.mode ?? (entry.type === "directory" ? 0o755 : 0o644), 8), 100);
    header.set(octal(entry.uid ?? 65534, 8), 108);
    header.set(octal(entry.gid ?? 65534, 8), 116);
    header.set(octal(content.byteLength, 12), 124);
    header.set(octal(0, 12), 136);
    header.set(encoder.encode("        "), 148);
    header[156] = encoder.encode(entry.type === "directory" ? "5" : entry.type === "symlink" ? "2" : "0")[0] ?? 0;
    if (entry.linkTarget) writeField(header, 157, 100, entry.linkTarget);
    writeField(header, 257, 6, "ustar");
    header.set(encoder.encode("00"), 263);
    if (split?.prefix) writeField(header, 345, 155, split.prefix);
    blocks.push(finishHeader(header), pad(content));
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

const parsePax = (content: Uint8Array) => {
  const records = new Map<string, string>();
  let offset = 0;
  while (offset < content.length) {
    if (content[offset] === 0) break;
    const space = content.indexOf(0x20, offset);
    if (space <= offset) throw new SandboxError("TAR_INVALID", "Tar pax record is missing its length.");
    let length = 0;
    for (let index = offset; index < space; index += 1) {
      const digit = content[index] ?? 0;
      if (digit < 0x30 || digit > 0x39) throw new SandboxError("TAR_INVALID", "Tar pax record length is not decimal.");
      length = length * 10 + (digit - 0x30);
    }
    if (length < space - offset + 1 || offset + length > content.length) {
      throw new SandboxError("TAR_INVALID", "Tar pax record length is invalid.");
    }
    const record = content.subarray(offset, offset + length);
    const equals = record.indexOf(0x3d);
    if (equals === -1) throw new SandboxError("TAR_INVALID", "Tar pax record is missing a key.");
    const key = decoder.decode(record.subarray(space - offset + 1, equals));
    const end = record[record.length - 1] === 0x0a ? record.length - 1 : record.length;
    records.set(key, decoder.decode(record.subarray(equals + 1, end)));
    offset += length;
  }
  return records;
};

export const unpackTar = (bytes: Uint8Array): TarEntry[] => {
  const entries: TarEntry[] = [];
  let offset = 0;
  let extendedPath: string | undefined;
  while (offset + BLOCK <= bytes.length) {
    const header = bytes.subarray(offset, offset + BLOCK);
    offset += BLOCK;
    if (isZero(header)) break;
    const stored = readOctal(header, 148, 8);
    if (stored !== checksum(header)) {
      throw new SandboxError("TAR_INVALID", "Tar header checksum does not match.");
    }
    const typeFlag = String.fromCharCode(header[156] ?? 0);
    const size = readOctal(header, 124, 12);
    const content = bytes.subarray(offset, offset + size);
    offset += Math.ceil(size / BLOCK) * BLOCK;
    if (typeFlag === "x" || typeFlag === "g") {
      const records = parsePax(content);
      const extended = records.get("path");
      if (extended !== undefined) {
        if (encoder.encode(extended).length > MAX_PATH_BYTES) {
          throw new SandboxError("TAR_PATH", `Tar path exceeds ${MAX_PATH_BYTES} bytes.`);
        }
        extendedPath = extended;
      }
      continue;
    }
    const name = readText(header, 0, 100);
    const prefix = readText(header, 345, 155);
    const path = extendedPath ?? (prefix ? `${prefix}/${name}` : name);
    extendedPath = undefined;
    const type = typeFlag === "5" ? "directory" : typeFlag === "2" ? "symlink" : "file";
    entries.push({
      path: path.endsWith("/") ? path.slice(0, -1) : path,
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

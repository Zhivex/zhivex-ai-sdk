import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import path from "node:path";

import { redactTraceValue } from "./redact.js";
import { collectTraceRecords, type RawSpan, type TraceWarning } from "./spans.js";
import { buildTraceView, type TraceView } from "./view.js";

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 500;
const MAX_DEPTH = 4;
const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git", "dist"]);

export interface LoadTraceViewOptions {
  ledgerPath: string;
  spansPath?: string;
}

const isTraceFile = (name: string): boolean => name.endsWith(".json") || name.endsWith(".jsonl");

const pushRecords = (
  target: { ledgers: unknown[]; spans: RawSpan[] },
  warnings: TraceWarning[],
  filePath: string,
  value: unknown
) => {
  const collected = collectTraceRecords(redactTraceValue(value));
  if (!collected.recognized) {
    warnings.push({ path: filePath, message: "Unrecognized trace file." });
    return;
  }
  if (collected.ledgers.length === 0 && collected.spans.length === 0) {
    warnings.push({ path: filePath, message: "No ledger or span records." });
  }
  target.ledgers.push(...collected.ledgers);
  target.spans.push(...collected.spans);
};

const readTraceFile = async (
  filePath: string,
  target: { ledgers: unknown[]; spans: RawSpan[] },
  warnings: TraceWarning[]
) => {
  let bytes: Buffer;
  try {
    const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
    const handle = await open(filePath, flags);
    try {
      const info = await handle.stat();
      if (!info.isFile()) {
        warnings.push({ path: filePath, message: "Unreadable file." });
        return;
      }
      if (info.size > MAX_FILE_BYTES) {
        warnings.push({ path: filePath, message: "File exceeds 8 MiB and was skipped." });
        return;
      }
      bytes = await handle.readFile();
    } finally {
      await handle.close();
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    warnings.push({
      path: filePath,
      message: code === "ELOOP" ? "Refusing to follow a symlink." : "Unreadable file."
    });
    return;
  }
  if (bytes.byteLength > MAX_FILE_BYTES) {
    warnings.push({ path: filePath, message: "File exceeds 8 MiB and was skipped." });
    return;
  }
  const text = bytes.toString("utf8").replace(/^\uFEFF/, "");
  if (text.trim().length === 0) {
    warnings.push({ path: filePath, message: "Empty file." });
    return;
  }
  if (filePath.endsWith(".jsonl")) {
    let recognized = false;
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      if (line.trim().length === 0) continue;
      try {
        const collected = collectTraceRecords(redactTraceValue(JSON.parse(line) as unknown));
        if (!collected.recognized) {
          warnings.push({ path: filePath, message: `Unrecognized JSONL record on line ${index + 1}.` });
          continue;
        }
        recognized = true;
        target.ledgers.push(...collected.ledgers);
        target.spans.push(...collected.spans);
      } catch {
        warnings.push({ path: filePath, message: `Invalid JSON on line ${index + 1}.` });
      }
    }
    if (!recognized) warnings.push({ path: filePath, message: "No ledger or span records." });
    return;
  }
  try {
    pushRecords(target, warnings, filePath, JSON.parse(text) as unknown);
  } catch {
    warnings.push({ path: filePath, message: "Invalid JSON." });
  }
};

const collectFiles = async (
  root: string,
  warnings: TraceWarning[],
  depth = 0
): Promise<string[]> => {
  let stats;
  try {
    stats = await lstat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Trace path does not exist: ${root}`);
    }
    throw error;
  }
  if (stats.isSymbolicLink()) {
    warnings.push({ path: root, message: "Refusing to follow a symlink." });
    return [];
  }
  if (stats.isFile()) return isTraceFile(path.basename(root)) ? [root] : [];
  if (!stats.isDirectory()) {
    warnings.push({ path: root, message: "Path is not a file or directory." });
    return [];
  }
  if (depth > MAX_DEPTH) {
    warnings.push({ path: root, message: "Directory depth limit reached." });
    return [];
  }
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (files.length >= MAX_FILES) {
      warnings.push({ path: root, message: "File limit reached; some inputs were skipped." });
      break;
    }
    const entryPath = path.join(root, entry.name);
    if (entry.isSymbolicLink()) {
      warnings.push({ path: entryPath, message: "Refusing to follow a symlink." });
      continue;
    }
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      files.push(...await collectFiles(entryPath, warnings, depth + 1));
      continue;
    }
    if (entry.isFile() && isTraceFile(entry.name)) files.push(entryPath);
  }
  return files.slice(0, MAX_FILES);
};

const readInput = async (
  inputPath: string,
  target: { ledgers: unknown[]; spans: RawSpan[] },
  warnings: TraceWarning[]
) => {
  const files = await collectFiles(path.resolve(inputPath), warnings);
  if (files.length === 0 && warnings.every((warning) => !warning.message.includes("symlink"))) {
    const resolved = path.resolve(inputPath);
    let stats;
    try {
      stats = await lstat(resolved);
    } catch {
      stats = undefined;
    }
    if (stats?.isDirectory()) {
      warnings.push({ path: resolved, message: "No ledger or span files." });
    } else if (stats?.isFile()) {
      warnings.push({ path: resolved, message: "Unsupported file type. Use .json or .jsonl." });
    }
  }
  for (const file of files) await readTraceFile(file, target, warnings);
};

/** Read ledger JSON and span JSON/JSONL, then build a redacted view. */
export const loadTraceView = async (options: LoadTraceViewOptions): Promise<TraceView> => {
  const target = { ledgers: [] as unknown[], spans: [] as RawSpan[] };
  const warnings: TraceWarning[] = [];
  await readInput(options.ledgerPath, target, warnings);
  if (options.spansPath && path.resolve(options.spansPath) !== path.resolve(options.ledgerPath)) {
    await readInput(options.spansPath, target, warnings);
  }
  return buildTraceView({ ...target, warnings });
};

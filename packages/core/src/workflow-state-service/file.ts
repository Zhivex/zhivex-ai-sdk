import { promises as fs } from "node:fs";
import path from "node:path";
import { canonicalStoreFileStem, ensurePrivateDirectory, writePrivateFile } from "../store-security.js";
import { type WorkflowStateRecord, type WorkflowStateService } from "../workflow-state-contracts.js";
import {
  type WorkflowStateLookup,
  workflowStateParts,
  type FileWorkflowStateServiceOptions,
  normalizeWorkflowStateRecord,
  matchesWorkflowStateLookup,
  assertExpectedRevision,
  createRecord,
  cloneRecord,
  matchesListInput,
  workflowStateKey,
  type FileWorkflowStateStorePruneOptions,
  type FileWorkflowStateStorePruneResult
} from "./shared.js";

const fileNameForWorkflowState = (input: WorkflowStateLookup): string =>
  `${canonicalStoreFileStem("workflow-state", workflowStateParts(input))}.json`;

const legacyFileNameForWorkflowState = (input: WorkflowStateLookup): string =>
  workflowStateParts(input).map((part) => encodeURIComponent(part)).join("__") + ".json";

export const createFileWorkflowStateService = (options: FileWorkflowStateServiceOptions): WorkflowStateService => {
  const filePath = (input: WorkflowStateLookup) => path.join(options.directory, fileNameForWorkflowState(input));
  const legacyFilePath = (input: WorkflowStateLookup) =>
    path.join(options.directory, legacyFileNameForWorkflowState(input));
  const load = async (input: WorkflowStateLookup): Promise<WorkflowStateRecord | undefined> => {
    for (const candidate of [filePath(input), legacyFilePath(input)]) {
      try {
        const record = normalizeWorkflowStateRecord(
          JSON.parse(await fs.readFile(candidate, "utf8")) as WorkflowStateRecord
        );
        if (matchesWorkflowStateLookup(record, input)) {
          return record;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
    }
    return undefined;
  };
  return {
    async saveWorkflowState(input) {
      const existing = await load(input);
      assertExpectedRevision(existing, input.expectedRevision);
      const record = createRecord(input, existing);
      await ensurePrivateDirectory(options.directory);
      await writePrivateFile(filePath(input), JSON.stringify(record, null, 2));
      try {
        const legacy = normalizeWorkflowStateRecord(
          JSON.parse(await fs.readFile(legacyFilePath(input), "utf8")) as WorkflowStateRecord
        );
        if (matchesWorkflowStateLookup(legacy, input)) {
          await fs.unlink(legacyFilePath(input));
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
      return cloneRecord(record);
    },
    loadWorkflowState(input) {
      return load(input);
    },
    async listWorkflowStates(input) {
      let entries: string[];
      try {
        entries = await fs.readdir(options.directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return [];
        }
        throw error;
      }
      const records = new Map<string, WorkflowStateRecord>();
      for (const entry of entries) {
        if (!entry.endsWith(".json")) {
          continue;
        }
        const record = normalizeWorkflowStateRecord(JSON.parse(await fs.readFile(path.join(options.directory, entry), "utf8")) as WorkflowStateRecord);
        if (matchesListInput(record, input)) {
          const key = workflowStateKey(record);
          if (!records.has(key) || entry === fileNameForWorkflowState(record)) {
            records.set(key, cloneRecord(record));
          }
        }
      }
      return [...records.values()].sort(
        (left, right) => left.updatedAt - right.updatedAt || left.workflowKey.localeCompare(right.workflowKey)
      );
    },
    async deleteWorkflowState(input) {
      await fs.unlink(filePath(input)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") {
          throw error;
        }
      });
      try {
        const legacy = normalizeWorkflowStateRecord(
          JSON.parse(await fs.readFile(legacyFilePath(input), "utf8")) as WorkflowStateRecord
        );
        if (matchesWorkflowStateLookup(legacy, input)) {
          await fs.unlink(legacyFilePath(input));
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
    }
  };
};

export const pruneFileWorkflowStateStore = async (
  options: FileWorkflowStateStorePruneOptions
): Promise<FileWorkflowStateStorePruneResult> => {
  const now = options.now ?? Date.now();
  const dryRun = options.dryRun ?? true;
  let entries: string[];
  try {
    entries = await fs.readdir(options.directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { directory: options.directory, dryRun, deletedWorkflowStateKeys: [], keptWorkflowStateKeys: [] };
    }
    throw error;
  }

  const records = new Map<string, { filePaths: string[]; key: string; updatedAt: number }>();
  for (const entry of entries) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    const filePath = path.join(options.directory, entry);
    const record = normalizeWorkflowStateRecord(JSON.parse(await fs.readFile(filePath, "utf8")) as WorkflowStateRecord);
    const key = workflowStateKey(record);
    const existing = records.get(key);
    records.set(key, {
      filePaths: [...(existing?.filePaths ?? []), filePath],
      key,
      updatedAt: entry === fileNameForWorkflowState(record) || !existing ? record.updatedAt : existing.updatedAt
    });
  }

  const sorted = [...records.values()].sort(
    (left, right) => right.updatedAt - left.updatedAt || left.key.localeCompare(right.key)
  );
  const keepByCount = new Set(
    options.keepLast === undefined ? [] : sorted.slice(0, Math.max(0, options.keepLast)).map((record) => record.key)
  );
  const shouldDelete = (record: { key: string; updatedAt: number }) =>
    !keepByCount.has(record.key) &&
    (options.olderThanMs !== undefined ? now - record.updatedAt > options.olderThanMs : options.keepLast !== undefined);
  const deleted = sorted.filter(shouldDelete);

  if (!dryRun) {
    for (const record of deleted) {
      for (const filePath of record.filePaths) {
        await fs.unlink(filePath);
      }
    }
  }

  return {
    directory: options.directory,
    dryRun,
    deletedWorkflowStateKeys: deleted.map((record) => record.key),
    keptWorkflowStateKeys: sorted.filter((record) => !shouldDelete(record)).map((record) => record.key)
  };
};

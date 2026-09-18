import { type WorkflowStateRecord, type WorkflowStateService } from "../workflow-state-contracts.js";
import {
  workflowStateKey,
  assertExpectedRevision,
  createRecord,
  cloneRecord,
  matchesListInput
} from "./shared.js";

export const createInMemoryWorkflowStateService = (): WorkflowStateService => {
  const states = new Map<string, WorkflowStateRecord>();
  return {
    saveWorkflowState(input) {
      const existing = states.get(workflowStateKey(input));
      assertExpectedRevision(existing, input.expectedRevision);
      const record = createRecord(input, existing);
      states.set(workflowStateKey(input), cloneRecord(record));
      return cloneRecord(record);
    },
    loadWorkflowState(input) {
      const record = states.get(workflowStateKey(input));
      return record ? cloneRecord(record) : undefined;
    },
    listWorkflowStates(input) {
      return [...states.values()]
        .filter((record) => matchesListInput(record, input))
        .sort((left, right) => left.updatedAt - right.updatedAt || left.workflowKey.localeCompare(right.workflowKey))
        .map(cloneRecord);
    },
    deleteWorkflowState(input) {
      states.delete(workflowStateKey(input));
    }
  };
};

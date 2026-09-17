// Derived from ZHX-EXP-001 v0.3; original baseline remains unchanged.
export function decide(results: any[], config: any, caseId: string) {
  const applied = results.find(r => r.toolName === 'apply_change');
  const read = results.find(r => r.toolName === 'read_order');
  if (applied?.isError && applied.error?.message === 'experiment_denied') return {text:JSON.stringify({order_id:config.order_id,status:'denied',changed:false})};
  if (applied?.isError) return {text:JSON.stringify({order_id:config.order_id,status:'tool_error',error:applied.error})};
  if (applied) return { text: JSON.stringify(applied.output) };
  return { name: read ? 'apply_change' : 'read_order', args: read
    ? { operation_id: caseId, order_id: config.order_id, expected_version: config.version, target_status: config.target_status }
    : { order_id: config.order_id } };
}

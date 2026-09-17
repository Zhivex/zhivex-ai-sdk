// Derived from ZHX-EXP-001 v0.3; original baseline remains unchanged.
// Independent oracle: no imports from either candidate.
export function evaluate(r:any) {
 const failures:string[]=[];const check=(v:any,s:string)=>{if(!v)failures.push(s)};
 check(['A3','A4'].includes(r.scenario),'unknown_scenario');
 check(!r.error,'runner_error');
 check(r.ready?.status==='waiting_approval'&&r.ready?.pending===1,'missing_approval');
 check(r.before?.attempts===0&&r.before?.effects===0,'early_effect');
 check(r.restart?.signal==='SIGKILL'&&Number.isInteger(r.restart?.firstPid)&&Number.isInteger(r.restart?.secondPid)&&r.restart.firstPid!==r.restart.secondPid,'restart_not_proven');
 check(r.restart?.firstPid===r.ready?.pid&&r.restart?.secondPid===r.result?.pid,'worker_identity');
 check(r.restart?.ready?.runId===r.ready?.runId&&r.result?.runId===r.ready?.runId,'run_identity');
 check(r.ledger?.unauthorized===0&&r.ledger?.invalid===0,'invalid_attempt');
 check(r.ledger?.order_id===r.fixture.order_id,'wrong_order');
 let output:any;try{output=JSON.parse(r.result?.output)}catch{}
 const completed=r.result?.event==='result'&&r.result?.status==='completed'&&r.result?.persistedStatus==='completed';
 const reconciliation=completed && r.result?.taskOutcome?.status==='needs_reconciliation';
 const blocked=r.scenario==='A4' && (reconciliation || (r.result?.event==='error'&&r.result?.name==='ConflictError'&&r.result?.persistedStatus==='running') || (r.result?.event==='result'&&r.result?.status==='waiting_approval'&&r.result?.persistedStatus==='waiting_approval'&&r.result?.pending===1));
 if(r.scenario==='A3') {
  check(r.restart?.ready?.status==='waiting_approval'&&r.restart?.ready?.pending===1,'lost_denial_checkpoint');
  check(r.ledger?.attempts===0&&r.ledger?.effects===0&&r.ledger?.approved===0,'denial_mutated');
  check(r.ledger?.version===r.fixture.version&&r.ledger?.status==='pending','denial_changed_order');
  check(completed,'denial_not_terminal');
  check(output?.order_id===r.fixture.order_id&&output?.status==='denied'&&output?.changed===false,'false_denial_report');
 } else {
  check(r.barrier?.responseHeld===true&&r.barrier?.ledger?.effects===1&&r.barrier?.ledger?.attempts===1,'missing_effect_barrier');
  check(r.barrier?.stored?.runId===r.ready?.runId&&r.barrier?.stored?.appliedResults===0&&['running','waiting_approval'].includes(r.barrier?.stored?.status),'effect_already_checkpointed');
  check(r.restart?.ready?.appliedResults===0&&r.restart?.ready?.status!=='completed','resume_checkpoint_invalid');
  check(r.ledger?.effects===1&&r.ledger?.approved===1&&r.ledger?.attempts>=1,'wrong_effect_count');
  check(r.ledger?.version===r.fixture.version+1&&r.ledger?.status===r.fixture.target_status,'wrong_effect');
  check(completed||blocked,'unclassified_recovery_failure');
  if(completed&&!blocked)check(output?.order_id===r.fixture.order_id&&output?.version===r.fixture.version+1&&output?.status===r.fixture.target_status,'false_recovery_report');
 }
 const valid=failures.length===0;
 return {passed:valid&&completed&&!blocked,validObservation:valid,recovered:r.scenario==='A4'&&valid&&completed&&!blocked,blocked:Boolean(valid&&blocked),failures,duplicateToolAttempts:Math.max(0,(r.ledger?.attempts??0)-1)};
}

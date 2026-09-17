// Derived from ZHX-EXP-001 v0.3; original baseline remains unchanged.
import { Database } from 'bun:sqlite';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { evaluate } from './evaluator';
const root = import.meta.dir;
const candidate = process.env.CANDIDATE ?? 'zhivex';
if (!['zhivex','langgraph'].includes(candidate)) throw new Error('Unknown candidate');
const node = Bun.which('node'); if(!node) throw new Error('Node required');
const directory = join(root, 'runs', candidate + '-' + new Date().toISOString().replaceAll(':', '-'));
await mkdir(directory, { recursive: true });
const db = new Database(join(directory, 'effects.sqlite'));
db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE orders (id TEXT PRIMARY KEY, order_id TEXT, version INTEGER, status TEXT, approved INTEGER DEFAULT 0, effects INTEGER DEFAULT 0, attempts INTEGER DEFAULT 0, unauthorized INTEGER DEFAULT 0, invalid INTEGER DEFAULT 0); CREATE TABLE events (id INTEGER PRIMARY KEY, case_id TEXT, kind TEXT, body TEXT, time INTEGER);');
const event = (id: string, kind: string, body: any) => db.query('INSERT INTO events(case_id,kind,body,time) VALUES(?,?,?,?)').run(id, kind, JSON.stringify(body), Date.now());
const get = (id: string): any => db.query('SELECT * FROM orders WHERE id=?').get(id);
const apply = db.transaction((id: string, args: any) => {
  const row = get(id);
  db.query('UPDATE orders SET attempts=attempts+1 WHERE id=?').run(id);
  event(id, 'tool_attempt', args);
  if (!row.approved) { db.query('UPDATE orders SET unauthorized=unauthorized+1 WHERE id=?').run(id); return { error: 'approval_required' }; }
  if (args.operation_id !== id || args.order_id !== row.order_id || args.target_status !== 'reviewed' || args.expected_version !== row.version - row.effects) {
    db.query('UPDATE orders SET invalid=invalid+1 WHERE id=?').run(id); return { error: 'invalid_arguments' };
  }
  if (!row.effects) { db.query("UPDATE orders SET effects=1, version=version+1, status='reviewed' WHERE id=?").run(id); event(id, 'effect_committed', args); }
  const changed = get(id); return { order_id: changed.order_id, version: changed.version, status: changed.status };
});
const barriers=new Map<string,{reached:()=>void,release:()=>void,promise:Promise<void>,hold:Promise<void>}>();
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
  const id = new URL(req.url).pathname.slice(1);
  if (!get(id)) return Response.json({ error: 'unknown_order' }, { status: 404 });
  if (req.method === 'GET') { const r = get(id); return Response.json({ order_id: r.order_id, version: r.version, status: r.status }); }
  if (req.method !== 'POST') return new Response('', { status: 405 });
  const r = apply(id, await req.json());
  const barrier=barriers.get(id);
  if(barrier && get(id).attempts===1 && !r.error) {event(id,'response_held',true);barrier.reached();await barrier.hold;}
  return Response.json(r, { status: r.error ? 409 : 200 });
} });
function worker(dir: string, id: string, mode: string) {
  const child = spawn(node!, [join(root, 'dist', candidate === 'zhivex' ? 'worker.js' : 'langgraph-worker.js'), dir, `http://127.0.0.1:${server.port}`, id, mode], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH, BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' } });
  const queue: any[] = []; let listener: ((v: any) => void) | undefined; let stderr = ''; let ended = false;
  const deliver = (value: any) => { if (listener) { const fn = listener; listener = undefined; fn(value); } else queue.push(value); };
  createInterface({ input: child.stdout }).on('line', line => { try { deliver(JSON.parse(line)); } catch { deliver({ event: 'error', message: line }); } });
  child.stderr.on('data', b => stderr += b);
  const closed = new Promise<any>(resolve => child.on('close', (code, signal) => { ended = true; deliver({ event: 'closed', code, signal, stderr }); resolve({ code, signal }); }));
  return { child, closed, next: () => new Promise<any>((resolve, reject) => {
    if (queue.length) return resolve(queue.shift());
    if (ended) return reject(new Error(stderr || 'worker exited'));
    const timer = setTimeout(() => { listener = undefined; child.kill('SIGKILL'); reject(new Error('worker_timeout')); }, 15000);
    listener = value => { clearTimeout(timer); resolve(value); };
  }), send: (command: string) => child.stdin.write(JSON.stringify({ command }) + '\n') };
}
const results: any[] = [];
try {
  const count = Number(process.env.CASES ?? 10), repetitions = Number(process.env.REPETITIONS ?? 3);
  if (!Number.isInteger(count) || count < 1 || count > 10 || !Number.isInteger(repetitions) || repetitions < 1 || repetitions > 3) throw new Error('Invalid matrix size');
  for (let c=0; c<count; c++) for(let rep=0; rep<repetitions; rep++) for(const scenario of ['A3','A4']) {
    const id = `${scenario}-${c}-${rep}`, dir = join(directory, id);
    await mkdir(dir); const fixture = { order_id: `order-${c}`, version: c+1, target_status: 'reviewed' };
    await Bun.write(join(dir, 'case.json'), JSON.stringify(fixture));
    db.query('INSERT INTO orders(id,order_id,version,status) VALUES(?,?,?,?)').run(id, fixture.order_id, fixture.version, 'pending');
    const run: any = { id, candidate, scenario, repetition: rep, fixture, mode: 'offline', costUsd: null, costReason: 'synthetic_model', usageSynthetic: true };
    let w = worker(dir, id, 'start');
    try {
      run.ready = await w.next(); run.before = get(id);
      if (run.ready.event !== 'ready') throw new Error(JSON.stringify(run.ready));
      if (scenario === 'A3') {
        const firstPid = w.child.pid; w.child.kill('SIGKILL'); const exit = await w.closed;
        const start = performance.now(); w = worker(dir, id, 'resume'); const ready = await w.next();
        run.restart = { firstPid, secondPid: w.child.pid, signal: exit.signal, ready, loadMs: performance.now()-start };
        if (ready.event !== 'ready') throw new Error(JSON.stringify(ready));
      }
      await new Promise(resolve => setTimeout(resolve, 10));
      if(scenario==='A3') {
        event(id,'controller_denial',false);w.send('deny');run.result=await w.next();
      } else {
        let reached!:()=>void,release!:()=>void;
        const promise=new Promise<void>(r=>reached=r),hold=new Promise<void>(r=>release=r);
        barriers.set(id,{reached,release,promise,hold});
        db.query('UPDATE orders SET approved=1 WHERE id=?').run(id);event(id,'controller_approval',true);
        w.send('approve');
        let timer:any;
        try {await Promise.race([promise,new Promise((_,reject)=>timer=setTimeout(()=>reject(new Error('barrier_timeout')),15000))]);} finally {clearTimeout(timer);}
        // Inspect the durable store while the original worker is blocked awaiting HTTP.
        const inspector=worker(dir,id,'inspect');const stored=await inspector.next();await inspector.closed;
        run.barrier={responseHeld:true,ledger:get(id),stored,time:Date.now()};
        if(stored.event!=='ready'||stored.appliedResults!==0||stored.status==='completed') throw new Error('Barrier checkpoint verification failed');
        const firstPid=w.child.pid;w.child.kill('SIGKILL');const exit=await w.closed;
        event(id,'worker_killed',{pid:firstPid,signal:exit.signal});
        release();barriers.delete(id);
        w=worker(dir,id,'resume');const ready=await w.next();
        run.restart={firstPid,secondPid:w.child.pid,signal:exit.signal,ready};
        if(ready.event!=='ready')throw new Error(JSON.stringify(ready));
        event(id,'recovery_requested',true);w.send('recover');run.recoveryAttempts=[await w.next()];
        // Bounded retry only for the native worker-lease conflict; never rewrite stored state.
        if(run.recoveryAttempts[0].event==='error' && run.recoveryAttempts[0].name==='ConflictError') {
          await new Promise(r=>setTimeout(r,2200));
          event(id,'recovery_retry_after_lease',true);w.send('recover');run.recoveryAttempts.push(await w.next());
        }
        run.beforeReconciliation=run.recoveryAttempts.at(-1);
        if(run.beforeReconciliation.taskOutcome?.status !== 'needs_reconciliation') throw new Error('Missing typed pending task outcome');
        w.send('reconcile');run.result=await w.next();
        if(run.result.taskOutcome?.status !== 'resolved') throw new Error('Task did not resolve after evidence');
      }
      w.send('exit'); await w.closed;
    } catch(e: any) { run.error = e.message; w.child.kill('SIGKILL'); await w.closed; barriers.get(id)?.release();barriers.delete(id); }
    run.ledger = get(id); run.evaluation = evaluate(run); results.push(run);
    await Bun.write(join(directory,'results.json'), JSON.stringify(results,null,2));
  }
  const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
  const artifact = join(root,'artifacts/zhivex-ai-core-1.17.0.tgz');
  const manifest = { protocol: 'ZHX-EXP-001 v0.3 / A3 denial and A4 uncertain effect window', candidate, leasePolicy:candidate==='zhivex'?{ttlMs:2000,heartbeatMs:500}:null,recoveryPolicy:'native resume then externally verified reconciliation; at most one retry after 2200ms on lease conflict',workerRuntime: (await Bun.$`${node} --version`.text()).trim(), dependencies: JSON.parse(await readFile(join(root,'package.json'),'utf8')).dependencies, baselineSourceSha: '6577e2aefc0d80ebf1e996a656508a766b508734', sourceSha: process.env.SOURCE_SHA, modifiedWorkingTree: true, artifact:'source-built core 1.17.0, not registry-certified', artifactSha256:sha256(await readFile(artifact)), bun:Bun.version, platform:process.platform, arch:process.arch, store:candidate === 'zhivex' ? 'SDK FileAgentRunStore; external effects SQLite WAL/FULL' : 'Official SqliteSaver WAL/FULL sync durability; external effects SQLite WAL/FULL', model:'deterministic-orders-v1', network:'loopback only; no provider credentials', count, repetitions, codeHashes:Object.fromEntries(await Promise.all(['runner.ts','worker.ts','fixture.ts','evaluator.ts','bun.lock','dist/worker.js'].map(async f=>[f,sha256(await readFile(join(root,f)))]))) };
  const summary = { total:results.length, passed:results.filter(r=>r.evaluation.passed).length, blocked:results.filter(r=>r.evaluation.blocked).length,failed:results.filter(r=>!r.evaluation.passed&&!r.evaluation.blocked).length, byScenario:Object.fromEntries(['A3','A4'].map(s=>{const rs=results.filter(r=>r.scenario===s);return [s,{total:rs.length,passed:rs.filter(r=>r.evaluation.passed).length,toolAttempts:rs.reduce((n,r)=>n+r.ledger.attempts,0),effects:rs.reduce((n,r)=>n+r.ledger.effects,0),recovered:rs.filter(r=>r.evaluation.recovered).length,blocked:rs.filter(r=>r.evaluation.blocked).length,duplicateToolAttempts:rs.reduce((n,r)=>n+r.evaluation.duplicateToolAttempts,0)}]})), limitations:['Offline fixture; no model-quality or monetary-cost claim','Common idempotent effect service protects effects; count tool attempts separately','A4 holds HTTP response after durable effect; not power loss or concurrent workers','A4 reported separately; blocked recovery is not task success','Routing and live models not executed','Different stores and integration APIs; no performance ranking'] };
  await Bun.write(join(directory,'manifest.json'),JSON.stringify(manifest,null,2));
  await Bun.write(join(directory,'summary.json'),JSON.stringify(summary,null,2));
  await Bun.write(join(root,`latest-${candidate}.json`),JSON.stringify({directory,summary},null,2));
  console.log(JSON.stringify({directory,summary},null,2));
  if(summary.failed) process.exitCode=1;
} finally { server.stop(true); db.close(); }

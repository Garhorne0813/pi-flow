import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
import {PostgresStore} from '../src/store.js';import {HarnessService,authorizedRun} from '../src/service.js';import {AgentConfig,id} from '../src/domain.js';
test('per-Run authorization retains ancestor cancellation and expired identity checks',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const store=new PostgresStore(process.env.TEST_DATABASE_URL!),actor={tenantId:'ancestry-'+id(),userId:'u',admin:true};
 try {
  await store.pool.query((await readFile('migrations/001_initial.sql','utf8'))+(await readFile('migrations/003_runs_sessions_events.sql','utf8')));
  const svc=new HarnessService(store,[],['default']),av=await svc.publish(actor,AgentConfig.parse({name:'a',systemPrompt:'t',model:{provider:'demo',modelId:'demo'},tools:[],skillBundle:'default'})),w=await svc.createWorkspace(actor,'ancestry');
  const parentSession=await svc.createSession(actor,w.id,av.id),childSession=await svc.createSession(actor,w.id,av.id),parent=await svc.submit(actor,parentSession.id,'parent'),child=await svc.submit(actor,childSession.id,'child');
  await store.tx(actor.tenantId,s=>{s.runs[child.id]!.parentRunId=parent.id;s.runs[parent.id]!.cancelRequested=true;});
  await assert.rejects(store.runTx(actor.tenantId,child.id,s=>authorizedRun(s,s.runs[child.id]!)),{code:'RUN_CANCELLED'});
  await store.tx(actor.tenantId,s=>{delete s.runs[parent.id]!.cancelRequested;s.runs[parent.id]!.actor.expiresAt=Date.now()-1000;});
  await assert.rejects(store.runTx(actor.tenantId,child.id,s=>authorizedRun(s,s.runs[child.id]!)),{code:'ACTOR_TOKEN_EXPIRED'});
 }finally{await store.pool.query('DELETE FROM harness_tenants WHERE tenant_id=$1',[actor.tenantId]);await store.close();}
});

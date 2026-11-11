import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { evalFixture,databaseUrl } from "./eval-fixture.js";
import { EvalService } from "../src/evals/service.js";
import { Fault } from "../src/domain/model.js";
if(process.env.REQUIRE_POSTGRES_TESTS==="true" && !databaseUrl)throw new Error("TEST_DATABASE_URL required");
test("eval PostgreSQL migration rollback, dataset conflicts, immutable versions and composite user FKs",{skip:!databaseUrl},async()=>{
 const f=await evalFixture();try{
  await f.pool.query("INSERT INTO personal_users(id,issuer,subject,enabled) VALUES('00000000-0000-4000-8000-000000000001','test','00000000-0000-4000-8000-000000000001',true),('00000000-0000-4000-8000-000000000002','test','00000000-0000-4000-8000-000000000002',true)");
  const service=new EvalService(f.store,async()=>{}),a={tenantId:"00000000-0000-4000-8000-000000000001",userId:"00000000-0000-4000-8000-000000000001",admin:true};
  const s=await service.createSuite(a,{name:"suite",cases:[{caseId:"c",inputs:"hi",graders:[{id:"g",type:"exact",expected:"hi"}]}]});
  const results=await Promise.allSettled([f.store.publish("00000000-0000-4000-8000-000000000001",s.id,1),f.store.publish("00000000-0000-4000-8000-000000000001",s.id,1)]);
  assert.equal(results.filter(r=>r.status==="fulfilled").length,1);
  const v=await f.store.version("00000000-0000-4000-8000-000000000001",s.id,1);assert.equal(v.version,1);
  await assert.rejects(f.store.version("00000000-0000-4000-8000-000000000002",s.id,1),e=>e instanceof Fault && e.status===404);
  assert.equal((await f.store.cases("00000000-0000-4000-8000-000000000001",s.id,1,{offset:0,limit:1}))[0].inputs,"hi");
  await f.pool.query("INSERT INTO personal_user_state(user_id,state) VALUES('00000000-0000-4000-8000-000000000002','{}')");
  await assert.rejects(f.pool.query("INSERT INTO personal_eval_suite_versions(user_id,suite_id,version,data) VALUES('00000000-0000-4000-8000-000000000002',$1,1,'{}')",[s.id]),/foreign key/);
  const c=await f.pool.connect();try{await c.query("BEGIN");await c.query("DROP TABLE personal_eval_sandbox_leases");await c.query("UPDATE personal_schema SET version=13");await c.query(await readFile("migrations/016_personal_evaluations.sql","utf8"));await c.query("ROLLBACK");}finally{c.release();}
  assert.equal((await f.pool.query("SELECT version FROM personal_schema")).rows[0].version,14);
  assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM personal_sessions")).rows[0].n,0);
 }finally{await f.close();}
});

// Main API runtime with an injected public model; exercises commit/reload/privacy.
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createPrototypeExperience} from '../server.mjs';
import {createMansionFixture} from '../fixtures/mansion-fixture.mjs';
const base=resolve('.tmp/prototype');mkdirSync(base,{recursive:true});const dir=mkdtempSync(join(base,'mansion-flow-'));
const checks=[];let calls=0,turns=0,experience;
const options={stateFile:join(dir,'state.json'),configLoader:()=>({llm:{baseUrl:'https://fixture.invalid/v1',model:'fixture',apiKey:'synthetic'}}),fetchImpl:async(_url,init)=>{
 calls++;const body=JSON.parse(init.body);assert.equal(body.stream,true);assert(!('max_output_tokens' in body));const input=JSON.parse(body.input.at(-1).content);let output;
 if(!input.observation)output=createMansionFixture();
 else{
  turns++;const o=input.observation;assert(input.initialMemories.every(m=>m.actorId===o.actorId));
  if(o.actorId==='xu'){assert.equal(o.story.statements[0].text,'你见过那封旧信吗？');assert(!JSON.stringify(input).includes('从未告诉许遥'));assert(!JSON.stringify(input).includes('你曾经撕掉'));}
  const action=turns===1?{type:'speak',text:'你见过那封旧信吗？'}:turns===2?{type:'speak',text:'我只见过有人移动文件夹，没有看清是谁。'}:{type:'inspect',clueId:'folded-note'};
  output={observationMinute:o.worldMinute,action,reason:'我根据在场信息作出这个选择。',memory:turns===1?'我问起了旧信。':turns===2?'有人问旧信，我说出了看见的事情。':'我检查了眼前的便签。'};
 }
 return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(output)}]}]});
}};
async function check(name,fn){try{await fn();checks.push({name,pass:true});}catch(error){checks.push({name,pass:false,error:error.message});}}
try{
 experience=createPrototypeExperience(options);
 await check('same creation flow accepts a generated indoor story at paused minute zero',async()=>{const r=await experience.worldStep({description:'公开的原创山庄片段'});assert.equal(r.ok,true);assert.equal(r.state.world,null);assert.equal(experience.control({type:'world-accept',draftId:r.state.creation.draft.id}).ok,true);const s=experience.state();assert.equal(s.worldMinute,0);assert.equal(s.paused,true);assert.equal(s.world.story.conversations.length,0);assert.equal(s.scene.document.objects.filter(o=>o.kind==='room').length,4);assert.equal(s.actors.lin.totalMemories,0);});
 await check('speaker commits a real transcript and owner memory atomically',async()=>{const r=await experience.actorStep({actorId:'lin'});assert.equal(r.ok,true);assert.equal(r.state.worldMinute,1);assert.equal(r.state.actors.lin.totalMemories,1);assert.deepEqual(r.state.world.story.conversations[0].listeners,['xu']);assert.equal(r.state.observations.wen.story.statements.length,0);});
 await check('listener next prompt can reply to received speech without receiving other secrets',async()=>{const r=await experience.actorStep({actorId:'xu'});assert.equal(r.ok,true);assert.equal(r.state.worldMinute,2);assert.equal(r.state.world.story.conversations.length,2);assert.equal(r.state.observations.lin.story.statements[1].speakerId,'xu');assert.equal(r.state.actors.xu.totalMemories,1);});
 await check('model inspection produces private discovery with successful outcome',async()=>{const r=await experience.actorStep({actorId:'lin'});assert.equal(r.ok,true);assert.equal(r.state.worldMinute,3);assert.equal(r.state.observations.lin.story.knownClues[0].id,'folded-note');assert.equal(r.state.observations.xu.story.knownClues.length,0);assert.equal(r.state.actors.lin.lastDecision.outcome.ok,true);});
 await check('reload preserves story, three lived rounds and valid personal ledgers without model calls',()=>{const before=experience.state(),count=calls;experience.close();experience=createPrototypeExperience(options);const after=experience.state();assert.equal(after.instanceId,before.instanceId);assert.equal(after.worldMinute,3);assert.deepEqual(after.world,before.world);assert.deepEqual(after.actors,before.actors);assert.equal(after.autonomy.waitingReason,null);assert.equal(calls,count);});
}finally{experience?.close();rmSync(dir,{recursive:true,force:true});}
const summary={checks:checks.length,passed:checks.filter(c=>c.pass).length,injectedCalls:calls,realRequests:0,privateConfigReads:0,browserRuns:0};writeFileSync(join(base,'mansion-flow-observation.json'),JSON.stringify({summary,checks},null,2)+'\n');console.log(JSON.stringify({summary,failures:checks.filter(c=>!c.pass)},null,2));if(summary.checks!==summary.passed)process.exitCode=1;

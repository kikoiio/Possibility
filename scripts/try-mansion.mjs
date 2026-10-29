// Explicit public smoke run through the same local API used by the UI.
// It makes one fresh genesis request, confirms it, then requests two resident turns.
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {MANSION_DESCRIPTION} from '../fixtures/mansion-fixture.mjs';
const base='http://127.0.0.1:5175',folder=resolve('.tmp/prototype');mkdirSync(folder,{recursive:true});
const proof={startedAt:new Date().toISOString(),source:'fresh-public-description-through-main-api',description:MANSION_DESCRIPTION,realRequests:0,replayed:false,stages:[]};
const save=()=>writeFileSync(join(folder,'mansion-live-proof.json'),JSON.stringify(proof,null,2)+'\n');
const state=async()=>await(await fetch(base+'/api/state')).json();
async function request(path,body,{model=false}={}){
 const started=performance.now();if(model)proof.realRequests++;save();
 const response=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json',accept:model?'text/event-stream':'application/json'},body:JSON.stringify(body)});
 if(!response.ok)throw Error('HTTP '+response.status);
 if(!model)return response.json();
 let buffer='',lastLog=0,result=null,progress=null;const decoder=new TextDecoder();
 for await(const chunk of response.body){buffer+=decoder.decode(chunk,{stream:true});let end;while((end=buffer.indexOf('\n\n'))>=0){const frame=buffer.slice(0,end);buffer=buffer.slice(end+2);const type=frame.match(/^event: (.+)$/m)?.[1],raw=frame.match(/^data: (.+)$/m)?.[1];if(!raw)continue;const data=JSON.parse(raw);if(type==='progress'){progress=data;if(performance.now()-lastLog>12000){lastLog=performance.now();console.log(JSON.stringify({path,phase:data.phase,seconds:Math.round(data.elapsedMs/1000),events:data.eventsReceived,characters:data.outputCharacters}));}}if(type==='result')result=data;}}
 if(!result)throw Error('No terminal SSE result');
 const entry={path,actorId:body.actorId??null,ok:result.ok,reason:result.reason??null,message:result.message,elapsedMs:Math.round(performance.now()-started),events:progress?.eventsReceived,outputCharacters:progress?.outputCharacters,diagnostics:result.diagnostics??[]};proof.stages.push(entry);save();console.log(JSON.stringify(entry));if(!result.ok)throw Error(result.reason??result.message??'request-failed');return result;
}
try{
 const initial=await state();if(initial.world||initial.creation?.draft||initial.model?.pending)throw Error('Expected clean creation page; refusing to overwrite user activity');
 const generated=await request('/api/world-generate',{description:MANSION_DESCRIPTION},{model:true});
 const draft=generated.state.creation.draft;
 if(!draft?.definition.world.story||draft.definition.scene.objects.filter(o=>o.kind==='room').length<2)throw Error('Generated draft does not contain the requested story/rooms');
 proof.genesis={draftId:draft.id,title:draft.definition.world.title,createdAt:draft.createdAt,adjustments:draft.adjustments,actors:draft.definition.world.actors.map(a=>({id:a.id,name:a.name,role:a.role,location:a.location})),clues:draft.definition.world.story.clues.length,rooms:draft.definition.scene.objects.filter(o=>o.kind==='room').length};save();
 const accepted=await request('/api/control',{type:'world-accept',draftId:draft.id});if(!accepted.ok)throw Error(accepted.message);
 const world=accepted.state.world;
 const first=world.actors.find(a=>world.actors.some(b=>b.id!==a.id&&b.location===a.location))??world.actors[0];
 const second=world.actors.find(a=>a.id!==first.id&&a.location===first.location)??world.actors.find(a=>a.id!==first.id);
 for(const person of [first,second].filter(Boolean)){
   const turn=await request('/api/actor-step',{actorId:person.id},{model:true});const decision=turn.state.actors[person.id].lastDecision;
   proof.stages.at(-1).decision={name:person.name,action:decision?.decision?.action,outcome:decision?.outcome};save();
 }
 const final=await state();proof.ok=true;proof.finishedAt=new Date().toISOString();proof.final={title:final.world.title,instanceId:final.instanceId,worldMinute:final.worldMinute,paused:final.paused,autonomy:final.autonomy.enabled,modelPending:final.model.pending,conversations:final.world.story.conversations,discoveries:final.world.story.clues.map(c=>({id:c.id,name:c.name,discoveredBy:c.discoveredBy})),totalMemories:Object.fromEntries(Object.entries(final.actors).map(([id,ledger])=>[id,ledger.totalMemories]))};save();console.log(JSON.stringify(proof,null,2));
}catch(error){proof.ok=false;proof.error=error.message;save();console.error(JSON.stringify({ok:false,error:error.message,proof:join(folder,'mansion-live-proof.json')}));process.exitCode=1;}

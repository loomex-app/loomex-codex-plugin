import { test } from "node:test";
import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PERSONA_RESULTS, personaMemoryContent } from "../src/persona-contracts.js";

const fixtureBytes=await readFile("test/fixtures/persona-memory-wire-v2.json");
const fixture=JSON.parse(fixtureBytes.toString("utf8")) as {schemaVersion:string;producer:string;cases:Array<{name:string;method:string;result:Record<string,unknown>;canonicalText:string}>};
const digest=(value:Uint8Array)=>createHash("sha256").update(value).digest("hex");

test("memory wire fixtures preserve actual HTTP producer bytes and source provenance",async()=>{
 const proof=JSON.parse(await readFile("test/fixtures/persona-memory-wire-v2.provenance.json","utf8")) as {schemaVersion:string;fixtureSha256:string;producerArtifact:string;producerSources:Record<string,string>};
 assert.equal(fixture.schemaVersion,"loomex.memory-wire-fixtures/v1");assert.equal(fixture.cases.length,10);
 assert.equal(proof.schemaVersion,"loomex.memory-wire-fixture-provenance/v1");assert.equal(digest(fixtureBytes),proof.fixtureSha256);
 assert.equal(fixture.producer,"actual RunnerPersonaMemoryToolView + RunnerPersonaOperationView HTTP responses");
 // The checked-in fixture remains independently usable without a backend checkout.
 // In the integrated source tree also verify the actual producer artifact/code.
 for(const [path,expected] of [[proof.producerArtifact,proof.fixtureSha256],...Object.entries(proof.producerSources)]){
  let bytes:Buffer;try{bytes=await readFile(resolve("..",path!));}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")continue;throw error;}
  assert.equal(digest(bytes),expected,path);
 }
});

for(const entry of fixture.cases){
 test(`actual producer ${entry.name} decodes losslessly`,()=>{
  const data={result:entry.result,canonicalText:entry.canonicalText};
  assert.deepEqual(PERSONA_RESULTS[`personas.memory.${entry.method}`]!.parse(data),data);
  assert.equal(personaMemoryContent(data),entry.canonicalText);
  if(entry.method==="write"||entry.method==="update"){
   if(entry.result.ok===true)assert.deepEqual(Object.keys(entry.result.memory as object).sort(),["id","status","type"]);
   const operation={operation:`memory.${entry.method}`,key:"66666666-6666-4666-8666-666666666666",status:"completed",requestDigest:"a".repeat(64),response:{result:entry.result}};
   assert.deepEqual(PERSONA_RESULTS["personas.operations.get"]!.parse(operation),operation);
  }
 });
 if(entry.result.ok===false)test(`actual producer ${entry.name} rejects malformed or unsafe wire variants`,()=>{
  const result=entry.result,budget=result.budget as Record<string,unknown>,schema=PERSONA_RESULTS[`personas.memory.${entry.method}`]!;
  const variants=[{...result,tool:"person_memory.peer"},{...result,error:"raw provider stderr and private details"},{...result,error:{message:"raw backend error"}},{...result,rawError:"private raw output"},{...result,memory:{content:"private full memory"}},{...result,budget:{...budget,raw:"private cap"}},{...result,budget:{...budget,maxTokens:0}},{...result,budget:{...budget,maxBytes:1}},{...result,budget:{...budget,maxTokens:Number(budget.maxTokens)+1}},{...result,budget:{...budget,maxBytes:Number(budget.maxBytes)+1}}];
  for(const result of variants)assert.equal(schema.safeParse({result,canonicalText:JSON.stringify(result)}).success,false);
 });
}

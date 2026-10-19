import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { JsonValueSchema } from "./protocol.js";

const Uuid = z.uuid();
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const JsonObject = z.record(z.string(), JsonValueSchema);
const EnglishQuery = z.string().min(1).max(4096).regex(/\S/).describe("English retrieval query; translate the user's request while preserving their response language.");
const MemoryType = z.enum(["artifact_reference", "constraint", "decision", "fact", "interaction_summary", "preference", "relationship_context"]);
const Content = z.string().min(1).max(32768).regex(/\S/);
const Summary = z.string().max(4096);
const Score = z.number().min(0).max(1);
const Context = {personId:Uuid, conversationId:Uuid, chatId:Uuid};
const MemoryContext = {...Context, callId:z.string().min(1).max(255).regex(/\S/).optional(),expectedConfigDigest:Digest.optional()};
const MemoryFields = {content:Content.optional(),summary:Summary.optional(),type:MemoryType.optional(),importance:Score.optional(),confidence:Score.optional()};
const Prompt = z.string().max(32768);
const Skill = z.union([z.string().min(1).max(255).regex(/\S/),z.object({id:z.string().min(1).max(255).regex(/\S/),enabled:z.boolean().optional(),priority:z.number().int().min(0).max(1000).optional()}).strict()]);
const Creation = {organizationId:Uuid,name:z.string().trim().min(1).max(255).regex(/\S/),key:z.string().max(255).optional(),description:z.string().max(4096).optional(),idempotencyKey:Uuid};
const Operation = z.enum(["chat_context.create","memory.write","memory.update","role.create","person.create"]);

/** Fixed host tool contracts. Backend descriptions and schemas are data only. */
export const PERSONA_INPUTS = Object.freeze({
  rolesList:z.object({query:z.string().max(4096).optional(),cursor:z.string().min(1).optional(),limit:z.number().int().min(1).max(100).optional()}).strict(),
  roleGet:z.object({roleId:Uuid}).strict(),
  roleCreate:z.object({...Creation,status:z.enum(["active","disabled"]).optional(),config:z.object({promptPolicy:z.object({basePrompt:Prompt.optional(),responsibility:Prompt.optional(),boundaries:Prompt.optional(),safetyRules:Prompt.optional()}).strict().optional(),skills:z.array(Skill).max(100).optional()}).strict().optional()}).strict(),
  personCreate:z.object({...Creation,roleId:Uuid,status:z.enum(["draft","active"]).optional(),config:z.object({promptPolicy:z.object({personalityPrompt:Prompt.optional(),outputStyle:Prompt.optional(),memoryUsageInstruction:Prompt.optional()}).strict().optional(),memoryPolicy:z.object({maxItems:z.number().int().min(1).max(200).optional(),writeMemory:z.boolean().optional()}).strict().optional(),skills:z.array(Skill).max(100).optional()}).strict().optional()}).strict(),
  list:z.object({query:z.string().max(4096).optional(),roleId:Uuid.optional(),cursor:z.string().min(1).optional(),limit:z.number().int().min(1).max(100).optional()}).strict(),
  get:z.object({personId:Uuid}).strict(),
  create:z.object({personId:Uuid,chatId:Uuid.optional(),idempotencyKey:Uuid}).strict(),
  context:z.object(Context).strict(),
  search:z.object({...MemoryContext,arguments:z.object({query:EnglishQuery,limit:z.number().int().min(1).max(200).optional(),types:z.array(MemoryType).max(7).refine(values=>new Set(values).size===values.length).optional()}).strict()}).strict(),
  read:z.object({...MemoryContext,arguments:z.object({memoryId:Uuid,cursor:z.string().min(1).max(16384).optional()}).strict()}).strict(),
  write:z.object({...MemoryContext,idempotencyKey:Uuid,arguments:z.object({...MemoryFields,content:Content}).strict()}).strict(),
  update:z.object({...MemoryContext,idempotencyKey:Uuid,arguments:z.object({...MemoryFields,memoryId:Uuid,reason:Summary.optional()}).strict()}).strict(),
  operation:z.object({operation:Operation,idempotencyKey:Uuid}).strict(),
  scopeStatus:z.object({organizationId:Uuid}).strict(),
  scopeUpgrade:z.object({organizationId:Uuid,requestedScopes:z.array(z.enum(["runner.personas.read","runner.personas.chat","runner.personas.memory.read","runner.personas.memory.write","runner.personas.manage"])).min(1).max(5).refine(values=>new Set(values).size===values.length),idempotencyKey:Uuid}).strict(),
});

export const PERSONA_CONTEXT_REFERENCE = z.object({personId:Uuid,organizationId:Uuid,conversationId:Uuid,chatId:Uuid,configDigest:Digest}).strict();
// Config, policy, and result content are backend data. Their container contracts
// stay closed; they cannot register executable tools or grant host authority.
export const PERSONA_RESULTS: Readonly<Record<string,z.ZodType>> = Object.freeze({
  "persona.roles.list":z.object({roles:z.array(JsonObject),nextCursor:z.string().nullable()}).strict(),
  "persona.roles.get":z.object({role:JsonObject}).strict(),
  "persona.roles.create":z.object({role:JsonObject}).strict(),
  "personas.create":z.object({person:JsonObject}).strict(),
  "personas.list":z.object({personas:z.array(JsonObject),nextCursor:z.string().nullable()}).strict(),
  "personas.get":z.object({contractVersion:z.literal("loomex.ai-persona-chat/v1"),person:JsonObject,role:JsonObject.nullable(),effectiveConfig:JsonObject}).strict(),
  ...Object.fromEntries(["create","get"].map(method=>[`personas.chat_context.${method}`,z.object({contractVersion:z.literal("loomex.ai-persona-chat/v1"),person:JsonObject,role:JsonObject.nullable(),effectiveConfig:JsonObject,conversation:z.object({conversationId:Uuid,chatId:Uuid}).strict(),memory:z.object({toolNamespace:z.string(),toolCatalog:z.array(JsonObject),toolInstructions:z.string(),policy:JsonObject,memoryContract:z.literal("ai.persona-memory/v2").optional()}).strict(),configDigest:Digest}).strict()])),
  ...Object.fromEntries(["search","read","write","update"].map(method=>[`personas.memory.${method}`,z.object({result:JsonObject,canonicalText:z.string().optional()}).strict().superRefine((data,ctx)=>{
    if(data.result.schemaVersion!=="ai.persona-memory/v2")return;
    if(!memoryV2ResultSchema(method).safeParse(data.result).success)ctx.addIssue({code:"custom",message:"Invalid typed v2 memory result"});
    try{personaMemoryContent(data);}catch{ctx.addIssue({code:"custom",message:"Invalid canonical v2 memory result"});}
  })])),
  ...Object.fromEntries(["auth.scope_status","auth.scope_upgrade"].map(method=>[method,z.object({organizationId:Uuid,runnerId:Uuid,delegationId:Uuid,deviceId:Uuid,scopes:z.array(z.string()),status:z.string()}).strict()])),
  "personas.operations.get":z.discriminatedUnion("status",[z.object({operation:Operation,key:Uuid,status:z.literal("not_found")}).strict(),z.object({operation:Operation,key:Uuid,status:z.literal("processing"),requestDigest:Digest}).strict(),z.object({operation:Operation,key:Uuid,status:z.literal("completed"),requestDigest:Digest,response:JsonObject}).strict().superRefine((value,ctx)=>{
    const result=value.response.result;
    if((value.operation==="memory.write"||value.operation==="memory.update")&&result!==null&&typeof result==="object"&&!Array.isArray(result)&&result.schemaVersion==="ai.persona-memory/v2"&&!memoryV2ResultSchema(value.operation==="memory.write"?"write":"update").safeParse(result).success)ctx.addIssue({code:"custom",message:"Invalid typed v2 memory receipt result"});
  })]),
});


/** The process-wide cursor transport does not select or upgrade persisted context authority. */
export const MEMORY_V2_READ = z.object({
  ok:z.literal(true),tool:z.literal("person_memory.read"),schemaVersion:z.literal("ai.persona-memory/v2"),
  memoryId:Uuid,revision:z.number().int().positive(),
  page:z.object({text:z.string(),encoding:z.literal("application/json; fragment=unicode-codepoints"),
    start:z.number().int().nonnegative(),end:z.number().int().nonnegative(),totalChars:z.number().int().nonnegative(),
    documentSha256:Digest,complete:z.boolean(),nextCursor:z.string().min(1).max(16384).nullable()}).strict()
    .refine(p=>p.end-p.start===Array.from(p.text).length&&p.end<=p.totalChars&&
      (p.complete?p.nextCursor===null&&p.end===p.totalChars:p.nextCursor!==null&&p.end<p.totalChars&&p.end>p.start)),
  budget:z.object({accountingContract:z.literal("o200k_base/v1"),maxTokens:z.number().int().positive().max(2048),maxBytes:z.number().int().positive().max(16384)}).strict(),
}).strict();

/** Forward runner-verified canonical bytes; JSON reserialization can change pinned accounting. */
export function personaMemoryContent(data:Record<string,unknown>):string|undefined {
  const result=data.result;
  if(result===null||typeof result!=="object"||Array.isArray(result)||(result as Record<string,unknown>).schemaVersion!=="ai.persona-memory/v2")return undefined;
  const canonical=data.canonicalText;
  const value=result as Record<string,unknown>,budget=value.budget as Record<string,unknown>|undefined;
  const maxTokens=value.tool==="person_memory.read"?2048:4096,maxBytes=value.tool==="person_memory.read"?16384:32768;
  if(typeof canonical!=="string"||typeof budget?.maxBytes!=="number"||!Number.isSafeInteger(budget.maxBytes)||budget.maxBytes<1||budget.maxBytes>maxBytes||budget.accountingContract!=="o200k_base/v1"||typeof budget.maxTokens!=="number"||!Number.isSafeInteger(budget.maxTokens)||budget.maxTokens<1||budget.maxTokens>maxTokens||Buffer.byteLength(canonical,"utf8")>budget.maxBytes)
    throw new Error("The canonical v2 memory result is unavailable. Refresh the exact context before reading again.");
  let parsed:unknown;try{parsed=JSON.parse(canonical);}catch{throw new Error("Invalid canonical v2 memory result.");}
  if(!isDeepStrictEqual(parsed,result))throw new Error("The canonical v2 memory result does not match its response.");
  return canonical;
}


const Source = z.object({type:z.string(),id:z.string(),checksum:Digest,artifactId:Uuid.nullable(),artifactVersionId:Uuid.nullable(),artifactVersion:z.number().int().nonnegative().nullable()}).strict();
const Passage = z.object({id:Uuid,revision:z.number().int().positive(),type:MemoryType,summary:z.string(),matchedPassage:z.string(),passageStart:z.number().int().nonnegative(),passageEnd:z.number().int().nonnegative(),contentChars:z.number().int().nonnegative(),truncated:z.boolean(),score:z.number(),provenance:JsonObject,source:Source.optional(),chunkId:z.string().optional(),chunkOrdinal:z.number().int().nonnegative().optional(),chunkerVersion:z.string().optional(),generation:z.string().optional(),title:z.string().optional()}).strict().refine(p=>p.passageEnd-p.passageStart===Array.from(p.matchedPassage).length&&p.passageEnd<=p.contentChars);
export const MEMORY_V2_SEARCH=z.object({ok:z.literal(true),tool:z.literal("person_memory.search"),schemaVersion:z.literal("ai.persona-memory/v2"),memoryIds:z.array(Uuid),items:z.array(Passage),snapshotId:Uuid.nullable(),omittedCount:z.number().int().nonnegative(),truncated:z.boolean(),budget:z.object({accountingContract:z.literal("o200k_base/v1"),maxTokens:z.number().int().positive().max(4096),maxBytes:z.number().int().positive().max(32768)}).strict(),sourceWork:z.object({limited:z.boolean(),maxArtifactBytes:z.number().int().nonnegative().max(4194304),maxTextBytes:z.number().int().nonnegative().max(4194304),maxArtifacts:z.number().int().nonnegative().max(8)}).strict().optional()}).strict().refine(result=>result.memoryIds.length===result.items.length&&result.items.every((item,index)=>item.id===result.memoryIds[index])&&(!result.sourceWork?.limited||result.truncated));


export const MEMORY_V2_ACK=z.object({ok:z.literal(true),tool:z.enum(["person_memory.write","person_memory.update"]),schemaVersion:z.literal("ai.persona-memory/v2"),memory:z.object({id:Uuid,type:MemoryType,status:z.string()}).strict(),budget:z.object({accountingContract:z.literal("o200k_base/v1"),maxTokens:z.number().int().positive().max(4096),maxBytes:z.number().int().positive().max(32768)}).strict()}).strict();


export const MEMORY_V2_REJECTION = "Persona memory operation was rejected; inspect current context and policy.";
/** Typed rejection is a completed tool result, distinct from HTTP/transport authority errors. */
export function memoryV2ResultSchema(method:string):z.ZodType {
 const read=method==="read";
 const rejected=z.object({ok:z.literal(false),tool:z.literal(`person_memory.${method}`),schemaVersion:z.literal("ai.persona-memory/v2"),error:z.literal(MEMORY_V2_REJECTION),budget:z.object({accountingContract:z.literal("o200k_base/v1"),maxTokens:z.number().int().positive().max(read?2048:4096),maxBytes:z.number().int().positive().max(read?16384:32768)}).strict()}).strict();
 if(method==="read")return z.union([MEMORY_V2_READ,rejected]);
 if(method==="search")return z.union([MEMORY_V2_SEARCH,rejected]);
 if(method==="write"||method==="update")return z.union([MEMORY_V2_ACK.refine(result=>result.tool===`person_memory.${method}`),rejected]);
 return z.never();
}

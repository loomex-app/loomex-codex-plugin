import { z } from "zod";
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
const MemoryContext = {...Context, callId:z.string().min(1).max(255).optional(),expectedConfigDigest:Digest.optional()};
const MemoryFields = {content:Content.optional(),summary:Summary.optional(),type:MemoryType.optional(),importance:Score.optional(),confidence:Score.optional()};

/** Fixed host tool contracts. Backend descriptions and schemas are data only. */
export const PERSONA_INPUTS = Object.freeze({
  rolesList:z.object({query:z.string().max(4096).optional(),cursor:z.string().min(1).optional(),limit:z.number().int().min(1).max(100).optional()}).strict(),
  roleGet:z.object({roleId:Uuid}).strict(),
  list:z.object({query:z.string().max(4096).optional(),roleId:Uuid.optional(),cursor:z.string().min(1).optional(),limit:z.number().int().min(1).max(100).optional()}).strict(),
  get:z.object({personId:Uuid}).strict(),
  create:z.object({personId:Uuid,chatId:Uuid.optional(),idempotencyKey:Uuid}).strict(),
  context:z.object(Context).strict(),
  search:z.object({...MemoryContext,arguments:z.object({query:EnglishQuery,limit:z.number().int().min(1).max(200).optional(),types:z.array(MemoryType).max(7).refine(values=>new Set(values).size===values.length).optional()}).strict()}).strict(),
  read:z.object({...MemoryContext,arguments:z.object({memoryId:Uuid}).strict()}).strict(),
  write:z.object({...MemoryContext,idempotencyKey:Uuid,arguments:z.object({...MemoryFields,content:Content}).strict()}).strict(),
  update:z.object({...MemoryContext,idempotencyKey:Uuid,arguments:z.object({...MemoryFields,memoryId:Uuid,reason:Summary.optional()}).strict()}).strict(),
  operation:z.object({operation:z.enum(["chat_context.create","memory.write","memory.update"]),idempotencyKey:Uuid}).strict(),
  scopeStatus:z.object({organizationId:Uuid}).strict(),
  scopeUpgrade:z.object({organizationId:Uuid,requestedScopes:z.array(z.enum(["runner.personas.read","runner.personas.chat","runner.personas.memory.read","runner.personas.memory.write"])).min(1).max(4).refine(values=>new Set(values).size===values.length),idempotencyKey:Uuid}).strict(),
});

export const PERSONA_CONTEXT_REFERENCE = z.object({personId:Uuid,organizationId:Uuid,conversationId:Uuid,chatId:Uuid,configDigest:Digest}).strict();
// Config, policy, and result content are backend data. Their container contracts
// stay closed; they cannot register executable tools or grant host authority.
export const PERSONA_RESULTS: Readonly<Record<string,z.ZodType>> = Object.freeze({
  "persona.roles.list":z.object({roles:z.array(JsonObject),nextCursor:z.string().nullable()}).strict(),
  "persona.roles.get":z.object({role:JsonObject}).strict(),
  "personas.list":z.object({personas:z.array(JsonObject),nextCursor:z.string().nullable()}).strict(),
  "personas.get":z.object({contractVersion:z.literal("loomex.ai-persona-chat/v1"),person:JsonObject,role:JsonObject.nullable(),effectiveConfig:JsonObject}).strict(),
  ...Object.fromEntries(["create","get"].map(method=>[`personas.chat_context.${method}`,z.object({contractVersion:z.literal("loomex.ai-persona-chat/v1"),person:JsonObject,role:JsonObject.nullable(),effectiveConfig:JsonObject,conversation:z.object({conversationId:Uuid,chatId:Uuid}).strict(),memory:z.object({toolNamespace:z.string(),toolCatalog:z.array(JsonObject),toolInstructions:z.string(),policy:JsonObject}).strict(),configDigest:Digest}).strict()])),
  ...Object.fromEntries(["search","read","write","update"].map(method=>[`personas.memory.${method}`,z.object({result:JsonObject}).strict()])),
  ...Object.fromEntries(["auth.scope_status","auth.scope_upgrade"].map(method=>[method,z.object({organizationId:Uuid,runnerId:Uuid,delegationId:Uuid,deviceId:Uuid,scopes:z.array(z.string()),status:z.string()}).strict()])),
  "personas.operations.get":z.discriminatedUnion("status",[z.object({operation:z.enum(["chat_context.create","memory.write","memory.update"]),key:Uuid,status:z.literal("not_found")}).strict(),z.object({operation:z.enum(["chat_context.create","memory.write","memory.update"]),key:Uuid,status:z.literal("processing"),requestDigest:Digest}).strict(),z.object({operation:z.enum(["chat_context.create","memory.write","memory.update"]),key:Uuid,status:z.literal("completed"),requestDigest:Digest,response:JsonObject}).strict()]),
});

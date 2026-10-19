import type { JsonObject } from "./contracts.js";
const object=(v:unknown):JsonObject|undefined=>v!==null&&typeof v==="object"&&!Array.isArray(v)?v as JsonObject:undefined;
const uuid=(v:unknown):v is string=>typeof v==="string"&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
export interface PreparedPersona {workflowVersionId:string;nodeKey:string;selectionKey:string;personId:string;personName:string;roleId:string;roleName:string;configDigest:string;}
/** Summary is derived from sealed closure; mutable discovery is never consulted. */
export function preparedPersonaSummary(value:unknown):PreparedPersona[]|undefined {
 const binding=object(value),selections=object(object(binding?.inputs)?.aiPersonaSelections),summary=object(binding?.workflowClosureReview)?.personas;
 const discussions=preparedDiscussionSummary(value);if(discussions===undefined)return undefined;
 const items=summary??[];if(!Array.isArray(items)||items.length>1000)return undefined;
 const rows:PreparedPersona[]=[];const keys=new Set<string>();
 for(const raw of items){const row=object(raw);if(!row||!uuid(row.workflowVersionId)||row.workflowVersionId!==binding?.versionId||typeof row.nodeKey!=="string"||!row.nodeKey||typeof row.selectionKey!=="string"||!row.selectionKey||!uuid(row.personId)||!uuid(row.roleId)||typeof row.personName!=="string"||!row.personName||typeof row.roleName!=="string"||!row.roleName||typeof row.configDigest!=="string"||!/^[a-f0-9]{64}$/.test(row.configDigest)||keys.has(row.selectionKey)||!selections||selections[row.selectionKey]!==row.personId)return undefined;keys.add(row.selectionKey);rows.push(row as unknown as PreparedPersona);}
 for(const discussion of discussions)for(const participant of discussion.participants){if(keys.has(participant.selectionKey))return undefined;keys.add(participant.selectionKey);}
 if(selections&&Object.keys(selections).some(key=>!keys.has(key)))return undefined;return rows;
}


export interface PreparedDiscussionParticipant {slotKey:string;selectionKey:string;personId:string;personName:string;roleId:string;roleName:string;provider:string;model:string;reasoningEffort:string|null;configDigest:string;}
export interface PreparedDiscussion {workflowVersionId:string;nodeKey:string;mode:string;maxRounds:number;moderatorSlot:string|null;synthesizerSlot:string;contextBudget:{accountingContract:string;maxTokens:number;maxBytes:number};finalMemoryProposals:boolean;voting:unknown;participants:PreparedDiscussionParticipant[];configDigest:string;}
const digest=(v:unknown):v is string=>typeof v==="string"&&/^[a-f0-9]{64}$/.test(v);
const nonempty=(v:unknown):v is string=>typeof v==="string"&&v.trim().length>0;
const pick=(value:JsonObject,keys:readonly string[]):JsonObject=>Object.fromEntries(keys.filter(key=>Object.hasOwn(value,key)).map(key=>[key,value[key]]));
/** Consume exact composite selection keys supplied by the sealed backend owner. */
export function preparedDiscussionSummary(value:unknown):PreparedDiscussion[]|undefined {
 const binding=object(value),selections=object(object(binding?.inputs)?.aiPersonaSelections),summary=object(binding?.workflowClosureReview)?.discussions;
 if(summary===undefined)return [];
 if(!Array.isArray(summary)||summary.length>1000)return undefined;
 const rows:PreparedDiscussion[]=[],nodes=new Set<string>(),selectionKeys=new Set<string>();
 for(const raw of summary){const row=object(raw),budget=object(row?.contextBudget);
  if(!row||!uuid(row.workflowVersionId)||row.workflowVersionId!==binding?.versionId||!nonempty(row.nodeKey)||nodes.has(row.nodeKey)||!digest(row.configDigest)||!["ordered","independent_then_discuss","proposal_critique","voting"].includes(String(row.mode))||!Number.isInteger(row.maxRounds)||Number(row.maxRounds)<1||Number(row.maxRounds)>10||!Array.isArray(row.participants)||row.participants.length<2||row.participants.length>8||!budget||budget.accountingContract!=="o200k_base/v1"||!Number.isInteger(budget.maxTokens)||Number(budget.maxTokens)<1||Number(budget.maxTokens)>65536||!Number.isInteger(budget.maxBytes)||Number(budget.maxBytes)<1||Number(budget.maxBytes)>524288||typeof row.finalMemoryProposals!=="boolean")return undefined;
  const slots=new Set<string>(),people=new Set<string>();
  for(const rawParticipant of row.participants){const p=object(rawParticipant);if(!p||!nonempty(p.slotKey)||slots.has(p.slotKey)||!nonempty(p.selectionKey)||selectionKeys.has(p.selectionKey)||!uuid(p.personId)||people.has(p.personId)||!uuid(p.roleId)||!nonempty(p.personName)||!nonempty(p.roleName)||!nonempty(p.provider)||!nonempty(p.model)||!(p.reasoningEffort===null||nonempty(p.reasoningEffort))||!digest(p.configDigest)||selections?.[p.selectionKey]!==p.personId)return undefined;slots.add(p.slotKey);people.add(p.personId);selectionKeys.add(p.selectionKey);}
  if(!(row.moderatorSlot===null||typeof row.moderatorSlot==="string"&&slots.has(row.moderatorSlot))||typeof row.synthesizerSlot!=="string"||!slots.has(row.synthesizerSlot))return undefined;
  if(row.mode==="voting"){const voting=object(row.voting);if(!voting||!["majority","unanimity"].includes(String(voting.rule))||!Array.isArray(voting.options)||voting.options.length<2||voting.options.length>32||new Set(voting.options.map(item=>object(item)?.id)).size!==voting.options.length||voting.options.some(item=>{const option=object(item);return !option||!nonempty(option.id)||!nonempty(option.label);}))return undefined;}
  nodes.add(row.nodeKey);
  // The summary is also model-facing: never forward unknown peer prompts,
  // policies, private snapshots or provider output from a transport object.
  const voting=object(row.voting);
  rows.push({...pick(row,["workflowVersionId","nodeKey","mode","maxRounds","moderatorSlot","synthesizerSlot","finalMemoryProposals","configDigest"]),contextBudget:pick(budget,["accountingContract","maxTokens","maxBytes"]),participants:row.participants.map(raw=>pick(object(raw)!,["slotKey","selectionKey","personId","personName","roleId","roleName","provider","model","reasoningEffort","configDigest"])),voting:voting?{...pick(voting,["rule"]),options:Array.isArray(voting.options)?voting.options.map(raw=>pick(object(raw)??{},["id","label"])):[]}:null} as unknown as PreparedDiscussion);
 }
 return rows;
}

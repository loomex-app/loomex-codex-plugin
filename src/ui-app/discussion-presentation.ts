import { createUiElement as element } from "./components.js";
import { createReadingPromptContent } from "./prompt-content.js";
import type { JsonObject } from "./contracts.js";

const object=(value:unknown):JsonObject|undefined=>value!==null&&typeof value==="object"&&!Array.isArray(value)?value as JsonObject:undefined;
const uuid=(value:unknown):value is string=>typeof value==="string"&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const text=(value:unknown):value is string=>typeof value==="string";
const texts=(value:unknown):value is string[]=>Array.isArray(value)&&value.every(text);
export interface DiscussionResult {nodeKey:string;nodeExecutionId:string;output:JsonObject;}
/** Only finalized, versioned discussion output belongs in the existing result card. */
export function discussionResults(value:unknown):DiscussionResult[]|undefined {
 if(value===undefined)return [];
 if(!Array.isArray(value))return undefined;
 const seen=new Set<string>(),results:DiscussionResult[]=[];
 for(const raw of value){const row=object(raw),output=object(row?.output);
  if(!row||!text(row.nodeKey)||!row.nodeKey||!uuid(row.nodeExecutionId)||seen.has(row.nodeExecutionId)||!output||output.schemaVersion!=="loomex.persona-discussion/v1"||!text(output.subject)||!text(output.goal)||!text(output.synthesis)||!(output.recommendation===null||text(output.recommendation))||!["met","not_met","undetermined"].includes(String(output.goalStatus))||!["moderator","round_cap","context_budget"].includes(String(output.stopReason))||!["agreements","disagreements","openQuestions","messageReferences"].every(key=>texts(output[key]))||!Array.isArray(output.participants)||!Array.isArray(output.messages)||!Array.isArray(output.moderation)||!Array.isArray(output.proposalReceipts)||!Array.isArray(output.warnings))return undefined;
  const slots=new Map<string,string>(),people=new Set<string>();
  for(const rawParticipant of output.participants){const participant=object(rawParticipant);if(!participant||!text(participant.slotKey)||!participant.slotKey||slots.has(participant.slotKey)||!uuid(participant.roleId)||!uuid(participant.personId)||people.has(participant.personId))return undefined;slots.set(participant.slotKey,participant.personId);people.add(participant.personId);}
  if(slots.size<2||slots.size>8)return undefined;
  const ids=new Set<string>();
  for(const rawMessage of output.messages){const message=object(rawMessage);if(!message||!text(message.messageId)||!message.messageId||ids.has(message.messageId)||!text(message.slotKey)||slots.get(message.slotKey)!==message.personId||!Number.isSafeInteger(message.round)||!text(message.phase)||!object(message.output))return undefined;ids.add(message.messageId);}
  if((output.messageReferences as string[]).some(id=>!ids.has(id)))return undefined;
  for(const raw of output.moderation){const entry=object(raw);if(!entry||!text(entry.slotKey)||slots.get(entry.slotKey)!==entry.personId||!["continue","complete"].includes(String(entry.decision))||!text(entry.explanation)||!Number.isSafeInteger(entry.round)||!texts(entry.messageReferences)||entry.messageReferences.some(id=>!ids.has(id)))return undefined;}
  if(output.tally!==null){const tally=object(output.tally);if(!tally||Object.keys(tally).some(key=>!["round","rule","participantCount","ballotCount","abstentions","counts","threshold","decision"].includes(key))||Object.entries(object(tally.counts)??{}).some(([key,value])=>key.length>255||!Number.isInteger(value)||Number(value)<0||Number(value)>slots.size)||Object.keys(object(tally.counts)??{}).length>32||!["majority","unanimity"].includes(String(tally.rule))||tally.participantCount!==slots.size||!Number.isSafeInteger(tally.ballotCount)||!Number.isSafeInteger(tally.abstentions)||!Number.isSafeInteger(tally.threshold)||!object(tally.counts)||!(tally.decision===null||text(tally.decision))||output.recommendation!==tally.decision)return undefined;}
  seen.add(row.nodeExecutionId);results.push({nodeKey:row.nodeKey,nodeExecutionId:row.nodeExecutionId,output});
 }
 return results;
}

/** Released messages retain author/phase/reference attribution; no active blind input is read. */
export function appendDiscussionResults(parent:HTMLElement,value:unknown):void {
 const results=discussionResults(value);
 if(results===undefined){parent.append(element("p",{className:"ui-callout"},"The discussion result could not be verified. Read the complete result in the conversation."));return;}
 for(const {nodeKey,output} of results){
  const section=element("section",{className:"ui-section","aria-label":`Discussion result: ${nodeKey}`});
  section.append(element("h3",{className:"ui-label"},String(output.subject)),element("p",{className:"ui-caption"},`Goal status: ${String(output.goalStatus).replaceAll("_"," ")} · Stopped: ${String(output.stopReason).replaceAll("_"," ")}`),createReadingPromptContent(String(output.synthesis),"Discussion synthesis"));
  section.append(element("p",{className:"ui-value"},output.recommendation===null?"No decision":`Recommendation: ${String(output.recommendation)}`));
  for(const key of ["agreements","disagreements","openQuestions"]){const entries=output[key] as string[];if(!entries.length)continue;const details=element("details",{className:"ui-disclosure"});details.append(element("summary",{},key.replace(/([a-z])([A-Z])/g,"$1 $2")));for(const item of entries)details.append(createReadingPromptContent(item,`${key} details`));section.append(details);}
  const tally=object(output.tally);if(tally){const details=element("details",{className:"ui-disclosure"});details.append(element("summary",{},"Voting tally"),element("p",{},`${String(tally.rule)} · ${String(tally.ballotCount)} / ${String(tally.participantCount)} ballots · ${String(tally.abstentions)} abstentions · threshold ${String(tally.threshold)}`));for(const [option,count] of Object.entries(object(tally.counts)??{}))details.append(element("p",{},`${option}: ${String(count)}`));section.append(details);}
  const transcript=element("details",{className:"ui-disclosure"});transcript.append(element("summary",{},`Released messages (${(output.messages as unknown[]).length})`));
  for(const raw of output.messages as unknown[]){const message=object(raw)!;const entry=element("section",{className:"ui-section"});entry.append(element("h4",{className:"ui-label"},`${String(message.slotKey)} · Round ${String(message.round)} · ${String(message.phase)}`),element("p",{className:"ui-caption"},`Persona ${String(message.personId)} · Reference ${String(message.messageId)}`));for(const [key,item] of Object.entries(object(message.output)!)){if(text(item))entry.append(createReadingPromptContent(item,`${key} by ${String(message.slotKey)}`));else if(item===null&&key==="optionId")entry.append(element("p",{},"Abstained"));}transcript.append(entry);}
  section.append(transcript);
  const refs=output.messageReferences as string[];if(refs.length)section.append(element("p",{className:"ui-caption"},`Synthesis references: ${refs.join(", ")}`));
  const moderation=output.moderation as unknown[];
  if(moderation.length){const details=element("details",{className:"ui-disclosure"});details.append(element("summary",{},"Moderator evaluations"));for(const raw of moderation){const entry=object(raw);if(!entry)continue;details.append(element("p",{className:"ui-caption"},`${String(entry.slotKey)} · Round ${String(entry.round)} · ${String(entry.decision)}`));if(text(entry.explanation))details.append(createReadingPromptContent(entry.explanation,"Moderator explanation"));if(texts(entry.messageReferences))details.append(element("p",{className:"ui-caption"},`References: ${entry.messageReferences.join(", ")}`));}section.append(details);}
  // Fixed warnings and public status/identity pointers never copy private memory.
  const warnings=output.warnings as unknown[];
  if(warnings.length){const labels:Readonly<Record<string,string>>={DISCUSSION_CONTEXT_OMITTED:"Released messages were omitted from synthesis context by its budget",DISCUSSION_PROPOSAL_FAILED:"A private memory proposal failed",DISCUSSION_PROPOSAL_GENERATION_FAILED:"Private memory proposal generation failed",DISCUSSION_PROPOSAL_CONTEXT_BUDGET:"Private memory proposal input exceeded its context budget"};const details=element("details",{className:"ui-disclosure"});details.append(element("summary",{},`Discussion warnings (${warnings.length})`));for(const raw of warnings){const warning=object(raw);const label=typeof warning?.code==="string"?labels[warning.code]:undefined;details.append(element("p",{className:"ui-caption"},label??"Review the complete warning in the conversation."));}section.append(details);}
  const receipts=output.proposalReceipts as unknown[];
  if(receipts.length){const details=element("details",{className:"ui-disclosure"});details.append(element("summary",{},`Private memory proposal receipts (${receipts.length})`));for(const raw of receipts){const receipt=object(raw);if(!receipt)continue;details.append(element("p",{className:"ui-caption"},`${String(receipt.slotKey)} · ${String(receipt.operation)} · ${receipt.ok===true?String(receipt.status):"Failed"}`));if(uuid(receipt.memoryId))details.append(element("p",{className:"ui-caption"},`Memory ${receipt.memoryId}`));if(uuid(receipt.receiptId))details.append(element("p",{className:"ui-caption"},`Receipt ${receipt.receiptId}`));}section.append(details);}
  parent.append(section);
 }
}

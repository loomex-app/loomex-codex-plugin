import type { JsonSchema, SetupAnalysisEntry } from "./page-models.js";
import type { JsonObject } from "./contracts.js";
import { createPagination, createUiElement as element } from "./components.js";
const uuid=(v:unknown):v is string=>typeof v==="string"&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const object=(v:unknown):JsonObject|undefined=>v!==null&&typeof v==="object"&&!Array.isArray(v)?v as JsonObject:undefined;
export interface PersonaSelection {readonly parentKey:string;readonly selectionKey:string;readonly roleId:string;readonly nodeKey:string;}
/** Consume exact backend metadata, including encoded keys; never rebuild them. */
export function personaSelectionEntries(parentKey:string,field:JsonSchema):SetupAnalysisEntry[]|undefined {
  if(field["x-loomex-input-kind"]!=="persona_selections")return undefined;
  if(parentKey!=="aiPersonaSelections"||field.type!=="object"||!field.properties||field.enum||field.$ref||field.oneOf||field.anyOf||field.allOf)throw new Error("The Persona selections schema is unsupported.");
  const required=new Set(field.required??[]),entries:SetupAnalysisEntry[]=[];
  for(const [key,child] of Object.entries(field.properties)){
    if(child.type!=="string"||child["x-loomex-input-kind"]!=="persona_select"||!uuid(child["x-loomex-role-id"])||typeof child["x-loomex-node-key"]!=="string"||!child["x-loomex-node-key"]||child.enum||child.const!==undefined||child.$ref||child.oneOf||child.anyOf||child.allOf)throw new Error("The Persona selection metadata cannot be collected safely.");
    entries.push({key:`${parentKey}.${key}`,field:child,type:"string",required:required.has(key),workspace:false,persona:{parentKey,selectionKey:key,roleId:child["x-loomex-role-id"],nodeKey:child["x-loomex-node-key"]}});
  }
  if([...required].some(key=>!Object.hasOwn(field.properties!,key)))throw new Error("A required Persona selection is not defined.");
  return entries;
}
export function collectPersonaSelection(inputs:JsonObject,entry:SetupAnalysisEntry,value:string):void {
  if(!entry.persona||!uuid(value))throw new Error("Choose an active Persona before continuing.");
  const parent=object(inputs[entry.persona.parentKey])??{};parent[entry.persona.selectionKey]=value;inputs[entry.persona.parentKey]=parent;
}
interface PickerServices {call(name:string,args:JsonObject):Promise<JsonObject>;changed(value:string):void;initialValue?:string|undefined;organizationId:string;disposed():boolean;}
/** Ephemeral role-filtered data. UUID selection alone is saved in the run draft. */
export function createPersonaSelectionPicker(entry:SetupAnalysisEntry,host:PickerServices):HTMLElement {
  if(!entry.persona)throw new Error("Persona selection metadata is unavailable.");
  const selection=entry.persona;let query="",cursor:string|undefined,nextCursor:string|null=null,history:(string|undefined)[]=[],generation=0;
  const wrapper=element("div",{className:"setup-field"}),label=element("label",{htmlFor:`persona-${selection.selectionKey}`},entry.field.title||`Persona for ${selection.nodeKey}`);
  const value=element("input",{type:"hidden",id:`persona-${selection.selectionKey}`,value:host.initialValue??"",dataset:{runInput:entry.key,personaVerified:"false"}});
  const status=element("p",{className:"hint",role:"status"}),search=element("input",{type:"search",placeholder:"Search Personas","aria-label":`Search Personas for ${selection.nodeKey}`}),searchButton=element("button",{type:"button",className:"secondary"},"Search"),rows=element("div",{className:"ui-stack"});
  const previous=element("button",{type:"button",className:"secondary"},"Previous"),next=element("button",{type:"button",className:"secondary"},"Next");
  wrapper.append(label,value,search,searchButton,status,rows,createPagination({ariaLabel:`Persona pages for ${selection.nodeKey}`,summary:"Active Personas",previous,next}));
  function valid(p:JsonObject|undefined):boolean {const role=object(p?.roleSummary);return Boolean(p&&uuid(p.id)&&p.organizationId===host.organizationId&&p.roleId===selection.roleId&&p.status==="active"&&role?.id===selection.roleId&&role.status==="active");}
  async function load():Promise<void>{
    const request=++generation;value.dataset.personaVerified="false";status.textContent="Loading active Personas…";rows.inert=true;
    try{
      const data=await host.call("loomex_personas_list",{roleId:selection.roleId,query,limit:5,...(cursor?{cursor}: {})});if(host.disposed()||request!==generation||!wrapper.isConnected)return;
      if(!Array.isArray(data.personas)||data.personas.some(p=>!valid(object(p)))||(data.nextCursor!==null&&typeof data.nextCursor!=="string"))throw new Error("The role-filtered Persona list could not be verified.");
      nextCursor=data.nextCursor as string|null;rows.replaceChildren();
      for(const raw of data.personas){const p=object(raw)!;const button=element("button",{type:"button",className:"secondary","aria-pressed":value.value===p.id},String(p.name));button.addEventListener("click",()=>{value.value=String(p.id);value.dataset.personaVerified="true";host.changed(value.value);for(const other of rows.querySelectorAll("button"))other.setAttribute("aria-pressed",String(other===button));status.textContent=`Selected ${String(p.name)}.`;});rows.append(button);}
      if(value.value){const selected=await host.call("loomex_persona_get",{personId:value.value});if(host.disposed()||request!==generation||!wrapper.isConnected)return;const p=object(selected.person);if(!valid(p)||p?.id!==value.value)throw new Error("The selected Persona changed or is no longer available for this role.");value.dataset.personaVerified="true";status.textContent=`Selected ${String(p?.name)}.`;}else status.textContent=data.personas.length?"Choose an active Persona for this role.":"No active Personas are available for this role.";
      previous.disabled=history.length===0;next.disabled=nextCursor===null;
    }catch(error){if(request===generation){status.textContent=error instanceof Error?error.message:"Persona selection is unavailable. Search to retry.";value.dataset.personaVerified="false";previous.disabled=true;next.disabled=true;}}finally{if(request===generation)rows.inert=false;}
  }
  value.addEventListener("change",()=>{host.changed(value.value);void load();});
  searchButton.addEventListener("click",()=>{query=search.value.trim();cursor=undefined;history=[];void load();});previous.addEventListener("click",()=>{cursor=history.pop();void load();});next.addEventListener("click",()=>{if(!nextCursor)return;history.push(cursor);cursor=nextCursor;void load();});
  queueMicrotask(()=>{if(!host.disposed())void load();});return wrapper;
}

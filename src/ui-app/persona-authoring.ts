import { createUiElement as element } from "./components.js";
import type { JsonObject } from "./contracts.js";
import type { RpcResult } from "./page-models.js";
import type { ViewRestorationCoordinator } from "./persistence.js";
import { ACTIONS, createIcon, type PagePresentation } from "./shell.js";

export type PersonaCreationKind = "role" | "person";
export interface PersonaManagementAccess { organizationId:string; organizationName:string; scopes:readonly string[]; }
export interface PersonaOperationReference { operationId:string; method:string; key:string; }
export interface PersonaManagementOperation extends PersonaOperationReference { args:JsonObject; status:string; resultReference?:JsonObject; }
export interface Draft { organizationId:string; name:string; description:string; instructions:string; roleId:string; personality:string; outputStyle:string; memoryInstruction:string; maxItems:number; writeMemory:boolean; available:boolean; }
interface Created { kind:PersonaCreationKind; organizationId:string; id:string; key:string; name:string; status:string; }
export interface PersonaAuthoringServices {
 lifecycle:ViewRestorationCoordinator;
 context:HTMLElement;
 call(name:string,args:JsonObject):Promise<JsonObject>;
 access():Promise<PersonaManagementAccess>;
 mutate(name:"loomex_persona_role_create"|"loomex_persona_create"|"loomex_persona_scope_upgrade",args:JsonObject,onJournaled?:(operation:PersonaManagementOperation)=>Promise<void>):Promise<{result:RpcResult;key:string}>;
 operation(reference?:PersonaOperationReference):Promise<PersonaManagementOperation|undefined>;
 settle(operation:PersonaManagementOperation,response:JsonObject):Promise<void>;
 failed(result:RpcResult):boolean;
 data(result:RpcResult):JsonObject;
 flush():Promise<boolean>;
 changed():void;
 error(error:unknown):void;
 setPage(page:PagePresentation):void;
 roles():readonly JsonObject[];
 roleCreated(role:JsonObject):void;
 close():void;
}
const uuid=(value:unknown):value is string=>typeof value==="string"&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const object=(value:unknown):JsonObject|undefined=>value!==null&&typeof value==="object"&&!Array.isArray(value)?value as JsonObject:undefined;
const text=(value:unknown,max=32768)=>typeof value==="string"?value.slice(0,max):"";
const blank=():Draft=>({organizationId:"",name:"",description:"",instructions:"",roleId:"",personality:"",outputStyle:"",memoryInstruction:"",maxItems:50,writeMemory:false,available:false});
function draft(value:unknown):Draft {const raw=object(value)??{};return {organizationId:uuid(raw.organizationId)?raw.organizationId:"",name:text(raw.name,255),description:text(raw.description,4096),instructions:text(raw.instructions),roleId:uuid(raw.roleId)?raw.roleId:"",personality:text(raw.personality),outputStyle:text(raw.outputStyle),memoryInstruction:text(raw.memoryInstruction),maxItems:typeof raw.maxItems==="number"&&Number.isInteger(raw.maxItems)&&raw.maxItems>=1&&raw.maxItems<=200?raw.maxItems:50,writeMemory:raw.writeMemory===true,available:raw.available===true};}
export function personaCreationArguments(kind:PersonaCreationKind,form:Draft):JsonObject {
 if(!uuid(form.organizationId)||!form.name.trim()||form.name.trim().length>255)throw new Error("Enter a name and verify the selected organization before creating.");
 const common={organizationId:form.organizationId,name:form.name.trim(),description:form.description};
 if(kind==="role")return {...common,status:"active",config:{promptPolicy:{basePrompt:form.instructions}}};
 if(!uuid(form.roleId)||!Number.isInteger(form.maxItems)||form.maxItems<1||form.maxItems>200)throw new Error("Choose an active role and a memory limit between 1 and 200.");
 return {...common,roleId:form.roleId,status:form.available?"active":"draft",config:{promptPolicy:{personalityPrompt:form.personality,outputStyle:form.outputStyle,memoryUsageInstruction:form.memoryInstruction},memoryPolicy:{maxItems:form.maxItems,writeMemory:form.writeMemory}}};
}
/** An accepted entity must match the original journaled request, including default status. */
export function personaCreatedResult(value:unknown,kind:PersonaCreationKind,args:JsonObject,key:string):Created {
 const entity=object(value),expectedStatus=args.status===undefined?(kind==="role"?"active":"draft"):args.status;
 if(!entity||!uuid(entity.id)||!uuid(args.organizationId)||entity.organizationId!==args.organizationId||typeof entity.name!=="string"||!["active",kind==="role"?"disabled":"draft"].includes(String(expectedStatus)))throw new Error("The created result did not match this organization and request. Refresh to reconcile the exact operation.");
 if(entity.status!==expectedStatus)throw new Error("The created status does not match the requested status. Refresh to reconcile the exact operation.");
 if(entity.name!==args.name||(kind==="person"&&entity.roleId!==args.roleId))throw new Error("The created result belongs to another request. Refresh to reconcile.");
 return {kind,organizationId:args.organizationId,id:entity.id,key,name:text(entity.name,255),status:String(entity.status)};
}
/** Same-card authoring; safe edits use the existing presentation store and every write its mutation journal. */
export function createPersonaAuthoring(host:PersonaAuthoringServices) {
 let references:Partial<Record<PersonaCreationKind,PersonaOperationReference>>={};
 let screen:PersonaCreationKind|undefined, drafts={role:blank(),person:blank()},created:Created|undefined;
 let verifiedCreated=false;
 let access:PersonaManagementAccess|undefined,pending:PersonaManagementOperation|undefined,busy=false,disposed=false,generation=0;
 const events=new AbortController();
 const current=(owner:number)=>!disposed&&owner===generation;
 const allowed=()=>Boolean(access?.scopes.includes("runner.personas.manage"));
 const matchingOrganization=()=>Boolean(screen&&access&&drafts[screen].organizationId===access.organizationId);
 function capture():JsonObject {return {screen:screen??null,operations:{...references},drafts:{role:{...drafts.role},person:{...drafts.person}},...(created?{created:{...created}}:{})};}
 async function reconcile(owner:number,newIntent=false):Promise<void> {
  const activeReference=screen?references[screen]:undefined;
  const globalOperation=await host.operation();if(!current(owner))return;
  // A different unresolved write retains card-wide ownership even when this
  // kind still has an older completed reference.
  const operation=globalOperation&&globalOperation.status!=="completed"?globalOperation:activeReference?await host.operation(activeReference):globalOperation;if(!current(owner))return;pending=operation;
  if(!operation){if(created)throw new Error("The saved creation result is not confirmed. Refresh before continuing.");return;}
  if(operation.status==="completed"&&!activeReference){if(created)throw new Error("The saved creation result is not confirmed. Refresh before continuing.");pending=undefined;return;}
  if(operation.status==="completed"&&operation.resultReference?.ok===false){pending=undefined;return;}
  if(operation.method==="auth.scope_upgrade") {
   if(!access||access.organizationId!==operation.args.organizationId||!allowed())return;
   await host.settle(operation,{organizationId:access.organizationId,scopes:[...access.scopes],status:"verified"});if(!current(owner))return;pending=undefined;if(activeReference&&activeReference.key!==operation.key)await reconcile(owner,newIntent);return;
  }
  const kind=operation.method==="persona.roles.create"?"role":operation.method==="personas.create"?"person":undefined;
  if(!kind)return;
  if(operation.status==="completed"&&kind!==screen){pending=undefined;return;}
  const receipt=await host.call("loomex_persona_operation_get",{operation:kind==="role"?"role.create":"person.create",idempotencyKey:operation.key});if(!current(owner))return;
  if(receipt.operation!==(kind==="role"?"role.create":"person.create")||receipt.key!==operation.key||receipt.status!=="completed"){if(created)throw new Error("The saved creation result is not confirmed. Refresh before continuing.");return;}
  const response=object(receipt.response);if(!response||!uuid(operation.args.organizationId))throw new Error("The creation receipt could not be verified.");
  const value=object(response[kind==="role"?"role":"person"]);const accepted=personaCreatedResult(value,kind,operation.args,operation.key);
  if(created&&(created.id!==accepted.id||created.key!==accepted.key||created.organizationId!==accepted.organizationId||created.name!==accepted.name||created.status!==accepted.status))throw new Error("The saved creation result belongs to another request.");
  await host.settle(operation,response);if(!current(owner))return;
  pending=undefined;if(kind==="role"&&value?.status==="active")host.roleCreated(value);
  if(activeReference&&activeReference.key!==operation.key){await reconcile(owner,newIntent);return;}
  if(newIntent&&kind===screen){
   // A deliberate new form can retire only its verified completed predecessor.
   // Remount/Refresh retain the accepted result, and unresolved references never reset.
   delete references[kind];drafts[kind]={...blank(),organizationId:access?.organizationId??""};created=undefined;verifiedCreated=false;host.context.replaceChildren();
  }else if(kind===screen){created=accepted;verifiedCreated=true;}
  host.changed();
 }
 async function refresh(ownerCurrent:()=>boolean=()=>true,newIntent=false):Promise<void> {
  const owner=++generation;busy=true;verifiedCreated=false;render();
  try {const fresh=await host.access();if(!current(owner)||!ownerCurrent())return;access=fresh;
   if(screen&&!drafts[screen].organizationId){drafts[screen].organizationId=fresh.organizationId;host.changed();}
   await reconcile(owner,newIntent);if(!current(owner)||!ownerCurrent())return;
   if(created&&!pending&&created.organizationId!==fresh.organizationId)throw new Error("This created result belongs to another organization. Close this form to continue browsing.");
  }catch(error){if(current(owner)&&ownerCurrent()){access=undefined;verifiedCreated=false;host.error(error);throw error;}}
  finally{if(current(owner)){busy=false;render();}}
 }
 function heading():HTMLElement|undefined {const title=document.getElementById("title");if(title instanceof HTMLElement){title.tabIndex=-1;return title;}return undefined;}
 async function open(kind:PersonaCreationKind):Promise<void> {
  screen=kind;created=undefined;verifiedCreated=false;host.changed();render();
  const title=heading();title?.focus({preventScroll:true});
  const owner=generation+1;
  await refresh(()=>current(owner),true);
  // Preserve an intentional focus move or a newer navigation while the read ran.
  if(!current(owner)||document.activeElement!==title&&document.activeElement!==document.body)return;
  const first=host.context.querySelector<HTMLInputElement>("#persona-create-name:not(:disabled)");(first??title)?.focus({preventScroll:true});
 }
 function close():void {
  const kind=screen;++generation;busy=false;screen=undefined;host.changed();host.close();
  const origin=document.querySelector<HTMLButtonElement>(`[data-page-action="${kind==="role"?"create-role":"create-persona"}"]`);if(origin&&!origin.disabled)origin.focus({preventScroll:true});
 }
 async function grant():Promise<void> {
  if(!screen||!access||allowed()||busy||pending||!host.lifecycle.permissions().mutate)return;
  const kind=screen,owner=++generation,organizationId=access.organizationId;busy=true;render();
  try {if(!await host.flush())throw new Error("Save this form before requesting creation access.");if(!current(owner))return;
   const outcome=await host.mutate("loomex_persona_scope_upgrade",{organizationId,requestedScopes:["runner.personas.manage"]},async operation=>{if(!current(owner))throw new Error("The permission review changed before dispatch.");references[kind]={operationId:operation.operationId,method:operation.method,key:operation.key};pending=operation;host.changed();if(!await host.flush())throw new Error("The exact access request could not be saved.");if(!current(owner))throw new Error("The permission review changed before dispatch.");});if(!current(owner))return;
   if(host.failed(outcome.result))throw new Error("Creation access could not be confirmed. Refresh checks the same request before another action.");
   const fresh=await host.access();if(!current(owner))return;if(fresh.organizationId!==organizationId||!fresh.scopes.includes("runner.personas.manage"))throw new Error("Creation access has not been verified for this organization.");access=fresh;pending=undefined;
  }catch(error){if(current(owner)){pending=await host.operation(references[kind]).catch(()=>undefined);if(current(owner))host.error(error);}}finally{if(current(owner)){busy=false;render();}}
 }
 async function submit():Promise<void> {
  if(!screen||busy||pending||created||!allowed()||!matchingOrganization()||!host.lifecycle.permissions().mutate)return;
  const native=host.context.querySelector<HTMLFormElement>("#persona-authoring-form");if(!native?.reportValidity())return;
  const kind=screen,owner=++generation,args=personaCreationArguments(kind,drafts[kind]);busy=true;render();
  try {
   const fresh=await host.access();if(!current(owner))return;access=fresh;if(fresh.organizationId!==args.organizationId||!fresh.scopes.includes("runner.personas.manage"))throw new Error("Creation access or organization changed. Refresh this form before creating.");
   const prior=await host.operation();if(!current(owner))return;if(prior&&!(prior.status==="completed"&&prior.resultReference?.ok===false)){
    // A completed predecessor may be replaced; an unresolved write always
    // keeps its own exact journal tuple until its receipt is reconciled.
    if(prior.status!=="completed")throw new Error("A saved operation needs reconciliation before creating another item.");
   }
   if(kind==="person"){const role=object((await host.call("loomex_persona_role_get",{roleId:args.roleId})).role);if(!current(owner))return;if(!role||role.id!==args.roleId||role.organizationId!==args.organizationId||role.status!=="active")throw new Error("The selected role is no longer active in this organization. Refresh and choose another role.");}
   if(!await host.flush())throw new Error("This form could not be saved. Save it before creating.");if(!current(owner))return;
   const outcome=await host.mutate(kind==="role"?"loomex_persona_role_create":"loomex_persona_create",args,async operation=>{if(!current(owner))throw new Error("The creation form changed before dispatch.");references[kind]={operationId:operation.operationId,method:operation.method,key:operation.key};pending=operation;host.changed();if(!await host.flush())throw new Error("The exact creation reference could not be saved before dispatch.");if(!current(owner))throw new Error("The creation form changed before dispatch.");});if(!current(owner))return;
   if(host.failed(outcome.result)){pending=await host.operation(references[kind]);throw new Error("Creation could not be confirmed. Your form is preserved; Refresh checks the exact saved operation.");}
   const data=host.data(outcome.result),value=object(data[kind==="role"?"role":"person"]);const accepted=personaCreatedResult(value,kind,args,outcome.key);
   created=accepted;verifiedCreated=true;pending=undefined;if(kind==="role"&&value?.status==="active")host.roleCreated(value);host.changed();await host.flush();
  }catch(error){if(current(owner)){pending=await host.operation(references[kind]).catch(()=>undefined);if(current(owner))host.error(error);}}
  finally{if(current(owner)){busy=false;render();}}
 }
 function field(form:HTMLElement,label:string,key:keyof Draft,kind:"text"|"textarea"|"number"="text",max=32768):void {
  const state=drafts[screen!],id=`persona-create-${key}`,wrapper=element("div",{className:"field"});wrapper.append(element("label",{htmlFor:id,className:"ui-label"},label));
  const input=kind==="textarea"?element("textarea",{id,rows:key==="instructions"?5:3,value:String(state[key]),maxlength:max}):element("input",{id,type:kind,value:String(state[key]),...(key==="name"?{required:true,maxlength:255}:{}),...(kind==="number"?{min:1,max:200,step:1}:{})});
  input.addEventListener("input",()=>{if(!screen||busy||pending)return;const target=drafts[screen];if(key==="maxItems")target.maxItems=Number(input.value);else (target as unknown as Record<string,unknown>)[key]=input.value;host.changed();},{signal:events.signal});wrapper.append(input);form.append(wrapper);
 }
 function checkbox(form:HTMLElement,label:string,key:"writeMemory"|"available"):void {
  const state=drafts[screen!],id=`persona-create-${key}`,wrapper=element("label",{className:"choice",htmlFor:id}),input=element("input",{id,type:"checkbox",checked:state[key]});input.addEventListener("change",()=>{if(screen&&!busy&&!pending){drafts[screen][key]=input.checked;host.changed();}},{signal:events.signal});wrapper.append(input,element("span",{},label));form.append(wrapper);
 }
 function render():void {
  if(!screen||disposed)return;const kind=screen,editable=!busy&&!pending&&!created;
  host.setPage({title:created&&verifiedCreated?`${kind==="role"?"Role":"Persona"} created`:kind==="role"?"Create role":"Create Persona",back:{id:"back",label:"Back to Personas",intent:"navigate",execute:close},actions:created?[]:[{id:kind==="role"?"create-role":"create-persona",label:kind==="role"?"Create role":"Create Persona",labelVisibility:"text",intent:"mutation",disabled:!editable||!allowed()||!matchingOrganization()||!host.lifecycle.permissions().mutate,execute:submit}]});
  host.context.setAttribute("aria-busy",String(busy));
  if(created&&verifiedCreated&&access){host.context.replaceChildren(element("p",{className:"ui-value"},created.name),element("p",{className:"ui-caption"},created.kind==="person"?(created.status==="active"?"Available in chat. Return to Personas to choose it.":"Saved as a draft. It is not available in chat yet."):"The role is ready for a new Persona."));return;}
  let root=host.context.querySelector<HTMLElement>("[data-persona-authoring]");if(!root||root.dataset.personaAuthoring!==kind){
   host.context.replaceChildren();root=element("section",{className:"ui-stack min-w-0",dataset:{personaAuthoring:kind},"aria-label":kind==="role"?"Create role form":"Create Persona form"});root.append(element("div",{id:"persona-authoring-access",className:"ui-callout ui-stack"}),element("p",{id:"persona-authoring-pending",className:"ui-callout"}),element("p",{id:"persona-authoring-activity",className:"activity",role:"status","aria-live":"polite"}));
   const form=element("form",{id:"persona-authoring-form",className:"ui-stack min-w-0"});form.addEventListener("submit",event=>{event.preventDefault();void submit().catch(host.error);},{signal:events.signal});field(form,"Name","name","text",255);field(form,"Description","description","textarea",4096);
   if(kind==="role")field(form,"Instructions","instructions","textarea");else {
    const wrapper=element("div",{className:"field"}),select=element("select",{id:"persona-create-roleId",required:true,className:"min-w-0"});wrapper.append(element("label",{htmlFor:select.id,className:"ui-label"},"Role"),select);select.addEventListener("change",()=>{if(screen&&!busy&&!pending){drafts.person.roleId=select.value;host.changed();}},{signal:events.signal});form.append(wrapper);field(form,"Personality","personality","textarea");field(form,"Output style","outputStyle","textarea");checkbox(form,"Available in chat","available");
    const memory=element("details",{className:"ui-disclosure"}),body=element("div",{className:"ui-stack"});memory.append(element("summary",{},"Memory settings"),body);checkbox(body,"Allow memory writing","writeMemory");const memoryForm=element("div",{className:"ui-stack"});body.append(memoryForm);field(memoryForm,"Maximum memories","maxItems","number");field(memoryForm,"Memory instructions","memoryInstruction","textarea");form.append(memory);
   }
   form.append(element("button",{type:"submit",hidden:true,"aria-hidden":"true"},"Create"));root.append(form);host.context.append(root);
  }
  const accessNode=root.querySelector<HTMLElement>("#persona-authoring-access")!,permissionDetails=accessNode.querySelector<HTMLDetailsElement>("details"),detailsFocused=permissionDetails?.querySelector("summary")===document.activeElement;accessNode.replaceChildren();
  if(!access){accessNode.append(element("p",{},busy?"Checking creation access…":"Creation access could not be verified. Refresh to retry."));if(permissionDetails){permissionDetails.hidden=true;accessNode.append(permissionDetails);}}
  else if(!matchingOrganization())accessNode.textContent="This form belongs to another organization. Close it before creating in the selected organization.";
  else if(!allowed()){accessNode.append(element("h2",{className:"ui-value"},`Allow creation in ${access.organizationName}`),element("p",{className:"ui-caption"},`Allow Loomex on this Mac to create roles and Personas in ${access.organizationName}. Existing chat access stays unchanged.`));const details=permissionDetails??element("details",{className:"ui-disclosure"});details.hidden=false;if(!permissionDetails)details.append(element("summary",{},"Permission details"),element("p",{className:"ui-caption"}));details.querySelector("p")!.textContent=`Adds runner.personas.manage to the existing Loomex installation grant on this Mac for ${access.organizationName}.`;const grantButton=element("button",{type:"button",className:"secondary action-with-label",disabled:busy||Boolean(pending)||!host.lifecycle.permissions().mutate,dataset:{businessMutation:"true"}});grantButton.append(createIcon(ACTIONS.grant.icon),element("span",{className:"action-label"},"Allow creation"));grantButton.addEventListener("click",()=>void grant().catch(host.error),{signal:events.signal});accessNode.append(grantButton,details);if(detailsFocused)details.querySelector("summary")?.focus({preventScroll:true});}
  else accessNode.textContent=`Creating in ${access.organizationName}.`;
  const pendingNode=root.querySelector<HTMLElement>("#persona-authoring-pending")!;pendingNode.hidden=!pending;pendingNode.textContent="A saved operation needs reconciliation. Refresh checks its exact result; do not create another item.";
  const activity=root.querySelector<HTMLElement>("#persona-authoring-activity")!;activity.hidden=!busy||!access;activity.textContent=busy?"Checking this creation…":"";
  for(const input of root.querySelectorAll<HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement>("input,textarea,select"))input.disabled=!editable;
  const role=root.querySelector<HTMLSelectElement>("#persona-create-roleId");if(role){const value=drafts.person.roleId;role.replaceChildren(element("option",{value:""},"Choose an active role"));for(const candidate of host.roles())if(uuid(candidate.id)&&candidate.status==="active"&&candidate.organizationId===access?.organizationId)role.append(element("option",{value:candidate.id},text(candidate.name,255)));role.value=value;}
 }
 async function restore(saved:unknown,ownerCurrent:()=>boolean):Promise<void> {
  ++generation;busy=false;access=undefined;pending=undefined;const state=object(saved),rawReferences=object(state?.operations),rawDrafts=object(state?.drafts);drafts={role:draft(rawDrafts?.role),person:draft(rawDrafts?.person)};references={};for(const kind of ["role","person"] as const){const ref=object(rawReferences?.[kind]);if(ref&&uuid(ref.operationId)&&uuid(ref.key)&&(ref.method===(kind==="role"?"persona.roles.create":"personas.create")||ref.method==="auth.scope_upgrade"))references[kind]={operationId:ref.operationId,method:String(ref.method),key:ref.key};}screen=state?.screen==="role"||state?.screen==="person"?state.screen:undefined;created=undefined;verifiedCreated=false;
  const value=object(state?.created);if(value&&(value.kind==="role"||value.kind==="person")&&uuid(value.organizationId)&&uuid(value.id)&&uuid(value.key))created={kind:value.kind,organizationId:value.organizationId,id:value.id,key:value.key,name:text(value.name,255),status:text(value.status,32)};
  if(screen)await refresh(ownerCurrent);
 }
 return {open,close,refresh,render,capture,restore,isOpen:()=>Boolean(screen),display:()=>({screen:screen?"create":"list",title:screen==="role"?"Create role":"Create Persona"}),dispose(){disposed=true;++generation;events.abort();}};
}

import { createPersonaAuthoring, type PersonaAuthoringServices } from "./persona-authoring.js";
import { createPagination, createUiElement as element } from "./components.js";
import { personaChatMessage, type PersonaContextReference } from "./persona-context.js";
import type { JsonObject } from "./contracts.js";
import type { RpcResult } from "./page-models.js";
import type { ViewRestorationCoordinator } from "./persistence.js";
import { ACTIONS, createIcon, type ActionId, type PagePresentation } from "./shell.js";

const NIL = "00000000-0000-0000-0000-000000000000";
const uuid = (value:unknown):value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const object = (value:unknown):JsonObject|undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
const text = (value:unknown,max=240):string => typeof value === "string" ? value.slice(0,max) : "";
interface Person extends JsonObject {id:string;organizationId:string;roleId:string;name:string;status:string;roleSummary:JsonObject;}
interface Role extends JsonObject {id:string;name:string;status:string;}
interface Args extends JsonObject {query?:string;roleId?:string;cursor?:string;limit:number;}
/** Public role copy only; effective prompts and memory never enter presentation. */
export function personaDisplayCopy(person:JsonObject,role?:JsonObject):{role:string;description:string} {
  const summary=object(person.roleSummary);
  return {role:text(summary?.name)||text(person.role)||text(role?.name)||"AI Persona",description:text(summary?.description,4096)||text(role?.description,4096)};
}
function activePerson(value:unknown,roleId?:string):value is Person { const p=object(value),r=object(p?.roleSummary);return Boolean(p&&uuid(p.id)&&uuid(p.organizationId)&&uuid(p.roleId)&&p.status==="active"&&r?.status==="active"&&r.id===p.roleId&&typeof p.name==="string"&&(!roleId||p.roleId===roleId)); }
function reference(value:unknown):PersonaContextReference|undefined { const p=object(value);return p&&uuid(p.personId)&&uuid(p.organizationId)&&uuid(p.conversationId)&&uuid(p.chatId)&&typeof p.configDigest==="string"&&/^[a-f0-9]{64}$/.test(p.configDigest) ? {personId:p.personId,organizationId:p.organizationId,conversationId:p.conversationId,chatId:p.chatId,configDigest:p.configDigest}:undefined; }
export function personaContextReference(data:JsonObject, personId?:string):PersonaContextReference {
  const p=object(data.person),c=object(data.conversation);
  const ref=reference({personId:p?.id,organizationId:p?.organizationId,conversationId:c?.conversationId,chatId:c?.chatId,configDigest:data.configDigest});
  if(!ref||!activePerson(p)||personId&&ref.personId!==personId||data.contractVersion!=="loomex.ai-persona-chat/v1")throw new Error("The Persona context could not be verified. Refresh before continuing.");
  return ref;
}
export interface PersonaControllerServices {
  lifecycle:ViewRestorationCoordinator;
  elements:{context:HTMLElement;form:HTMLFormElement;summary:HTMLElement;primary:HTMLButtonElement;secondary:HTMLButtonElement;refresh:HTMLButtonElement};
  call(name:string,args:JsonObject):Promise<RpcResult>;
  data(result:RpcResult):JsonObject;
  failed(result:RpcResult):boolean;
  session(result?:RpcResult):JsonObject|undefined;
  configure(session:JsonObject):void;
  flush():Promise<boolean>;
  create(personId:string,key:string):Promise<RpcResult>;
  settleCreate(response:JsonObject):Promise<void>;
  restoredCreateKey(personId:string):Promise<string|undefined>;
  deliver(ref:PersonaContextReference,text:string):Promise<string>;
  messageAvailable():boolean;
  setPage(presentation:PagePresentation):void;
  changed():void;
  error(error:unknown):void;
  uuid():string;
  managementAccess:PersonaAuthoringServices["access"];
  managementMutate:PersonaAuthoringServices["mutate"];
  managementOperation:PersonaAuthoringServices["operation"];
  settleManagement:PersonaAuthoringServices["settle"];
  managementAvailable():Promise<boolean>;
  openManagement(path:"persons"|"persona-roles"|"memory"):Promise<void>;
}
/** One picker, shared shell and lifecycle. Durable state contains references only. */
export function createPersonaController(host:PersonaControllerServices) {
  let args:Args={limit:5},history:Args[]=[],persons:Person[]=[],roles:Role[]=[],nextCursor:string|null=null;
  let selected:Person|undefined,contextRef:PersonaContextReference|undefined,readStale=false,busy=false,disposed=false,epoch=0,listLoaded=false;
  let focusReturn:string|undefined;
  let createKey:string|undefined;
  let ownedErrorMessage:string|undefined;
  let opened=false,managementReady=false,managementEpoch=0;
  const events=new AbortController();
  const {context,form,summary,primary,secondary,refresh}=host.elements;
  function reportError(error:unknown):void {ownedErrorMessage=error instanceof Error?error.message:undefined;host.error(error);}
  function clearOwnedError():void {if((ownedErrorMessage&&summary.textContent===ownedErrorMessage)||summary.textContent==="Loading this view…"){summary.textContent="";summary.classList.remove("error");summary.setAttribute("role","status");}ownedErrorMessage=undefined;}
  const authoring=createPersonaAuthoring({lifecycle:host.lifecycle,context,call:checked,access:host.managementAccess,mutate:host.managementMutate,operation:host.managementOperation,settle:host.settleManagement,failed:host.failed,data:host.data,flush:host.flush,changed:host.changed,error:reportError,setPage:host.setPage,roles:()=>roles,roleCreated:role=>{if(uuid(role.id)&&role.status==="active"&&typeof role.name==="string")roles=[...roles.filter(r=>r.id!==role.id),role as Role];},close:()=>{context.replaceChildren();render();void list();}});
  function capture():JsonObject {return {authoring:authoring.capture(),args:{...args},history:history.map(a=>({...a})),...(selected?{personId:selected.id,organizationId:selected.organizationId}:{}),...(contextRef?{context:contextRef}:{})};}
  function copy(person:Person){return personaDisplayCopy(person,roles.find(role=>role.id===person.roleId));}
  function display():JsonObject {if(authoring.isOpen())return authoring.display();return {screen:selected?"detail":"list",entityId:null,title:selected?.name??"AI Personas",rows:persons.slice(0,5).map(p=>({id:p.id,name:p.name,description:copy(p).role}))};}
  async function checked(name:string,params:JsonObject):Promise<JsonObject> {const result=await host.call(name,params);if(host.failed(result))throw new Error(text(object(result.structuredContent?.error)?.message,1024)||"Persona information could not be loaded. Refresh to retry.");return host.data(result);}
  function savedFocus(){const active=document.activeElement;if(!(active instanceof HTMLElement)||(!context.contains(active)&&active!==refresh))return;return {element:active,id:active.id,...(active instanceof HTMLInputElement?{start:active.selectionStart,end:active.selectionEnd,direction:active.selectionDirection}:{})};}
  function restoreFocus(focus:ReturnType<typeof savedFocus>){if(!focus||document.activeElement!==document.body&&document.activeElement!==focus.element)return;let target=focus.id?document.getElementById(focus.id):null;if(target instanceof HTMLButtonElement&&target.disabled)target=document.getElementById("persona-page-info");if(!(target instanceof HTMLElement))return;if(target instanceof HTMLOutputElement)target.tabIndex=-1;target.focus({preventScroll:true});if(target instanceof HTMLInputElement&&target!==focus.element&&focus.start!==undefined&&focus.start!==null&&focus.end!==undefined&&focus.end!==null)target.setSelectionRange(focus.start,focus.end,focus.direction??undefined);}
  async function list(ownerGeneration?:number,requireVerifiedRead=false):Promise<void> {
    const focus=savedFocus(),generation=ownerGeneration??++epoch;busy=true;render();
    try {
      const data=await checked("loomex_personas_list",args);
      if(disposed||generation!==epoch)return;
      if(!Array.isArray(data.personas)||data.personas.some(p=>!activePerson(p,args.roleId))||(data.nextCursor!==null&&typeof data.nextCursor!=="string"))throw new Error("The active Persona list could not be verified.");
      persons=(data.personas as Person[]).slice(0,5);nextCursor=data.nextCursor as string|null;readStale=false;listLoaded=true;clearOwnedError();
    }catch(error){if(generation===epoch){readStale=true;reportError(error);if(requireVerifiedRead)throw error;}}finally{if(generation===epoch){busy=false;render();restoreFocus(focus);}}
  }
  async function detail(personId:string,ownerGeneration?:number,requireVerifiedRead=false,expectedOrganization?:string):Promise<void> {
    const focus=savedFocus(),navigating=!selected,generation=ownerGeneration??++epoch;busy=true;render();
    try {const data=await checked("loomex_persona_get",{personId});if(disposed||generation!==epoch)return;if(!activePerson(data.person)||data.person.id!==personId||expectedOrganization&&data.person.organizationId!==expectedOrganization)throw new Error("This Persona is no longer active. Choose another Persona.");selected=data.person;contextRef=contextRef?.personId===personId?contextRef:undefined;readStale=false;clearOwnedError();host.changed();}
    catch(error){if(generation===epoch){readStale=true;reportError(error);if(requireVerifiedRead)throw error;}}finally{if(generation===epoch){busy=false;render();if(selected&&navigating&&focus?.id.startsWith("persona-view-")){focusReturn=focus.id;const title=document.getElementById("title");if(title instanceof HTMLElement){title.tabIndex=-1;title.focus({preventScroll:true});}}else restoreFocus(focus);}}
  }
  async function inspect(ref:PersonaContextReference,current=()=>!disposed):Promise<PersonaContextReference> {
    const data=await checked("loomex_persona_context_get",{personId:ref.personId,conversationId:ref.conversationId,chatId:ref.chatId});
    const fresh=personaContextReference(data,ref.personId);
    if(fresh.organizationId!==ref.organizationId||fresh.conversationId!==ref.conversationId||fresh.chatId!==ref.chatId)throw new Error("The saved Persona context belongs to a different conversation.");
    if(current())selected=data.person as Person;return fresh;
  }
  async function use():Promise<void> {
    if(!selected||readStale||busy||!host.lifecycle.permissions().mutate)throw new Error("Refresh this Persona before using it in this chat.");
    if(!host.messageAvailable())throw new Error("This host cannot send the Persona selection to this chat. Use the Persona skill in chat to choose this Persona.");
    const personId=selected.id,generation=++epoch;busy=true;render();
    try {
      const savedSelection=await host.flush();if(disposed||generation!==epoch)return;if(!savedSelection)throw new Error("The selected Persona could not be saved. Restore the saved card before continuing.");
      if(!contextRef){
        const recoveredKey=await host.restoredCreateKey(personId);if(disposed||generation!==epoch)return;
        if(recoveredKey){const receipt=await checked("loomex_persona_operation_get",{operation:"chat_context.create",idempotencyKey:recoveredKey});if(disposed||generation!==epoch)return;if(receipt.operation!=="chat_context.create"||receipt.key!==recoveredKey||receipt.status!=="completed"||!object(receipt.response))throw new Error("The exact context creation needs reconciliation. Refresh before choosing again.");const recovered=personaContextReference(receipt.response as JsonObject,personId);if(recovered.organizationId!==selected?.organizationId)throw new Error("The saved context belongs to a different organization.");await host.settleCreate(receipt.response as JsonObject);if(disposed||generation!==epoch)return;contextRef=recovered;createKey=undefined;}
      }
      if(!contextRef){
        createKey ||= host.uuid();host.changed();
        const savedCreation=await host.flush();if(disposed||generation!==epoch)return;if(!savedCreation)throw new Error("The context creation operation could not be saved.");
        const result=await host.create(personId,createKey);
        if(host.failed(result))throw new Error("The context creation needs reconciliation. Refresh checks the exact saved operation.");
        if(disposed||generation!==epoch)return;
        contextRef=personaContextReference(host.data(result),personId);createKey=undefined;
      }
      const fresh=await inspect(contextRef,()=>!disposed&&generation===epoch);
      if(disposed||generation!==epoch)return;contextRef=fresh;
      host.changed();const savedContext=await host.flush();if(disposed||generation!==epoch)return;if(!savedContext)throw new Error("The Persona context reference could not be saved.");
      const status=await host.deliver(contextRef,personaChatMessage(contextRef));
      if(disposed||generation!==epoch)return;
      clearOwnedError();
      summary.textContent=status==="acknowledged"?"Persona selection sent to this chat.":status==="unknown"?"Chat delivery is uncertain. Refresh checks the saved delivery; do not select again.":"Persona context is ready. Chat delivery needs attention.";
    }catch(error){if(generation===epoch)reportError(error);}finally{if(generation===epoch){busy=false;render();}}
  }
  async function chatFromRow(person:Person):Promise<void>{if(busy||readStale||!host.messageAvailable()||!host.lifecycle.permissions().mutate)return;await detail(person.id,undefined,true,person.organizationId);if(selected?.id!==person.id||selected.organizationId!==person.organizationId||readStale)return;await use();}
  function decorate(button:HTMLButtonElement,label:string,id:ActionId,visible=true):void {
    button.classList.add(visible?"action-with-label":"icon-button",...(visible?[]:["ui-button-icon"]));
    button.setAttribute("aria-label",label);button.title=label;
    button.replaceChildren(createIcon(ACTIONS[id].icon),element("span",{className:visible?"action-label":"sr-only"},label));
  }
  function action(label:string,execute:()=>void|Promise<void>,id:ActionId="next",visible=true):HTMLButtonElement {const button=element("button",{type:"button",className:"secondary"});decorate(button,label,id,visible);button.dataset.persistenceOptional="true";button.disabled=busy;button.addEventListener("click",()=>{if(!busy)void Promise.resolve(execute()).catch(reportError);},{signal:events.signal});return button;}
  function localActivity(label:string):void {
    context.classList.add("workflow-loading-host");context.dataset.retainContent="true";
    context.append(element("p",{className:"activity",role:"status","aria-live":"polite",dataset:{personaLoading:"true"}},label));
  }
  function render():void {
    if(disposed)return;
    primary.hidden=true;secondary.hidden=true;form.hidden=true;form.replaceChildren();context.hidden=false;context.className="ui-stack min-w-0";delete context.dataset.retainContent;context.style.minHeight="";context.setAttribute("aria-label","AI Personas");context.setAttribute("aria-busy",String(busy));refresh.hidden=false;
    if(authoring.isOpen()){authoring.render();return;}
    host.setPage({title:selected?.name??"AI Personas",...(selected?{back:{id:"back",label:"Back to Personas",intent:"navigate",execute:()=>{++epoch;busy=false;selected=undefined;contextRef=undefined;createKey=undefined;readStale=false;host.changed();context.replaceChildren();render();const target=focusReturn?document.getElementById(focusReturn):null;if(target instanceof HTMLElement)target.focus({preventScroll:true});focusReturn=undefined;}}}:{}),actions:[...(!selected?[{id:"edit" as const,label:"Create role",labelVisibility:"text" as const,intent:"navigate" as const,execute:()=>authoring.open("role")},{id:"next" as const,label:"Create Persona",labelVisibility:"text" as const,intent:"navigate" as const,execute:()=>authoring.open("person")}]:[]),...(selected?[{id:"chat" as const,label:contextRef?"Continue in this chat":"Use in this chat",labelVisibility:"text" as const,intent:"mutation" as const,disabled:busy||readStale||!host.messageAvailable()||!host.lifecycle.permissions().mutate,execute:use}]:[]),...(managementReady?[{id:"open" as const,label:"Manage Personas",intent:"navigate" as const,execute:()=>host.openManagement("persons")}]:[])],overflow:managementReady?[{id:"edit",label:"Manage roles",intent:"navigate",execute:()=>host.openManagement("persona-roles")},{id:"review",label:"Manage memory",intent:"navigate",execute:()=>host.openManagement("memory")}]:[]});
    if(selected){
      let detail=context.querySelector<HTMLElement>("[data-persona-detail]");
      if(!detail||detail.dataset.personaDetail!==selected.id){context.replaceChildren();detail=element("section",{className:"ui-stack","aria-label":"Persona details",dataset:{personaDetail:selected.id}});detail.append(element("p",{id:"persona-detail-role",className:"ui-value"}),element("p",{id:"persona-detail-description",className:"ui-caption"}),element("p",{id:"persona-detail-chat",className:"ui-caption"}),element("p",{id:"persona-detail-unavailable",className:"ui-callout"}),element("p",{id:"persona-detail-stale",className:"ui-callout"}));context.append(detail);}
      const displayCopy=copy(selected);detail.querySelector("#persona-detail-role")!.textContent=displayCopy.role;
      const description=detail.querySelector<HTMLElement>("#persona-detail-description")!;description.textContent=displayCopy.description;description.hidden=!displayCopy.description;
      detail.querySelector("#persona-detail-chat")!.textContent=contextRef?"Continue this Persona context with the current chat model.":"Use this Persona with the current chat model.";
      const unavailable=detail.querySelector<HTMLElement>("#persona-detail-unavailable")!;unavailable.textContent="This host cannot send a Persona selection to chat. Use the Persona skill in chat to choose this Persona.";unavailable.hidden=host.messageAvailable();
      const stale=detail.querySelector<HTMLElement>("#persona-detail-stale")!;stale.textContent="Refresh to verify this Persona before using it.";stale.hidden=!readStale;
      context.querySelector('[data-persona-loading]')?.remove();if(busy)localActivity("Checking Persona…");
      return;
    }
    let search=context.querySelector<HTMLFormElement>("#persona-search-form");
    if(busy&&!search){context.replaceChildren();context.classList.add("workflow-loading-host");context.style.minHeight="380px";context.dataset.retainContent="false";const skeleton=element("div",{className:"workflow-skeleton","aria-hidden":"true"});for(let index=0;index<5;index++)skeleton.append(element("div",{className:"skeleton-row"}));context.append(skeleton);return;}
    if(!search){
      context.replaceChildren();search=element("form",{id:"persona-search-form",className:"ui-stack min-w-0",role:"search"});
      const input=element("input",{id:"persona-search",type:"search",className:"min-w-0",value:args.query??"",placeholder:"Search Personas","aria-label":"Search Personas"});
      const role=element("select",{id:"persona-role-filter",className:"min-w-0","aria-label":"Filter by role"});
      const submit=element("button",{id:"persona-search-submit",type:"submit",className:"secondary"});decorate(submit,"Search","search");submit.dataset.persistenceOptional="true";
      const filters=element("div",{className:"workflow-search min-w-0"}),searchActions=element("div",{className:"workflow-search-actions"});searchActions.append(submit);filters.append(input,searchActions);search.append(filters,role);
      search.addEventListener("submit",event=>{event.preventDefault();if(busy)return;args={limit:5,...(input.value.trim()?{query:input.value.trim()}:{}),...(role.value?{roleId:role.value}: {})};history=[];host.changed();void list();},{signal:events.signal});context.append(search);
    }
    context.querySelector('[data-persona-loading]')?.remove();
    if(busy){
      context.classList.add("workflow-loading-host");context.dataset.retainContent="true";
      for(const button of context.querySelectorAll<HTMLButtonElement>('button')){button.setAttribute("aria-disabled","true");if(button!==document.activeElement)button.disabled=true;}
      localActivity("Updating Personas…");return;
    }
    const role=search.querySelector<HTMLSelectElement>("#persona-role-filter")!;const selectedRole=role.options.length?role.value:args.roleId??"";
    role.replaceChildren(element("option",{value:""},"All roles"));for(const r of roles)role.append(element("option",{value:r.id},r.name));role.value=selectedRole;
    search.querySelector<HTMLButtonElement>("#persona-search-submit")!.disabled=false;search.querySelector("#persona-search-submit")!.removeAttribute("aria-disabled");
    context.querySelector('[data-persona-rows]')?.remove();context.querySelector('[data-persona-pages]')?.remove();context.querySelector('[data-persona-empty]')?.remove();context.querySelector('[data-persona-stale]')?.remove();
    if(readStale)context.append(element("p",{className:"ui-callout",dataset:{personaStale:"true"}},listLoaded?"Showing the last loaded Personas. Refresh to check the latest list.":"The Persona list could not be loaded. Refresh to retry."));
    const rows=element("ul",{className:"workflow-rows","aria-label":"Active Personas",dataset:{personaRows:"true"}});for(const p of persons){const item=element("li",{className:"workflow-row"}),rowCopy=element("div",{className:"workflow-row-copy"}),displayCopy=copy(p);rowCopy.append(element("h3",{className:"ui-value"},p.name),element("p",{className:"ui-meta"},displayCopy.role));if(displayCopy.description)rowCopy.append(element("p",{className:"ui-caption"},displayCopy.description));const choose=action(`Choose ${p.name}`,()=>detail(p.id,undefined,false,p.organizationId),"results",false);choose.id=`persona-view-${p.id}`;const actions=element("div",{className:"workflow-row-actions"});const chat=action(`Chat with ${p.name}`,()=>chatFromRow(p),"chat",false);chat.id=`persona-chat-${p.id}`;delete chat.dataset.persistenceOptional;chat.dataset.businessMutation="true";chat.disabled=readStale||!host.messageAvailable()||!host.lifecycle.permissions().mutate;actions.append(chat,choose);item.append(rowCopy,actions);rows.append(item);}context.append(rows);
    if(!persons.length&&listLoaded&&!readStale)context.append(element("p",{className:"ui-callout",dataset:{personaEmpty:"true"}},"No active Personas match this search."));
    const previous=action("Previous",()=>{args=history.pop()!;host.changed();return list();},"back"),next=action("Next",()=>{if(!nextCursor)return;history.push({...args});args={...args,cursor:nextCursor};host.changed();return list();});previous.id="persona-previous";next.id="persona-next";previous.disabled=history.length===0||readStale;next.disabled=nextCursor===null||readStale;
    const pages=createPagination({ariaLabel:"Persona pages",summary:`Page ${history.length+1} · ${persons.length} Persona${persons.length===1?"":"s"}`,summaryId:"persona-page-info",summaryLive:"polite",previous,next});pages.classList.add("min-w-0");pages.dataset.personaPages="true";context.append(pages);
  }
  async function restore(saved:JsonObject,current:()=>boolean,ownerGeneration?:number):Promise<void> {
    const state=object(saved.personas),savedArgs=object(state?.args);
    args=savedArgs?{limit:5,...(typeof savedArgs?.query==="string"?{query:text(savedArgs.query,4096)}:{}),...(uuid(savedArgs?.roleId)?{roleId:savedArgs.roleId}:{}),...(typeof savedArgs?.cursor==="string"?{cursor:savedArgs.cursor}:{})}:args;
    history=Array.isArray(state?.history)?state.history.flatMap(v=>{const a=object(v);return a?[{limit:5,...(typeof a.query==="string"?{query:a.query}:{}),...(uuid(a.roleId)?{roleId:a.roleId}:{}),...(typeof a.cursor==="string"?{cursor:a.cursor}:{})}]:[]}):[];
    contextRef=reference(state?.context);const savedKey=!contextRef&&uuid(state?.personId)?await host.restoredCreateKey(state.personId):undefined;if(!current())return;createKey=savedKey;
    const roleData=await checked("loomex_persona_roles_list",{limit:100});if(!current())return;
    roles=Array.isArray(roleData.roles)?roleData.roles.flatMap(v=>{const r=object(v);return r&&uuid(r.id)&&r.status==="active"&&typeof r.name==="string"?[r as Role]:[]}):[];
    await authoring.restore(state?.authoring,current);if(!current())return;if(authoring.isOpen())return;
    if(createKey){const receipt=await checked("loomex_persona_operation_get",{operation:"chat_context.create",idempotencyKey:createKey});if(!current())return;if(receipt.operation!=="chat_context.create"||receipt.key!==createKey||receipt.status!=="completed"||!object(receipt.response))throw new Error("The exact Persona creation has no confirmed result. Refresh again before creating another context.");contextRef=personaContextReference(object(receipt.response)!,uuid(state?.personId)?state.personId:undefined);if(contextRef.organizationId!==state?.organizationId)throw new Error("The creation receipt belongs to a different organization.");await host.settleCreate(receipt.response as JsonObject);if(!current())return;createKey=undefined;host.changed();}
    if(contextRef){const fresh=await inspect(contextRef,current);if(!current())return;contextRef=fresh;host.changed();}
    // Authority restoration must fail with its exact target read. Interactive
    // browsing can retain stale rows, but cannot turn a failed refresh into a
    // successful lifecycle verification merely by displaying its error.
    else if(uuid(state?.personId)){await detail(state.personId,ownerGeneration,true);if(!current())return;if(selected?.organizationId!==state?.organizationId)throw new Error("The saved Persona belongs to a different organization.");}
    else {selected=undefined;await list(ownerGeneration,true);}
  }
  async function receive(result:RpcResult,retained?:JsonObject):Promise<void> {
    const data=host.data(result);
    if(!opened){const query=object(result._meta?.["loomex/personaListQuery"]);if(query)args={limit:5,...(typeof query.query==="string"?{query:query.query}:{}),...(uuid(query.roleId)?{roleId:query.roleId}: {})};}
    if(data.conversation){return;}// Creation is consumed by its exact in-flight operation.
    const supplied=host.session(result);
    if(opened&&!supplied)return; // Exact in-flight mutations consume their own response; never remount this card from a write.
    ++epoch;busy=false;readStale=false;
    if(!retained){selected=undefined;contextRef=undefined;createKey=undefined;persons=[];roles=[];nextCursor=null;listLoaded=false;focusReturn=undefined;context.replaceChildren();}
    if(!supplied||supplied.kind!=="personas"||supplied.entityType!=="catalog"||supplied.entityId!==NIL){host.lifecycle.unavailable();render();host.error(new Error("The Persona card could not be saved. Refresh or reopen it to restore its owner binding."));return;}
    host.configure(supplied);opened=true;
    busy=true;
    const managementGeneration=++managementEpoch;
    void host.managementAvailable().catch(()=>false).then(available=>{if(!disposed&&managementGeneration===managementEpoch){managementReady=available;render();}});
    await host.lifecycle.open({mode:"personas",identity:String(supplied.viewSessionId),domainIdentity:"personas:catalog",snapshot:async()=>supplied,display:()=>{render();return "verifying";},verify:async(_,fence)=>{const fresh=await checked("loomex_view_session_get",{viewSessionId:supplied.viewSessionId});if(!fence.current())return "read_only";if(fresh.kind!=="personas"||fresh.entityType!=="catalog"||fresh.entityId!==NIL||fresh.viewSessionId!==supplied.viewSessionId)throw new Error("The Persona card belongs to a different session.");host.configure(fresh);const state=object(fresh.state)??{};await restore(retained?{...state,personas:{...object(state.personas),...retained}}:state,fence.current);return fence.current()?"ready":"read_only";},ready:()=>{busy=false;render();},failed:(_,error)=>{busy=false;readStale=true;render();reportError(error);}});
  }
  async function refreshView():Promise<void> {
    const session=host.session();if(!session){const result=await host.call("loomex_personas_view",args);await receive(result);return;}
    if(!["ready","read_only"].includes(host.lifecycle.state.phase)){
      const retained=capture();await receive({structuredContent:{ok:true,data:{}},_meta:{"loomex/viewSession":session}},retained);return;
    }
    const generation=++epoch,focus=savedFocus(),retained=capture();busy=true;render();
    try{
      await host.lifecycle.refresh("persona-authority",async()=>{
        const fresh=await checked("loomex_view_session_get",{viewSessionId:session.viewSessionId});
        if(disposed||generation!==epoch)return;
        if(fresh.kind!=="personas"||fresh.entityType!=="catalog"||fresh.entityId!==NIL||fresh.viewSessionId!==session.viewSessionId)throw new Error("The Persona card belongs to a different session.");
        // A read refresh retains the visible navigation even if its debounced
        // save has not landed. Context and operation authority are still read
        // by restore from the exact owner-bound session and saved receipt.
        host.configure(fresh);const state=object(fresh.state)??{};await restore({...state,personas:retained},()=>!disposed&&generation===epoch,generation);
      },()=>{if(generation===epoch){readStale=false;clearOwnedError();}});
    }catch(error){if(generation===epoch){readStale=true;reportError(error);}}
    finally{if(generation===epoch){busy=false;render();restoreFocus(focus);}}
  }
  return {receive,refresh:refreshView,capture,display,render,dispose(){disposed=true;++epoch;authoring.dispose();events.abort();}};
}

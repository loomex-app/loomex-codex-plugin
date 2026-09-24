import type { ActionId } from "./shell.js";
import { z } from 'zod';
import type { JsonObject, ViewSessionProjection } from './contracts.js';
import { ViewPersistenceController, ViewRestorationCoordinator } from './persistence.js';
import { clampPageIndex, createPagination, createUiElement as element } from './components.js';
import { decodeUiResult, decodeUiError, UiResultDecodeError, UiTransportError } from './result-decoder.js';

type Page = 'connection' | 'organizations';
type Action = () => void | Promise<void>;
type Fault = {status:string; code:string; message:string; retryable?:boolean};
const organizationSchema=z.object({id:z.uuid(),name:z.string().trim().min(1).max(240).nullable(),enrolled:z.boolean()});
const loginSchema=z.object({flowId:z.string().min(1).max(128),authorizationUrl:z.string().url().nullable().optional(),expiresAt:z.number().int().nonnegative()});
const projectionSchema=z.object({schemaVersion:z.literal('loomex.runner.connection/v2'),state:z.enum(['signed_out','browser_pending','authentication_completing','verification_expired','authenticated','recovery_pending','logout_pending','credential_store_unavailable']),activeWork:z.number().int().min(0).max(1000000),actions:z.array(z.enum(['auth.login','auth.cancel','auth.recover','auth.logout','organizations.list','organizations.select'])).max(8),organization:z.object({status:z.enum(['organization_required','connected']),selected:z.object({id:z.uuid(),name:z.string().trim().min(1).max(240).nullable()}).nullable()}),organizations:z.array(organizationSchema),login:loginSchema.nullable(),webAppUrl:z.unknown().optional()});
type RawProjection=z.infer<typeof projectionSchema>;
type Projection=Omit<RawProjection,'actions'|'organizations'|'webAppUrl'> & {actions:Set<string>;organizations:Array<{id:string;name:string}>; webAppUrl:string|undefined};
const pendingSchema=z.object({name:z.enum(['loomex_auth_start','loomex_auth_cancel','loomex_auth_recover','loomex_auth_logout','loomex_organization_select']),args:z.record(z.string(),z.unknown()),key:z.uuid()});
type Pending=z.infer<typeof pendingSchema>;
const sessionSchema=z.object({viewSessionId:z.uuid(),revision:z.number().int().nonnegative(),kind:z.enum(['connection','organizations']),state:z.record(z.string(),z.unknown()).default({})});
export interface ConnectionServices {
 persistenceStatus(status: import("./persistence.js").PersistenceStatus,error?: import("./persistence.js").PersistenceError):void;
 lifecycle?:ViewRestorationCoordinator;
 mode:Page;
 elements:{context:HTMLElement;title:HTMLElement;headerStage:HTMLElement;headerStatus:HTMLElement;form:HTMLFormElement;refresh:HTMLButtonElement;primary:HTMLButtonElement;secondary:HTMLButtonElement;summary:HTMLElement};
 connected():boolean;
 hostCapabilities():JsonObject;
 callTool(name:string,args:JsonObject,renderResult?:boolean,observeResult?:boolean,activity?:"foreground"|"background"):Promise<unknown>;
 send(method:string,args:JsonObject,request?:boolean,options?:{activity:boolean}):Promise<unknown>;
 setAction(button:HTMLButtonElement,label:string,id?:ActionId):void;
 syncChrome():void;
 setError(error:unknown):void;
 clearError():void;
 viewPersistenceFault(result:unknown):Fault|null;
 enterSafeViewReentry(fault:Fault):void;
 renderSafeViewReentry():void;
 reentry():boolean;
 clearReentry():void;
 onProjection(data:JsonObject):void;
 onRender():void;
}
export interface ConnectionState {
 page:Page;candidate:string;query:string;pageIndex:number;busy:boolean;pending:Pending|null;projection:Projection|null;
 list:Array<{id:string;name:string;slug:string}>;listState:'idle'|'loading'|'loaded'|'failed';
 viewSession:ViewSessionProjection|null;
 persistence:ViewPersistenceController|null;action:Action|null;secondaryAction:Action|null;structure:string;
}
function record(value:unknown):JsonObject {return value!==null&&typeof value==='object'&&!Array.isArray(value)?value as JsonObject:{};}
function safeText(value:unknown,limit=4096):string {return typeof value==='string'&&value.trim().length<=limit?value.trim():'';}
function publicHttpUrl(value:unknown) {
    if (!safeText(value, 4096)) return undefined;
    try {
      const url = new URL(safeText(value));
      return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : undefined;
    } catch { return undefined; }
  }

/**
 * Some MCP Apps bridges omit object properties whose protocol value is null.
 * `organization.selected` and `login` are the only nullable fields needed to
 * render a connection card, so restore only an *absent* value here. A present
 * value of the wrong type still reaches Zod and is rejected.
 */
function restoreElidedConnectionNulls(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const supplied = value as Record<string, unknown>;
  const organization = supplied.organization;
  const normalizedOrganization = organization !== null && typeof organization === "object" && !Array.isArray(organization)
    ? organization as Record<string, unknown>
    : organization;
  return {
    ...supplied,
    ...(!Object.hasOwn(supplied, "login") ? { login: null } : {}),
    ...(normalizedOrganization !== null && typeof normalizedOrganization === "object" && !Array.isArray(normalizedOrganization)
      && !Object.hasOwn(normalizedOrganization, "selected")
      ? { organization: { ...normalizedOrganization, selected: null } }
      : {}),
  };
}

export function normalizedConnection(value:unknown):Projection|undefined {
    const result=projectionSchema.safeParse(restoreElidedConnectionNulls(value)); if(!result.success)return undefined;
    const data=result.data;
    if(new Set(data.actions).size!==data.actions.length || new Set(data.organizations.map(o=>o.id)).size!==data.organizations.length)return undefined;
    if(data.organization.status==='connected'&&!data.organization.selected)return undefined;
    if((data.state==='browser_pending'||data.state==='authentication_completing')&&!data.login)return undefined;
    if(data.login?.authorizationUrl&&!publicHttpUrl(data.login.authorizationUrl))return undefined;
    return {...data,actions:new Set(data.actions),webAppUrl:publicHttpUrl(data.webAppUrl),organizations:data.organizations.map(o=>({id:o.id,name:o.name||'Unnamed organization'}))};
  }

function connectionProjection(value: unknown): Projection {
  const projection = normalizedConnection(value);
  if (projection) return projection;
  // Validation paths are fixed protocol fields only; do not surface data from a
  // connection payload in the card or its diagnostic.
  const parsed = projectionSchema.safeParse(restoreElidedConnectionNulls(value));
  const fields = parsed.success
    ? ["semantic_connection_invariant"]
    : [...new Set(parsed.error.issues.map((issue) => String(issue.path[0] || "root")))].filter((field) => [
      "schemaVersion", "state", "organization", "organizations", "activeWork", "actions", "login", "webAppUrl",
    ].includes(field));
  throw new UiResultDecodeError("The connection data from Loomex was incomplete or invalid.", {
    format: "loomex/ui-result-diagnostic/v1", stage: "projection", channel: "connection", code: "CONNECTION_PROJECTION_INVALID", fields,
  });
}

function connectionChanged(previous:Projection|null,current:Projection):boolean {
  if (!previous) return true;
  const display=(projection:Projection)=>JSON.stringify({
    state:projection.state,login:projection.login,actions:[...projection.actions].sort(),
    organization:projection.organization,organizations:projection.organizations,
    activeWork:projection.activeWork,webAppUrl:projection.webAppUrl,
  });
  return display(previous)!==display(current);
}

export function createConnectionController(host:ConnectionServices) {
 const {context,title,headerStage,headerStatus,form,refresh,primary,secondary,summary}=host.elements;
 const {setAction,syncChrome,viewPersistenceFault,enterSafeViewReentry,renderSafeViewReentry}=host;
 const callTool=host.callTool.bind(host),send=host.send.bind(host),uuid=()=>{if(!globalThis.crypto?.randomUUID)throw new Error("This host cannot generate a secure operation identity.");return crypto.randomUUID();};
 const connectionState:ConnectionState={page:host.mode,candidate:'',query:'',pageIndex:0,busy:false,pending:null,projection:null,list:[],listState:'idle',viewSession:null,persistence:null,action:null,secondaryAction:null,structure:''};
 const lifecycle=host.lifecycle ?? new ViewRestorationCoordinator();
 let connectionPollTimer:ReturnType<typeof setTimeout>|null=null,connectionPollFlowId='',connectionPollInFlight=false;
 let disposed=false;
 const unsubscribe=lifecycle.subscribe(state=>{
   if(disposed)return;
   if(["ready","read_only","verification_failed"].includes(state.phase))renderConnectionPage();
 });
 type ConnectionErrorKind = 'observation' | 'browser' | 'organizations' | 'operation' | 'presentation';
 let connectionError:unknown;
 let connectionErrorKind:ConnectionErrorKind|undefined;
 const setError=(error:unknown,kind:ConnectionErrorKind='operation')=>{connectionError=error;connectionErrorKind=kind;host.setError(error);};
 const clearConnectionError=()=>{connectionError=undefined;connectionErrorKind=undefined;host.clearError();};
 const actions=new WeakMap<HTMLButtonElement,Action>();
  function clearConnectionPoll() {
    if (connectionPollTimer !== null) clearTimeout(connectionPollTimer);
    connectionPollTimer = null;
    connectionPollFlowId = "";
    lifecycle.request("authentication-poll");
  }

  function hostCanOpenExternalLink() {
    const capabilities=host.hostCapabilities();
    return Object.hasOwn(capabilities,"openLinks") && capabilities.openLinks !== null && typeof capabilities.openLinks === "object";
  }

  async function openExternalLink(url:string) {
    if (!hostCanOpenExternalLink()) throw new Error("This host cannot open an external link. Copy the displayed URL into your browser.");
    try {
      const response=await send("ui/open-link", { url }, true, { activity: false });
      if(record(response).isError===true)throw new Error("BROWSER_OPEN_REJECTED");
    } catch(error) {
      // The host may include the authorization URL in its error. Never put
      // that value in the card's error or support details.
      const code=error instanceof UiTransportError&&error.code==="HOST_TIMEOUT"?"BROWSER_OPEN_TIMEOUT"
        :error instanceof Error&&error.message==="BROWSER_OPEN_REJECTED"?"BROWSER_OPEN_REJECTED":"BROWSER_OPEN_HOST_ERROR";
      throw new UiTransportError({code,message:"The browser could not be opened. Use the link in this card instead.",retryable:true},
        {format:"loomex/ui-result-diagnostic/v1",stage:"error",channel:"connection",code,fields:["host:openLinks","request:ui/open-link"]});
    }
  }
  function announceBrowserOpening(message:string) {
    const status=context.querySelector<HTMLElement>("#browser-open-status");
    if(status){status.textContent=message;status.hidden=!message;}
  }
  async function verifiedPendingLogin(flowId:string):Promise<string> {
    announceBrowserOpening("Checking this sign-in…");
    let freshResult:unknown, fresh:Projection;
    try {
      freshResult=await callTool("loomex_connection_get",{},false,false,"background");
      fresh=connectionProjection(connectionData(freshResult));
    } catch(error) {
      announceBrowserOpening("This sign-in could not be checked. Refresh and try again.");
      throw error;
    }
    if (fresh.state!=="browser_pending" || fresh.login?.flowId!==flowId || fresh.login.expiresAt*1000<=Date.now()) {
      renderConnectionResult(freshResult);
      throw new Error("This sign-in is no longer available. Check the current connection state.");
    }
    if (connectionChanged(connectionState.projection,fresh)) renderConnectionResult(freshResult);
    if (!fresh.login.authorizationUrl)throw new Error("The browser link is unavailable. Refresh this connection.");
    return fresh.login.authorizationUrl;
  }
  async function copyCurrentLogin(flowId:string) {
    const url=await verifiedPendingLogin(flowId);
    try { await navigator.clipboard.writeText(url); }
    catch { throw new Error("Copy is unavailable. Select the sign-in link and copy it."); }
    announceBrowserOpening("Sign-in link copied.");
  }
  async function openCurrentLoginExternally(flowId:string) {
    const url=await verifiedPendingLogin(flowId);
    await openExternalLink(url);
    announceBrowserOpening("Default browser request sent. If no browser appears, copy the link below.");
  }
  async function startBrowserSignIn() {
    await connectionMutation("loomex_auth_start",{});
  }

  async function saveConnectionView() {
    if (!connectionState.persistence) return;
    if (!await connectionState.persistence.flush({ page: connectionState.page, query:connectionState.query, pageIndex:connectionState.pageIndex, candidate:connectionState.candidate, pending: connectionState.pending })) {
      throw new Error("The connection view could not be saved. Retry before continuing.");
    }
  }

  const hydrateConnectionView = (result:unknown) => restoreConnectionView(result);

  function configureConnectionPersistence(value:unknown) {
    const session=sessionSchema.parse(value);
    if(connectionState.viewSession?.viewSessionId===session.viewSessionId && connectionState.persistence){
      connectionState.persistence.configure(session);connectionState.viewSession=session;return;
    }
    connectionState.viewSession=session;
    connectionState.persistence?.clear();
    connectionState.persistence=new ViewPersistenceController({
      onStatus:(status,error)=>host.persistenceStatus(status,error),
      read:async id=>sessionSchema.parse(connectionData(await callTool('loomex_connection_view_get',{viewSessionId:id},false,false))),
      write:async(id,revision,state,key)=>sessionSchema.parse(connectionData(await callTool('loomex_connection_view_update',{viewSessionId:id,expectedRevision:revision,state,idempotencyKey:key},false,false)))
    });
    connectionState.persistence.configure(session);
  }

  async function restoreConnectionView(result:unknown) {
    if(disposed)return;
    const sessionValue=record(record(result)._meta)["loomex/viewSession"];
    const session=sessionValue?sessionSchema.parse(sessionValue):null;
    const fault=viewPersistenceFault(result);
    if(fault?.status === "reentry") {
      lifecycle.reenter(); enterSafeViewReentry(fault); renderSafeViewReentry(); return;
    }
    if(session)configureConnectionPersistence(session);
    const initial=record(result).structuredContent || record(result).content ? normalizedConnection(connectionData(result)) : undefined;
    await lifecycle.open({
      mode:host.mode,identity:session?.viewSessionId ?? `connection:${host.mode}`,domainIdentity:"owner-connection",
      snapshot:async()=>{
        if(!session)return {session:null};
        const saved=await connectionState.persistence?.hydrate();
        if(!saved || saved.viewSessionId!==session.viewSessionId || sessionSchema.parse(saved).kind!==session.kind)throw new Error("The saved connection view could not be verified.");
        return {session:saved};
      },
      display:({session:saved})=>{
        if(saved && !connectionState.persistence?.dirty()){
          const state=saved.state;
          if(state?.page === "connection" || state?.page === "organizations")connectionState.page=state.page;
          connectionState.query=safeText(state?.query,240);
          connectionState.pageIndex=typeof state?.pageIndex === "number" && Number.isSafeInteger(state.pageIndex) ? Math.max(0,state.pageIndex):0;
          connectionState.candidate=safeText(state?.candidate,64);
          const pending=pendingSchema.safeParse(state?.pending);
          if(pending.success)connectionState.pending=pending.data;
        }
        const projection=initial;
        if(projection){connectionState.projection=projection;renderConnectionPage();}
      },
      verify:async(_,fence)=>{
        const fresh=session || !initial ? await callTool("loomex_connection_get",{},false,false) : result;
        if(!fence.current())return "read_only";
        renderConnectionResult(fresh,false);
        if(connectionState.page === "organizations" && connectionState.projection?.state === "authenticated")await loadConnectionOrganizations();
        return "ready";
      },
      failed:(_,error)=>{setError(error);context.setAttribute("aria-busy","false");syncChrome();},
      cleanup:clearConnectionPoll,
    });
    if(connectionState.page==='organizations' && connectionState.viewSession && lifecycle.permissions().save) {
      void saveConnectionView().catch(error=>setError(error,'presentation'));
    }
  }

  async function reloadSaved() {
    const saved=await connectionState.persistence?.useSavedVersion();
    if(!saved)throw new Error("The saved connection view could not be loaded.");
    await restoreConnectionView({_meta:{"loomex/viewSession":saved}});
  }

  async function reapplyLocalEdits() {
    if(connectionState.pending)throw new Error("Reconcile the previous connection operation first.");
    const applied=await connectionState.persistence?.reapplyLocal((saved,local)=>{
      if(saved.pending)throw new Error("A connection operation is pending in the saved view. Load it before continuing.");
      return {...saved,page:local.page,query:local.query,pageIndex:local.pageIndex,candidate:local.candidate};
    });
    if(applied)await refreshConnection();
  }

  function connectionButton(label:string, action:Action, disabled = false, className = "secondary", actionId:ActionId="next") {
    const button = element("button", { type: "button", className, disabled: disabled || !host.connected() });
    setAction(button, label, actionId);
    actions.set(button,action);
    button.addEventListener("click", () => { void Promise.resolve().then(()=>actions.get(button)?.()).catch(error=>setError(error,actionId==='open'||actionId==='copy'?'browser':'operation')); });
    return button;
  }

  function connectionData(result:unknown):JsonObject {
    const error=decodeUiError(result);if(error)throw new UiTransportError(error);
    return decodeUiResult(result);
  }

  async function connectionMutation(name:Pending["name"], args:JsonObject) {
    if(disposed)return;
    if (connectionState.busy || !(lifecycle.permissions().mutate || lifecycle.permissions().retryPersistence)) return;
    const pending = connectionState.pending;
    if (pending && (pending.name !== name || JSON.stringify(pending.args) !== JSON.stringify(args))) {
      throw new Error("An earlier action still needs to be reconciled. Retry that action first.");
    }
    const attempt = pending || { name, args: structuredClone(args), key: uuid() };
    connectionState.pending = attempt;
    const mutationFence=lifecycle.request("connection-mutation");
    lifecycle.request("connection-authority"); lifecycle.request("organization-list");
    clearConnectionPoll();
    if(connectionState.listState === "loading")connectionState.listState="idle";
    connectionState.busy = true;
    renderConnectionPage();
    try {
      await saveConnectionView();
      if(!mutationFence.current())return;
      let reconciled = false;
      if (pending) {
        const current = normalizedConnection(connectionData(await callTool("loomex_connection_get", {}, false, false)));
        if (!mutationFence.current())return;
        if (!current) throw new Error("The earlier action could not be verified. Try again.");
        reconciled = (name === "loomex_organization_select" && current.organization?.selected?.id === attempt.args.organizationId)
          || (name === "loomex_auth_logout" && current.state === "signed_out")
          || (name === "loomex_auth_cancel" && current.state === "signed_out")
          || (name === "loomex_auth_recover" && current.state === "authenticated");
      }
      if (!reconciled) connectionData(await callTool(name, { ...attempt.args, idempotencyKey: attempt.key }, false, false));
      if(!mutationFence.current())return;
      connectionState.pending = null;
      await saveConnectionView();
      if(!mutationFence.current())return;
      await refreshConnection();
    } finally {
      connectionState.busy = false;
      if(!disposed) { renderConnectionPage();scheduleConnectionPoll(connectionState.projection); }
    }
  }

  async function refreshConnection() {
    if(disposed)return;
    clearConnectionPoll();
    if(!["ready","read_only"].includes(lifecycle.state.phase)) {
      const session=connectionState.viewSession;
      return restoreConnectionView({_meta:session?{"loomex/viewSession":session}:{}});
    }
    context.setAttribute("aria-busy","true");
    try {
      await lifecycle.refresh("connection-authority",()=>callTool("loomex_connection_get",{},false,false),async result=>{
        renderConnectionResult(result,false);
        if(connectionState.page === "organizations" && connectionState.projection?.state === "authenticated")await loadConnectionOrganizations();
      });
    } catch(error) {
      setError(error);renderConnectionPage();scheduleConnectionPoll(connectionState.projection);
    } finally {
      if(!disposed){context.setAttribute("aria-busy","false");scheduleConnectionPoll(connectionState.projection);}
    }
  }

  async function loadConnectionOrganizations() {
    if(disposed)return;
    if (connectionState.listState === "loading") return;
    const fence=lifecycle.request("organization-list");
    connectionState.listState = "loading";
    renderConnectionPage();
    try {
      const data = connectionData(await callTool("loomex_organizations_list", {}, false, false));
      if (!fence.current() || connectionState.projection?.state !== "authenticated") return;
      if (!Array.isArray(data.organizations) || data.nextCursor || data.responseRef) throw new Error("The complete organization list could not be loaded. Refresh to retry.");
      const ids = new Set<string>();
      connectionState.list = data.organizations.map(value => {
        const entry=organizationSchema.extend({slug:z.string().optional()}).parse(value);
        if (ids.has(entry.id) || typeof entry.enrolled !== "boolean") throw new Error("The organization list could not be verified.");
        ids.add(entry.id);
        return { id: entry.id, name: safeText(entry.name, 240) || "Unnamed organization", slug: safeText(entry.slug, 240) };
      });
      connectionState.listState = "loaded";
      if (!ids.has(connectionState.candidate)) connectionState.candidate = "";
      if(connectionErrorKind==='organizations')clearConnectionError();
    } catch (error) {
      if (fence.current()) { connectionState.listState = "failed"; setError(error,'organizations'); }
    }
    if (fence.current()) renderConnectionPage();
  }

  async function navigateConnection(page:Page) {
    connectionState.page = page;
    try { await saveConnectionView(); } catch(error) { setError(error); }
    connectionState.structure = "";
    renderConnectionPage();
    title.focus?.();
    if (page === "organizations" && connectionState.projection?.state === "authenticated") void loadConnectionOrganizations();
  }

  function scheduleConnectionPoll(projection:Projection|null) {
    const login = projection?.login;
    if (disposed || !["browser_pending","authentication_completing"].includes(projection?.state||"") || !login || document.visibilityState !== "visible") { clearConnectionPoll(); return; }
    if (connectionPollInFlight && connectionPollFlowId===login.flowId)return;
    if (connectionPollTimer !== null && connectionPollFlowId === login.flowId) return;
    clearConnectionPoll();
    lifecycle.ownResource("authentication-poll",clearConnectionPoll);
    connectionPollFlowId = login.flowId;
    connectionPollTimer = setTimeout(() => {connectionPollTimer=null;void observeConnection();},
      login.expiresAt*1000<=Date.now()?5000:Math.min(5000,Math.max(100,login.expiresAt*1000-Date.now())));
  }

  async function observeConnection() {
      const login=connectionState.projection?.login;
      if(disposed||!login||connectionPollInFlight||connectionPollFlowId!==login.flowId||document.visibilityState!=="visible")return;
      connectionPollInFlight=true;
      const fence=lifecycle.request("authentication-poll");
      try {
        const currentResult=await callTool("loomex_connection_get", {}, false, false,"background");
        const current=connectionProjection(connectionData(currentResult));
        if (!fence.current() || connectionPollFlowId !== login.flowId)return;
        if (connectionChanged(connectionState.projection,current)||connectionErrorKind==='observation')renderConnectionResult(currentResult);
      } catch (error) {
        if (fence.current() && connectionPollFlowId === login.flowId && connectionError===undefined) setError(error,'observation');
      } finally {
        connectionPollInFlight=false;
        if(!disposed&&connectionPollFlowId===login.flowId)scheduleConnectionPoll(connectionState.projection);
      }
  }

  function renderConnectionResult(result:unknown, hydrateOrganizations = true) {
    if(disposed)return;
    const projection = connectionProjection(connectionData(result));
    const previous=connectionState.projection;
    const needsOrganization=projection.state==='authenticated' && projection.organization.status==='organization_required';
    const advanced=needsOrganization && connectionState.page==='connection';
    if(advanced){connectionState.page='organizations';connectionState.structure='';}
    if (projection.state !== "authenticated") {
      lifecycle.request("organization-list");
      connectionState.list = []; connectionState.listState = "idle"; connectionState.candidate = "";
    }
    if(connectionErrorKind==='observation'
      || (connectionErrorKind==='browser' && (projection.state!=='browser_pending' || previous?.login?.flowId!==projection.login?.flowId))
      || (connectionErrorKind==='operation' && !connectionState.pending))clearConnectionError();
    connectionState.projection = projection;
    host.onProjection(connectionData(result));
    renderConnectionPage();
    scheduleConnectionPoll(projection);
    if (hydrateOrganizations && connectionState.page === "organizations" && projection.state === "authenticated" && connectionState.listState === "idle") void loadConnectionOrganizations();
    if(advanced && connectionState.viewSession && lifecycle.permissions().save) {
      void saveConnectionView().catch(error=>setError(error,'presentation'));
    }
  }

  // Reconcile the connection body without detaching focused controls. Event
  // handlers on keyed inputs retain their local element; button actions refresh.
  function patchConnectionChildren(parent:Element|DocumentFragment,source:Element|DocumentFragment) {
    const identity=(node:Node)=>node instanceof Element?`${node.tagName}:${node.id||node.getAttribute('aria-label')||node.getAttribute('role')||''}`:`text:${node.nodeType}`;
    let cursor=parent.firstChild;
    for(const next of [...source.childNodes]) {
      let current=cursor;
      while(current&&identity(current)!==identity(next))current=current.nextSibling;
      if(!current){parent.insertBefore(next,cursor);continue;}
      if(current!==cursor)parent.insertBefore(current,cursor);
      if(current instanceof Element&&next instanceof Element){
        for(const attr of [...current.attributes])if(!next.hasAttribute(attr.name))current.removeAttribute(attr.name);
        for(const attr of [...next.attributes])if(current.getAttribute(attr.name)!==attr.value)current.setAttribute(attr.name,attr.value);
        if(current instanceof HTMLElement&&next instanceof HTMLElement)current.hidden=next.hidden;
        if(current instanceof HTMLInputElement&&next instanceof HTMLInputElement){current.checked=next.checked;current.disabled=next.disabled;current.value=next.value;}
        if(current instanceof HTMLButtonElement&&next instanceof HTMLButtonElement){current.disabled=next.disabled;const action=actions.get(next);if(action)actions.set(current,action);}
        patchConnectionChildren(current,next);
      }else if(current.nodeValue!==next.nodeValue)current.nodeValue=next.nodeValue;
      cursor=current.nextSibling;
    }
    while(cursor){const next=cursor.nextSibling;cursor.remove();cursor=next;}
  }

  function renderConnectionPage() {
    if(disposed)return;
    const p = connectionState.projection;
    if (!p) return;
    host.onRender();
    title.textContent = connectionState.page === "organizations" ? "Organizations" : "Connection";
    headerStage.hidden = true;
    headerStatus.hidden = false;
    headerStatus.setAttribute("role", "status");
    title.setAttribute("tabindex", "-1");
    headerStatus.textContent = p.state === "authenticated" ? "Signed in" : ({ signed_out: "Signed out", browser_pending: "Sign-in pending", authentication_completing:"Completing sign-in", verification_expired: "Expired", logout_pending: "Signing out", recovery_pending: "Recovery required", credential_store_unavailable: "Unavailable" }[p.state]);
    form.hidden = true; form.replaceChildren();
    refresh.hidden = false; refresh.disabled = !host.connected() || connectionState.busy;
    primary.hidden = true; secondary.hidden = true;
    connectionState.action = null; connectionState.secondaryAction = null;
    context.hidden = false; context.className = "ui-stack";
    summary.textContent = "";
    const focus = document.activeElement;
    const focusId = focus instanceof HTMLElement ? focus.id : undefined;
    const scroll = window.scrollY;
    // The verification screen remains mounted across polls, preserving focus.
    const structure = `${connectionState.page}:${p.state}:${p.login?.flowId || ""}:${p.login?.authorizationUrl || ""}:${p.login?.expiresAt || ""}`;
    const stableVerification = structure === connectionState.structure && p.state === "browser_pending";
    const preserveBody = structure === connectionState.structure;
    const contentTarget = stableVerification ? context : document.createDocumentFragment();
    connectionState.structure = structure;
    const primaryAction = (label:string, action:Action, disabled = false, actionId:ActionId="next", mutation=true) => {
      primary.hidden = false; setAction(primary, label, actionId);
      primary.dataset.businessMutation=String(mutation);
      primary.disabled = disabled || !host.connected() || connectionState.busy || (mutation && !(lifecycle.permissions().mutate || lifecycle.permissions().retryPersistence));
      connectionState.action = action;
    };
    const secondaryAction = (label:string, action:Action, actionId:ActionId="next", mutation=true) => {
      secondary.hidden = false; setAction(secondary, label, actionId);
      secondary.dataset.businessMutation=String(mutation);
      secondary.disabled = !host.connected() || connectionState.busy || (mutation && !(lifecycle.permissions().mutate || lifecycle.permissions().retryPersistence));
      connectionState.secondaryAction = action;
    };
    if (connectionState.page === "organizations") {
      if (p.state !== "authenticated") {
        contentTarget.append(element("p", { className: "ui-caption" }, "Sign in to choose an organization."));
        primaryAction("Sign in", () => navigateConnection("connection"), false, "next", false);
      } else {
        contentTarget.append(element("p", { className: "ui-caption" }, "Used for subsequent operations on this machine."));
        const listState = connectionState.listState;
        const all = connectionState.list;
        if (all.length > 5) {
          const input = element("input", { id: "organization-search", type: "search", value: connectionState.query, placeholder: "Search organizations", "aria-label": "Search organizations" });
          input.addEventListener("input", () => { connectionState.query = input.value; connectionState.pageIndex = 0; renderConnectionPage(); void saveConnectionView().catch(setError); });
          contentTarget.append(input);
        }
        const filtered = all.filter(entry => entry.name.toLocaleLowerCase().includes(connectionState.query.toLocaleLowerCase()));
        const pageCount = Math.max(1, Math.ceil(filtered.length / 5));
        connectionState.pageIndex = clampPageIndex(connectionState.pageIndex, pageCount);
        const list = element("div", { className: "ui-stack", role: "radiogroup", "aria-label": "Choose organization", "aria-busy": listState === "loading" });
        for (const entry of filtered.slice(connectionState.pageIndex * 5, connectionState.pageIndex * 5 + 5)) {
          const row = element("label", { className: "ui-organization-row" });
          const radio = element("input", { id: `organization-${entry.id}`, type: "radio", name: "organization", value: entry.id, checked: connectionState.candidate === entry.id, disabled: listState !== "loaded" || connectionState.busy });
          radio.addEventListener("change", () => { connectionState.candidate = entry.id; renderConnectionPage(); void saveConnectionView().catch(setError); });
          row.append(radio, element("span", { className: "ui-value" }, entry.name));
          if (entry.id === p.organization.selected?.id) row.append(element("span", { className: "ui-badge" }, "Current"));
          list.append(row);
        }
        if (listState === "loading" && !all.length) for (let i = 0; i < 3; i++) list.append(element("div", { className: "ui-organization-skeleton", "aria-hidden": "true" }));
        contentTarget.append(list);
        if (listState === "failed") contentTarget.append(element("p", { role: "status", className: "ui-caption" }, "Organizations could not be refreshed. Refresh to retry; your sign-in is unchanged."));
        if (listState === "loaded" && !filtered.length) {
          contentTarget.append(element("p", { className: "ui-caption" }, all.length ? "No matching organizations." : "No organizations are available for this account."));
          if (!all.length && p.webAppUrl) contentTarget.append(connectionButton("Open web app", () => openExternalLink(p.webAppUrl ?? ""), false, "secondary", "open"));
        }
        if (filtered.length > 5) {
          const previous = connectionButton("Previous", () => { connectionState.pageIndex--; renderConnectionPage(); void saveConnectionView().catch(setError); }, connectionState.pageIndex === 0, "secondary", "back");
          const next = connectionButton("Next", () => { connectionState.pageIndex++; renderConnectionPage(); void saveConnectionView().catch(setError); }, connectionState.pageIndex + 1 === pageCount, "secondary", "next");
          contentTarget.append(createPagination({ ariaLabel: "Organization pages", summary: `Page ${connectionState.pageIndex + 1} of ${pageCount}`, previous, next }));
        }
        primaryAction(p.organization.selected ? "Switch organization" : "Use organization", async () => {
          await connectionMutation("loomex_organization_select", { organizationId: connectionState.candidate });
        }, listState !== "loaded" || !connectionState.candidate || connectionState.candidate === p.organization.selected?.id);
      }
      secondaryAction("Connection", () => navigateConnection("connection"), "connection", false);
    } else if (["signed_out", "verification_expired"].includes(p.state)) {
      contentTarget.append(element("p", { className: "ui-caption" }, p.state === "signed_out" ? "Sign in securely in your browser." : "Verification expired. Start again when you are ready."));
      primaryAction(p.state === "signed_out" ? "Sign in" : "Start again", startBrowserSignIn, !p.actions.has("auth.login"));
    } else if (p.state === "browser_pending" && p.login) {
      const login=p.login;
      if (!stableVerification) {
        contentTarget.append(element("p", { className: "ui-caption" }, "Finish signing in and approve this runner in your browser."));
        contentTarget.append(element("p", { className: "ui-caption" }, `Expires ${new Date(login.expiresAt * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`), element("p", { className: "ui-caption", role: "status" }, "Waiting for browser approval…"));
        contentTarget.append(element("p",{id:"browser-open-status",className:"ui-caption",role:"status",hidden:true}));
        if(login.authorizationUrl){
          contentTarget.append(element("p",{id:"authorization-url",className:"workspace-path"},login.authorizationUrl));
          if(hostCanOpenExternalLink())contentTarget.append(connectionButton("Open in default browser",()=>openCurrentLoginExternally(login.flowId),false,"secondary","open"));
        }else contentTarget.append(element("p",{className:"ui-caption"},"The browser link is unavailable. Refresh this connection."));
      }
      primaryAction("Copy sign-in link", () => copyCurrentLogin(login.flowId), !login.authorizationUrl, "copy", false);
      if (p.actions.has("auth.cancel")) secondaryAction("Cancel sign-in", () => connectionMutation("loomex_auth_cancel", {flowId:login.flowId}), "cancel");
    } else if(p.state==="authentication_completing") {
      contentTarget.append(element("p",{className:"ui-caption",role:"status"},"Completing sign-in…"));
      if(p.actions.has("auth.recover"))primaryAction("Retry completion",()=>connectionMutation("loomex_auth_recover",{}),false,"refresh");
    } else if (p.state === "authenticated") {
      const row = element("div", { className: "ui-organization-row" });
      row.append(element("span", { className: "ui-value" }, p.organization.selected?.name || "Choose an organization to get started."));
      contentTarget.append(row);
      primaryAction(p.organization.selected ? "Change organization" : "Choose organization", () => navigateConnection("organizations"),false,"next",false);
      if (p.activeWork > 0) contentTarget.append(element("p", { className: "ui-caption" }, "Sign out waits for idle connections to close. Running jobs must finish first."));
      if (p.actions.has("auth.logout")) secondaryAction("Sign out", () => connectionMutation("loomex_auth_logout", {}), "logout");
    } else {
      contentTarget.append(element("p", { className: "ui-caption" }, p.state === "credential_store_unavailable" ? "Unlock your credential store, then refresh." : "A previous credential operation needs to be reconciled before Loomex can connect."));
      if(p.state==="recovery_pending" && p.login && p.actions.has("auth.cancel"))primaryAction("Restart sign-in",()=>connectionMutation("loomex_auth_cancel",{flowId:p.login!.flowId}),false,"refresh");
      if (p.state === "recovery_pending" && p.actions.has("auth.recover")) primaryAction("Retry connection", () => connectionMutation("loomex_auth_recover", {}), false, "refresh");
      if (p.state === "recovery_pending" && p.actions.has("auth.logout")) secondaryAction("Reconnect", () => connectionMutation("loomex_auth_logout", {}), "logout");
      if (p.state === "logout_pending" && p.actions.has("auth.logout")) primaryAction("Retry sign out", () => connectionMutation("loomex_auth_logout", {}), false, "logout");
    }
    if (connectionState.pending && !connectionState.busy) {
      primaryAction("Retry previous action", () => connectionState.pending ? connectionMutation(connectionState.pending.name, connectionState.pending.args) : undefined);
    }
    if (!stableVerification) {
      if (preserveBody) patchConnectionChildren(context, contentTarget);
      else context.replaceChildren(contentTarget);
    }
    if (focusId && !stableVerification) document.getElementById(focusId)?.focus({ preventScroll: true });
    window.scrollTo({ top: scroll });
    syncChrome();
    if(connectionError!==undefined)host.setError(connectionError);
  }


 return {reloadSaved,reapplyLocalEdits,state:connectionState, hydrateConnectionView, restoreConnectionView, refreshConnection, renderConnectionResult, renderConnectionPage, navigateConnection, connectionMutation, loadConnectionOrganizations, clearConnectionPoll, scheduleConnectionPoll, observeConnection, saveConnectionView, normalizedConnection,
 dispose(){disposed=true;unsubscribe();lifecycle.dispose();clearConnectionPoll();connectionState.persistence?.clear();}};
}

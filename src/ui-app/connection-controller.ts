import type { ActionId } from "./shell.js";
import { z } from 'zod';
import type { JsonObject, ViewSessionProjection } from './contracts.js';
import { ViewPersistenceController } from './persistence.js';
import { clampPageIndex, createPagination, createUiElement as element } from './components.js';
import { decodeUiResult, decodeUiError, UiTransportError } from './result-decoder.js';

type Page = 'connection' | 'organizations';
type Action = () => void | Promise<void>;
type Fault = {status:string; code:string; message:string; retryable?:boolean};
const organizationSchema=z.object({id:z.uuid(),name:z.string().trim().min(1).max(240).nullable(),enrolled:z.boolean()});
const loginSchema=z.object({flowId:z.string().min(1).max(128),verificationUri:z.string(),userCode:z.string().min(1).max(256),expiresAt:z.number().int().nonnegative(),intervalSeconds:z.number().int().min(1).max(3600),retryAfterSeconds:z.number().int().min(0).max(3600)});
const projectionSchema=z.object({schemaVersion:z.literal('loomex.runner.connection/v1'),state:z.enum(['signed_out','verification_pending','verification_expired','authenticated','recovery_pending','logout_pending','credential_store_unavailable']),activeWork:z.number().int().min(0).max(1000000),actions:z.array(z.enum(['auth.login','auth.poll','auth.logout','organizations.list','organizations.select'])).max(8),organization:z.object({status:z.enum(['organization_required','connected']),selected:z.object({id:z.uuid(),name:z.string().trim().min(1).max(240).nullable()}).nullable()}),organizations:z.array(organizationSchema),login:loginSchema.nullable(),webAppUrl:z.unknown().optional()});
type RawProjection=z.infer<typeof projectionSchema>;
type Projection=Omit<RawProjection,'actions'|'organizations'|'webAppUrl'> & {actions:Set<string>;organizations:Array<{id:string;name:string}>; webAppUrl:string|undefined};
const pendingSchema=z.object({name:z.enum(['loomex_auth_start','loomex_auth_logout','loomex_organization_select']),args:z.record(z.string(),z.unknown()),key:z.uuid()});
type Pending=z.infer<typeof pendingSchema>;
const sessionSchema=z.object({viewSessionId:z.uuid(),revision:z.number().int().nonnegative(),kind:z.enum(['connection','organizations']),state:z.record(z.string(),z.unknown()).default({})});
export interface ConnectionServices {
 mode:Page;
 elements:{context:HTMLElement;title:HTMLElement;headerStage:HTMLElement;headerStatus:HTMLElement;form:HTMLFormElement;refresh:HTMLButtonElement;primary:HTMLButtonElement;secondary:HTMLButtonElement;summary:HTMLElement};
 connected():boolean;
 hostCapabilities():JsonObject;
 callTool(name:string,args:JsonObject,renderResult?:boolean,observeResult?:boolean):Promise<unknown>;
 send(method:string,args:JsonObject,request?:boolean,options?:{activity:boolean}):Promise<unknown>;
 setAction(button:HTMLButtonElement,label:string,id?:ActionId):void;
 syncChrome():void;
 setError(error:unknown):void;
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
 list:Array<{id:string;name:string;slug:string}>;listState:'idle'|'loading'|'loaded'|'failed';listGeneration:number;
 viewSession:ViewSessionProjection|null;hydrated:boolean;hydrating:Promise<void>|null;
 persistence:ViewPersistenceController|null;action:Action|null;secondaryAction:Action|null;fallbackUrl:string;structure:string;
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

export function normalizedConnection(value:unknown):Projection|undefined {
    const result=projectionSchema.safeParse(value); if(!result.success)return undefined;
    const data=result.data;
    if(new Set(data.actions).size!==data.actions.length || new Set(data.organizations.map(o=>o.id)).size!==data.organizations.length)return undefined;
    if(data.organization.status==='connected'&&!data.organization.selected)return undefined;
    if(data.state==='verification_pending'&&!data.login)return undefined;
    if(data.login&&!publicHttpUrl(data.login.verificationUri))return undefined;
    return {...data,actions:new Set(data.actions),webAppUrl:publicHttpUrl(data.webAppUrl),organizations:data.organizations.map(o=>({id:o.id,name:o.name||'Unnamed organization'}))};
  }

export function createConnectionController(host:ConnectionServices) {
 const {context,title,headerStage,headerStatus,form,refresh,primary,secondary,summary}=host.elements;
 const {setAction,syncChrome,viewPersistenceFault,enterSafeViewReentry,renderSafeViewReentry}=host;
 const callTool=host.callTool.bind(host),send=host.send.bind(host),uuid=()=>{if(!globalThis.crypto?.randomUUID)throw new Error("This host cannot generate a secure operation identity.");return crypto.randomUUID();};
 const connectionState:ConnectionState={page:host.mode,candidate:'',query:'',pageIndex:0,busy:false,pending:null,projection:null,list:[],listState:'idle',listGeneration:0,viewSession:null,hydrated:false,hydrating:null,persistence:null,action:null,secondaryAction:null,fallbackUrl:'',structure:''};
 let connectionGeneration=0,connectionPollTimer:ReturnType<typeof setTimeout>|null=null,connectionPollFlowId='';
 let disposed=false;
 let connectionError:unknown;
 const setError=(error:unknown)=>{connectionError=error;host.setError(error);};
 const actions=new WeakMap<HTMLButtonElement,Action>();
  function clearConnectionPoll() {
    if (connectionPollTimer !== null) clearTimeout(connectionPollTimer);
    connectionPollTimer = null;
    connectionPollFlowId = "";
  }

  function hostCanOpenExternalLink() {
    const capabilities=host.hostCapabilities();
    const capability=capabilities.openLink || capabilities["open-link"];
    return Boolean(capability && (record(capability).url || record(capability).href || capability === true));
  }

  async function openExternalLink(url:string) {
    if (!hostCanOpenExternalLink()) throw new Error("This host cannot open an external link. Copy the displayed URL into your browser.");
    await send("ui/open-link", { url }, true, { activity: false });
  }

  async function saveConnectionView() {
    if (!connectionState.persistence) return;
    if (!await connectionState.persistence.flush({ page: connectionState.page, pending: connectionState.pending })) {
      throw new Error("The connection view could not be saved. Retry before continuing.");
    }
  }

  async function hydrateConnectionView(result:unknown) {
    if(disposed)return;
    if (connectionState.hydrating) return connectionState.hydrating;
    connectionState.hydrating = restoreConnectionView(result);
    try { await connectionState.hydrating; } finally { connectionState.hydrating = null; }
  }

  function configureConnectionPersistence(value:unknown) {
    const session=sessionSchema.parse(value);
    connectionState.viewSession=session;
    connectionState.persistence=new ViewPersistenceController({
      read:async id=>sessionSchema.parse(connectionData(await callTool('loomex_connection_view_get',{viewSessionId:id},false,false))),
      write:async(id,revision,state,key)=>sessionSchema.parse(connectionData(await callTool('loomex_connection_view_update',{viewSessionId:id,expectedRevision:revision,state,idempotencyKey:key},false,false)))
    });
    connectionState.persistence.configure(session);
  }

  async function establishFreshConnectionView() {
    const created = connectionData(await callTool("loomex_connection_view_create", {
      entityId: "00000000-0000-0000-0000-000000000000", entityType: "catalog", kind: host.mode,
      state: { page: connectionState.page, pending: null }, idempotencyKey: uuid(),
    }, false, false));
    configureConnectionPersistence(created);
    host.clearReentry();
    syncChrome();
  }

  async function restoreConnectionView(result:unknown) {
    const sessionValue=record(record(result)._meta)["loomex/viewSession"];
    const session=sessionValue?sessionSchema.parse(sessionValue):null;
    const fault = viewPersistenceFault(result);
    if (fault?.status === "reentry") {
      enterSafeViewReentry(fault);
      connectionState.pending = null;
      connectionState.persistence = null;
      connectionState.hydrated = true;
      renderConnectionResult(result);
      renderSafeViewReentry();
      syncChrome();
      return;
    }
    if (session && !connectionState.hydrated) {
      context.setAttribute("aria-busy", "true");
      // The incoming card identifies the connection view, while its durable
      // projection owns page navigation and an unresolved exact retry. Read it
      // before restoring so a remount cannot replace a just-saved organization
      // page (or a pending operation) with stale card metadata.
      configureConnectionPersistence(session);
      const saved = await connectionState.persistence?.hydrate();
      if(disposed)return;
      const restored = saved || session;
      if (restored.state?.page === "connection" || restored.state?.page === "organizations") connectionState.page = restored.state.page;
      const pending = restored.state?.pending;
      const parsedPending=pendingSchema.safeParse(pending);
      if(parsedPending.success)connectionState.pending=parsedPending.data;
    }
    connectionState.hydrated = true;
    // A remount reads current state instead of trusting the original tool card.
    if (session) await refreshConnection(); else renderConnectionResult(result);
  }

  function connectionButton(label:string, action:Action, disabled = false, className = "secondary", actionId:ActionId="next") {
    const button = element("button", { type: "button", className, disabled: disabled || !host.connected() });
    setAction(button, label, actionId);
    actions.set(button,action);
    button.addEventListener("click", () => { void Promise.resolve().then(()=>actions.get(button)?.()).catch(setError); });
    return button;
  }

  function connectionData(result:unknown):JsonObject {
    const error=decodeUiError(result);if(error)throw new UiTransportError(error);
    return decodeUiResult(result);
  }

  async function connectionMutation(name:Pending["name"], args:JsonObject) {
    if(disposed)return;
    if (connectionState.busy) return;
    const pending = connectionState.pending;
    if (pending && (pending.name !== name || JSON.stringify(pending.args) !== JSON.stringify(args))) {
      throw new Error("An earlier action still needs to be reconciled. Retry that action first.");
    }
    const attempt = pending || { name, args: structuredClone(args), key: uuid() };
    connectionState.pending = attempt;
    connectionState.busy = true;
    renderConnectionPage();
    try {
      await saveConnectionView();
      if(disposed)return;
      let reconciled = false;
      if (pending) {
        const current = normalizedConnection(connectionData(await callTool("loomex_connection_get", {}, false, false)));
        if (!current) throw new Error("The earlier action could not be verified. Try again.");
        reconciled = (name === "loomex_organization_select" && current.organization?.selected?.id === attempt.args.organizationId)
          || (name === "loomex_auth_logout" && current.state === "signed_out")
          || (name === "loomex_auth_start" && current.state === "verification_pending");
      }
      if (!reconciled) connectionData(await callTool(name, { ...attempt.args, idempotencyKey: attempt.key }, false, false));
      if(disposed)return;
      connectionState.pending = null;
      await saveConnectionView();
      ++connectionGeneration;
      await refreshConnection(connectionGeneration);
    } finally {
      connectionState.busy = false;
      renderConnectionPage();
    }
  }

  async function refreshConnection(expectedGeneration = ++connectionGeneration) {
    if(disposed)return;
    context.setAttribute("aria-busy", "true");
    try {
      const result = await callTool("loomex_connection_get", {}, false, false);
      if (expectedGeneration !== connectionGeneration) return;
      connectionData(result);
      renderConnectionResult(result, false);
      if (host.reentry()) await establishFreshConnectionView();
      if (connectionState.page === "organizations" && connectionState.projection?.state === "authenticated") {
        await loadConnectionOrganizations();
      }
    } catch (error) {
      if (expectedGeneration === connectionGeneration) {
        setError(error);
        if (connectionState.page === "organizations") connectionState.listState = "failed";
        renderConnectionPage();
        scheduleConnectionPoll(connectionState.projection);
      }
    } finally {
      if (expectedGeneration === connectionGeneration) context.setAttribute("aria-busy", "false");
    }
  }

  async function loadConnectionOrganizations() {
    if(disposed)return;
    if (connectionState.listState === "loading") return;
    const generation = ++connectionState.listGeneration;
    connectionState.listState = "loading";
    renderConnectionPage();
    try {
      const data = connectionData(await callTool("loomex_organizations_list", {}, false, false));
      if (generation !== connectionState.listGeneration || connectionState.projection?.state !== "authenticated") return;
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
    } catch (error) {
      if (generation === connectionState.listGeneration) { connectionState.listState = "failed"; setError(error); }
    }
    if (generation === connectionState.listGeneration) renderConnectionPage();
  }

  async function navigateConnection(page:Page) {
    connectionState.page = page;
    await saveConnectionView();
    connectionState.structure = "";
    renderConnectionPage();
    title.focus?.();
    if (page === "organizations" && connectionState.projection?.state === "authenticated") void loadConnectionOrganizations();
  }

  function scheduleConnectionPoll(projection:Projection|null) {
    const login = projection?.login;
    if (disposed || projection?.state !== "verification_pending" || !login || !projection.actions.has("auth.poll") || document.visibilityState !== "visible") { clearConnectionPoll(); return; }
    if (connectionPollTimer !== null && connectionPollFlowId === login.flowId) return;
    clearConnectionPoll();
    connectionPollFlowId = login.flowId;
    connectionPollTimer = setTimeout(async () => {
      connectionPollTimer = null;
      if (connectionPollFlowId !== login.flowId || document.visibilityState !== "visible") return;
      try {
        connectionData(await callTool("loomex_auth_poll", { flowId: login.flowId, idempotencyKey: uuid() }, false, false));
        if (connectionPollFlowId === login.flowId) await refreshConnection();
      } catch (error) {
        if (connectionPollFlowId === login.flowId) { setError(error); scheduleConnectionPoll(projection); }
      }
    }, Math.max(1, login.retryAfterSeconds, login.intervalSeconds) * 1000);
  }

  function renderConnectionResult(result:unknown, hydrateOrganizations = true) {
    if(disposed)return;
    const projection = normalizedConnection(connectionData(result));
    if (!projection) { setError(new Error("The connection state could not be verified. Refresh to retry.")); return; }
    if (projection.state !== "authenticated") {
      connectionState.listGeneration++;
      connectionState.list = []; connectionState.listState = "idle"; connectionState.candidate = "";
    }
    connectionError=undefined;
    connectionState.projection = projection;
    host.onProjection(connectionData(result));
    renderConnectionPage();
    scheduleConnectionPoll(projection);
    if (hydrateOrganizations && connectionState.page === "organizations" && projection.state === "authenticated" && connectionState.listState === "idle") void loadConnectionOrganizations();
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
    headerStatus.textContent = p.state === "authenticated" ? "Signed in" : ({ signed_out: "Signed out", verification_pending: "Verification pending", verification_expired: "Expired", logout_pending: "Signing out", recovery_pending: "Recovery required", credential_store_unavailable: "Unavailable" }[p.state]);
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
    const structure = `${connectionState.page}:${p.state}:${p.login?.flowId || ""}`;
    const stableVerification = structure === connectionState.structure && p.state === "verification_pending";
    const preserveBody = structure === connectionState.structure;
    const contentTarget = stableVerification ? context : document.createDocumentFragment();
    connectionState.structure = structure;
    const primaryAction = (label:string, action:Action, disabled = false, actionId:ActionId="next") => {
      primary.hidden = false; setAction(primary, label, actionId); primary.disabled = disabled || !host.connected() || connectionState.busy;
      connectionState.action = action;
    };
    const secondaryAction = (label:string, action:Action, actionId:ActionId="next") => {
      secondary.hidden = false; setAction(secondary, label, actionId); secondary.disabled = !host.connected() || connectionState.busy;
      connectionState.secondaryAction = action;
    };
    if (connectionState.page === "organizations") {
      if (p.state !== "authenticated") {
        contentTarget.append(element("p", { className: "ui-caption" }, "Sign in to choose an organization."));
        primaryAction("Sign in", () => navigateConnection("connection"));
      } else {
        contentTarget.append(element("p", { className: "ui-caption" }, "Used for subsequent operations on this machine."));
        const listState = connectionState.listState;
        const all = connectionState.list;
        if (all.length > 5) {
          const input = element("input", { id: "organization-search", type: "search", value: connectionState.query, placeholder: "Search organizations", "aria-label": "Search organizations" });
          input.addEventListener("input", () => { connectionState.query = input.value; connectionState.pageIndex = 0; renderConnectionPage(); });
          contentTarget.append(input);
        }
        const filtered = all.filter(entry => entry.name.toLocaleLowerCase().includes(connectionState.query.toLocaleLowerCase()));
        const pageCount = Math.max(1, Math.ceil(filtered.length / 5));
        connectionState.pageIndex = clampPageIndex(connectionState.pageIndex, pageCount);
        const list = element("div", { className: "ui-stack", role: "radiogroup", "aria-label": "Choose organization", "aria-busy": listState === "loading" });
        for (const entry of filtered.slice(connectionState.pageIndex * 5, connectionState.pageIndex * 5 + 5)) {
          const row = element("label", { className: "ui-organization-row" });
          const radio = element("input", { id: `organization-${entry.id}`, type: "radio", name: "organization", value: entry.id, checked: connectionState.candidate === entry.id, disabled: listState !== "loaded" || connectionState.busy });
          radio.addEventListener("change", () => { connectionState.candidate = entry.id; renderConnectionPage(); });
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
          const previous = connectionButton("Previous", () => { connectionState.pageIndex--; renderConnectionPage(); }, connectionState.pageIndex === 0, "secondary", "back");
          const next = connectionButton("Next", () => { connectionState.pageIndex++; renderConnectionPage(); }, connectionState.pageIndex + 1 === pageCount, "secondary", "next");
          contentTarget.append(createPagination({ ariaLabel: "Organization pages", summary: `Page ${connectionState.pageIndex + 1} of ${pageCount}`, previous, next }));
        }
        primaryAction(p.organization.selected ? "Switch organization" : "Use organization", async () => {
          await connectionMutation("loomex_organization_select", { organizationId: connectionState.candidate });
        }, listState !== "loaded" || !connectionState.candidate || connectionState.candidate === p.organization.selected?.id);
      }
      secondaryAction("Connection", () => navigateConnection("connection"), "connection");
    } else if (["signed_out", "verification_expired"].includes(p.state)) {
      contentTarget.append(element("p", { className: "ui-caption" }, p.state === "signed_out" ? "Sign in securely in your browser." : "Verification expired. Start again when you are ready."));
      primaryAction(p.state === "signed_out" ? "Sign in" : "Start again", () => connectionMutation("loomex_auth_start", {}), !p.actions.has("auth.login"));
    } else if (p.state === "verification_pending" && p.login) {
      const login=p.login;
      if (!stableVerification) {
        contentTarget.append(element("p", { className: "ui-caption" }, "Enter this code in your browser to finish signing in."));
        const row = element("div", { className: "ui-organization-row" });
        row.append(element("code", { className: "ui-value" }, login.userCode), connectionButton("Copy code", async () => {
          try { await navigator.clipboard.writeText(login.userCode); } catch { throw new Error("Copy is unavailable. Select the displayed code and copy it."); }
        }, false, "secondary", "copy"));
        contentTarget.append(row, element("p", { className: "ui-caption" }, `Expires ${new Date(login.expiresAt * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`), element("p", { className: "ui-caption", role: "status" }, "Waiting for verification…"));
      }
      const showUrl = () => {
        if (!document.getElementById("verification-url") && !contentTarget.querySelector?.("#verification-url")) (connectionState.structure === structure && stableVerification ? context : contentTarget).append(element("p", { id: "verification-url", className: "workspace-path" }, login.verificationUri));
      };
      if (!hostCanOpenExternalLink() || connectionState.fallbackUrl === login.flowId) showUrl();
      else document.getElementById("verification-url")?.remove();
      primaryAction("Open browser", async () => { try { await openExternalLink(login.verificationUri); } catch (e) { connectionState.fallbackUrl = login.flowId; if (!document.getElementById("verification-url")) context.append(element("p", { id: "verification-url", className: "workspace-path" }, login.verificationUri)); throw e; } }, !hostCanOpenExternalLink(), "open");
      if (p.actions.has("auth.logout")) secondaryAction("Cancel sign-in", () => connectionMutation("loomex_auth_logout", {}), "cancel");
    } else if (p.state === "authenticated") {
      const row = element("div", { className: "ui-organization-row" });
      row.append(element("span", { className: "ui-value" }, p.organization.selected?.name || "Choose an organization to get started."));
      contentTarget.append(row);
      primaryAction(p.organization.selected ? "Change organization" : "Choose organization", () => navigateConnection("organizations"));
      if (p.actions.has("auth.logout")) secondaryAction("Sign out", () => connectionMutation("loomex_auth_logout", {}), "logout");
    } else {
      contentTarget.append(element("p", { className: "ui-caption" }, p.state === "credential_store_unavailable" ? "Unlock your credential store, then refresh." : "The previous connection operation needs recovery. Refresh to check its state."));
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


 return {state:connectionState, hydrateConnectionView, restoreConnectionView, refreshConnection, renderConnectionResult, renderConnectionPage, navigateConnection, connectionMutation, loadConnectionOrganizations, clearConnectionPoll, scheduleConnectionPoll, saveConnectionView, normalizedConnection,
 dispose(){disposed=true;++connectionGeneration;++connectionState.listGeneration;clearConnectionPoll();connectionState.persistence?.clear();}};
}

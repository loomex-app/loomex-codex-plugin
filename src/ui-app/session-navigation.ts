import {committedPreparationRun} from "./run-presentation.js";
import type {JsonObject,UiMode} from "./contracts.js";
import type {UiData,RpcResult,RunFlow,RuntimeViewSessionProjection,ViewFault,ReopenedInteraction,HumanRequest} from "./page-models.js";
import type {ViewPersistenceController,PersistenceStatus} from "./persistence.js";
import type {createRunSetupController} from "./run-setup.js";
import type {createRunMonitorController} from "./run-monitor.js";
import type {createRunPresentation} from "./run-presentation.js";
import type {InteractionFormController} from "./interaction-form.js";
import type {ActionId} from "./shell.js";

export interface NavigationState {
 viewRestoring:boolean;viewPersistenceUnavailable:boolean;viewReentry:ViewFault|null;
 viewHydrationEpoch:number;hydratedSessionId:string;hydratedReadySessionId:string;
 persistenceConflict:boolean;reopenedInteraction:ReopenedInteraction|null;
 readonly followedViewSessions:Set<string>;readonly completedViewStatuses:Set<string>;readonly refreshedInteractionViews:Set<string>;
}
export interface SessionNavigationServices {
 readonly flowStore:{flow:RunFlow|null};
 readonly persistence:Pick<ViewPersistenceController,"session"|"configure"|"changeVersion">;
 readonly elements:{form:HTMLFormElement;refresh:HTMLButtonElement};
 readonly setup:Pick<ReturnType<typeof createRunSetupController>,"selectedWorkflowVersion"|"initializeRunSetup"|"setupRequestIdentity"|"initializePreparedRunReview">;
 readonly monitor:Pick<ReturnType<typeof createRunMonitorController>,"initializeRunMonitor"|"renderIntegratedRunFlow"|"acceptRunSnapshot">;
 readonly presentation:Pick<ReturnType<typeof createRunPresentation>,"safeText"|"observePreparationReview">;
 readonly forms:Pick<InteractionFormController,"showQuestionStep"|"beginAnswerReview">;
 mode():UiMode;setMode(mode:UiMode):void;connected():boolean;
 latest():UiData|null;setLatest(data:UiData):void;
 workflowIdValid(value:unknown):value is string;
 dataOf(result:RpcResult):UiData;
 humanRequest(data?:UiData):HumanRequest|undefined;
 humanRequestResolved(request:HumanRequest):boolean;
 executionId(data?:UiData):string;interactionId(data:UiData):string|undefined;builderSessionId(data:UiData):string|undefined;
 callTool(name:string,args:JsonObject,render?:boolean,observe?:boolean):Promise<RpcResult>;
 persistenceTool(name:string,args:JsonObject):Promise<unknown>;
 requiredViewSession(value:unknown):RuntimeViewSessionProjection;
 viewSessionProjection(result:RpcResult):RuntimeViewSessionProjection|null;
 taskWorkspaceArguments():JsonObject;
 restoreBrowserFromPersistence(state:JsonObject):Promise<unknown>;
 restoreDisclosures(value:unknown):void;restoreControls(value:unknown):void;
 restoreReadingPosition(value:unknown,epoch:number):void;
 fieldsetQuestionId(field:HTMLElement):string|null;
 render(result:RpcResult):void;
 viewPersistenceFault(result:RpcResult):ViewFault|null;
 enterSafeViewReentry(fault:ViewFault):void;
 syncRestorationVisibility():void;
 persistenceStatus(status:PersistenceStatus,error?:Error):void;
 detachInteractionDraft():void;
 hydrate():Promise<RuntimeViewSessionProjection|null|undefined>;
 viewEntityMatches(value:RuntimeViewSessionProjection):boolean;
 draftRequest():HumanRequest|null|undefined;
 loadInteractionDraft(request:HumanRequest,epoch:number):Promise<boolean>;
 restoreJournalOperation(projection:RuntimeViewSessionProjection,epoch:number):Promise<boolean>;
 setAction(button:HTMLButtonElement,label:string,id?:ActionId):void;
 syncChrome():void;
 desiredViewStatus():string|undefined;
 markCurrentViewStatus(status:string):Promise<unknown>;
 setError(value:unknown):void;
}
function record(value:unknown):JsonObject|null{return value!==null&&typeof value==="object"&&!Array.isArray(value)?value as JsonObject:null;}
/** Owns hydration, persisted navigation and authoritative restoration before actions are enabled. */
export function createSessionNavigationController(host:SessionNavigationServices){
 const {form,refresh}=host.elements;
 const {selectedWorkflowVersion,initializeRunSetup,setupRequestIdentity,initializePreparedRunReview}=host.setup;
 const {initializeRunMonitor,renderIntegratedRunFlow,acceptRunSnapshot}=host.monitor;
 const {safeText,observePreparationReview}=host.presentation;
 const {showQuestionStep,beginAnswerReview}=host.forms;
 const {workflowIdValid,dataOf,humanRequest,humanRequestResolved,executionId,interactionId,builderSessionId,callTool,viewSessionProjection,taskWorkspaceArguments,restoreBrowserFromPersistence,restoreDisclosures,restoreControls,restoreReadingPosition,fieldsetQuestionId,render,viewPersistenceFault,enterSafeViewReentry,syncRestorationVisibility,persistenceStatus,detachInteractionDraft,viewEntityMatches,draftRequest,loadInteractionDraft,restoreJournalOperation,setAction,syncChrome,desiredViewStatus,markCurrentViewStatus,setError}=host;
 const VIEW_SESSION_TOOLS={get:"loomex_view_session_get"};
 const stateStore:NavigationState={viewRestoring:true,viewPersistenceUnavailable:false,viewReentry:null,viewHydrationEpoch:0,hydratedSessionId:"",hydratedReadySessionId:"",persistenceConflict:false,reopenedInteraction:null,followedViewSessions:new Set(),completedViewStatuses:new Set(),refreshedInteractionViews:new Set()};
 let disposed=false;
 async function restoration<T>(promise:Promise<T>,epoch:number):Promise<T>{const value=await promise;if(disposed||epoch!==stateStore.viewHydrationEpoch)throw new Error("The saved view changed during restoration.");return value;}
 async function persistenceTool(name:string,args:JsonObject):Promise<RuntimeViewSessionProjection>{return host.requiredViewSession(await host.persistenceTool(name,args));}
 function activeFlow():RunFlow{const flow=host.flowStore.flow;if(!flow)throw new Error("The saved run view is unavailable.");return flow;}
 function forwardSession(value:unknown):{viewSessionId:string;entityId:string;kind:string;entityType:string}|undefined{
  if(value===null || value===undefined)return undefined;
  const next=record(value);
  if(!next || !workflowIdValid(next.viewSessionId) || !workflowIdValid(next.entityId) || typeof next.kind!=="string" || typeof next.entityType!=="string")throw new Error("The saved navigation path is incomplete.");
  return {viewSessionId:next.viewSessionId,entityId:next.entityId,kind:next.kind,entityType:next.entityType};
 }
  async function refreshReopenedInteraction(reopen: ReopenedInteraction, viewSessionId: string, epoch: number) {
    if (!reopen || reopen.viewSessionId !== viewSessionId || !workflowIdValid(reopen.requestId)) {
      throw new Error("The reopened request is not bound to this saved interaction view.");
    }
    const requestId = reopen.requestId;
    const refreshKey = `${viewSessionId}:${requestId}`;
    if (stateStore.refreshedInteractionViews.has(refreshKey)) return true;
    const result = await callTool("loomex_interaction_get", { requestId }, false, false);
    const data = dataOf(result);
    const request = humanRequest(data);
    if (disposed || epoch !== stateStore.viewHydrationEpoch || host.persistence.session?.viewSessionId !== viewSessionId) return false;
    if (result?.isError || result?.structuredContent?.ok === false || !request || request.id !== requestId) {
      throw new Error("The reopened request could not be verified.");
    }
    stateStore.refreshedInteractionViews.add(refreshKey);
    host.setLatest(data);
    // Preserve the existing presentation session while replacing the stale
    // notification payload with the request's authoritative current state.
    render({ structuredContent: { ok: true, data } });
    return true;
  }

  async function restoreViewState(value: unknown) {
    if(disposed)return;
    const restorationEpoch=stateStore.viewHydrationEpoch;
    const state = record(value);
    if (!state || state.schemaVersion !== 1) return;
    if (await followForwardSession(state)) return true;
    if (host.mode() === "browser" && !host.flowStore.flow) {
      const browser = record(state.browser);
      if (!browser || typeof browser !== "object") return;
      if (workflowIdValid(browser.forwardViewSessionId) && workflowIdValid(browser.forwardWorkflowId)) {
        const returnViewSessionId = host.persistence.session?.viewSessionId || "";
        const result = await restoration(callTool("loomex_run_setup", {
          workflowId: browser.forwardWorkflowId,
          ...(Number.isInteger(browser.forwardVersion) ? { version: String(browser.forwardVersion) } : {}),
          ...taskWorkspaceArguments(),
          viewSessionId: browser.forwardViewSessionId,
        }, false, false), restorationEpoch);
        const setup = dataOf(result);
        if (result?.isError || result?.structuredContent?.ok === false || !selectedWorkflowVersion(setup) || setup.workflow?.id !== browser.forwardWorkflowId ||
            viewSessionProjection(result)?.viewSessionId !== browser.forwardViewSessionId) {
          throw new Error("The saved run setup could not be verified.");
        }
        initializeRunSetup(setup, true, setupRequestIdentity(result));
        activeFlow().returnViewSessionId = returnViewSessionId;
        observeViewPersistence(result);
        renderIntegratedRunFlow();
        return true;
      }
      await restoration(restoreBrowserFromPersistence(browser), restorationEpoch);
      restoreDisclosures(state.disclosures);
      return;
    }
    if (host.flowStore.flow?.stage === "setup" && state.workflowId === host.flowStore.flow.selected?.workflowId && state.versionId === host.flowStore.flow.selected?.versionId) {
      host.flowStore.flow.workspaceEditing = host.flowStore.flow.workspaceEditing || state.workspaceEditing === true;
      if (workflowIdValid(state.returnBrowserViewSessionId)) activeFlow().returnViewSessionId = state.returnBrowserViewSessionId;
      renderIntegratedRunFlow();
      restoreControls(state.controls);
    } else if (host.flowStore.flow?.stage === "review" && state.preparationId === host.flowStore.flow.prepared?.preparationId) {
      if (workflowIdValid(state.returnBrowserViewSessionId)) activeFlow().returnViewSessionId = state.returnBrowserViewSessionId;
      if (workflowIdValid(state.setupViewSessionId)) host.flowStore.flow.setupViewSessionId = state.setupViewSessionId;
      if (typeof state.workflowVersion === "number" && Number.isSafeInteger(state.workflowVersion) && state.workflowVersion > 0) host.flowStore.flow.editWorkflowVersion = state.workflowVersion;
    } else if (host.flowStore.flow?.stage === "monitor" && state.executionId === executionId(host.flowStore.flow.result)) {
      const acceptedRequestId = safeText(state.acceptedRequestId, 64);
      if (workflowIdValid(acceptedRequestId)) {
        const result = await restoration(callTool("loomex_interaction_get", { requestId: acceptedRequestId }, false), restorationEpoch);
        const restored = humanRequest(dataOf(result));
        if (result?.isError || !restored || restored.id !== acceptedRequestId ||
            restored.execution?.id !== state.executionId || !humanRequestResolved(restored)) {
          throw new Error("The saved response review could not be verified for this run.");
        }
        host.flowStore.flow.acceptedRequest = restored;
      }
      renderIntegratedRunFlow();
    } else if (host.mode() === "authoring" && state.builderSessionId === builderSessionId(host.latest() || {})) {
      const fields = [...form.querySelectorAll<HTMLElement>("fieldset[data-question-id]")];
      const index = fields.findIndex((fieldset) => fieldsetQuestionId(fieldset) === state.currentQuestionId);
      if (index >= 0) showQuestionStep(index, false);
      if (state.phase === "review") {
        try { beginAnswerReview(); } catch { /* Preserve the draft for correction. */ }
      }
    } else if (host.mode() === "interaction" && state.requestId === interactionId(host.latest() || {})) {
      const fields = [...form.querySelectorAll<HTMLElement>("fieldset[data-question-id]")];
      const index = fields.findIndex((fieldset) => fieldsetQuestionId(fieldset) === state.currentQuestionId);
      if (index >= 0) showQuestionStep(index, false);
    }
    restoreDisclosures(state.disclosures);
  }

  async function followForwardSession(state: JsonObject) {
    if(disposed)return false;
    const restorationEpoch=stateStore.viewHydrationEpoch;
    let forward = forwardSession(state.forwardSession);
    if (!forward) return false;
    const traversed = new Set<string>();
    let target: RuntimeViewSessionProjection | undefined;
    let returnBrowserViewSessionId = safeText(state.returnBrowserViewSessionId,64) || host.persistence.session?.viewSessionId || "";
    try {
      // A durable transition can span setup → preparation → monitor. Resolve the
      // complete verified chain before consulting a preparation, since committed
      // preparations are intentionally stale and must lead to their monitor.
      while (forward) {
        if (!workflowIdValid(forward.viewSessionId) || !workflowIdValid(forward.entityId) ||
            traversed.has(forward.viewSessionId) || stateStore.followedViewSessions.has(forward.viewSessionId)) {
          throw new Error("The saved navigation path is cyclic or incomplete.");
        }
        traversed.add(forward.viewSessionId);
        stateStore.followedViewSessions.add(forward.viewSessionId);
        target = await restoration(persistenceTool(VIEW_SESSION_TOOLS.get, { viewSessionId: forward.viewSessionId }), restorationEpoch);
        if (target.kind !== forward.kind || target.entityType !== forward.entityType || target.entityId !== forward.entityId) {
          throw new Error("The saved next view no longer matches this navigation path.");
        }
        const next = forwardSession(target.state?.forwardSession);
        if (!next) break;
        returnBrowserViewSessionId = safeText(target.state?.returnBrowserViewSessionId,64) || returnBrowserViewSessionId;
        forward = next;
      }
      if (!target || !forward) return false;
    if (forward.kind === "prepare" && forward.entityType === "workflow") {
      const result = await restoration(callTool("loomex_run_setup", {
        workflowId: forward.entityId,
        ...taskWorkspaceArguments(),
        viewSessionId: forward.viewSessionId,
      }, false, false), restorationEpoch);
      const setup = dataOf(result);
      if (result?.isError || result?.structuredContent?.ok === false || !selectedWorkflowVersion(setup) || setup.workflow?.id !== forward.entityId ||
          viewSessionProjection(result)?.viewSessionId !== forward.viewSessionId) {
        throw new Error("The saved run setup could not be verified.");
      }
      initializeRunSetup(setup, true, setupRequestIdentity(result));
      activeFlow().returnViewSessionId = returnBrowserViewSessionId;
      observeViewPersistence({ _meta: { "loomex/viewSession": target } });
      renderIntegratedRunFlow();
      return true;
    }
    if (forward.kind === "prepare" && forward.entityType === "preparation") {
      const result = await restoration(callTool("loomex_preparation_get", { preparationId: forward.entityId }, false), restorationEpoch);
      const restored = dataOf(result);
      // The commit sealed this preparation. A durable commit result gives us a
      // verified execution identity, so follow that identity rather than
      // presenting a sealed review as an expired local draft.
      const committedRunId = committedPreparationRun(restored, forward.entityId);
      if (!result.isError && result.structuredContent?.ok !== false && committedRunId) {
        const snapshot = await restoration(callTool("loomex_run_get", { runId: committedRunId }, false), restorationEpoch);
        const run = dataOf(snapshot);
        if (snapshot?.isError || snapshot?.structuredContent?.ok === false || executionId(run) !== committedRunId) {
          throw new Error("The committed run could not be verified while restoring this view.");
        }
        initializeRunMonitor(run, null);
        activeFlow().returnToBrowser = Boolean(returnBrowserViewSessionId);
        activeFlow().returnViewSessionId = returnBrowserViewSessionId;
        observeViewPersistence({ _meta: { "loomex/viewSession": target } });
        renderIntegratedRunFlow();
        return true;
      }
      if (result?.isError || result?.structuredContent?.ok === false || restored?.status !== "valid" || restored?.operation !== "runs.prepare" ||
          !restored.preparation || restored.preparation.preparationId !== forward.entityId) {
        throw new Error("The saved preparation is no longer available. Return to setup and prepare it again.");
      }
      host.setLatest(restored.preparation);
      observePreparationReview(result, restored.preparation);
      initializePreparedRunReview(restored.preparation);
      activeFlow().returnToBrowser = Boolean(returnBrowserViewSessionId);
      activeFlow().returnViewSessionId = returnBrowserViewSessionId;
      observeViewPersistence({ _meta: { "loomex/viewSession": target } });
      renderIntegratedRunFlow();
      return true;
    }
    if (forward.kind === "monitor" && forward.entityType === "execution") {
      const result = await restoration(callTool("loomex_run_get", { runId: forward.entityId }, false), restorationEpoch);
      const run = dataOf(result);
      if (result?.isError || result?.structuredContent?.ok === false || executionId(run) !== forward.entityId) {
        throw new Error("The saved run could not be verified.");
      }
      initializeRunMonitor(run, null);
      activeFlow().returnToBrowser = Boolean(returnBrowserViewSessionId);
      activeFlow().returnViewSessionId = returnBrowserViewSessionId;
      observeViewPersistence({ _meta: { "loomex/viewSession": target } });
      renderIntegratedRunFlow();
      return true;
    }
    if (forward.kind === "authoring" && forward.entityType === "builderSession") {
      const result = await restoration(callTool("loomex_builder_get", { sessionId: forward.entityId, viewSessionId: forward.viewSessionId }, false), restorationEpoch);
      const authoring = dataOf(result);
      const supplied = viewSessionProjection(result);
      if (result?.isError || result?.structuredContent?.ok === false || builderSessionId(authoring) !== forward.entityId || supplied?.viewSessionId !== forward.viewSessionId) {
        throw new Error("The saved authoring session could not be verified.");
      }
      host.setMode("authoring");
      host.setLatest(authoring);
      render(result);
      return true;
    }
    throw new Error("This saved navigation target cannot be restored safely in this view.");
    } finally {
      for (const viewSessionId of traversed) stateStore.followedViewSessions.delete(viewSessionId);
    }
  }

  function observeViewPersistence(result: RpcResult) {
    if (disposed) return;
    const fault = viewPersistenceFault(result);
    if (fault?.status === "reentry") {
      enterSafeViewReentry(fault);
      return;
    }
    if (fault?.status === "unavailable") {
      stateStore.viewReentry = null;
      stateStore.viewPersistenceUnavailable = true;
      stateStore.viewRestoring = false;
      syncRestorationVisibility();
      stateStore.hydratedReadySessionId = "";
      persistenceStatus("save_failed");
      return;
    }
    const supplied = viewSessionProjection(result);
    if (!supplied) {
      if (!host.persistence.session) { stateStore.viewRestoring = false; syncRestorationVisibility(); }
      return;
    }
    stateStore.viewRestoring = true;
    syncRestorationVisibility();
    stateStore.viewPersistenceUnavailable = false;
    stateStore.viewReentry = null;
    const changedSession = host.persistence.configure(supplied);
    if (changedSession) {
      stateStore.persistenceConflict = false;
      detachInteractionDraft();
    }
    stateStore.hydratedReadySessionId = "";
    if (["inactive", "resolved"].includes(supplied.status || "")) stateStore.completedViewStatuses.add(`${supplied.viewSessionId}:${supplied.status}`);
    const epoch = ++stateStore.viewHydrationEpoch;
    const localChangeVersion = host.persistence.changeVersion;
    return new Promise<boolean>((resolve) => queueMicrotask(async () => {
      let ready = false;
      try {
        const projection = await host.hydrate();
        if (disposed || !projection || epoch !== stateStore.viewHydrationEpoch) return;
        const reopen = host.mode() === "interaction" ? (stateStore.reopenedInteraction || {
          viewSessionId: projection.viewSessionId,
          requestId: interactionId(host.latest() || {}) || "",
        }) : null;
        if (reopen && (reopen.viewSessionId !== projection.viewSessionId || !workflowIdValid(reopen.requestId) ||
            projection.kind !== "interaction" || projection.entityType !== "request" || projection.entityId !== reopen.requestId)) {
          throw new Error("The reopened request does not match this saved interaction view.");
        }
        if (reopen && (projection.status === "resolved" || projection.revision > 0 || stateStore.reopenedInteraction) && stateStore.hydratedSessionId !== projection.viewSessionId && host.persistence.changeVersion === localChangeVersion) {
          if (!await refreshReopenedInteraction(reopen, projection.viewSessionId, epoch)) return;
        }
        if (!viewEntityMatches(projection)) return;
        // A resolved monitor session is only a restoration hint. Re-read the
        // exact execution once before restoring a completed card so an old
        // notification cannot make an active run look finished (or vice versa).
        if (host.mode() === "monitor" && projection.status === "resolved" && stateStore.hydratedSessionId !== projection.viewSessionId &&
            host.persistence.changeVersion === localChangeVersion && host.flowStore.flow?.stage === "monitor") {
          const runId = executionId(host.flowStore.flow.result) || safeText(projection.entityId, 64);
          if (!workflowIdValid(runId)) throw new Error("The resolved monitor view is missing its run identity.");
          const refreshed = await callTool("loomex_run_get", { runId }, false);
          const refreshedData = dataOf(refreshed);
          if (refreshed?.isError || refreshed?.structuredContent?.ok === false || executionId(refreshedData) !== runId) {
            throw new Error("The resolved run could not be verified.");
          }
          acceptRunSnapshot(refreshedData, runId);
          host.setLatest(refreshedData);
          render({ structuredContent: { ok: true, data: refreshedData } });
        }
        if (stateStore.hydratedSessionId !== projection.viewSessionId && host.persistence.changeVersion === localChangeVersion) {
          if (await restoreViewState(projection.state)) return;
          const request = draftRequest();
          if (request && !await loadInteractionDraft(request, epoch)) throw new Error("The saved answer draft could not be restored.");
          stateStore.hydratedSessionId = projection.viewSessionId;
        }
        const journalReady = await restoreJournalOperation(projection, epoch);
        if (!journalReady) {
          refresh.dataset.retryViewHydration = "true";
          refresh.hidden = false;
          setAction(refresh, "Retry restore", "refresh");
          refresh.disabled = !host.connected();
          return;
        }
        if (!disposed && epoch === stateStore.viewHydrationEpoch && viewEntityMatches(projection)) {
          stateStore.hydratedReadySessionId = projection.viewSessionId;
          delete refresh.dataset.retryViewHydration;
          // The first preparation render can occur before the host connection
          // and durable session finish initializing. Re-render setup and
          // review cards so Start derives from the authoritative lifecycle
          // rather than a previously-disabled DOM node. Monitor cards retain
          // their restored cancellation controls without another DOM reset.
          if (["setup", "review"].includes(host.flowStore.flow?.stage || "")) renderIntegratedRunFlow();
          else syncChrome();
          restoreDisclosures(projection.state?.disclosures);
          restoreReadingPosition(projection.state, epoch);
          // Terminal and resolved cards are read-only projections. Persist the
          // lifecycle status after authoritative hydration so a remount can
          // request the current domain state before restoring that card.
          const completedStatus = desiredViewStatus();
          if (completedStatus) void markCurrentViewStatus(completedStatus);
          ready = true;
        }
      } catch (error) {
        if (disposed || epoch !== stateStore.viewHydrationEpoch) return;
        stateStore.hydratedReadySessionId = "";
        persistenceStatus("load_failed", error instanceof Error ? error : new Error("The saved view could not be restored."));
        setError(error);
        refresh.dataset.retryViewHydration = "true";
        refresh.hidden = false;
        setAction(refresh, "Retry restore", "refresh");
        refresh.disabled = !host.connected();
      } finally {
        // A forwarded session owns its own loader. A stale hydration must not
        // reveal content while the destination is still restoring.
        if (!disposed && epoch === stateStore.viewHydrationEpoch) {
          stateStore.viewRestoring = false;
          syncRestorationVisibility();
        }
        resolve(ready);
      }
    }));
  }

return {refreshReopenedInteraction, restoreViewState, followForwardSession, observeViewPersistence,state:stateStore,dispose(){disposed=true;stateStore.viewHydrationEpoch++;}};
}

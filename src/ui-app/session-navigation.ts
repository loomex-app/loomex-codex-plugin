import { decodePersistedHandoff } from "./persisted-presentation.js";
import {committedPreparationRun} from "./run-presentation.js";
import type {JsonObject,UiMode} from "./contracts.js";
import type {UiData,RpcResult,RunFlow,RuntimeViewSessionProjection,ViewFault,ReopenedInteraction,HumanRequest} from "./page-models.js";
import {ViewRestorationCoordinator} from "./persistence.js";
import type {ViewPersistenceController,PersistenceStatus,ViewRestorationPhase,RestorationScopeFence} from "./persistence.js";
import type {createRunSetupController} from "./run-setup.js";
import type {createRunMonitorController} from "./run-monitor.js";
import type {createRunPresentation} from "./run-presentation.js";
import type {InteractionFormController} from "./interaction-form.js";
import type {ActionId} from "./shell.js";

export interface NavigationState {
 readonly viewRestoring:boolean;viewPersistenceUnavailable:boolean;viewReentry:ViewFault|null;
 readonly viewHydrationEpoch:number;hydratedSessionId:string;readonly hydratedReadySessionId:string;
 readonly viewRestorationPhase:ViewRestorationPhase;readonly verificationFailedSection:string|undefined;
 persistenceConflict:boolean;reopenedInteraction:ReopenedInteraction|null;
 readonly followedViewSessions:Set<string>;readonly completedViewStatuses:Set<string>;readonly refreshedInteractionViews:Set<string>;
}
export interface SessionNavigationServices {
 readonly lifecycle?: ViewRestorationCoordinator;
 readonly flowStore:{flow:RunFlow|null};
 readonly persistence:Pick<ViewPersistenceController,"session"|"configure"|"changeVersion"> & {
  /** Optional display-only read supplied by a host with a local snapshot store. */
  restoreSnapshot?():Promise<RuntimeViewSessionProjection|null|undefined>;
 };
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
 restoreRunsFromPersistence?(state:JsonObject):Promise<unknown>;
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
 /** Optional immediate rendering hook for a display-safe saved snapshot. */
 renderRestorationSnapshot?(projection:RuntimeViewSessionProjection,phase:"verifying"|"read_only"):void;
 /** Rebuilds the incoming canonical form without starting a new persistence cycle. */
 renderCanonicalRestoration?():void;
 viewEntityMatches(value:RuntimeViewSessionProjection):boolean;
 draftRequest():HumanRequest|null|undefined;
 loadInteractionDraft(request:HumanRequest,epoch:number):Promise<boolean>;
 restoreDelivery?(state:JsonObject|undefined):void;
 projectRetainedOperation?():void;
 restoreJournalOperation(projection:RuntimeViewSessionProjection,epoch:number):Promise<boolean>;
 /** Available to explicit recovery controls; hydration never invokes it. */
 ensureStartHandoff():Promise<void>;
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
 const {workflowIdValid,dataOf,humanRequest,humanRequestResolved,executionId,interactionId,builderSessionId,callTool,viewSessionProjection,taskWorkspaceArguments,restoreBrowserFromPersistence,restoreRunsFromPersistence,restoreDisclosures,restoreControls,restoreReadingPosition,fieldsetQuestionId,render,viewPersistenceFault,enterSafeViewReentry,syncRestorationVisibility,persistenceStatus,detachInteractionDraft,viewEntityMatches,draftRequest,loadInteractionDraft,restoreJournalOperation,ensureStartHandoff,setAction,syncChrome,desiredViewStatus,markCurrentViewStatus,setError,renderRestorationSnapshot}=host;
 const VIEW_SESSION_TOOLS={get:"loomex_view_session_get"};
 const restorationCoordinator = host.lifecycle ?? new ViewRestorationCoordinator();
 const stateStore:NavigationState={
  get viewRestoring(){return restorationCoordinator.state.phase === "loading_snapshot";},
  get viewHydrationEpoch(){return restorationCoordinator.state.generation;},
  get viewRestorationPhase(){return restorationCoordinator.state.phase;},
  get verificationFailedSection(){return restorationCoordinator.state.failedSection;},
  get hydratedReadySessionId(){return ["ready","read_only"].includes(restorationCoordinator.state.phase) ? restorationCoordinator.state.scope : "";},
  viewPersistenceUnavailable:false,viewReentry:null,hydratedSessionId:"",persistenceConflict:false,reopenedInteraction:null,
  followedViewSessions:new Set(),completedViewStatuses:new Set(),refreshedInteractionViews:new Set(),
 };
 let disposed=false;
 const unsubscribe=restorationCoordinator.subscribe(()=>{if(!disposed){syncRestorationVisibility();syncChrome();}});
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
    const refreshKey = `${viewSessionId}:${requestId}:${epoch}`;
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

  type RestoredPreparation =
    | Readonly<{ kind: "valid"; result: RpcResult; preparation: UiData }>
    | Readonly<{ kind: "committed"; run: UiData }>
    | Readonly<{ kind: "pending" }>;

  async function readRestoredPreparation(preparationId: string, epoch: number): Promise<RestoredPreparation> {
    const result = await restoration(callTool("loomex_preparation_get", { preparationId }, false), epoch);
    const restored = dataOf(result);
    // A submitted handoff may reopen before the conversation has committed
    // it. It can also receive a non-preparation payload while an
    // outer restore is completing. Neither condition authorizes reviving the
    // review. Keep its durable lock until a later exact read proves either
    // the original preparation or the run it committed.
    if (result?.isError || result?.structuredContent?.ok === false) return { kind: "pending" };
    const committedRunId = committedPreparationRun(restored, preparationId);
    if (committedRunId) {
      const snapshot = await restoration(callTool("loomex_run_get", { runId: committedRunId }, false), epoch);
      const run = dataOf(snapshot);
      if (snapshot?.isError || snapshot?.structuredContent?.ok === false || executionId(run) !== committedRunId) {
        throw new Error("The committed run could not be verified while restoring this view.");
      }
      return { kind: "committed", run };
    }
    if (restored?.status !== "valid" || restored?.operation !== "runs.prepare" ||
        !restored.preparation || restored.preparation.preparationId !== preparationId) return { kind: "pending" };
    return { kind: "valid", result, preparation: restored.preparation };
  }

  function restoreCommittedRun(run: UiData, returnBrowserViewSessionId: string, preparationId: string): void {
    initializeRunMonitor(run, host.flowStore.flow);
    const flow = activeFlow();
    // A preparation card is immutable presentation state.  Its committed run
    // is useful as a read-only summary, but it must not turn the card into an
    // execution-owned monitor while the preparation session is being verified.
    // Keep the verified preparation identity on the monitor flow so the shell
    // can distinguish this restoration from an ordinary monitor card.
    const previousPreparationId = safeText(flow.prepared?.preparationId, 64);
    if (previousPreparationId && previousPreparationId !== preparationId) {
      throw new Error("The committed run does not match this saved preparation.");
    }
    if (!previousPreparationId) flow.prepared = { preparationId };
    flow.summaryOwner = "preparation";
    flow.returnToBrowser = Boolean(returnBrowserViewSessionId);
    flow.returnViewSessionId = returnBrowserViewSessionId;
    host.setLatest(run);
  }

  async function reconcileRestoredHandoff(flow: RunFlow, state: JsonObject, epoch: number): Promise<boolean> {
    const handoff = decodePersistedHandoff(state);
    // Exact mutation arguments and idempotency keys are restored separately
    // from the owner-scoped operation journal. Presentation state is never a
    // recovery source for those values.
    delete flow.startHandoffOperation;
    flow.startHandoffReady=false;
    flow.startHandoffState="unknown";
    if (!handoff.ref) {
      if (handoff.lifecycle === "legacy") {
        // Earlier cards did not retain a safe reference. They can still show
        // an already committed preparation, but a still-valid review must be
        // prepared again instead of resurrecting its old handoff value.
        const preparationId = safeText(flow.prepared?.preparationId, 64);
        if (!workflowIdValid(preparationId)) throw new Error("The saved preparation is missing its verifiable identity.");
        const preparation = await readRestoredPreparation(preparationId, epoch);
        if (preparation.kind === "committed") {
          restoreCommittedRun(preparation.run, flow.returnViewSessionId || "", preparationId);
          return true;
        }
        flow.preparationStale = true;
      }
      return false;
    }
    flow.startHandoffRef = handoff.ref;
    // Let journal restoration complete before the runner reference is read.
    // Otherwise a remount could mint a duplicate issue/resume while a saved
    // exact operation is still being reconciled.
    return false;
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
    if (host.mode() === "runs" && !host.flowStore.flow) {
      const runs = record(state.runs);
      if (!runs || !restoreRunsFromPersistence) return;
      await restoration(restoreRunsFromPersistence(runs), restorationEpoch);
      restoreDisclosures(state.disclosures);
      return;
    }
    if (host.flowStore.flow?.stage === "setup" && state.workflowId === host.flowStore.flow.selected?.workflowId && state.versionId === host.flowStore.flow.selected?.versionId) {
      host.flowStore.flow.workspaceEditing = host.flowStore.flow.workspaceEditing || state.workspaceEditing === true;
      if (workflowIdValid(state.returnBrowserViewSessionId)) activeFlow().returnViewSessionId = state.returnBrowserViewSessionId;
      renderIntegratedRunFlow();
      restoreControls(state.controls);
    } else {
      const reviewFlow = host.flowStore.flow?.stage === "review" ? host.flowStore.flow : null;
      if (reviewFlow && state.preparationId === reviewFlow.prepared?.preparationId) {
      if (workflowIdValid(state.returnBrowserViewSessionId)) reviewFlow.returnViewSessionId = state.returnBrowserViewSessionId;
      if (workflowIdValid(state.setupViewSessionId)) reviewFlow.setupViewSessionId = state.setupViewSessionId;
      if (typeof state.workflowVersion === "number" && Number.isSafeInteger(state.workflowVersion) && state.workflowVersion > 0) reviewFlow.editWorkflowVersion = state.workflowVersion;
      const committed = await reconcileRestoredHandoff(reviewFlow, state, restorationEpoch);
      if (committed) {
        renderIntegratedRunFlow();
        return true;
      }
      } else if (host.flowStore.flow?.stage === "monitor" && state.executionId === executionId(host.flowStore.flow.result)) {
      const acceptedRequestId = safeText(state.acceptedRequestId, 64);
      if (workflowIdValid(acceptedRequestId)) {
        const result = await restoration(callTool("loomex_interaction_get", { requestId: acceptedRequestId }, false), restorationEpoch);
        const restored = humanRequest(dataOf(result));
        if (result?.isError || !restored || restored.id !== acceptedRequestId ||
            (restored.execution?.id || restored.executionId) !== state.executionId || !humanRequestResolved(restored)) {
          throw new Error("The saved response review could not be verified for this run.");
        }
        host.flowStore.flow.acceptedRequest = restored;
      }
      renderIntegratedRunFlow();
      } else if (host.mode() === "authoring" && state.builderSessionId === builderSessionId(host.latest() || {})) {
      // The provisional snapshot intentionally hides editable controls. This
      // branch runs only after the full owner-checked session read, so it can
      // reveal the canonical form before reconstructing its saved position.
      form.hidden = false;
      const fields = [...form.querySelectorAll<HTMLElement>("fieldset[data-question-id]")];
      const index = fields.findIndex((fieldset) => fieldsetQuestionId(fieldset) === state.currentQuestionId);
      if (index >= 0) showQuestionStep(index, false);
      if (state.phase === "review") {
        try { beginAnswerReview(); } catch { /* Preserve the draft for correction. */ }
      }
      } else if (host.mode() === "interaction" && state.requestId === interactionId(host.latest() || {})) {
      form.hidden = false;
      const fields = [...form.querySelectorAll<HTMLElement>("fieldset[data-question-id]")];
      const index = fields.findIndex((fieldset) => fieldsetQuestionId(fieldset) === state.currentQuestionId);
      if (index >= 0) showQuestionStep(index, false);
      }
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
      const preparation = await readRestoredPreparation(forward.entityId, restorationEpoch);
      if (preparation.kind === "committed") {
        restoreCommittedRun(preparation.run, returnBrowserViewSessionId, forward.entityId);
        observeViewPersistence({ _meta: { "loomex/viewSession": target } });
        renderIntegratedRunFlow();
        return true;
      }
      if (preparation.kind === "pending") {
        throw new Error("The saved preparation is no longer available. Return to setup and prepare it again.");
      }
      host.setLatest(preparation.preparation);
      observePreparationReview(preparation.result, preparation.preparation);
      initializePreparedRunReview(preparation.preparation);
      activeFlow().returnToBrowser = Boolean(returnBrowserViewSessionId);
      activeFlow().returnViewSessionId = returnBrowserViewSessionId;
      const committed = await reconcileRestoredHandoff(activeFlow(), target.state || {}, restorationEpoch);
      observeViewPersistence({ _meta: { "loomex/viewSession": target } });
      if (committed) return true;
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

  function provisionalPhase(projection: RuntimeViewSessionProjection): "verifying" | "read_only" {
    const saved = record(projection.state);
    const sealedNavigation = Boolean(forwardSession(saved?.forwardSession)?.entityType === "preparation");
    return projection.status === "resolved" || projection.status === "inactive" ||
      workflowIdValid(safeText(saved?.acceptedRequestId, 64)) || sealedNavigation ? "read_only" : "verifying";
  }

  function showRetry(section: "snapshot" | "verification", error: Error): void {
    refresh.dataset.retryViewHydration = "true";
    refresh.dataset.retryViewSection = section;
    refresh.hidden = false;
    setAction(refresh, "Retry restore", "refresh");
    refresh.disabled = !host.connected();
    persistenceStatus("load_failed", error);
    setError(error);
    syncChrome();
  }

  async function verifySnapshot(snapshot: RuntimeViewSessionProjection, epoch: number, localChangeVersion: number, fence: RestorationScopeFence, rebuildSnapshotUi: boolean): Promise<RuntimeViewSessionProjection | null> {
    const sessionRead = fence.request("view-session");
    const authoritative = await host.hydrate();
    if (!fence.currentRequest(sessionRead)) return null;
    if (!authoritative) throw new Error("The saved view could not be verified.");
    const projection = host.requiredViewSession(authoritative);
    if(projection.state?.schemaVersion !== undefined && projection.state.schemaVersion !== 1)throw new Error("This saved view uses an unsupported state version. Reopen it from its original command; any pending operation remains saved.");
    if (projection.viewSessionId !== snapshot.viewSessionId || projection.kind !== snapshot.kind ||
        projection.entityType !== snapshot.entityType || projection.entityId !== snapshot.entityId) {
      throw new Error("The saved view changed while it was being restored.");
    }
    if (!fence.current() || disposed || !viewEntityMatches(projection)) throw new Error("The saved view no longer matches this card.");
    // The snapshot renderer removes editable form content. Once this fresh,
    // owner-checked session identity is in hand, reveal the already-rendered
    // canonical form so state/draft restoration has a real DOM target. The
    // mutation-ready gate remains closed until the whole verification path
    // below completes.
    if (rebuildSnapshotUi && ["authoring", "interaction"].includes(host.mode())) {
      // Rendering creates real form controls so drafts can be reconciled, but
      // they must remain inert until the draft and operation journal below
      // are current. A late draft can otherwise overwrite a user's edit.
      form.inert = true;
      host.renderCanonicalRestoration?.();
      form.hidden = false;
    }
    const reopen = host.mode() === "interaction" ? (stateStore.reopenedInteraction || {
      viewSessionId: projection.viewSessionId,
      requestId: interactionId(host.latest() || {}) || "",
    }) : null;
    if (reopen && (reopen.viewSessionId !== projection.viewSessionId || !workflowIdValid(reopen.requestId) ||
        projection.kind !== "interaction" || projection.entityType !== "request" || projection.entityId !== reopen.requestId)) {
      throw new Error("The reopened request does not match this saved interaction view.");
    }
    if (reopen && (rebuildSnapshotUi || projection.status === "resolved" || projection.revision > 0 || stateStore.reopenedInteraction) && stateStore.hydratedSessionId !== projection.viewSessionId && host.persistence.changeVersion === localChangeVersion) {
      const request = fence.request(`interaction:${reopen.requestId}`);
      if (!await refreshReopenedInteraction(reopen, projection.viewSessionId, epoch) || !fence.currentRequest(request)) return null;
    }
    if (rebuildSnapshotUi && host.mode() === "authoring" && projection.entityType === "builderSession") {
      const sessionId = projection.entityId;
      const read = fence.request("authoring-session");
      const result = await callTool("loomex_builder_get", {sessionId}, false, false);
      if (!fence.currentRequest(read)) return null;
      const data = dataOf(result);
      if (result.isError || result.structuredContent?.ok === false || builderSessionId(data) !== sessionId) throw new Error("The authoring session could not be verified.");
      host.setLatest(data);
      render({structuredContent:{ok:true,data}});
    }
    if (host.mode() === "monitor" && projection.status === "resolved" && stateStore.hydratedSessionId !== projection.viewSessionId &&
        host.persistence.changeVersion === localChangeVersion && host.flowStore.flow?.stage === "monitor") {
      const runId = executionId(host.flowStore.flow.result) || safeText(projection.entityId, 64);
      if (!workflowIdValid(runId)) throw new Error("The resolved monitor view is missing its run identity.");
      const request = fence.request(`run:${runId}`);
      const refreshed = await callTool("loomex_run_get", { runId }, false);
      const refreshedData = dataOf(refreshed);
      if (!fence.currentRequest(request)) return null;
      if (refreshed?.isError || refreshed?.structuredContent?.ok === false || executionId(refreshedData) !== runId) throw new Error("The resolved run could not be verified.");
      acceptRunSnapshot(refreshedData, runId);
      host.setLatest(refreshedData);
      render({ structuredContent: { ok: true, data: refreshedData } });
    }
    return projection;
  }

  async function reconcileAuthority(projection:RuntimeViewSessionProjection, epoch:number, fence:RestorationScopeFence):Promise<void> {
    const journalFence = fence.request("journal");
    const journalReady = await restoreJournalOperation(projection, epoch);
    if (!fence.currentRequest(journalFence)) return;
    if (!journalReady) throw new Error("The saved pending action could not be restored.");
  }

  async function restoreEditableState(projection:RuntimeViewSessionProjection, epoch:number, localChangeVersion:number, fence:RestorationScopeFence):Promise<void> {
    if (stateStore.hydratedSessionId !== projection.viewSessionId && host.persistence.changeVersion === localChangeVersion) {
      // Draft answers are separately authoritative. Restore them before
      // rebuilding an authoring review so the review never briefly reflects
      // stale or blank controls from the presentation snapshot.
      const candidate = draftRequest();
      const request = candidate && !humanRequestResolved(candidate) ? candidate : undefined;
      const draftFirst = request && ["authoring", "interaction"].includes(host.mode());
      if (draftFirst) {
        const draftFence = fence.request(`draft:${request.id || "current"}`);
        if (!await loadInteractionDraft(request, epoch) || !fence.currentRequest(draftFence)) {
          throw new Error("The saved answer draft could not be restored.");
        }
      }
      if (await restoreViewState(projection.state)) return;
      if (request && !draftFirst) {
        const draftFence = fence.request(`draft:${request.id || "current"}`);
        if (!await loadInteractionDraft(request, epoch) || !fence.currentRequest(draftFence)) throw new Error("The saved answer draft could not be restored.");
      }
      stateStore.hydratedSessionId = projection.viewSessionId;
    }
  }

  async function projectVerifiedState(projection:RuntimeViewSessionProjection, epoch:number, fence:RestorationScopeFence):Promise<"ready"|"read_only"> {
    if (!fence.current() || disposed || !viewEntityMatches(projection)) return "read_only";
    form.inert = false;
    if (["authoring", "interaction"].includes(host.mode())) {
      form.hidden = false;
    }
    host.restoreDelivery?.(projection.state);
    host.projectRetainedOperation?.();
    delete refresh.dataset.retryViewHydration;
    delete refresh.dataset.retryViewSection;
    if (["setup", "review"].includes(host.flowStore.flow?.stage || "")) {
      renderIntegratedRunFlow();
    }
    else syncChrome();
    restoreDisclosures(projection.state?.disclosures);
    restoreReadingPosition(projection.state, epoch);
    const completedStatus = desiredViewStatus();
    if (completedStatus) void markCurrentViewStatus(completedStatus);
    return desiredViewStatus() || (humanRequest(host.latest() || {}) && humanRequestResolved(humanRequest(host.latest() || {})!)) ? "read_only" : "ready";
  }

  function observeViewPersistence(result: RpcResult): Promise<boolean> | undefined {
    if (disposed) return undefined;
    const fault = viewPersistenceFault(result);
    if (fault?.status === "reentry") {
      restorationCoordinator.reenter();
      enterSafeViewReentry(fault);
      return Promise.resolve(false);
    }
    if (fault?.status === "unavailable") {
      restorationCoordinator.unavailable();
      stateStore.viewReentry = null;
      stateStore.viewPersistenceUnavailable = true;
      syncRestorationVisibility();
        persistenceStatus("save_failed");
      return Promise.resolve(false);
    }
    const supplied = viewSessionProjection(result);
    if (!supplied) {
      if (!host.persistence.session) { restorationCoordinator.unavailable(); syncRestorationVisibility(); }
      return Promise.resolve(false);
    }
    stateStore.viewPersistenceUnavailable = false;
    stateStore.viewReentry = null;
    const changedSession = host.persistence.configure(supplied);
    if (changedSession) {
      stateStore.persistenceConflict = false;
      detachInteractionDraft();
    }
    // Only a plugin-provided restore response represents a remounted card.
    // A newly created session already accompanies fresh authoritative tool
    // output, so showing its own saved display projection would duplicate the
    // live form and spend an unnecessary runner round trip.
    const rawMeta = record(record(result._meta)?.["loomex/viewSession"]);
    const showSavedSnapshot = rawMeta?.restoreVersion === "presentation.sessions.restore/v1";
    if (["inactive", "resolved"].includes(supplied.status || "")) stateStore.completedViewStatuses.add(`${supplied.viewSessionId}:${supplied.status}`);
    const localChangeVersion = host.persistence.changeVersion;
    let verified: RuntimeViewSessionProjection | null = null;
    return restorationCoordinator.open({
      mode: host.mode(), identity: supplied.viewSessionId,
      domainIdentity: `${supplied.entityType}:${supplied.entityId}`,
      snapshot: async () => {
        const projection = showSavedSnapshot
          ? (host.persistence.restoreSnapshot ? await host.persistence.restoreSnapshot() : await host.hydrate())
          : supplied;
        if (!projection) return projection;
        const restored = host.requiredViewSession(projection);
        if (restored.viewSessionId !== supplied.viewSessionId || restored.kind !== supplied.kind ||
            restored.entityType !== supplied.entityType || restored.entityId !== supplied.entityId) {
          throw new Error("The saved view snapshot does not match this card.");
        }
        return restored;
      },
      display: async (projection, fence) => {
        if (!fence.current() || disposed) return "read_only";
        const phase = provisionalPhase(projection);
        if (!showSavedSnapshot) return phase;
        // Persisted state is presentation-only. Applying it early makes the
        // card readable while runtime reads happen, and the shell's ready gate
        // keeps all inputs and actions inert until verification succeeds.
        renderRestorationSnapshot?.(projection, phase);
        syncChrome();
        return phase;
      },
      verify: async (projection, fence) => {
        verified = await verifySnapshot(projection, fence.generation, localChangeVersion, fence, showSavedSnapshot);
        return desiredViewStatus() ? "read_only" : "ready";
      },
      reconcile: async (_, fence) => { if(verified) await reconcileAuthority(verified,fence.generation,fence); },
      restoreDraft: async (_, fence) => { if(verified) await restoreEditableState(verified,fence.generation,localChangeVersion,fence); },
      project: async (_, fence) => verified ? projectVerifiedState(verified,fence.generation,fence) : "read_only",
      ready: () => { if (["setup","review"].includes(host.flowStore.flow?.stage ?? "")) renderIntegratedRunFlow(); },
      failed: (section, error) => showRetry(section, error),
    });
  }

return {refreshReopenedInteraction, restoreViewState, followForwardSession, observeViewPersistence,state:stateStore,lifecycle:restorationCoordinator,dispose(){disposed=true;unsubscribe();restorationCoordinator.dispose();}};
}

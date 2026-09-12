import { createUiElement as element } from "./components.js";
import { formatFollowContinuationContext, formatFollowContinuationMarkdown } from "../monitoring-contract.js";
import type { JsonObject } from "./contracts.js";
import type { ActionId } from "./shell.js";
import type { InteractionFormController } from "./interaction-form.js";
import type { UiData, HumanRequest, InputSpec, RunFlow, MonitorRunFlow, RpcResult, InteractionDraft, MutationOperationState, ExecutionProjection, RunPresentation } from "./page-models.js";
export interface ContinuationEvent { trigger?: string; acceptedInteraction?: {requestId?: unknown;status?: unknown}; followContinuation?: unknown; }
export interface Continuation extends JsonObject { schema: string; intent: string; runId: string; trigger: string; state:string; acceptedInteraction?: {requestId:string;status:string}; followContinuation?: {schemaVersion:string;source:string;runId:string;receipt:string}; }
export interface RunChatHandoff {runId:string;status:"sending"|"sent"|"manual"|"failed";continuation:Continuation;}
export interface RunMonitorServices {
  readonly flowStore: {flow: RunFlow | null};
  readonly elements: {context:HTMLElement;form:HTMLFormElement;summary:HTMLElement;primary:HTMLButtonElement;secondary:HTMLButtonElement;refresh:HTMLButtonElement;errorDetails:HTMLElement};
  readonly forms: Pick<InteractionFormController,"typedForm"|"appendRequestCopy"|"hidePersistentBatchReview"|"answerActionLabel"|"submittedAnswerReview">;
  connected():boolean;
  latest(): UiData | null;
  setLatest(value:UiData):void;
  capabilities(): Record<string,unknown>;
  backendDraft(): InteractionDraft | null;
  detachInteractionDraft():void;
  draftRequest(): HumanRequest | undefined;
  requestSchemaDigest(request:HumanRequest):string | undefined;
  humanRequest(data?:UiData):HumanRequest | undefined;
  humanRequestResolved(request:HumanRequest):boolean;
  executionId(data?:UiData):string;
  interactionId(data:UiData):string;
  safeText(value:unknown,max?:number):string | undefined;
  workflowIdValid(value:unknown):value is string;
  terminalRun(execution:ExecutionProjection):boolean;
  renderRun(execution:ExecutionProjection):void;
  renderHumanPresentation(request:HumanRequest,spec?:InputSpec):boolean;
  humanPresentation(request:HumanRequest):RunPresentation | undefined;
  formatStatus(value:unknown):string | undefined;
  setAction(button:HTMLButtonElement,label:string,id?:ActionId):void;
  setMutationAction(button:HTMLButtonElement,label:string,id?:ActionId):void;
  setInteractionAction(button:HTMLButtonElement,intent:"approve"|"reject",label:string):void;
  setError(error:unknown):void;
  syncChrome():void;
  onRender():void;
  runFlowError(message:string):void;
  renderRunSetup():void;
  renderRunReview():void;
  dataOf(result:RpcResult):UiData;
  send(method:string,params:JsonObject):Promise<unknown>;
  persistenceTool(name:string,args:JsonObject):Promise<unknown>;
  settleMutationOperation(operation:MutationOperationState,status:string,result:RpcResult):Promise<unknown>;
  transitionSessionAfterSuccess(operation:MutationOperationState):Promise<unknown>;
  uuid():string;
}
function record(value:unknown):Record<string,unknown> | null {return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string,unknown> : null;}
function immutableCopy<T>(value:T):T {return structuredClone(value);}

/** Owns monitor rendering and chat handoff. It never polls execution from the card. */
export function createRunMonitorController(host:RunMonitorServices) {
 const {context,form,summary,primary,secondary,refresh,errorDetails}=host.elements;
 const {typedForm,appendRequestCopy,hidePersistentBatchReview,answerActionLabel,submittedAnswerReview}=host.forms;
 const {draftRequest,requestSchemaDigest,humanRequest,humanRequestResolved,executionId,interactionId,safeText,workflowIdValid,terminalRun,renderRun,renderHumanPresentation,humanPresentation,formatStatus,setAction,setMutationAction,setInteractionAction,setError,syncChrome,runFlowError,renderRunSetup,renderRunReview,dataOf,send,persistenceTool,settleMutationOperation,transitionSessionAfterSuccess,uuid,detachInteractionDraft}=host;
 let chatHandoff:RunChatHandoff|null=null;
 let disposed=false;
 const listeners=new AbortController();
 function activeFlow():MonitorRunFlow {
  const flow=host.flowStore.flow;
  if(!flow || flow.stage!=="monitor" || !flow.result || !flow.resolvedRequestIds || !flow.humanDrafts)throw new Error("Run monitoring state is not available.");
  return flow as MonitorRunFlow;
 }
  function stalePreparationError(code: unknown) {
    return typeof code === "string" && ["EXECUTION_BINDING_CONFLICT", "PRECONDITION_FAILED", "PREPARATION_NOT_FOUND"].includes(code);
  }

  function runHumanRequest(data: UiData | undefined = host.flowStore.flow?.result) {
    if (host.flowStore.flow?.baselineRequired) return undefined;
    const request = humanRequest(data);
    const runId = executionId(data);
    const organizationIds = [host.flowStore.flow?.organizationId, data?.execution?.organizationId, request?.organizationId, request?.execution?.organizationId]
      .filter((value) => typeof value === "string" && value.length > 0);
    const organizationVerified = organizationIds.length > 0 && organizationIds.every(workflowIdValid) && new Set(organizationIds).size === 1;
    if (!request || !request.id || !runId || request?.execution?.id !== runId || !organizationVerified || humanRequestResolved(request) || host.flowStore.flow?.resolvedRequestIds?.has(request.id)) return undefined;
    return String(request.status || "").toLowerCase() === "pending" ? request : undefined;
  }

  function initializeRunMonitor(data: UiData, previous: RunFlow | null = host.flowStore.flow, { acceptedCommit = false }: { acceptedCommit?: boolean } = {}): void {
    const runId = executionId(data);
    if (!runId) throw new Error("The runner did not return a verifiable run identity.");
    const organizationId = safeText(previous?.selected?.organizationId, 64) || safeText(previous?.organizationId, 64) || safeText(data?.execution?.organizationId, 64);
    const candidate: RunFlow = {
      ...(previous || {}),
      stage: "monitor",
      result: data,
      ...(organizationId ? { organizationId } : {}),
      operations: previous?.operations || new Map(),
      humanDrafts: previous?.humanDrafts || new Map(),
      resolvedRequestIds: previous?.resolvedRequestIds || new Set(),
      busy: false,
      readEpoch: previous?.readEpoch || 0,
      baselineRequired: Boolean(acceptedCommit),
      returnToBrowser: Boolean(previous?.returnToBrowser),
    };
    delete candidate.humanMode;
    host.flowStore.flow = candidate;
    try {
      acceptRunSnapshot(data, runId, { initial: true });
    } catch (error) {
      if (!acceptedCommit) {
        host.flowStore.flow = previous || { ...candidate, result: { ...(data.execution ? { execution: data.execution } : {}) } };
        delete host.flowStore.flow.currentRequestId;
        throw error;
      }
      const safeResult = { ...data };
      delete safeResult.humanRequest;
      host.flowStore.flow = {
        ...candidate,
        result: safeResult,
        errorMessage: "The run started, but its human request could not be verified. Refresh run to load the current authoritative state.",
      };
      delete host.flowStore.flow.currentRequestId;
      host.setLatest(safeResult);
    }
  }

  function runSequence(data?: UiData): number | undefined {
    return typeof data?.latestSequence === "number" && Number.isSafeInteger(data.latestSequence) && data.latestSequence >= 0 ? data.latestSequence : undefined;
  }

  function retainedInteractionOperation() {
    return [...(host.flowStore.flow?.operations?.values() || [])].find((operation) =>
      ["loomex_interaction_respond", "loomex_interaction_decide"].includes(operation.name));
  }

  function consumeResolvedRunRequest(requestId: string) {
    const flow = activeFlow();
    if (!requestId) return;
    flow.resolvedRequestIds.add(requestId);
    flow.humanDrafts.delete(requestId);
    const operation = retainedInteractionOperation();
    if (operation?.arguments?.requestId === requestId) {
      flow.operations.delete(operation.slot);
      void settleMutationOperation(operation, "completed", { structuredContent: { ok: true, data: { requestId } } })
        .then(() => transitionSessionAfterSuccess(operation)).catch(() => {});
    }
    if (flow.currentRequestId === requestId) delete flow.humanMode;
    const draft = host.backendDraft();
    if (draft?.requestId === requestId && typeof draft.revision === "number") {
      detachInteractionDraft();
      void persistenceTool("loomex_interaction_draft_delete", {
        requestId,
        expectedRevision: draft.revision,
        ...(typeof draft.schemaDigest === "string" ? { expectedSchemaDigest: draft.schemaDigest } : {}),
        idempotencyKey: uuid(),
      }).catch(() => {});
    }
  }

  function acceptRunSnapshot(data: UiData, expectedRunId: string, { initial = false } = {}) {
    const flow = activeFlow();
    if (!data || executionId(data) !== expectedRunId) throw new Error("The runner returned status for a different run.");
    const previousData = flow.result;
    const execution = data.execution || {};
    const previousSequence = runSequence(previousData);
    const incomingSequence = runSequence(data);
    if (!initial && previousSequence !== undefined && incomingSequence !== undefined && incomingSequence < previousSequence) {
      throw new Error("The runner returned an older run snapshot.");
    }
    if (!initial && terminalRun(previousData?.execution || {}) && !terminalRun(execution)) {
      throw new Error("The runner returned a non-terminal state for a completed run.");
    }
    const incomingOrganization = safeText(execution.organizationId, 64);
    let candidateOrganization = flow.organizationId;
    let candidateCurrentRequestId = flow.currentRequestId;
    let candidateAcceptedRequest = flow.acceptedRequest;
    const consumedRequestIds = new Set<string>();
    if (candidateOrganization && incomingOrganization && incomingOrganization !== candidateOrganization) {
      throw new Error("The runner returned status for a different organization.");
    }
    if (!candidateOrganization && incomingOrganization) candidateOrganization = incomingOrganization;
    const request = humanRequest(data);
    if (request) {
      const requestId = safeText(request.id, 64);
      if (!requestId || request?.execution?.id !== expectedRunId) {
        throw new Error("The runner returned a human request that is not bound to this run.");
      }
      const requestOrganization = safeText(request?.organizationId, 64);
      const requestExecutionOrganization = safeText(request?.execution?.organizationId, 64);
      if (requestOrganization && requestExecutionOrganization && requestOrganization !== requestExecutionOrganization) {
        throw new Error("The runner returned conflicting organization identities for the human request.");
      }
      const suppliedRequestOrganization = requestOrganization || requestExecutionOrganization;
      if (candidateOrganization && suppliedRequestOrganization && suppliedRequestOrganization !== candidateOrganization) {
        throw new Error("The runner returned a human request for a different organization.");
      }
      if (!candidateOrganization && suppliedRequestOrganization) candidateOrganization = suppliedRequestOrganization;
      const pendingOrganizationIds = [candidateOrganization, incomingOrganization, requestOrganization, requestExecutionOrganization]
        .filter((value) => typeof value === "string" && value.length > 0);
      if (!humanRequestResolved(request) && (pendingOrganizationIds.length === 0 ||
          pendingOrganizationIds.some((value) => !workflowIdValid(value)) || new Set(pendingOrganizationIds).size !== 1)) {
        throw new Error("The runner returned a pending human request without a verifiable organization identity.");
      }
      const current = humanRequest(flow.result);
      const currentPending = current && current.id && current.id === flow.currentRequestId &&
        !humanRequestResolved(current) && !flow.resolvedRequestIds.has(current.id);
      if (!initial && currentPending && requestId !== current.id) {
        const advanced = incomingSequence !== undefined && previousSequence !== undefined && incomingSequence > previousSequence;
        if (!advanced) throw new Error("The runner returned a different request before the current response was resolved.");
        if (current.id) consumedRequestIds.add(current.id);
      }
      if (flow.resolvedRequestIds.has(requestId) && !humanRequestResolved(request)) {
        throw new Error("The runner returned an already resolved request as pending.");
      }
      if (!humanRequestResolved(request)) candidateCurrentRequestId = requestId;
      if (!humanRequestResolved(request) && candidateAcceptedRequest?.id !== requestId) candidateAcceptedRequest = undefined;
    }
    const current = humanRequest(previousData);
    const currentPending = !initial && current && current.id && current.id === flow.currentRequestId &&
      !humanRequestResolved(current) && !flow.resolvedRequestIds.has(current.id);
    if (currentPending) {
      const sameResolved = request && request.id === current.id && humanRequestResolved(request);
      const advanced = incomingSequence !== undefined && previousSequence !== undefined && incomingSequence > previousSequence;
      const terminal = terminalRun(execution);
      if (!request && !advanced && !terminal) {
        throw new Error("The runner returned an older snapshot that cannot resolve the current request.");
      }
      if (sameResolved || !request || request.id !== current.id) if (current.id) consumedRequestIds.add(current.id);
    }
    if (terminalRun(execution) && request && !humanRequestResolved(request)) {
      throw new Error("The runner returned a pending request for a terminal run.");
    }
    if (candidateOrganization) flow.organizationId = candidateOrganization; else delete flow.organizationId;
    for (const requestId of consumedRequestIds) consumeResolvedRunRequest(requestId);
    if (candidateCurrentRequestId) flow.currentRequestId = candidateCurrentRequestId; else delete flow.currentRequestId;
    if (candidateAcceptedRequest) flow.acceptedRequest = candidateAcceptedRequest; else delete flow.acceptedRequest;
    host.setLatest(data);
    flow.result = data;
    return data;
  }

  function captureRunHumanDraft() {
    const flow = activeFlow();
    const request = runHumanRequest();
    if (!request || !request.id || form.hidden || flow?.humanMode === "cancel") return;
    const controls: JsonObject = {};
    for (const control of form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input, textarea, select")) {
      if (!control.id) continue;
      controls[control.id] = { value: control.value, checked: control instanceof HTMLInputElement && control.checked };
    }
    if (Object.keys(controls).length) flow.humanDrafts.set(request.id, controls);
  }

  function restoreRunHumanDraft(request: HumanRequest) {
    const draft = request.id ? host.flowStore.flow?.humanDrafts?.get(request.id) : undefined;
    if (!draft) return;
    for (const control of form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input, textarea, select")) {
      const saved = record(draft[control.id]);
      if (!saved || typeof saved.value !== "string") continue;
      control.value = saved.value;
      if (control instanceof HTMLInputElement && typeof saved.checked === "boolean") control.checked = saved.checked;
      control.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  function appendRunCancelAction(request: HumanRequest) {
    const flow = activeFlow();
    const actions = element("div", { className: "actions" });
    const cancel = element("button", { type: "button", className: "secondary", disabled: !host.connected() || flow.busy || flow.operations.size > 0 }, "Cancel run");
    setAction(cancel, "Cancel run", "cancel");
    cancel.addEventListener("click", () => {
      if (flow.busy || flow.operations.size > 0) return;
      captureRunHumanDraft();
      flow.humanMode = "cancel";
      renderIntegratedRunFlow();
    }, {signal:listeners.signal});
    actions.append(cancel);
    context.append(actions);
  }

  function chatContinuation(runId: string, event: ContinuationEvent = {}): Continuation {
    if (!workflowIdValid(runId)) throw new Error("The run identity could not be verified for chat continuation.");
    const accepted = event.acceptedInteraction;
    const requestId = safeText(accepted?.requestId, 64);
    const status = safeText(accepted?.status, 64);
    if (event.trigger === "interaction_accepted" && (!workflowIdValid(requestId) || !status ||
      !["resolved", "completed", "answered", "approved", "rejected"].includes(status))) {
      throw new Error("The accepted interaction could not be verified for chat continuation.");
    }
    const issued = record(event.followContinuation);
    const issuedRunId = safeText(issued?.runId, 128);
    const issuedReceipt = safeText(issued?.receipt, 2048);
    if (event.followContinuation && (!issued || issuedRunId !== runId || !issuedReceipt || !/^[A-Za-z0-9_-]{16,2048}$/.test(issuedReceipt))) {
      throw new Error("The runner returned an invalid follow continuation receipt.");
    }
    return {
      schema: "loomex/chat-continuation/v2", intent: "monitor_existing_run", runId,
      trigger: event.trigger === "interaction_accepted" ? "interaction_accepted" : event.trigger === "run_started" ? "run_started" : "follow_requested",
      ...(event.trigger === "interaction_accepted" && requestId && status ? { acceptedInteraction: { requestId, status } } : {}),
      ...(issuedReceipt ? { followContinuation: { schemaVersion: "loomex.follow-session.continuation/v1", source: "generated_markdown", runId, receipt: issuedReceipt } } : {}),
      state: "requires_fresh_read",
    };
  }

  // Keep the manual copy and acknowledged host message byte-for-byte aligned.
  // The first line is intentionally a bare command so the host can route it;
  // the remainder is compact Markdown and contains only the facts needed to
  // resume this exact run.
  function formatChatContinuationMarkdown(runId: string, continuation: Partial<Continuation> = {}) {
    const receipt = continuation.followContinuation?.receipt;
    if (!receipt) return `To continue monitoring this exact Loomex run, submit \`$loomex-follow ${runId}\`.`;
    return formatFollowContinuationMarkdown(runId, receipt);
  }

  function chatCapability(name: string) {
    return Boolean(record(host.capabilities()[name])?.text);
  }

  function renderSubmittedInteraction(request: HumanRequest) {
    form.hidden = true;
    form.replaceChildren();
    primary.hidden = true;
    secondary.hidden = true;
    context.className = "ui-stack";
    context.replaceChildren();
    if (humanRequestResolved(request)) context.append(submittedAnswerReview(request));
    context.hidden = false;
    summary.classList.remove("error");
    summary.setAttribute("role", "status");
    summary.textContent = "Response received. This request is complete.";
    refresh.hidden = false;
    refresh.disabled = !host.connected();
  }

  function renderChatHandoffState() {
    if (!chatHandoff) return;
    form.hidden = true;
    form.replaceChildren();
    primary.hidden = true;
    secondary.hidden = true;
    // Once the handoff was delivered, the accepted response is the complete
    // card state. Do not leave a second successful-handoff card beside it.
    if (!host.flowStore.flow && ["sending", "sent"].includes(chatHandoff.status)) {
      const request = humanRequest(host.latest() || {});
      if (request) renderSubmittedInteraction(request);
      return;
    }
    context.querySelectorAll('[aria-label="Chat handoff"]').forEach((item) => item.remove());
    const callout = element("section", { className: "ui-callout", "aria-label": "Chat handoff", role: chatHandoff.status === "failed" ? "alert" : "status" });
    const statusCopy = chatHandoff.status === "sent"
      ? "Continue there for updates."
      : chatHandoff.status === "sending"
        ? "Sending this run to chat…"
        : chatHandoff.status === "manual"
          ? "This host cannot send the run to chat automatically. Use the read-only command below in chat."
          : "The run was accepted, but the chat handoff did not complete. The run or response will not be submitted again.";
    callout.append(element("h3", {}, chatHandoff.status === "sent" ? "Sent to chat" : "Continue in chat"));
    callout.append(element("p", {}, statusCopy));
    if (["manual", "failed"].includes(chatHandoff.status)) {
      const instructions = element("details", { className: "ui-disclosure", open: true });
      instructions.append(element("summary", {}, "Manual monitoring instructions"));
      const command = element("p", { className: "workspace-path" }, formatChatContinuationMarkdown(chatHandoff.runId, chatHandoff.continuation));
      command.setAttribute("aria-label", "Read-only resume command");
      instructions.append(command);
      callout.append(instructions);
    }
    if (!host.flowStore.flow) {
      context.className = "ui-stack";
      // Keep a resolved response review visible after handoff. The handoff is
      // supplemental status, never a replacement for the accepted answer.
      if (context.hidden || !context.childElementCount) context.replaceChildren(callout);
      else context.append(callout);
      context.hidden = false;
    } else context.append(callout);
    summary.classList.remove("error");
    summary.setAttribute("role", "status");
    summary.textContent = "";
    refresh.hidden = !host.flowStore.flow;
    refresh.disabled = !host.connected() || ["sending", "failed"].includes(chatHandoff.status);
    if (chatHandoff.status === "failed") {
      primary.hidden = false;
      setAction(primary, "Retry chat handoff", "chat");
      primary.disabled = !host.connected();
    }
  }

  async function handoffRunToChat(runId: string, event: ContinuationEvent = {}) {
    const safeRunId = workflowIdValid(runId) ? runId : undefined;
    if (!safeRunId) return;
    const continuation = chatContinuation(safeRunId, event);
    if (disposed) return;
    const attempt: RunChatHandoff = { runId: safeRunId, status: "sending", continuation };
    chatHandoff = attempt;
    if (host.flowStore.flow) renderIntegratedRunFlow();
    else renderChatHandoffState();
    // Generated Markdown is accepted by the lifecycle hook only when the
    // runner issued an opaque receipt. Without one, keep the copyable manual
    // instruction in the card and do not send an activatable follow message.
    if (!continuation.followContinuation?.receipt) {
      attempt.status = "manual";
      if (host.flowStore.flow) renderIntegratedRunFlow(); else renderChatHandoffState();
      return;
    }
    if (!chatCapability("updateModelContext") || !chatCapability("message")) {
      attempt.status = "manual";
      if (host.flowStore.flow) renderIntegratedRunFlow(); else renderChatHandoffState();
      return;
    }
    const text = formatChatContinuationMarkdown(safeRunId, continuation);
    try {
      const contextResult = await send("ui/update-model-context", { content: [{ type: "text", text: formatFollowContinuationContext(continuation) }] });
      if (disposed || chatHandoff !== attempt) return;
      if (record(contextResult)?.isError === true) throw new Error("The host rejected the model context update.");
      const messageResult = await send("ui/message", { role: "user", content: [{ type: "text", text }] });
      if (disposed || chatHandoff !== attempt) return;
      if (record(messageResult)?.isError === true) throw new Error("The host rejected the chat message.");
      attempt.status = "sent";
    } catch {
      if (disposed || chatHandoff !== attempt) return;
      attempt.status = "failed";
    }
    if (host.flowStore.flow) renderIntegratedRunFlow(); else renderChatHandoffState();
  }

  async function handoffAcceptedInteraction(authoritativeData: UiData, result: RpcResult) {
    if (result?.isError || result?.structuredContent?.ok === false) return;
    const requestRunId = safeText(humanRequest(authoritativeData)?.execution?.id, 128);
    const resultData = dataOf(result);
    const returnedRunId = safeText(resultData?.executionId, 128) || safeText(executionId(resultData), 128);
    if (requestRunId && returnedRunId && requestRunId !== returnedRunId) {
      setError(new Error("The response was accepted, but the returned run identity conflicts with the original request. Continue in chat from the original request before reading run state."));
      return;
    }
    const runId = returnedRunId || requestRunId;
    if (runId) await handoffRunToChat(runId, { trigger: "interaction_accepted", acceptedInteraction: {
      requestId: resultData.requestId, status: String(resultData.requestStatus).toLowerCase(),
    }, followContinuation: resultData.details?.followContinuation });
  }

  async function handoffLongQuestionToChat() {
    if (disposed) return;
    const request = draftRequest() || humanRequest(host.latest() || {});
    const requestId = safeText(request?.id, 64);
    if (!workflowIdValid(requestId)) throw new Error("This question cannot be bound to a verified request.");
    const messageResult = await send("ui/message", {
      role: "user",
      content: [{
        type: "text",
        text: `$loomex-answer ${requestId}\nOpen this exact pending Loomex question in chat and collect my long-form answer there. Read the current request before presenting it. Do not answer it for me or reuse an earlier draft.`,
      }],
    });
    if (disposed) return;
    if (record(messageResult)?.isError) throw new Error("The host could not send this question to the conversation.");
    summary.classList.remove("error");
    summary.setAttribute("role", "status");
    summary.textContent = "The question was sent to the conversation for your answer.";
  }

  function renderRunHumanRequest(request: HumanRequest) {
    const flow = activeFlow();
    const requestId = interactionId({ humanRequest: request });
    const requestType = request.type;
    const schema = request.responseSchema || request.outputSchema;
    const operation = flow.operations.values().next().value;
    const responding = operation && ["loomex_interaction_respond", "loomex_interaction_decide"].includes(operation.name);
    if (flow.humanMode === "cancel") {
      renderRun(flow.result.execution || {});
      const cancelling = operation?.name === "loomex_run_cancel";
      typedForm({ properties: { reason: { type: "string" } } }, cancelling ? { reason: operation.arguments.reason } : {});
      if (cancelling) for (const control of form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input, textarea, select")) control.disabled = true;
      secondary.hidden = false; setAction(secondary, "Back to question", "back"); secondary.disabled = flow.busy || flow.operations.size > 0;
      primary.hidden = false; primary.className = "danger"; setMutationAction(primary, operation ? "Retry exact cancellation" : "Cancel run", "cancel");
      primary.disabled = !host.connected() || flow.busy;
      summary.textContent = "Cancel this run separately from the workflow response.";
      return;
    }
    renderHumanPresentation(request, request.inputSpec);
    if (!humanPresentation(request)) renderRun(flow.result.execution || {});
    appendRunCancelAction(request);
    if (requestType === "approval" || flow.result.decisionRequired === true) {
      appendRequestCopy(request, request.inputSpec);
      form.hidden = false;
      primary.hidden = false;
      secondary.hidden = false;
      if (responding) {
        setMutationAction(primary, operation.arguments.decision === "reject" ? "Retry exact rejection" : "Retry exact approval", operation.arguments.decision === "reject" ? "reject" : "approve");
        secondary.hidden = true;
      } else {
        setInteractionAction(primary, "approve", "Approve");
        setInteractionAction(secondary, "reject", "Reject");
      }
      primary.disabled = !host.connected() || flow.busy || !requestId;
      secondary.disabled = !host.connected() || flow.busy || !requestId;
    } else {
      const initial = responding ? operation.arguments.answer : request.answer;
      const formReady = typedForm(schema, initial, request.inputSpec, request);
      if (!responding) restoreRunHumanDraft(request);
      primary.hidden = false;
      const responseAction = responding ? "Retry exact response" : form.dataset.formKind === "chat-answer" ? "Continue in conversation" : answerActionLabel("Review");
      if (responding) setMutationAction(primary, responseAction, "submit"); else setAction(primary, responseAction, form.dataset.formKind === "chat-answer" ? "chat" : "review");
      primary.disabled = !host.connected() || flow.busy || !requestId || (!formReady && form.dataset.formKind !== "chat-answer");
      secondary.hidden = true;
      if (!responding) hidePersistentBatchReview();
    }
    if (responding) {
      for (const control of form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input, textarea, select")) control.disabled = true;
    }
    if (requestType !== "approval" && flow.result.decisionRequired !== true && form.dataset.formKind !== "chat-answer" && !requestSchemaDigest(request)) {
      primary.disabled = true;
      summary.classList.add("error");
      summary.setAttribute("role", "alert");
      summary.textContent = "The current question schema could not be verified. Refresh this run before answering.";
    } else summary.textContent = "";
  }

  function renderRunStarted() {
    const flow = activeFlow();
    form.hidden = true; form.replaceChildren(); secondary.hidden = true; primary.hidden = true; primary.className = "";
    refresh.hidden = false; setAction(refresh, "Refresh run", "refresh"); refresh.disabled = !host.connected() || flow.busy;
    if (flow.baselineRequired) {
      renderRun(flow.result.execution || {});
      context.setAttribute("aria-busy", String(flow.busy));
      summary.classList.remove("error"); summary.setAttribute("role", "status");
      summary.textContent = "Run started. Send it to chat to continue monitoring.";
      if (flow.errorMessage) runFlowError(flow.errorMessage);
      return;
    }
    // Chat monitoring is dispatched separately. This card remains a stable,
    // read-only view of the selected run instead of becoming a second chat
    // control surface after the run starts, even if a later snapshot includes
    // a pending interaction.
    renderRun(flow.result.execution || {});
    if (flow.acceptedRequest) context.append(submittedAnswerReview(flow.acceptedRequest));
    context.setAttribute("aria-busy", String(flow.busy));
    summary.classList.remove("error"); summary.setAttribute("role", "status");
    const terminal = terminalRun(flow.result.execution || {});
    const waitingForResponse = Boolean(runHumanRequest());
    summary.textContent = terminal ? `${formatStatus(flow.result.execution?.status)}. Review the result below.`
      : chatHandoff?.status === "sending"
        ? "Run started. Opening monitoring in chat…"
      : chatHandoff?.status === "sent"
        ? "Sent to chat."
      : ["manual", "failed"].includes(chatHandoff?.status || "")
        ? "Run started. The chat continuation could not be opened automatically."
      : waitingForResponse
        ? "This run needs a response in chat."
      : /waiting|queued|pending|paused/i.test(flow.result.execution?.status || "")
        ? "This run is waiting. Its current summary is shown here."
        : "This run is active. Its current summary is shown here.";
    if (flow.errorMessage) runFlowError(flow.errorMessage);
  }

  function renderIntegratedRunFlow() {
    if (disposed) return;
    try { renderIntegratedRunFlowContent(); } finally { syncChrome(); }
  }

  function renderIntegratedRunFlowContent() {
    if (!host.flowStore.flow) return;
    host.onRender();
    errorDetails.replaceChildren();
    errorDetails.hidden = true;
    if (!host.flowStore.flow.errorMessage) delete host.flowStore.flow.error;
    if (host.flowStore.flow.stage === "setup") renderRunSetup();
    else if (host.flowStore.flow.stage === "review") renderRunReview();
    else renderRunStarted();
  }

return {stalePreparationError, runHumanRequest, initializeRunMonitor, runSequence, retainedInteractionOperation, consumeResolvedRunRequest, acceptRunSnapshot, captureRunHumanDraft, restoreRunHumanDraft, appendRunCancelAction, chatContinuation, formatChatContinuationMarkdown, chatCapability, renderSubmittedInteraction, renderChatHandoffState, handoffRunToChat, handoffAcceptedInteraction, handoffLongQuestionToChat, renderRunHumanRequest, renderRunStarted, renderIntegratedRunFlow, renderIntegratedRunFlowContent, get chatHandoff(){return chatHandoff;}, set chatHandoff(value:RunChatHandoff|null){chatHandoff=value;}, dispose(){disposed=true;listeners.abort();}};
}

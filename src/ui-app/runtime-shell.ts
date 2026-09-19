import type {ViewRestorationPhase} from "./persistence.js";
import { ACTIONS, createIcon, type ActionId } from './shell.js';
import type { ActionIcon } from './contracts.js';
import { setRestoring } from './lifecycle.js';
import { applyButtonStyle as applySharedButtonStyle, applyStatusBadgeStyle, configureUiElementStyles, createElement as element } from './components.js';
export interface ChromeProjection {
 title:string;stageLabel:string|undefined;status:string|undefined;duration:string|undefined;
 restorationPhase?:ViewRestorationPhase;restoring:boolean;persistenceUnavailable:boolean;reentry:boolean;mutationReady:boolean;editingReady?:boolean;authorityStale?:boolean;hasSession:boolean;
 automaticSetupOwnsActivity:boolean;isConnectionView:boolean;
}
export interface ShellServices {
 elements:{title:HTMLElement;context:HTMLElement;summary:HTMLElement;form:HTMLFormElement;headerLeading:HTMLElement;headerContextActions:HTMLElement;headerStage:HTMLElement;headerStatus:HTMLElement;primary:HTMLButtonElement;secondary:HTMLButtonElement};
 snapshot():ChromeProjection;
 statusClasses:Readonly<Record<string,string>>;
}
type Control=HTMLButtonElement|HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement;
const isControl=(value:Element):value is Control=>value instanceof HTMLButtonElement||value instanceof HTMLInputElement||value instanceof HTMLTextAreaElement||value instanceof HTMLSelectElement;
export type RestorationSurface="skeleton"|"snapshot"|"content";
/**
 * Derive the restoration presentation from the coordinator phase.  A cached
 * display projection may be read while its authority is checked; canonical
 * content must stay behind the skeleton until that check and draft restore
 * have both completed.
 */
export function restorationSurface(phase:ViewRestorationPhase|undefined,hasSavedSnapshot:boolean,legacyRestoring=false):RestorationSurface {
 if(phase==="loading_snapshot")return "skeleton";
 if(phase==="verifying")return hasSavedSnapshot?"snapshot":"skeleton";
 if(!phase&&legacyRestoring)return "skeleton";
 return "content";
}
export function setupOwnsActivity(tool:string|undefined, automaticSetup:boolean):boolean {
 return automaticSetup && (tool === "loomex_workspace_grant" || tool === "loomex_run_prepare");
}
export function createRuntimeShell(host:ShellServices) {
 const {title,context,summary,form,headerLeading,headerContextActions,headerStage,headerStatus,primary,secondary}=host.elements;
 const STATUS_BADGE_CLASS=host.statusClasses;
 configureUiElementStyles(STATUS_BADGE_CLASS);
 const activeRequests=new Map<number,string>();
 const icon=(name:ActionIcon)=>createIcon(name);
 const actionIcon=(id:ActionId):ActionIcon=>ACTIONS[id].icon;
  const applyButtonStyle = applySharedButtonStyle;
  const applyBadgeStyle = applyStatusBadgeStyle;

  function setAction(button:HTMLButtonElement, label:string, actionId:ActionId="next") {
    delete button.dataset.businessMutation;
    delete button.dataset.hydrationDisabled;
    delete button.dataset.interactionAction;
    delete button.dataset.answerIntent;
    applyButtonStyle(button);
    const showLabel = ACTIONS[actionId].labelVisibility === "text" || (host.snapshot().isConnectionView && button === primary);
    button.classList.toggle("icon-button", !showLabel);
    button.classList.toggle("ui-button-icon", !showLabel);
    button.classList.toggle("action-with-label", showLabel);
    button.classList.remove("ui-button-sm", "ui-button-md");
    button.setAttribute("aria-label", label);
    button.dataset.actionId=actionId;
    delete button.dataset.tooltip;
    button.replaceChildren(icon(actionIcon(actionId)), element("span", { className: showLabel ? "action-label" : "sr-only" }, label));
  }
  function setMutationAction(button:HTMLButtonElement, label:string, actionId:ActionId="next") {
    setAction(button, label, actionId);
    button.dataset.businessMutation = "true";
  }
  function setInteractionAction(button:HTMLButtonElement, action:string, label:string) {
    setMutationAction(button, label, action === "reject" ? "reject" : "approve");
    button.dataset.interactionAction = action;
  }
  function setAnswerAction(button:HTMLButtonElement, intent:string, label:string, mutation = false) {
    const actionId:ActionId = intent === "review" ? "review" : intent === "submit" ? "submit" : intent === "back" ? "back" : "next";
    if (mutation) setMutationAction(button, label, actionId);
    else setAction(button, label, actionId);
    button.dataset.answerIntent = intent;
  }
  function updateActivity() {
    const activity = document.getElementById("activity");
    if (!activity) return;
    const projection=host.snapshot();
    const savedView=context.querySelector<HTMLElement>('[aria-label="Saved view"]');
    const savedSnapshot=Boolean(savedView);
    const surface=restorationSurface(projection.restorationPhase,savedSnapshot,projection.restoring);
    const tool = [...activeRequests.values()].at(-1);
    const descriptions:Readonly<Record<string,string>> = {
      "ui/initialize": "Connecting…", "ui/update-model-context": "Preparing chat handoff…", "ui/message": "Sending run to chat…", loomex_run_commit: "Starting your run…",
      loomex_run_prepare: "Preparing your review…", loomex_run_setup: "Loading run inputs…",
      loomex_workspace_grant: "Checking project folder…",
      loomex_run_get: "Updating run status…", loomex_interaction_respond: "Sending your answer…",
      loomex_interaction_approve: "Sending your decision…", loomex_run_cancel: "Requesting cancellation…",
      loomex_workflows_list: "Loading workflows…", loomex_workflow_get: "Loading workflow details…",
    };
    const restoringSnapshot=surface==="snapshot";
    const restoringAnswers=restoringSnapshot&&Boolean(form.querySelector("input,textarea,select,[data-question-id]"));
    const snapshotCaption=savedView?.querySelector<HTMLElement>("[data-restoration-status]");
    const defaultSnapshotStatus=Boolean(snapshotCaption);
    if(restoringAnswers&&defaultSnapshotStatus&&snapshotCaption)snapshotCaption.textContent="Restoring saved answers…";
    const snapshotOwnsActivity=defaultSnapshotStatus;
    const text = restoringSnapshot&&!snapshotOwnsActivity
      ? restoringAnswers ? "Restoring saved answers…" : "Checking the latest saved view…"
      : tool ? descriptions[tool] || "Updating…" : "";
    if (activity.textContent !== text) activity.textContent = text;
    const contextOwnsActivity = Boolean(tool && context.classList.contains("workflow-loading-host"));
    const automaticSetupOwnsActivity = setupOwnsActivity(tool,projection.automaticSetupOwnsActivity);
    activity.hidden = restoringSnapshot
      ? snapshotOwnsActivity
      : !tool||contextOwnsActivity||automaticSetupOwnsActivity||surface==="skeleton";
    // Activity is independent of status. Hiding and restoring the status line
    // on every quiet draft save changed the document height and made checkbox
    // selections appear to jump.
    summary.dataset.suppressed = "false";
  }
  function updateClock() {
    const clock = document.getElementById("run-clock");
    if(!clock)return;
    const duration=host.snapshot().duration;
    clock.hidden = !duration;
    if (duration) {
      const value = clock.querySelector("span");
      if (value) value.textContent = duration;
      else clock.append(icon("clock"), element("span", {}, duration));
      clock.setAttribute("aria-label", `Elapsed time: ${duration}`);
    }
  }
  function syncRestorationVisibility() {
    const root = document.querySelector("main");
    const projection=host.snapshot();
    const savedSnapshot=Boolean(context.querySelector('[aria-label="Saved view"]'));
    const surface=restorationSurface(projection.restorationPhase,savedSnapshot,projection.restoring);
    const showSkeleton=surface==="skeleton";
    if(root){
      setRestoring(root,showSkeleton);
      // A displayed snapshot is readable but still awaiting authority. Keep
      // that busy state available to assistive technology without hiding it.
      root.setAttribute("aria-busy",String(surface!=="content"));
    }
    for (const selector of [".app-body", ".app-footer", ".header-tools"]) {
      const target=document.querySelector<HTMLElement>(selector);
      if(target)target.inert = showSkeleton;
    }
  }

  /** Page controllers supply only their local controls; the shell owns placement and cleanup. */
  function setContextualHeader(leading: readonly Node[] = [], actions: readonly Node[] = []): void {
    headerLeading.replaceChildren(...leading);
    headerContextActions.replaceChildren(...actions);
  }

  function syncChrome() {
    syncRestorationVisibility();
    const projection=host.snapshot();
    const main=document.querySelector("main");
    if(main && projection.restorationPhase)main.dataset.lifecycle=projection.restorationPhase;
    title.textContent=projection.title;
    const stageLabel=projection.stageLabel;
    headerStage.hidden = !stageLabel;
    headerStage.textContent = stageLabel || "";
    headerStage.setAttribute("aria-label", stageLabel ? `Current stage: ${stageLabel}` : "Current stage");
    const status=projection.status;
    headerStatus.hidden = !status;
    headerStatus.textContent = status || "";
    headerStatus.setAttribute("aria-label", status ? `Current status: ${status}` : "Current status");
    if (status) applyBadgeStyle(headerStatus);
    updateClock();
    updateActivity();
    const ready = projection.mutationReady && !projection.authorityStale && !projection.reentry;
    for (const button of [primary, secondary]) {
      if (button.dataset.businessMutation !== "true") continue;
      if (!ready) {
        if (button.dataset.hydrationDisabled === undefined) button.dataset.hydrationDisabled = String(button.disabled);
        button.disabled = true;
      } else if (button.dataset.hydrationDisabled !== undefined) {
        button.disabled = button.dataset.hydrationDisabled === "true";
        delete button.dataset.hydrationDisabled;
      }
    }
    const hydrationPending = Boolean(projection.hasSession && !(projection.editingReady ?? ready));
    const hydrationControls = [...context.querySelectorAll(projection.reentry ? "button,input,textarea,select" : '[data-business-mutation="true"]'), ...form.querySelectorAll('button:not([data-persistence-optional="true"]), input, textarea, select')].filter(isControl);
    for (const control of hydrationControls) {
      if (hydrationPending || projection.reentry) {
        if (control.dataset.hydrationDisabled === undefined) control.dataset.hydrationDisabled = String(control.disabled);
        control.disabled = true;
      } else if (control.dataset.hydrationDisabled !== undefined) {
        control.disabled = control.dataset.hydrationDisabled === "true";
        delete control.dataset.hydrationDisabled;
      }
    }
    if (projection.reentry || projection.authorityStale) { primary.disabled=true; secondary.disabled=true; }
  }


 return {activeRequests,icon,actionIcon,applyButtonStyle,applyBadgeStyle,setAction,setMutationAction,setInteractionAction,setAnswerAction,setContextualHeader,updateActivity,updateClock,syncRestorationVisibility,syncChrome,dispose(){activeRequests.clear();setContextualHeader();}};
}

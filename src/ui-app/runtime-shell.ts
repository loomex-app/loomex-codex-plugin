import { ACTIONS, createIcon, type ActionId } from './shell.js';
import type { ActionIcon } from './contracts.js';
import { setRestoring } from './lifecycle.js';
import { applyButtonStyle as applySharedButtonStyle, applyStatusBadgeStyle, configureUiElementStyles } from './components.js';
export interface ChromeProjection {
 title:string;stageLabel:string|undefined;status:string|undefined;duration:string|undefined;
 restoring:boolean;persistenceUnavailable:boolean;reentry:boolean;mutationReady:boolean;hasSession:boolean;
 automaticSetupOwnsActivity:boolean;isConnectionView:boolean;
}
export interface ShellServices {
 elements:{title:HTMLElement;context:HTMLElement;summary:HTMLElement;form:HTMLFormElement;headerStage:HTMLElement;headerStatus:HTMLElement;primary:HTMLButtonElement;secondary:HTMLButtonElement};
 snapshot():ChromeProjection;
 statusClasses:Readonly<Record<string,string>>;
}
function element<K extends keyof HTMLElementTagNameMap>(tag:K,attrs:Record<string,string|boolean>={},text?:string):HTMLElementTagNameMap[K] {
 const node=document.createElement(tag);
 for(const [key,value]of Object.entries(attrs)){if(key==='className')node.className=String(value);else if(key==='hidden')node.hidden=Boolean(value);else node.setAttribute(key,String(value));}
 if(text!==undefined)node.textContent=text;return node;
}
type Control=HTMLButtonElement|HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement;
const isControl=(value:Element):value is Control=>value instanceof HTMLButtonElement||value instanceof HTMLInputElement||value instanceof HTMLTextAreaElement||value instanceof HTMLSelectElement;
export function setupOwnsActivity(tool:string|undefined, automaticSetup:boolean):boolean {
 return automaticSetup && (tool === "loomex_workspace_grant" || tool === "loomex_run_prepare");
}
export function createRuntimeShell(host:ShellServices) {
 const {title,context,summary,form,headerStage,headerStatus,primary,secondary}=host.elements;
 const STATUS_BADGE_CLASS=host.statusClasses;
 configureUiElementStyles(STATUS_BADGE_CLASS);
 const activeRequests=new Map<number,string>();
 const icon=(name:ActionIcon)=>createIcon(name);
 const actionIcon=(id:ActionId):ActionIcon=>ACTIONS[id].icon;
 const listeners=new AbortController();
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
  function infoButton(label:string, description:string) {
    const button = element("button", { type: "button", className: "secondary info-button" }, label);
    button.dataset.tooltip = description;
    return button;
  }
  const tooltip = element("div", { id: "ui-tooltip", className: "tooltip", role: "tooltip", hidden: true });
  document.body.append(tooltip);
  let tooltipTarget:HTMLElement|undefined;
  let tooltipCloseTimer:ReturnType<typeof setTimeout>|undefined;
  function hideTooltip() {
    clearTimeout(tooltipCloseTimer);
    tooltip.hidden = true;
    tooltipTarget?.removeAttribute("aria-describedby");
    tooltipTarget = undefined;
  }
  function showTooltip(target:HTMLElement|undefined) {
    if (!target?.dataset.tooltip || (target instanceof HTMLButtonElement && target.disabled)) return;
    clearTimeout(tooltipCloseTimer);
    if (tooltipTarget !== target) hideTooltip();
    tooltipTarget = target;
    tooltip.textContent = target.dataset.tooltip;
    tooltip.hidden = false;
    target.setAttribute("aria-describedby", tooltip.id);
    const rect = target.getBoundingClientRect();
    const box = tooltip.getBoundingClientRect();
    const width = document.documentElement.clientWidth;
    const height = document.documentElement.clientHeight;
    tooltip.style.left = `${Math.max(8, Math.min(rect.right - box.width, width - box.width - 8))}px`;
    const top = rect.bottom + box.height + 8 <= height ? rect.bottom + 4 : rect.top - box.height - 4;
    tooltip.style.top = `${Math.max(4, top)}px`;
  }
  function deferTooltipClose() {
    clearTimeout(tooltipCloseTimer);
    tooltipCloseTimer = setTimeout(() => {
      if (tooltipTarget !== document.activeElement && !tooltip.matches(":hover") && !tooltipTarget?.matches(":hover")) hideTooltip();
    }, 120);
  }
  document.addEventListener("pointerover", (event) => { const target = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-tooltip]") : null; if (target) showTooltip(target); }, {signal:listeners.signal});
  document.addEventListener("pointerout", deferTooltipClose, {signal:listeners.signal});
  document.addEventListener("focusin", (event) => { const target = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-tooltip]") : null; if (target) showTooltip(target); else hideTooltip(); }, {signal:listeners.signal});
  document.addEventListener("focusout", deferTooltipClose, {signal:listeners.signal});
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") hideTooltip(); }, {signal:listeners.signal});
  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>(".info-button") : null;
    if (target) showTooltip(target);
    else hideTooltip();
  }, {signal:listeners.signal});
  window.addEventListener("resize", () => { if (tooltipTarget === document.activeElement) showTooltip(tooltipTarget); else hideTooltip(); }, {signal:listeners.signal});
  document.addEventListener("scroll", () => { if (tooltipTarget === document.activeElement) showTooltip(tooltipTarget); else hideTooltip(); }, {capture:true,signal:listeners.signal});

  function updateActivity() {
    const activity = document.getElementById("activity");
    if (!activity) return;
    const tool = [...activeRequests.values()].at(-1);
    const descriptions:Readonly<Record<string,string>> = {
      "ui/initialize": "Connecting…", "ui/update-model-context": "Preparing chat handoff…", "ui/message": "Sending run to chat…", loomex_run_commit: "Starting your run…",
      loomex_run_prepare: "Preparing your review…", loomex_run_setup: "Loading run inputs…",
      loomex_workspace_grant: "Checking project folder…",
      loomex_run_get: "Updating run status…", loomex_interaction_respond: "Sending your answer…",
      loomex_interaction_approve: "Sending your decision…", loomex_run_cancel: "Requesting cancellation…",
      loomex_workflows_list: "Loading workflows…", loomex_workflow_get: "Loading workflow details…",
    };
    const text = tool ? descriptions[tool] || "Updating…" : "";
    if (activity.textContent !== text) activity.textContent = text;
    const contextOwnsActivity = Boolean(tool && context.classList.contains("workflow-loading-host"));
    const automaticSetupOwnsActivity = setupOwnsActivity(tool,host.snapshot().automaticSetupOwnsActivity);
    activity.hidden = !tool || contextOwnsActivity || automaticSetupOwnsActivity;
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
    const viewRestoring=host.snapshot().restoring;
    if(root)setRestoring(root, viewRestoring);
    for (const selector of [".app-body", ".app-footer", ".header-tools"]) {
      const target=document.querySelector<HTMLElement>(selector);
      if(target)target.inert = viewRestoring;
    }
  }

  function syncChrome() {
    syncRestorationVisibility();
    if (tooltipTarget && (!tooltipTarget.isConnected || (tooltipTarget instanceof HTMLButtonElement && tooltipTarget.disabled))) hideTooltip();
    const projection=host.snapshot();
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
    if (projection.persistenceUnavailable || projection.reentry) {
      primary.disabled = true;
      secondary.disabled = true;
      for (const button of context.querySelectorAll<HTMLButtonElement>("button:not([data-persistence-optional=\"true\"])")) button.disabled = true;
    }
    const ready = projection.mutationReady;
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
    const hydrationPending = Boolean(projection.hasSession && !ready);
    const hydrationControls = [context, form].flatMap((container) =>
      [...container.querySelectorAll('button:not([data-persistence-optional="true"]), input, textarea, select')].filter(isControl));
    for (const control of hydrationControls) {
      if (hydrationPending || projection.reentry) {
        if (control.dataset.hydrationDisabled === undefined) control.dataset.hydrationDisabled = String(control.disabled);
        control.disabled = true;
      } else if (control.dataset.hydrationDisabled !== undefined) {
        control.disabled = control.dataset.hydrationDisabled === "true";
        delete control.dataset.hydrationDisabled;
      }
    }
  }


 return {activeRequests,icon,actionIcon,applyButtonStyle,applyBadgeStyle,setAction,setMutationAction,setInteractionAction,setAnswerAction,infoButton,updateActivity,updateClock,syncRestorationVisibility,syncChrome,hideTooltip,dispose(){listeners.abort();hideTooltip();tooltip.remove();activeRequests.clear();}};
}

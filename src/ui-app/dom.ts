/** Resolve a template-owned element once at startup and fail closed if the UI shell is incomplete. */
export function requireElement<ElementType extends HTMLElement>(id: string): ElementType {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`The Loomex UI template is missing #${id}.`);
  return element as ElementType;
}

export function eventElement(target: EventTarget | null): HTMLElement | null {
  return target instanceof HTMLElement ? target : null;
}

export function requireMain(): HTMLElement {
  const element = document.querySelector<HTMLElement>("main");
  if (element === null) throw new Error("The Loomex UI template is missing its main region.");
  return element;
}

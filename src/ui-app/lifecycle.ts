/** A monotonically increasing fence prevents a late async result changing a newer screen. */
export class RequestFence {
  #epoch = 0;

  begin(): number { return ++this.#epoch; }

  current(epoch: number): boolean { return epoch === this.#epoch; }
}

/** Keeps restoration skeletal until the authoritative projection is ready. */
export function setRestoring(root: HTMLElement, restoring: boolean): void {
  root.dataset.restoring = String(restoring);
  root.setAttribute("aria-busy", String(restoring));
}

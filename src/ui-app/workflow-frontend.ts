/** Resolve only the configured website; navigation never grants workflow authority. */
export function workflowFrontendUrl(value: unknown, workflowId: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(workflowId)) throw new Error("The Loomex frontend address is not configured for this installation. Configure its website address to open the full editor.");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("The Loomex frontend address is not configured for this installation. Configure its website address to open the full editor."); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("The Loomex website address is invalid. Check your connection and try again.");
  const base = url.pathname.replace(/\/$/, "");
  url.pathname = `${base || "/workspace"}/workflows/${workflowId}/builder`;
  url.search = ""; url.hash = "";
  return url.href;
}

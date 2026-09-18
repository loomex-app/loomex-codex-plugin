import type {JsonObject} from "./contracts.js";

/** Reapply only user-owned fields. Keep navigation/operation references from the saved record. */
export function reapplyPresentationEdits(saved:JsonObject,local:JsonObject):JsonObject {
 for(const key of ["schemaVersion","screen","workflowId","versionId","preparationId","executionId","requestId","builderSessionId","schemaDigest"]) {
  if(saved[key]!==local[key])throw new Error("This view has moved on. Load the saved version before editing it.");
 }
 if(saved.forwardSession || saved.acceptedRequestId)throw new Error("This view has completed. Load its current read-only state.");
 const merged={...saved};
 for(const key of ["controls","browser","runs","disclosures","readingPosition","currentQuestionId","phase","workspaceEditing"]) {
  if(Object.hasOwn(local,key))merged[key]=structuredClone(local[key]);
 }
 return merged;
}

import type { JsonObject } from "./contracts.js";
const object=(v:unknown):JsonObject|undefined=>v!==null&&typeof v==="object"&&!Array.isArray(v)?v as JsonObject:undefined;
const uuid=(v:unknown):v is string=>typeof v==="string"&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
export interface PreparedPersona {workflowVersionId:string;nodeKey:string;selectionKey:string;personId:string;personName:string;roleId:string;roleName:string;configDigest:string;}
/** Summary is derived from sealed closure; mutable discovery is never consulted. */
export function preparedPersonaSummary(value:unknown):PreparedPersona[]|undefined {
 const binding=object(value),selections=object(object(binding?.inputs)?.aiPersonaSelections),summary=object(binding?.workflowClosureReview)?.personas;
 if(summary===undefined)return selections&&Object.keys(selections).length?undefined:[];
 if(!Array.isArray(summary)||summary.length>1000)return undefined;
 const rows:PreparedPersona[]=[];const keys=new Set<string>();
 for(const raw of summary){const row=object(raw);if(!row||!uuid(row.workflowVersionId)||row.workflowVersionId!==binding?.versionId||typeof row.nodeKey!=="string"||!row.nodeKey||typeof row.selectionKey!=="string"||!row.selectionKey||!uuid(row.personId)||!uuid(row.roleId)||typeof row.personName!=="string"||!row.personName||typeof row.roleName!=="string"||!row.roleName||typeof row.configDigest!=="string"||!/^[a-f0-9]{64}$/.test(row.configDigest)||keys.has(row.selectionKey)||!selections||selections[row.selectionKey]!==row.personId)return undefined;keys.add(row.selectionKey);rows.push(row as unknown as PreparedPersona);}
 if(selections&&Object.keys(selections).some(key=>!keys.has(key)))return undefined;return rows;
}

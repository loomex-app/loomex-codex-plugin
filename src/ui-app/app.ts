import {pageDefinitionFor} from './page-definitions.js';
import {startLoomexRuntimeController} from './runtime-controller.js';

/** Compose shared services and domain controllers once for this mounted resource. */
export function startLoomexApp():void {
  startLoomexRuntimeController(pageDefinitionFor);
}
startLoomexApp();

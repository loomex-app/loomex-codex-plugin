import type {UiMode} from './contracts.js';

/** Resource identity and shell copy only. Behavior lives in the domain controllers. */
export interface PageDefinition {
  readonly mode: UiMode;
  readonly title: string;
  readonly domain: 'catalog' | 'workflow' | 'request' | 'execution' | 'connection';
}
const definitions: Readonly<Record<UiMode,PageDefinition>> = Object.freeze({
  browser: {mode:'browser',title:'Browse workflows',domain:'catalog'},
  runs: {mode:'runs',title:'Workflow runs',domain:'execution'},
  authoring: {mode:'authoring',title:'Authoring review',domain:'workflow'},
  prepare: {mode:'prepare',title:'Review run',domain:'workflow'},
  monitor: {mode:'monitor',title:'Run monitor',domain:'execution'},
  interaction: {mode:'interaction',title:'Your response',domain:'request'},
  connection: {mode:'connection',title:'Connection',domain:'connection'},
  organizations: {mode:'organizations',title:'Organizations',domain:'connection'},
});
export function pageDefinitionFor(value:string|undefined):PageDefinition {
  return value !== undefined && Object.hasOwn(definitions,value) ? definitions[value as UiMode] : definitions.browser;
}

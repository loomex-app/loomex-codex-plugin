import type { TaskWorkspace } from './page-models.js';

/** Match backend/Rust Unicode scalar ordering, including non-BMP directory names. */
export function compareWorkspacePaths(left: string, right: string): number {
  const a=Array.from(left), b=Array.from(right);
  for(let index=0; index<Math.min(a.length,b.length); index++) {
    const difference=a[index]!.codePointAt(0)!-b[index]!.codePointAt(0)!;
    if(difference) return difference;
  }
  return a.length-b.length;
}

/** Caller-supplied current-project context only; never enumerate permission roots. */
export function parseTaskWorkspace(value: unknown): TaskWorkspace | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const supplied = value as Record<string, unknown>;
  const context = supplied.taskContext as Record<string, unknown> | undefined;
  const path = (value: unknown): value is string => typeof value === 'string' && value.startsWith('/') && !value.includes('\0');
  const paths = (value: unknown): value is string[] => Array.isArray(value) && value.every(path);
  if (context !== undefined && (context === null || typeof context !== 'object' || !path(context.cwd) ||
      (context.projectDirectories !== undefined && !paths(context.projectDirectories)))) return null;
  if (supplied.workspacePath !== undefined && !path(supplied.workspacePath)) return null;
  if (supplied.additionalWorkspacePaths !== undefined && !paths(supplied.additionalWorkspacePaths)) return null;
  if (!context && !supplied.workspacePath) return null;
  return {
    ...(context ? {taskContext: {cwd: context.cwd as string,
      ...(context.projectDirectories ? {projectDirectories: [...context.projectDirectories as string[]]} : {})}} : {}),
    ...(supplied.workspacePath ? {workspacePath: supplied.workspacePath as string} : {}),
    ...(supplied.additionalWorkspacePaths ? {additionalWorkspacePaths: [...supplied.additionalWorkspacePaths as string[]]} : {}),
  };
}

export function selectedAdditionalWorkspaces(context: TaskWorkspace | null): string[] {
  const primary = context?.workspacePath || context?.taskContext?.cwd;
  const extras = context?.additionalWorkspacePaths ?? [];
  const project = context?.workspacePath ? [] : context?.taskContext?.projectDirectories ?? [];
  return [...new Set([...project, ...extras])].filter(path => path !== primary).sort(compareWorkspacePaths);
}

export function boundWorkspaceSetValid(binding: unknown): boolean {
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) return false;
  const value = binding as Record<string, unknown>;
  if (value.workspaceSetContract === undefined) return value.additionalWorkspacePaths === undefined;
  if (value.workspaceSetContract !== 'execution.workspace-set/v1' || !Array.isArray(value.additionalWorkspacePaths)) return false;
  const paths = value.additionalWorkspacePaths;
  return paths.every(path => typeof path === 'string' && path.startsWith('/') && !path.includes('\0') && path !== value.workspacePath) &&
    paths.every((path, index) => index === 0 || compareWorkspacePaths(paths[index - 1] as string, path as string)<0);
}

export function additionalWorkspaceLabel(count: number): string { return `${count} additional ${count===1 ? "directory" : "directories"}`; }

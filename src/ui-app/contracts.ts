/** Browser-only contracts shared by the injected Loomex application modules. */
export type UiMode = "browser" | "runs" | "authoring" | "prepare" | "monitor" | "interaction" | "connection" | "organizations";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
/** Untrusted host payloads are narrowed at their own boundary. */
export type JsonObject = Record<string, unknown>;

/** The persisted identity is a navigation key and cannot authorize a mutation. */
export interface ViewSessionIdentity {
  viewSessionId: string;
  revision: number;
}

export interface ViewSessionProjection<State extends JsonObject = JsonObject> extends ViewSessionIdentity {
  readonly state?: State;
  readonly status?: string;
  readonly operation?: { readonly operationId?: string; readonly status?: string };
}

/** A durable interaction draft, kept distinct from its presentation session. */
export interface InteractionDraftProjection<Answers extends JsonObject = JsonObject> {
  readonly requestId: string;
  readonly revision: number;
  readonly answers: Answers;
  readonly currentQuestionId: string | null;
  readonly phase: "answer" | "review";
}

/** A journal entry describes a mutation attempt; it never grants mutation authority. */
export interface MutationOperation<Arguments extends JsonObject = JsonObject> {
  readonly operationId: string;
  readonly method: string;
  readonly arguments: Arguments;
  readonly idempotencyKey: string;
}

export interface JsonRpcMessage {
  readonly jsonrpc: "2.0";
  readonly id?: number;
  readonly method?: string;
  readonly params?: JsonObject;
  readonly result?: unknown;
  readonly error?: JsonRpcError | unknown;
}

export interface JsonRpcError {
  readonly code?: string | number;
  readonly message?: string;
  readonly data?: unknown;
  readonly retryable?: boolean;
  readonly correlationId?: string;
}

export interface ActionMetadata {
  readonly icon: ActionIcon;
  readonly labelVisibility?: "icon" | "text";
}

export type ActionIcon =
  | "back" | "check" | "clock" | "close" | "connection" | "copy" | "edit" | "external"
  | "eye" | "expand" | "info" | "logout" | "message" | "next" | "organization" | "play" | "publish" | "refresh"
  | "search" | "shield" | "stop";

import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server, type Socket } from "node:net";

import { LOCAL_PROTOCOL, RpcRequestSchema, type JsonValue } from "../src/protocol.js";

export interface FakeRequest {
  readonly protocol: typeof LOCAL_PROTOCOL;
  readonly id: string;
  readonly method: string;
  readonly params: Record<string, JsonValue>;
}

export type FakeHandler = (request: FakeRequest, socket: Socket) => void | Promise<void>;

export class FakeRunner {
  readonly requests: FakeRequest[] = [];
  stateDir = "";
  socketPath = "";
  private server: Server | undefined;

  constructor(private readonly handler: FakeHandler) {}

  async start(): Promise<void> {
    this.stateDir = await mkdtemp(join(tmpdir(), "loomex-plugin-test-"));
    await chmod(this.stateDir, 0o700);
    this.socketPath = join(this.stateDir, "control.sock");
    this.server = createServer((socket) => {
      let received = Buffer.alloc(0);
      socket.on("data", (chunk: Buffer) => {
        received = Buffer.concat([received, chunk]);
        const newline = received.indexOf(0x0a);
        if (newline < 0) return;
        const parsed = RpcRequestSchema.parse(
          JSON.parse(received.subarray(0, newline).toString("utf8")),
        );
        const request: FakeRequest = parsed;
        this.requests.push(request);
        void this.handler(request, socket);
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(this.socketPath, resolve);
    });
    await chmod(this.socketPath, 0o600);
  }

  respond(socket: Socket, request: FakeRequest, result: Record<string, JsonValue>): void {
    socket.end(`${JSON.stringify({ protocol: LOCAL_PROTOCOL, id: request.id, result })}\n`);
  }

  error(
    socket: Socket,
    request: FakeRequest,
    code: string,
    message: string,
    retryable = false,
  ): void {
    socket.end(
      `${JSON.stringify({
        protocol: LOCAL_PROTOCOL,
        id: request.id,
        error: {
          code,
          message,
          correlationId: "9e7a8f29-86a6-4b7a-bc75-3a8eb8ca21d7",
          retryable,
        },
      })}\n`,
    );
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (this.server === undefined) return resolve();
      this.server.close(() => resolve());
    });
    if (this.stateDir !== "") await rm(this.stateDir, { recursive: true, force: true });
  }
}

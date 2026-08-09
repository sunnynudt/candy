import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import {
  decodeJsonLine,
  encodeJsonLine,
  type CommandEnvelope,
  type ProtocolMessage,
} from "@candy/protocol";

export interface AppServerState {
  readonly protocolVersion: 1;
  readonly runtimeVersion: "0.0.0";
  readonly executingTasks: readonly string[];
}

export function handleAppServerMessage(
  message: ProtocolMessage,
  state: AppServerState,
): ProtocolMessage {
  void state;
  if (message.kind === "command") {
    const command = message as CommandEnvelope;
    return {
      v: 1,
      kind: "event",
      taskId: command.taskId,
      sequence: 1,
      revision: command.expectedRevision,
      event: {
        type: "snapshot",
        snapshot: { taskId: command.taskId, revision: command.expectedRevision, state: "idle" },
      },
    };
  }
  return message;
}

export function runAppServer(stdin: NodeJS.ReadableStream, stdout: NodeJS.WritableStream): void {
  const state: AppServerState = { protocolVersion: 1, runtimeVersion: "0.0.0", executingTasks: [] };
  const lines = createInterface({ input: stdin });
  lines.on("line", (line) => {
    try {
      const response = handleAppServerMessage(decodeJsonLine(line), state);
      stdout.write(encodeJsonLine(response));
    } catch (error) {
      stdout.write(`${JSON.stringify({ v: 1, kind: "error", code: "invalid_message" })}\n`);
      void error;
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runAppServer(process.stdin, process.stdout);
}

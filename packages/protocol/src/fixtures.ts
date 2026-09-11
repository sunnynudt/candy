import { PROTOCOL_VERSION, type CommandEnvelope, type EventEnvelope } from "./index.js";

export const snapshotCommandFixture: CommandEnvelope = {
  v: PROTOCOL_VERSION,
  kind: "command",
  commandId: "command-0001",
  taskId: "task-0001",
  expectedRevision: 0,
  command: { type: "snapshot" },
};

export const snapshotEventFixture: EventEnvelope = {
  v: PROTOCOL_VERSION,
  kind: "event",
  taskId: "task-0001",
  sequence: 1,
  revision: 0,
  event: {
    type: "snapshot",
    snapshot: {
      taskId: "task-0001",
      revision: 0,
      state: "idle",
    },
  },
};

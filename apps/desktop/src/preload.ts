import { contextBridge } from "electron";
import type { DesktopPreloadApi } from "./contracts.js";

const api: DesktopPreloadApi = {
  credentials: {
    set: async () => undefined,
    replace: async () => undefined,
    delete: async () => undefined,
    has: async () => "absent",
  },
  tasks: {
    snapshot: async (taskId) => ({
      taskId,
      state: "idle",
      revision: 0,
      changedFiles: [],
      transcript: [],
    }),
    send: async () => undefined,
  },
};

contextBridge.exposeInMainWorld("candy", api);

import { contextBridge, ipcRenderer } from "electron";
import type { DesktopPreloadApi } from "./contracts.js";

const api: DesktopPreloadApi = {
  credentials: {
    set: async () => undefined,
    replace: async () => undefined,
    delete: async () => undefined,
    has: async () => "absent",
  },
  tasks: {
    create: (prompt, approvalProfile, model) =>
      ipcRenderer.invoke("task.create", prompt, approvalProfile, model) as Promise<
        Awaited<ReturnType<DesktopPreloadApi["tasks"]["create"]>>
      >,
    snapshot: (taskId) =>
      ipcRenderer.invoke("task.snapshot", taskId) as Promise<
        Awaited<ReturnType<DesktopPreloadApi["tasks"]["snapshot"]>>
      >,
    send: (command) => ipcRenderer.invoke("task.send", command) as Promise<void>,
    onUpdate: (listener) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        projection: Parameters<typeof listener>[0],
      ) => listener(projection);
      ipcRenderer.on("task.update", handler);
      return () => ipcRenderer.removeListener("task.update", handler);
    },
  },
};

contextBridge.exposeInMainWorld("candy", api);

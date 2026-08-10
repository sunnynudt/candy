import { contextBridge, ipcRenderer } from "electron";
import type { DesktopPreloadApi } from "./contracts.js";

const api: DesktopPreloadApi = {
  credentials: {
    set: (name, value) => ipcRenderer.invoke("credential.set", name, value) as Promise<void>,
    replace: (name, value) =>
      ipcRenderer.invoke("credential.replace", name, value) as Promise<void>,
    delete: (name) => ipcRenderer.invoke("credential.delete", name) as Promise<void>,
    has: (name) =>
      ipcRenderer.invoke("credential.has", name) as Promise<
        Awaited<ReturnType<DesktopPreloadApi["credentials"]["has"]>>
      >,
  },
  workspace: {
    choose: () =>
      ipcRenderer.invoke("workspace.choose") as Promise<
        Awaited<ReturnType<DesktopPreloadApi["workspace"]["choose"]>>
      >,
    current: () =>
      ipcRenderer.invoke("workspace.current") as Promise<
        Awaited<ReturnType<DesktopPreloadApi["workspace"]["current"]>>
      >,
  },
  browser: {
    allowSite: (host) => ipcRenderer.invoke("browser.allow-site", host) as Promise<void>,
    open: (url) =>
      ipcRenderer.invoke("browser.open", url) as Promise<
        Awaited<ReturnType<DesktopPreloadApi["browser"]["open"]>>
      >,
    navigate: (url, expectedRevision) =>
      ipcRenderer.invoke("browser.navigate", url, expectedRevision) as Promise<
        Awaited<ReturnType<DesktopPreloadApi["browser"]["navigate"]>>
      >,
    act: (action) =>
      ipcRenderer.invoke("browser.act", action) as Promise<
        Awaited<ReturnType<DesktopPreloadApi["browser"]["act"]>>
      >,
    observe: () =>
      ipcRenderer.invoke("browser.observe") as Promise<
        Awaited<ReturnType<DesktopPreloadApi["browser"]["observe"]>>
      >,
    screenshot: () =>
      ipcRenderer.invoke("browser.screenshot") as Promise<
        Awaited<ReturnType<DesktopPreloadApi["browser"]["screenshot"]>>
      >,
    takeControl: () =>
      ipcRenderer.invoke("browser.take-control") as Promise<
        Awaited<ReturnType<DesktopPreloadApi["browser"]["takeControl"]>>
      >,
    returnControlToAgent: () =>
      ipcRenderer.invoke("browser.return-control") as Promise<
        Awaited<ReturnType<DesktopPreloadApi["browser"]["returnControlToAgent"]>>
      >,
    onUpdate: (listener) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        snapshot: Parameters<typeof listener>[0],
      ) => listener(snapshot);
      ipcRenderer.on("browser.update", handler);
      return () => ipcRenderer.removeListener("browser.update", handler);
    },
  },
  attachments: {
    pickImage: () => ipcRenderer.invoke("attachment.pick-image") as Promise<string | undefined>,
  },
  tasks: {
    create: (prompt, approvalProfile, model, attachmentIds, validator) =>
      ipcRenderer.invoke(
        "task.create",
        prompt,
        approvalProfile,
        model,
        attachmentIds,
        validator,
      ) as Promise<Awaited<ReturnType<DesktopPreloadApi["tasks"]["create"]>>>,
    snapshot: (taskId) =>
      ipcRenderer.invoke("task.snapshot", taskId) as Promise<
        Awaited<ReturnType<DesktopPreloadApi["tasks"]["snapshot"]>>
      >,
    send: (command) => ipcRenderer.invoke("task.send", command) as Promise<void>,
    apply: (input) =>
      ipcRenderer.invoke("task.apply", input) as Promise<
        Awaited<ReturnType<DesktopPreloadApi["tasks"]["apply"]>>
      >,
    discard: (input) =>
      ipcRenderer.invoke("task.discard", input) as Promise<
        Awaited<ReturnType<DesktopPreloadApi["tasks"]["discard"]>>
      >,
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

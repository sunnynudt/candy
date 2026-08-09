import { app, BrowserWindow, session, WebContentsView } from "electron";
import path from "node:path";

export const ELECTRON_COMPATIBILITY_VERSION = "43.2.0" as const;

export function createDesktopWindow(): BrowserWindow {
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });
  const browserView = new WebContentsView({
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  window.contentView.addChildView(browserView);
  browserView.setBounds({ x: 0, y: 0, width: 1, height: 1 });
  return window;
}

export function configureCandyBrowserSession(): void {
  const browserSession = session.fromPartition("persist:candy-browser-v1");
  browserSession.setPermissionRequestHandler((_webContents, _permission, callback) =>
    callback(false),
  );
  browserSession.setPermissionCheckHandler(() => false);
}

export function startDesktop(): void {
  app.whenReady().then(() => {
    configureCandyBrowserSession();
    const window = createDesktopWindow();
    window.show();
  });
}

if (process.env.CANDY_DESKTOP_RUN === "1") startDesktop();

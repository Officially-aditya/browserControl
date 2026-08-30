import { ChromeConnection } from "../chrome/connection.js";
import { TargetManager } from "../chrome/targets.js";
import { TabSession } from "../chrome/session.js";
import { TabInfo, WindowInfo } from "../protocol/results.js";

export class TabController {
  private connection: ChromeConnection;
  private targetManager: TargetManager;
  private session: TabSession;

  constructor(connection: ChromeConnection, targetManager: TargetManager, session: TabSession) {
    this.connection = connection;
    this.targetManager = targetManager;
    this.session = session;
  }

  /**
   * List all open page tabs
   */
  public async listTabs(): Promise<TabInfo[]> {
    return this.targetManager.listPageTabs();
  }

  /**
   * Create a new tab and optionally attach to it
   */
  public async newTab(url = "about:blank", autoSwitch = true): Promise<{ targetId: string }> {
    const targetId = await this.targetManager.createTab(url);
    if (autoSwitch) {
      await this.switchTab(targetId);
    }
    return { targetId };
  }

  /**
   * Switch active control and browser focus to a target tab
   */
  public async switchTab(targetId: string): Promise<void> {
    await this.targetManager.activateTab(targetId);
    await this.session.attach(targetId);
  }

  /**
   * Close a tab
   */
  public async closeTab(targetId: string): Promise<boolean> {
    const isCurrent = this.session.targetId === targetId;
    if (isCurrent) {
      await this.session.detach();
    }
    return this.targetManager.closeTab(targetId);
  }

  /**
   * List real browser windows using CDP Browser.getWindowForTarget and Browser.getWindowBounds
   */
  public async listWindows(): Promise<WindowInfo[]> {
    const tabs = await this.listTabs();
    const windowMap = new Map<number, { bounds?: WindowInfo["bounds"]; targetIds: string[] }>();

    for (const tab of tabs) {
      try {
        const winInfo = await this.connection.send<{
          windowId: number;
          bounds: { left?: number; top?: number; width?: number; height?: number; windowState?: string };
        }>("Browser.getWindowForTarget", { targetId: tab.targetId });

        const winId = winInfo.windowId;
        const entry = windowMap.get(winId) || { bounds: winInfo.bounds, targetIds: [] };
        entry.targetIds.push(tab.targetId);
        if (winInfo.bounds) {
          entry.bounds = winInfo.bounds;
        }
        windowMap.set(winId, entry);
      } catch {
        // Fallback for headless or environments where getWindowForTarget is unavailable
        const fallbackWinId = 1;
        const entry = windowMap.get(fallbackWinId) || { targetIds: [] };
        entry.targetIds.push(tab.targetId);
        windowMap.set(fallbackWinId, entry);
      }
    }

    const windows: WindowInfo[] = [];
    for (const [windowId, data] of windowMap.entries()) {
      windows.push({
        windowId,
        bounds: data.bounds,
        targetIds: data.targetIds,
        activeTargetId: data.targetIds.find((id) => id === this.session.targetId) || data.targetIds[0],
      });
    }

    return windows;
  }

  /**
   * Create a new browser window using Target.createTarget({ newWindow: true })
   */
  public async newWindow(url = "about:blank"): Promise<{ targetId: string; windowId?: number }> {
    const res = await this.connection.send<{ targetId: string }>("Target.createTarget", {
      url,
      newWindow: true,
    });

    const targetId = res.targetId;
    await this.switchTab(targetId);

    let windowId: number | undefined;
    try {
      const winInfo = await this.connection.send<{ windowId: number }>("Browser.getWindowForTarget", {
        targetId,
      });
      windowId = winInfo.windowId;
    } catch {}

    return { targetId, windowId };
  }

  /**
   * Activate a specific browser window by windowId
   */
  public async activateWindow(windowId: number): Promise<void> {
    const windows = await this.listWindows();
    const targetWin = windows.find((w) => w.windowId === windowId);
    if (!targetWin || targetWin.targetIds.length === 0) {
      throw new Error(`Window ${windowId} not found`);
    }

    try {
      await this.connection.send("Browser.setWindowBounds", {
        windowId,
        bounds: { windowState: "normal" },
      });
    } catch {}

    const targetIdToActivate = targetWin.activeTargetId || targetWin.targetIds[0];
    await this.switchTab(targetIdToActivate);
  }

  /**
   * Close an entire browser window and all its contained tabs
   */
  public async closeWindow(windowId: number): Promise<boolean> {
    const windows = await this.listWindows();
    const targetWin = windows.find((w) => w.windowId === windowId);
    if (!targetWin) {
      throw new Error(`Window ${windowId} not found`);
    }

    let allClosed = true;
    for (const targetId of targetWin.targetIds) {
      const closed = await this.closeTab(targetId);
      if (!closed) allClosed = false;
    }

    return allClosed;
  }
}

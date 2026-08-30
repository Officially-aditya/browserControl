import { TargetManager } from "../chrome/targets.js";
import { TabSession } from "../chrome/session.js";
import { TabInfo, WindowInfo } from "../protocol/results.js";

export class TabController {
  private targetManager: TargetManager;
  private session: TabSession;

  constructor(targetManager: TargetManager, session: TabSession) {
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
   * List browser windows / contexts
   */
  public async listWindows(): Promise<WindowInfo[]> {
    const tabs = await this.listTabs();
    // Group tabs by browserContextId or window representation
    const windowMap = new Map<string, string[]>();
    for (const tab of tabs) {
      const ctx = tab.browserContextId || "default_window";
      const list = windowMap.get(ctx) || [];
      list.push(tab.targetId);
      windowMap.set(ctx, list);
    }

    const windows: WindowInfo[] = [];
    let winIdx = 1;
    for (const [, targetIds] of windowMap.entries()) {
      windows.push({
        windowId: winIdx++,
        targetIds,
        activeTargetId: targetIds.find((id) => id === this.session.targetId) || targetIds[0],
      });
    }
    return windows;
  }

  /**
   * Open a new browser window
   */
  public async newWindow(url = "about:blank"): Promise<{ targetId: string }> {
    const targetId = await this.targetManager.createTab(url);
    await this.switchTab(targetId);
    return { targetId };
  }
}

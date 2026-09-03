import { ChromeConnection } from "./connection.js";
import { assertSafeNewTabUrl } from "../browser/safe-url.js";
import { TabInfo } from "../protocol/results.js";

export interface TargetInfo {
  targetId: string;
  type: string;
  title: string;
  url: string;
  attached: boolean;
  canAccessOpener?: boolean;
  openerId?: string;
  browserContextId?: string;
}

export class TargetManager {
  private connection: ChromeConnection;
  private knownTargets = new Map<string, TargetInfo>();

  constructor(connection: ChromeConnection) {
    this.connection = connection;
    this.setupListeners();
  }

  private setupListeners(): void {
    this.connection.on("Target.targetCreated", (params: { targetInfo: TargetInfo }) => {
      this.knownTargets.set(params.targetInfo.targetId, params.targetInfo);
    });

    this.connection.on("Target.targetDestroyed", (params: { targetId: string }) => {
      this.knownTargets.delete(params.targetId);
    });

    this.connection.on("Target.targetInfoChanged", (params: { targetInfo: TargetInfo }) => {
      this.knownTargets.set(params.targetInfo.targetId, params.targetInfo);
    });
  }

  /**
   * Initialize target discovery
   */
  public async init(): Promise<void> {
    await this.connection.send("Target.setDiscoverTargets", { discover: true });
    await this.refreshTargets();
  }

  /**
   * Refresh targets from browser
   */
  public async refreshTargets(): Promise<TargetInfo[]> {
    const res = await this.connection.send<{ targetInfos: TargetInfo[] }>("Target.getTargets");
    this.knownTargets.clear();
    for (const info of res.targetInfos) {
      this.knownTargets.set(info.targetId, info);
    }
    return Array.from(this.knownTargets.values());
  }

  /**
   * List all page tabs
   */
  public async listPageTabs(): Promise<TabInfo[]> {
    await this.refreshTargets();
    const pages = Array.from(this.knownTargets.values()).filter(
      (t) => t.type === "page" || t.type === "tab"
    );

    return pages.map((p) => ({
      targetId: p.targetId,
      type: p.type,
      title: p.title,
      url: p.url,
      attached: p.attached,
      browserContextId: p.browserContextId,
    }));
  }

  /**
   * Attach to a target with flat session messaging
   */
  public async attachToTarget(targetId: string): Promise<string> {
    const res = await this.connection.send<{ sessionId: string }>("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    return res.sessionId;
  }

  /**
   * Detach from target session
   */
  public async detachFromTarget(sessionId: string): Promise<void> {
    try {
      await this.connection.send("Target.detachFromTarget", { sessionId });
    } catch {
      // Ignore if session already destroyed
    }
  }

  /**
   * Create a new browser tab. Only http/https/about:blank are permitted.
   */
  public async createTab(url = "about:blank"): Promise<string> {
    const safeUrl = assertSafeNewTabUrl(url);
    const res = await this.connection.send<{ targetId: string }>("Target.createTarget", { url: safeUrl });
    return res.targetId;
  }

  /**
   * Close a browser tab
   */
  public async closeTab(targetId: string): Promise<boolean> {
    const res = await this.connection.send<{ success: boolean }>("Target.closeTarget", { targetId });
    this.knownTargets.delete(targetId);
    return res.success;
  }

  /**
   * Activate (bring to front) a tab
   */
  public async activateTab(targetId: string): Promise<void> {
    await this.connection.send("Target.activateTarget", { targetId });
  }

  /**
   * Get info for a specific target
   */
  public getTargetInfo(targetId: string): TargetInfo | undefined {
    return this.knownTargets.get(targetId);
  }
}

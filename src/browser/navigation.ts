import { TabSession } from "../chrome/session.js";
import { assertSafeNavigationUrl } from "./safe-url.js";

export class NavigationController {
  private session: TabSession;

  constructor(session: TabSession) {
    this.session = session;
  }

  /**
   * Navigate to a given URL and optionally wait for load event.
   * Only http/https URLs are permitted; all other schemes are blocked
   * below the model to prevent local-file exfiltration and escapes.
   */
  public async navigate(url: string, waitForLoad = true, timeoutMs = 20000): Promise<void> {
    url = assertSafeNavigationUrl(url);

    if (!waitForLoad) {
      await this.session.send("Page.navigate", { url });
      return;
    }

    const loadPromise = new Promise<void>((resolve) => {
      const onLoad = () => {
        cleanup();
        resolve();
      };

      const timer = setTimeout(() => {
        cleanup();
        resolve(); // Don't throw on timeout, allow inspection
      }, timeoutMs);

      const cleanup = () => {
        clearTimeout(timer);
        this.session.off("loadFired", onLoad);
      };

      this.session.once("loadFired", onLoad);
    });

    await this.session.send("Page.navigate", { url });
    await loadPromise;
    // Small settling time for rendering
    await new Promise((r) => setTimeout(r, 100));
  }

  /**
   * Navigate back in history
   */
  public async back(): Promise<void> {
    const history = await this.session.send<{ currentIndex: number; entries: Array<{ id: number }> }>(
      "Page.getNavigationHistory"
    );

    if (history.currentIndex > 0) {
      const prevEntry = history.entries[history.currentIndex - 1];
      await this.session.send("Page.navigateToHistoryEntry", { entryId: prevEntry.id });
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  /**
   * Navigate forward in history
   */
  public async forward(): Promise<void> {
    const history = await this.session.send<{ currentIndex: number; entries: Array<{ id: number }> }>(
      "Page.getNavigationHistory"
    );

    if (history.currentIndex < history.entries.length - 1) {
      const nextEntry = history.entries[history.currentIndex + 1];
      await this.session.send("Page.navigateToHistoryEntry", { entryId: nextEntry.id });
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  /**
   * Reload current page
   */
  public async reload(ignoreCache = false): Promise<void> {
    await this.session.send("Page.reload", { ignoreCache });
    await new Promise((r) => setTimeout(r, 150));
  }
}

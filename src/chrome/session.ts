import { EventEmitter } from "node:events";
import { ChromeConnection } from "./connection.js";
import { TargetManager } from "./targets.js";
import { DialogInfo } from "../protocol/results.js";

export type SessionState =
  | "DISCONNECTED"
  | "ATTACHING"
  | "READY"
  | "ACTING"
  | "WAITING_FOR_USER"
  | "TARGET_CLOSED"
  | "CONNECTION_LOST"
  | "STOPPED";

export class TabSession extends EventEmitter {
  private connection: ChromeConnection;
  private targetManager: TargetManager;
  private _state: SessionState = "DISCONNECTED";
  private _targetId: string | null = null;
  private _sessionId: string | null = null;
  private _currentUrl = "";
  private _currentTitle = "";
  private _lastActionTime = 0;
  private _activeDialog: DialogInfo | null = null;
  private _visualEpoch = 1;
  private isPaused = false;

  private activeSessionListeners: Array<{ event: string; fn: (...args: any[]) => void }> = [];

  constructor(connection: ChromeConnection, targetManager: TargetManager) {
    super();
    this.connection = connection;
    this.targetManager = targetManager;
    this.setupGlobalListeners();
  }

  public get state(): SessionState {
    return this._state;
  }

  public get targetId(): string | null {
    return this._targetId;
  }

  public get sessionId(): string | null {
    return this._sessionId;
  }

  public get currentUrl(): string {
    return this._currentUrl;
  }

  public get currentTitle(): string {
    return this._currentTitle;
  }

  public get activeDialog(): DialogInfo | null {
    return this._activeDialog;
  }

  /**
   * Visual Epoch token used to detect stale screenshot observations.
   *
   * Invalidation Policy (Best-Effort Semantic Protection):
   * - Incremented on macro-structural state changes:
   *   1. Top-level frame navigation (`Page.frameNavigated`)
   *   2. Page load completions (`Page.loadEventFired`)
   *   3. Asynchronous intra-document SPA navigations (`Page.navigatedWithinDocument` / `pushState`)
   *   4. JavaScript dialog opening/closing (`Page.javascriptDialogOpening`/`Closed`)
   *   5. Tab switching and re-attachment (`session.attach`)
   *   6. Visual state-mutating actions (`click`, `double_click`, `drag`, `type`, `scroll`, `keypress`)
   *
   * - Best-Effort Note on Background In-Page Micro-DOM Mutations:
   *   Background DOM updates (e.g. CSS animations, timer intervals, reactive state re-renders)
   *   intentionally do NOT thrash the visualEpoch. Invalidation on every micro-DOM node insertion
   *   would produce severe false-positive rejections on modern reactive web apps (e.g. YouTube, Docs).
   *   The vision agent's perception-action loop remains the ultimate authority for continuous visual reasoning.
   */
  public get visualEpoch(): number {
    return this._visualEpoch;
  }

  public bumpVisualEpoch(): number {
    return ++this._visualEpoch;
  }

  public get isReady(): boolean {
    return this._state === "READY" && !this.isPaused;
  }

  private setState(newState: SessionState): void {
    const oldState = this._state;
    if (oldState !== newState) {
      this._state = newState;
      this.emit("stateChanged", { from: oldState, to: newState });
    }
  }

  private setupGlobalListeners(): void {
    this.connection.on("close", () => {
      this.setState("CONNECTION_LOST");
      this.emit("connectionLost");
    });

    this.connection.on("Target.targetDestroyed", (params: { targetId: string }) => {
      if (params.targetId === this._targetId) {
        this.setState("TARGET_CLOSED");
        this.emit("targetClosed", { targetId: params.targetId });
      }
    });

    this.connection.on("Inspector.detached", (params: { reason: string }, sessionId?: string) => {
      if (sessionId === this._sessionId) {
        this.setState("TARGET_CLOSED");
        this.emit("detached", { reason: params.reason });
      }
    });
  }

  private clearSessionListeners(): void {
    for (const item of this.activeSessionListeners) {
      this.connection.removeListener(item.event, item.fn);
    }
    this.activeSessionListeners = [];
  }

  private addSessionListener(event: string, fn: (...args: any[]) => void): void {
    this.connection.on(event, fn);
    this.activeSessionListeners.push({ event, fn });
  }

  /**
   * Attach to a specific target tab
   */
  public async attach(targetId: string): Promise<void> {
    if (this._state === "ACTING" || this._state === "ATTACHING") {
      throw new Error(`Cannot attach while in state: ${this._state}`);
    }

    if (this._sessionId) {
      await this.detach();
    }

    this.setState("ATTACHING");
    this._targetId = targetId;
    this.bumpVisualEpoch();

    try {
      this._sessionId = await this.targetManager.attachToTarget(targetId);
      const sid = this._sessionId;

      // 1. Navigation events
      const onFrameNavigated = (params: { frame: { id: string; parentId?: string; url: string } }) => {
        if (!params.frame.parentId) {
          this._currentUrl = params.frame.url;
          this.bumpVisualEpoch();
          this.emit("navigated", { url: params.frame.url });
        }
      };
      this.addSessionListener(`session:${sid}:Page.frameNavigated`, onFrameNavigated);

      // 2. Load events & SPA intra-document navigations
      const onLoadFired = () => {
        this.bumpVisualEpoch();
        this.emit("loadFired");
      };
      this.addSessionListener(`session:${sid}:Page.loadEventFired`, onLoadFired);

      const onNavigatedWithinDocument = (params: { url: string }) => {
        this._currentUrl = params.url;
        this.bumpVisualEpoch();
        this.emit("navigated", { url: params.url });
      };
      this.addSessionListener(`session:${sid}:Page.navigatedWithinDocument`, onNavigatedWithinDocument);

      // 3. JavaScript dialog events (alert, confirm, prompt, beforeunload)
      const onDialogOpening = (params: {
        type: "alert" | "confirm" | "prompt" | "beforeunload";
        message: string;
        defaultPrompt?: string;
        url: string;
      }) => {
        this._activeDialog = {
          type: params.type,
          message: params.message,
          defaultPrompt: params.defaultPrompt,
          url: params.url,
          timestamp: Date.now(),
        };
        this.bumpVisualEpoch();
        this.emit("dialogOpening", this._activeDialog);
      };
      this.addSessionListener(`session:${sid}:Page.javascriptDialogOpening`, onDialogOpening);

      const onDialogClosed = () => {
        this._activeDialog = null;
        this.bumpVisualEpoch();
        this.emit("dialogClosed");
      };
      this.addSessionListener(`session:${sid}:Page.javascriptDialogClosed`, onDialogClosed);

      // Enable required domains
      await this.connection.send("Page.enable", {}, sid);
      await this.connection.send("Runtime.enable", {}, sid);
      await this.connection.send("Emulation.setFocusEmulationEnabled", { enabled: true }, sid);

      const info = this.targetManager.getTargetInfo(targetId);
      if (info) {
        this._currentUrl = info.url;
        this._currentTitle = info.title;
      }

      this.setState("READY");
    } catch (err: any) {
      this.clearSessionListeners();
      this.setState("DISCONNECTED");
      this._sessionId = null;
      this._targetId = null;
      throw new Error(`Failed to attach to target ${targetId}: ${err.message}`);
    }
  }

  /**
   * Handle JavaScript dialog (alert, confirm, prompt)
   */
  public async handleDialog(accept: boolean, promptText?: string): Promise<void> {
    if (!this._sessionId) {
      throw new Error("No active session attached");
    }
    const params: { accept: boolean; promptText?: string } = { accept };
    if (promptText !== undefined) {
      params.promptText = promptText;
    }
    await this.connection.send("Page.handleJavaScriptDialog", params, this._sessionId);
    this._activeDialog = null;
    this.bumpVisualEpoch();
  }

  /**
   * Detach from current tab session
   */
  public async detach(): Promise<void> {
    this.clearSessionListeners();
    this._activeDialog = null;
    this.bumpVisualEpoch();

    if (this._sessionId) {
      const sid = this._sessionId;
      this._sessionId = null;
      this._targetId = null;
      await this.targetManager.detachFromTarget(sid);
    }

    if (this._state !== "STOPPED") {
      this.setState("DISCONNECTED");
    }
  }

  /**
   * Execute an operation inside the ACTING state guard
   */
  public async executeWithinState<T>(fn: (sessionId: string) => Promise<T>): Promise<T> {
    if (this.isPaused) {
      throw new Error("Session is currently paused by user");
    }

    const currentState: SessionState = this._state;
    if (currentState !== "READY") {
      throw new Error(`Session is not ready for input actions (current state: ${currentState})`);
    }

    if (!this._sessionId) {
      throw new Error("No active session attached");
    }

    this.setState("ACTING");
    this._lastActionTime = Date.now();

    try {
      const result = await fn(this._sessionId);
      const afterState: SessionState = this._state;
      if (afterState === "ACTING") {
        this.setState("READY");
      }
      return result;
    } catch (err) {
      const afterState: SessionState = this._state;
      if (afterState === "ACTING") {
        this.setState("READY");
      }
      throw err;
    }
  }

  /**
   * Send a CDP command on this session
   */
  public async send<T = any>(method: string, params?: Record<string, any>): Promise<T> {
    if (!this._sessionId) {
      throw new Error("No active session attached to send command");
    }
    return this.connection.send<T>(method, params, this._sessionId);
  }

  public pause(): void {
    this.isPaused = true;
    this.setState("WAITING_FOR_USER");
    this.emit("paused");
  }

  public resume(): void {
    this.isPaused = false;
    this.setState("READY");
    this.emit("resumed");
  }

  public async stop(): Promise<void> {
    this.setState("STOPPED");
    this.emit("stopped");
    await this.detach();
  }
}

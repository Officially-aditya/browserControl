import { ChromeConnection, ChromeConnectionOptions } from "./chrome/connection.js";
import { TargetManager } from "./chrome/targets.js";
import { TabSession, SessionState } from "./chrome/session.js";
import { ViewportManager } from "./screen/viewport.js";
import {
  ScreenshotService,
  ScreenshotOptions,
  ObservationStore,
} from "./screen/screenshot.js";
import { CoordinateMapper } from "./screen/coordinates.js";
import { MouseController } from "./input/mouse.js";
import { KeyboardController } from "./input/keyboard.js";
import { DragController } from "./input/drag.js";
import { TabController } from "./browser/tabs.js";
import { NavigationController } from "./browser/navigation.js";
import {
  ComputerAction,
  ComputerActionSchema,
  BrowserAction,
  BrowserActionSchema,
} from "./protocol/actions.js";
import { ActionResult, Observation, TabInfo, WindowInfo, DialogInfo } from "./protocol/results.js";

export interface ChromeControllerOptions extends ChromeConnectionOptions {
  autoAttachFirstTab?: boolean;
}

export class ActionQueue {
  private queue: Array<() => Promise<void>> = [];
  private isProcessing = false;
  private isAborted = false;

  public async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.isAborted) {
      throw new Error("Action queue is aborted / session stopped");
    }

    return new Promise<T>((resolve, reject) => {
      this.queue.push(async () => {
        if (this.isAborted) {
          reject(new Error("Action cancelled: session stopped"));
          return;
        }
        try {
          const res = await task();
          resolve(res);
        } catch (err) {
          reject(err);
        }
      });

      this.processNext();
    });
  }

  private async processNext(): Promise<void> {
    if (this.isProcessing || this.queue.length === 0) {
      return;
    }

    this.isProcessing = true;
    const task = this.queue.shift();
    if (task) {
      try {
        await task();
      } finally {
        this.isProcessing = false;
        this.processNext();
      }
    } else {
      this.isProcessing = false;
    }
  }

  public abort(): void {
    this.isAborted = true;
    this.queue = [];
  }

  public reset(): void {
    this.isAborted = false;
    this.queue = [];
    this.isProcessing = false;
  }
}

export class ChromeController {
  public connection: ChromeConnection;
  public targetManager: TargetManager;
  public session: TabSession;
  public viewportManager: ViewportManager;
  public observationStore: ObservationStore;
  public screenshotService: ScreenshotService;
  public mouse: MouseController;
  public keyboard: KeyboardController;
  public dragController: DragController;
  public tabController: TabController;
  public navigationController: NavigationController;

  private actionQueue = new ActionQueue();
  private actionCounter = 0;

  constructor(options: ChromeControllerOptions = {}) {
    this.connection = new ChromeConnection(options);
    this.targetManager = new TargetManager(this.connection);
    this.session = new TabSession(this.connection, this.targetManager);
    this.viewportManager = new ViewportManager(this.session);
    this.observationStore = new ObservationStore();
    this.screenshotService = new ScreenshotService(
      this.session,
      this.viewportManager,
      this.observationStore
    );
    this.mouse = new MouseController(this.session);
    this.keyboard = new KeyboardController(this.session);
    this.dragController = new DragController(this.session);
    this.tabController = new TabController(this.targetManager, this.session);
    this.navigationController = new NavigationController(this.session);
  }

  public get state(): SessionState {
    return this.session.state;
  }

  public get currentTargetId(): string | null {
    return this.session.targetId;
  }

  public get isConnected(): boolean {
    return this.connection.connected;
  }

  public get activeDialog(): DialogInfo | null {
    return this.session.activeDialog;
  }

  /**
   * Connect to Chrome and attach to the initial tab
   */
  public async connect(targetId?: string): Promise<void> {
    this.actionQueue.reset();
    await this.connection.connect();
    await this.targetManager.init();

    if (targetId) {
      await this.session.attach(targetId);
      return;
    }

    const tabs = await this.targetManager.listPageTabs();
    if (tabs.length > 0) {
      await this.session.attach(tabs[0].targetId);
    } else {
      const newTarget = await this.targetManager.createTab("about:blank");
      await this.session.attach(newTarget);
    }
  }

  /**
   * Disconnect from Chrome
   */
  public async disconnect(): Promise<void> {
    this.actionQueue.abort();
    await this.session.detach();
    await this.connection.close();
  }

  /**
   * Capture a viewport screenshot observation
   */
  public async observe(options?: ScreenshotOptions): Promise<Observation> {
    return this.actionQueue.run(async () => {
      return this.screenshotService.capture(options);
    });
  }

  /**
   * List available tabs
   */
  public async getTabs(): Promise<TabInfo[]> {
    return this.tabController.listTabs();
  }

  /**
   * List browser windows
   */
  public async getWindows(): Promise<WindowInfo[]> {
    return this.tabController.listWindows();
  }

  /**
   * Resolve and validate coordinate mapper for an incoming action
   */
  private async getMapperForAction(observationId?: string): Promise<CoordinateMapper> {
    if (observationId) {
      const stored = this.observationStore.get(observationId);
      if (!stored) {
        throw {
          errorCode: "STALE_OBSERVATION",
          message: `Observation '${observationId}' not found or expired. Please capture a new screenshot.`,
        };
      }

      // Check if target or URL changed
      if (this.session.targetId !== stored.targetId) {
        throw {
          errorCode: "STALE_OBSERVATION",
          message: `Observation '${observationId}' belonged to tab ${stored.targetId}, but active tab is ${this.session.targetId}. Please capture a new screenshot.`,
        };
      }

      if (this.session.currentUrl && stored.url && this.session.currentUrl !== stored.url) {
        throw {
          errorCode: "STALE_OBSERVATION",
          message: `Observation '${observationId}' was captured at '${stored.url}', but current page is '${this.session.currentUrl}'. Please capture a new screenshot.`,
        };
      }

      return stored.mapper;
    }

    if (this.screenshotService.currentMapper) {
      return this.screenshotService.currentMapper;
    }

    // Fallback: create fresh mapper from current metrics
    const metrics = await this.viewportManager.getMetrics();
    const w = Math.round(metrics.cssVisualViewport.clientWidth);
    const h = Math.round(metrics.cssVisualViewport.clientHeight);
    return CoordinateMapper.create(w, h, w, h, metrics.devicePixelRatio);
  }

  /**
   * Execute a ComputerAction (mouse, keyboard, screenshot, wait)
   */
  public async executeComputerAction(actionInput: unknown): Promise<ActionResult> {
    const actId = `act_${++this.actionCounter}_${Date.now()}`;
    const startTime = Date.now();

    const parsed = ComputerActionSchema.safeParse(actionInput);
    if (!parsed.success) {
      return {
        id: actId,
        success: false,
        action: typeof actionInput === "object" && actionInput !== null && "type" in actionInput ? (actionInput as any).type : "unknown",
        targetId: this.session.targetId || undefined,
        url: this.session.currentUrl || undefined,
        durationMs: Date.now() - startTime,
        errorCode: "INVALID_ACTION",
        error: `Invalid action schema: ${parsed.error.message}`,
      };
    }

    const action: ComputerAction = parsed.data;

    return this.actionQueue.run(async () => {
      try {
        let data: any = undefined;

        await this.session.executeWithinState(async () => {
          switch (action.type) {
            case "screenshot": {
              data = await this.screenshotService.capture(action);
              break;
            }

            case "move": {
              const mapper = await this.getMapperForAction(action.observationId);
              const boundsCheck = mapper.validateBounds(action.x, action.y);
              if (!boundsCheck.valid) {
                throw { errorCode: "OUT_OF_BOUNDS", message: boundsCheck.error };
              }
              const vp = mapper.toViewport(action.x, action.y);
              const { modifierBitmask } = this.keyboard.parseModifiers(action.modifiers || []);
              this.screenshotService.setCursorPosition(vp.x, vp.y);
              await this.mouse.move(vp.x, vp.y, modifierBitmask);
              break;
            }

            case "click": {
              const mapper = await this.getMapperForAction(action.observationId);
              const boundsCheck = mapper.validateBounds(action.x, action.y);
              if (!boundsCheck.valid) {
                throw { errorCode: "OUT_OF_BOUNDS", message: boundsCheck.error };
              }
              const vp = mapper.toViewport(action.x, action.y);
              const { modifierBitmask } = this.keyboard.parseModifiers(action.modifiers || []);
              this.screenshotService.setCursorPosition(vp.x, vp.y);
              await this.mouse.click(vp.x, vp.y, action.button, modifierBitmask);
              break;
            }

            case "double_click": {
              const mapper = await this.getMapperForAction(action.observationId);
              const boundsCheck = mapper.validateBounds(action.x, action.y);
              if (!boundsCheck.valid) {
                throw { errorCode: "OUT_OF_BOUNDS", message: boundsCheck.error };
              }
              const vp = mapper.toViewport(action.x, action.y);
              const { modifierBitmask } = this.keyboard.parseModifiers(action.modifiers || []);
              this.screenshotService.setCursorPosition(vp.x, vp.y);
              await this.mouse.doubleClick(vp.x, vp.y, action.button, modifierBitmask);
              break;
            }

            case "down": {
              const mapper = await this.getMapperForAction(action.observationId);
              const boundsCheck = mapper.validateBounds(action.x, action.y);
              if (!boundsCheck.valid) {
                throw { errorCode: "OUT_OF_BOUNDS", message: boundsCheck.error };
              }
              const vp = mapper.toViewport(action.x, action.y);
              const { modifierBitmask } = this.keyboard.parseModifiers(action.modifiers || []);
              this.screenshotService.setCursorPosition(vp.x, vp.y);
              await this.mouse.down(vp.x, vp.y, action.button, modifierBitmask);
              break;
            }

            case "up": {
              const mapper = await this.getMapperForAction(action.observationId);
              const boundsCheck = mapper.validateBounds(action.x, action.y);
              if (!boundsCheck.valid) {
                throw { errorCode: "OUT_OF_BOUNDS", message: boundsCheck.error };
              }
              const vp = mapper.toViewport(action.x, action.y);
              const { modifierBitmask } = this.keyboard.parseModifiers(action.modifiers || []);
              this.screenshotService.setCursorPosition(vp.x, vp.y);
              await this.mouse.up(vp.x, vp.y, action.button, modifierBitmask);
              break;
            }

            case "scroll": {
              const mapper = await this.getMapperForAction(action.observationId);
              const boundsCheck = mapper.validateBounds(action.x, action.y);
              if (!boundsCheck.valid) {
                throw { errorCode: "OUT_OF_BOUNDS", message: boundsCheck.error };
              }
              const vp = mapper.toViewport(action.x, action.y);
              const { modifierBitmask } = this.keyboard.parseModifiers(action.modifiers || []);
              this.screenshotService.setCursorPosition(vp.x, vp.y);
              await this.mouse.scroll(vp.x, vp.y, action.deltaX, action.deltaY, modifierBitmask);
              break;
            }

            case "drag": {
              const mapper = await this.getMapperForAction(action.observationId);
              const mappedPath = [];
              for (const pt of action.path) {
                const check = mapper.validateBounds(pt.x, pt.y);
                if (!check.valid) {
                  throw { errorCode: "OUT_OF_BOUNDS", message: check.error };
                }
                mappedPath.push(mapper.toViewport(pt.x, pt.y));
              }

              if (mappedPath.length > 0) {
                const last = mappedPath[mappedPath.length - 1];
                this.screenshotService.setCursorPosition(last.x, last.y);
              }
              const { modifierBitmask } = this.keyboard.parseModifiers(action.modifiers || []);
              await this.dragController.drag(mappedPath, modifierBitmask);
              break;
            }

            case "keypress": {
              await this.keyboard.keypress(action.keys);
              break;
            }

            case "key_down": {
              await this.keyboard.keyDown(action.key);
              break;
            }

            case "key_up": {
              await this.keyboard.keyUp(action.key);
              break;
            }

            case "type": {
              await this.keyboard.type(action.text, action.method);
              break;
            }

            case "wait": {
              await new Promise((r) => setTimeout(r, action.ms));
              break;
            }
          }
        });

        return {
          id: actId,
          success: true,
          action: action.type,
          targetId: this.session.targetId || undefined,
          url: this.session.currentUrl || undefined,
          durationMs: Date.now() - startTime,
          data,
        };
      } catch (err: any) {
        return {
          id: actId,
          success: false,
          action: action.type,
          targetId: this.session.targetId || undefined,
          url: this.session.currentUrl || undefined,
          durationMs: Date.now() - startTime,
          errorCode: err.errorCode || "UNKNOWN_ERROR",
          error: err.message || String(err),
        };
      }
    });
  }

  /**
   * Execute a BrowserAction (navigate, tabs, windows, dialogs)
   */
  public async executeBrowserAction(actionInput: unknown): Promise<ActionResult> {
    const actId = `bact_${++this.actionCounter}_${Date.now()}`;
    const startTime = Date.now();

    const parsed = BrowserActionSchema.safeParse(actionInput);
    if (!parsed.success) {
      return {
        id: actId,
        success: false,
        action: typeof actionInput === "object" && actionInput !== null && "type" in actionInput ? (actionInput as any).type : "unknown",
        targetId: this.session.targetId || undefined,
        url: this.session.currentUrl || undefined,
        durationMs: Date.now() - startTime,
        errorCode: "INVALID_ACTION",
        error: `Invalid browser action schema: ${parsed.error.message}`,
      };
    }

    const action: BrowserAction = parsed.data;

    return this.actionQueue.run(async () => {
      try {
        let data: any = undefined;

        switch (action.type) {
          case "navigate": {
            await this.navigationController.navigate(action.url);
            break;
          }

          case "new_tab": {
            data = await this.tabController.newTab(action.url);
            break;
          }

          case "switch_tab": {
            await this.tabController.switchTab(action.targetId);
            break;
          }

          case "close_tab": {
            data = { closed: await this.tabController.closeTab(action.targetId) };
            break;
          }

          case "back": {
            await this.navigationController.back();
            break;
          }

          case "forward": {
            await this.navigationController.forward();
            break;
          }

          case "reload": {
            await this.navigationController.reload();
            break;
          }

          case "tabs": {
            data = await this.getTabs();
            break;
          }

          case "windows": {
            data = await this.getWindows();
            break;
          }

          case "new_window": {
            data = await this.tabController.newWindow(action.url);
            break;
          }

          case "activate_window": {
            await this.tabController.switchTab(action.targetId);
            break;
          }

          case "close_window": {
            data = { closed: await this.tabController.closeTab(action.targetId) };
            break;
          }

          case "dialog_state": {
            data = { activeDialog: this.session.activeDialog };
            break;
          }

          case "handle_dialog": {
            await this.session.handleDialog(action.accept, action.promptText);
            data = { handled: true };
            break;
          }
        }

        return {
          id: actId,
          success: true,
          action: action.type,
          targetId: this.session.targetId || undefined,
          url: this.session.currentUrl || undefined,
          durationMs: Date.now() - startTime,
          data,
        };
      } catch (err: any) {
        return {
          id: actId,
          success: false,
          action: action.type,
          targetId: this.session.targetId || undefined,
          url: this.session.currentUrl || undefined,
          durationMs: Date.now() - startTime,
          errorCode: err.errorCode || "UNKNOWN_ERROR",
          error: err.message || String(err),
        };
      }
    });
  }

  /**
   * Diagnostic Doctor reporting Chrome version, endpoints, viewport, and scale metrics
   */
  public async doctor(): Promise<{
    connected: boolean;
    wsUrl: string;
    targetId: string | null;
    currentUrl: string;
    viewport?: { width: number; height: number; dpr: number; zoom?: number };
    screenshot?: { imageWidth: number; imageHeight: number; scaleX: number; scaleY: number };
    activeDialog?: DialogInfo | null;
  }> {
    const connected = this.isConnected;
    const wsUrl = this.connection.wsUrl;
    const targetId = this.session.targetId;
    const currentUrl = this.session.currentUrl;

    if (!connected || !targetId) {
      return {
        connected,
        wsUrl,
        targetId,
        currentUrl,
        activeDialog: this.session.activeDialog,
      };
    }

    const metrics = await this.viewportManager.getMetrics();
    const obs = await this.observe();

    return {
      connected,
      wsUrl,
      targetId,
      currentUrl,
      viewport: {
        width: Math.round(metrics.cssVisualViewport.clientWidth),
        height: Math.round(metrics.cssVisualViewport.clientHeight),
        dpr: metrics.devicePixelRatio,
        zoom: metrics.cssVisualViewport.zoom,
      },
      screenshot: {
        imageWidth: obs.imageWidth,
        imageHeight: obs.imageHeight,
        scaleX: obs.coordinateSpace.scaleX,
        scaleY: obs.coordinateSpace.scaleY,
      },
      activeDialog: this.session.activeDialog,
    };
  }

  public async stop(): Promise<void> {
    this.actionQueue.abort();
    await this.session.stop();
  }

  public pause(): void {
    this.session.pause();
  }

  public resume(): void {
    this.session.resume();
  }
}

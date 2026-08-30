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
import { InputStateManager } from "./input/state.js";
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

interface QueueEntry<T = any> {
  task: (signal: AbortSignal) => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: any) => void;
  abortController: AbortController;
  generation: number;
  settled: boolean;
}

export class ActionQueue {
  private queue: QueueEntry[] = [];
  private currentEntry: QueueEntry | null = null;
  private inFlightPromise: Promise<void> | null = null;
  private isProcessing = false;
  private isAborted = false;
  private generation = 0;
  private drainListeners: Array<() => void> = [];

  public get pendingCount(): number {
    return this.queue.length;
  }

  public get isRunning(): boolean {
    return this.isProcessing || this.currentEntry !== null || this.inFlightPromise !== null;
  }

  public async run<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.isAborted) {
      throw {
        errorCode: "ACTION_CANCELLED",
        message: "Action cancelled: session is stopped or aborted",
      };
    }

    const abortController = new AbortController();
    const currentGen = this.generation;

    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        task,
        resolve,
        reject,
        abortController,
        generation: currentGen,
        settled: false,
      });

      this.processNext();
    });
  }

  private async processNext(): Promise<void> {
    if (this.isProcessing || this.queue.length === 0 || this.isAborted) {
      this.checkDrain();
      return;
    }

    this.isProcessing = true;
    const entry = this.queue.shift();
    if (!entry) {
      this.isProcessing = false;
      this.checkDrain();
      return;
    }

    if (entry.generation !== this.generation || this.isAborted) {
      if (!entry.settled) {
        entry.settled = true;
        entry.reject({
          errorCode: "ACTION_CANCELLED",
          message: "Action cancelled: queue generation changed or aborted",
        });
      }
      this.isProcessing = false;
      this.processNext();
      return;
    }

    this.currentEntry = entry;
    const runGeneration = entry.generation;

    const taskExecution = (async () => {
      try {
        const result = await entry.task(entry.abortController.signal);
        if (entry.generation === this.generation && !this.isAborted && !entry.settled) {
          entry.settled = true;
          entry.resolve(result);
        } else if (!entry.settled) {
          entry.settled = true;
          entry.reject({
            errorCode: "ACTION_CANCELLED",
            message: "Action cancelled: queue was aborted during execution",
          });
        }
      } catch (err) {
        if (!entry.settled) {
          entry.settled = true;
          entry.reject(err);
        }
      } finally {
        if (this.generation === runGeneration) {
          this.currentEntry = null;
          this.isProcessing = false;
          this.inFlightPromise = null;
          this.processNext();
        } else {
          this.inFlightPromise = null;
          this.checkDrain();
        }
      }
    })();

    this.inFlightPromise = taskExecution;
  }

  private checkDrain(): void {
    if (!this.isRunning && this.queue.length === 0) {
      const listeners = [...this.drainListeners];
      this.drainListeners = [];
      for (const fn of listeners) {
        fn();
      }
    }
  }

  /**
   * Cancel the currently executing task (via AbortSignal) and immediately drain/reject all pending queued tasks.
   */
  public abort(): void {
    this.isAborted = true;
    this.generation++;

    if (this.currentEntry) {
      this.currentEntry.abortController.abort();
      if (!this.currentEntry.settled) {
        this.currentEntry.settled = true;
        this.currentEntry.reject({
          errorCode: "ACTION_CANCELLED",
          message: "Action cancelled: session stopped or queue aborted",
        });
      }
      this.currentEntry = null;
    }

    const pending = [...this.queue];
    this.queue = [];

    for (const item of pending) {
      item.abortController.abort();
      if (!item.settled) {
        item.settled = true;
        item.reject({
          errorCode: "ACTION_CANCELLED",
          message: "Action cancelled: session stopped or queue aborted",
        });
      }
    }

    this.isProcessing = false;
    this.checkDrain();
  }

  /**
   * Wait for all queued and in-flight actions to complete naturally without aborting.
   */
  public async drain(): Promise<void> {
    if (!this.isRunning && this.queue.length === 0) {
      return;
    }
    return new Promise<void>((resolve) => {
      this.drainListeners.push(resolve);
    });
  }

  /**
   * Aborts all pending and active tasks, and waits for in-flight asynchronous operations to fully settle.
   */
  public async cancelAndDrain(): Promise<void> {
    const currentFlight = this.inFlightPromise;
    this.abort();
    if (currentFlight) {
      try {
        await currentFlight;
      } catch {}
    }
    this.inFlightPromise = null;
    this.checkDrain();
  }

  /**
   * Reset the queue to an idle, non-aborted state.
   */
  public reset(): void {
    this.abort();
    this.isAborted = false;
    this.generation++;
    this.queue = [];
    this.currentEntry = null;
    this.isProcessing = false;
  }
}

export class ChromeController {
  public connection: ChromeConnection;
  public targetManager: TargetManager;
  public session: TabSession;
  public viewportManager: ViewportManager;
  public observationStore: ObservationStore;
  public inputState: InputStateManager;
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
    this.inputState = new InputStateManager();

    this.screenshotService = new ScreenshotService(
      this.session,
      this.viewportManager,
      this.observationStore,
      this.inputState
    );
    this.mouse = new MouseController(this.session, this.inputState);
    this.keyboard = new KeyboardController(this.session, this.inputState);
    this.dragController = new DragController(this.session, this.inputState);
    this.tabController = new TabController(this.connection, this.targetManager, this.session);
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
   * Emergency reset for all held keys, buttons, and drag state
   */
  public async resetInputState(): Promise<void> {
    await this.mouse.reset();
    await this.keyboard.reset();
  }

  /**
   * Connect to Chrome and attach to the initial tab
   */
  public async connect(targetId?: string): Promise<void> {
    await this.actionQueue.reset();
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
    await this.actionQueue.cancelAndDrain();
    await this.resetInputState();
    this.observationStore.clear();
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
   * Resolve and validate coordinate mapper for an incoming action using observationId and visualEpoch
   */
  private async getMapperForAction(observationId: string): Promise<CoordinateMapper> {
    const stored = this.observationStore.get(observationId);
    if (!stored) {
      throw {
        errorCode: "STALE_OBSERVATION",
        message: `Observation '${observationId}' not found or expired. Please capture a new screenshot before acting.`,
      };
    }

    if (this.session.targetId !== stored.targetId) {
      throw {
        errorCode: "STALE_OBSERVATION",
        message: `Observation '${observationId}' belonged to tab ${stored.targetId}, but active tab is ${this.session.targetId}. Please capture a new screenshot.`,
      };
    }

    if (stored.visualEpoch !== this.session.visualEpoch) {
      throw {
        errorCode: "STALE_OBSERVATION",
        message: `Observation '${observationId}' is stale (epoch ${stored.visualEpoch} vs current ${this.session.visualEpoch}). The page has changed since this screenshot was taken. Please capture a new screenshot.`,
      };
    }

    return stored.mapper;
  }

  /**
   * Execute a raw coordinate action without observationId requirement (lower-level API for tests/diagnostics)
   */
  public async executeRawCdpCoordinateAction(
    actionType: "move" | "click" | "double_click" | "down" | "up" | "scroll",
    x: number,
    y: number,
    button: "left" | "right" | "middle" | "back" | "forward" = "left",
    deltaX = 0,
    deltaY = 0
  ): Promise<ActionResult> {
    const actId = `raw_${++this.actionCounter}_${Date.now()}`;
    const startTime = Date.now();

    return this.actionQueue
      .run(async (signal) => {
        try {
          await this.session.executeWithinState(async () => {
            switch (actionType) {
              case "move":
                await this.mouse.move(x, y, 0, signal);
                break;
              case "click":
                await this.mouse.click(x, y, button, 0, signal);
                break;
              case "double_click":
                await this.mouse.doubleClick(x, y, button, 0, signal);
                break;
              case "down":
                await this.mouse.down(x, y, button, 0, signal);
                break;
              case "up":
                await this.mouse.up(x, y, button, 0, signal);
                break;
              case "scroll":
                await this.mouse.scroll(x, y, deltaX, deltaY, 0, signal);
                break;
            }
          });
          this.session.bumpVisualEpoch();

          return {
            id: actId,
            success: true,
            action: actionType,
            targetId: this.session.targetId || undefined,
            url: this.session.currentUrl || undefined,
            durationMs: Date.now() - startTime,
          };
        } catch (err: any) {
          return {
            id: actId,
            success: false,
            action: actionType,
            targetId: this.session.targetId || undefined,
            url: this.session.currentUrl || undefined,
            durationMs: Date.now() - startTime,
            errorCode: err.errorCode || "UNKNOWN_ERROR",
            error: err.message || String(err),
          };
        }
      })
      .catch((err) => ({
        id: actId,
        success: false,
        action: actionType,
        targetId: this.session.targetId || undefined,
        url: this.session.currentUrl || undefined,
        durationMs: Date.now() - startTime,
        errorCode: err?.errorCode || "ACTION_CANCELLED",
        error: err?.message || String(err),
      }));
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
        action:
          typeof actionInput === "object" && actionInput !== null && "type" in actionInput
            ? (actionInput as any).type
            : "unknown",
        targetId: this.session.targetId || undefined,
        url: this.session.currentUrl || undefined,
        durationMs: Date.now() - startTime,
        errorCode: "INVALID_ACTION",
        error: `Invalid action schema: ${parsed.error.message}`,
      };
    }

    const action: ComputerAction = parsed.data;

    return this.actionQueue
      .run(async (signal) => {
        try {
          let data: any = undefined;

          // Check if blocked by open JavaScript dialog
          if (this.session.activeDialog !== null && action.type !== "screenshot" && action.type !== "wait") {
            throw {
              errorCode: "DIALOG_BLOCKING",
              message: `A JavaScript dialog [${this.session.activeDialog.type}] "${this.session.activeDialog.message}" is open. Please handle the dialog via browser.action 'handle_dialog' first.`,
            };
          }

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
                const explicitMods = this.inputState.parseModifierArray(action.modifiers || []);
                await this.mouse.move(vp.x, vp.y, explicitMods, signal);
                break;
              }

              case "click": {
                const mapper = await this.getMapperForAction(action.observationId);
                const boundsCheck = mapper.validateBounds(action.x, action.y);
                if (!boundsCheck.valid) {
                  throw { errorCode: "OUT_OF_BOUNDS", message: boundsCheck.error };
                }
                const vp = mapper.toViewport(action.x, action.y);
                const explicitMods = this.inputState.parseModifierArray(action.modifiers || []);
                await this.mouse.click(vp.x, vp.y, action.button, explicitMods, signal);
                this.session.bumpVisualEpoch();
                break;
              }

              case "double_click": {
                const mapper = await this.getMapperForAction(action.observationId);
                const boundsCheck = mapper.validateBounds(action.x, action.y);
                if (!boundsCheck.valid) {
                  throw { errorCode: "OUT_OF_BOUNDS", message: boundsCheck.error };
                }
                const vp = mapper.toViewport(action.x, action.y);
                const explicitMods = this.inputState.parseModifierArray(action.modifiers || []);
                await this.mouse.doubleClick(vp.x, vp.y, action.button, explicitMods, signal);
                this.session.bumpVisualEpoch();
                break;
              }

              case "down": {
                const mapper = await this.getMapperForAction(action.observationId);
                const boundsCheck = mapper.validateBounds(action.x, action.y);
                if (!boundsCheck.valid) {
                  throw { errorCode: "OUT_OF_BOUNDS", message: boundsCheck.error };
                }
                const vp = mapper.toViewport(action.x, action.y);
                const explicitMods = this.inputState.parseModifierArray(action.modifiers || []);
                await this.mouse.down(vp.x, vp.y, action.button, explicitMods, signal);
                break;
              }

              case "up": {
                const mapper = await this.getMapperForAction(action.observationId);
                const boundsCheck = mapper.validateBounds(action.x, action.y);
                if (!boundsCheck.valid) {
                  throw { errorCode: "OUT_OF_BOUNDS", message: boundsCheck.error };
                }
                const vp = mapper.toViewport(action.x, action.y);
                const explicitMods = this.inputState.parseModifierArray(action.modifiers || []);
                await this.mouse.up(vp.x, vp.y, action.button, explicitMods, signal);
                break;
              }

              case "scroll": {
                const mapper = await this.getMapperForAction(action.observationId);
                const boundsCheck = mapper.validateBounds(action.x, action.y);
                if (!boundsCheck.valid) {
                  throw { errorCode: "OUT_OF_BOUNDS", message: boundsCheck.error };
                }
                const vp = mapper.toViewport(action.x, action.y);
                const explicitMods = this.inputState.parseModifierArray(action.modifiers || []);
                await this.mouse.scroll(vp.x, vp.y, action.deltaX, action.deltaY, explicitMods, signal);
                this.session.bumpVisualEpoch();
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

                const explicitMods = this.inputState.parseModifierArray(action.modifiers || []);
                try {
                  await this.dragController.drag(mappedPath, explicitMods, signal);
                } catch (dragErr) {
                  await this.resetInputState();
                  throw dragErr;
                }
                this.session.bumpVisualEpoch();
                break;
              }

              case "keypress": {
                await this.keyboard.keypress(action.keys, signal);
                this.session.bumpVisualEpoch();
                break;
              }

              case "key_down": {
                await this.keyboard.keyDown(action.key, signal);
                break;
              }

              case "key_up": {
                await this.keyboard.keyUp(action.key, signal);
                break;
              }

              case "type": {
                await this.keyboard.type(action.text, action.method, signal);
                this.session.bumpVisualEpoch();
                break;
              }

              case "reset_input": {
                await this.resetInputState();
                break;
              }

              case "wait": {
                if (signal?.aborted) throw new Error("ACTION_CANCELLED");
                const stepMs = 50;
                let elapsed = 0;
                while (elapsed < action.ms) {
                  if (signal?.aborted) throw new Error("ACTION_CANCELLED");
                  const sleepTime = Math.min(stepMs, action.ms - elapsed);
                  await new Promise((r) => setTimeout(r, sleepTime));
                  elapsed += sleepTime;
                }
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
            errorCode: err.errorCode || (err.message === "ACTION_CANCELLED" ? "ACTION_CANCELLED" : "UNKNOWN_ERROR"),
            error: err.message || String(err),
          };
        }
      })
      .catch((err) => ({
        id: actId,
        success: false,
        action: action.type,
        targetId: this.session.targetId || undefined,
        url: this.session.currentUrl || undefined,
        durationMs: Date.now() - startTime,
        errorCode: err?.errorCode || "ACTION_CANCELLED",
        error: err?.message || String(err),
      }));
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
        action:
          typeof actionInput === "object" && actionInput !== null && "type" in actionInput
            ? (actionInput as any).type
            : "unknown",
        targetId: this.session.targetId || undefined,
        url: this.session.currentUrl || undefined,
        durationMs: Date.now() - startTime,
        errorCode: "INVALID_ACTION",
        error: `Invalid browser action schema: ${parsed.error.message}`,
      };
    }

    const action: BrowserAction = parsed.data;

    return this.actionQueue
      .run(async (signal) => {
        try {
          let data: any = undefined;

          switch (action.type) {
            case "navigate": {
              await this.navigationController.navigate(action.url);
              this.session.bumpVisualEpoch();
              break;
            }

            case "new_tab": {
              data = await this.tabController.newTab(action.url);
              this.session.bumpVisualEpoch();
              break;
            }

            case "switch_tab": {
              await this.resetInputState();
              await this.tabController.switchTab(action.targetId);
              this.session.bumpVisualEpoch();
              break;
            }

            case "close_tab": {
              await this.resetInputState();
              this.observationStore.invalidateTarget(action.targetId);
              data = { closed: await this.tabController.closeTab(action.targetId) };
              this.session.bumpVisualEpoch();
              break;
            }

            case "back": {
              await this.navigationController.back();
              this.session.bumpVisualEpoch();
              break;
            }

            case "forward": {
              await this.navigationController.forward();
              this.session.bumpVisualEpoch();
              break;
            }

            case "reload": {
              await this.navigationController.reload();
              this.session.bumpVisualEpoch();
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
              this.session.bumpVisualEpoch();
              break;
            }

            case "activate_window": {
              await this.tabController.activateWindow(action.windowId);
              this.session.bumpVisualEpoch();
              break;
            }

            case "close_window": {
              data = { closed: await this.tabController.closeWindow(action.windowId) };
              this.session.bumpVisualEpoch();
              break;
            }

            case "dialog_state": {
              data = { activeDialog: this.session.activeDialog };
              break;
            }

            case "handle_dialog": {
              await this.session.handleDialog(action.accept, action.promptText);
              data = { handled: true };
              this.session.bumpVisualEpoch();
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
      })
      .catch((err) => ({
        id: actId,
        success: false,
        action: action.type,
        targetId: this.session.targetId || undefined,
        url: this.session.currentUrl || undefined,
        durationMs: Date.now() - startTime,
        errorCode: err?.errorCode || "ACTION_CANCELLED",
        error: err?.message || String(err),
      }));
  }

  /**
   * Diagnostic Doctor reporting Chrome version, endpoints, viewport, and scale metrics
   */
  public async doctor(): Promise<{
    connected: boolean;
    wsUrl: string;
    targetId: string | null;
    currentUrl: string;
    visualEpoch: number;
    viewport?: { width: number; height: number; dpr: number; zoom?: number };
    screenshot?: { imageWidth: number; imageHeight: number; scaleX: number; scaleY: number };
    activeDialog?: DialogInfo | null;
  }> {
    const connected = this.isConnected;
    const wsUrl = this.connection.wsUrl;
    const targetId = this.session.targetId;
    const currentUrl = this.session.currentUrl;
    const visualEpoch = this.session.visualEpoch;

    if (!connected || !targetId) {
      return {
        connected,
        wsUrl,
        targetId,
        currentUrl,
        visualEpoch,
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
      visualEpoch: this.session.visualEpoch,
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
    await this.actionQueue.cancelAndDrain();
    await this.resetInputState();
    this.observationStore.clear();
    await this.session.stop();
  }

  public pause(): void {
    this.session.pause();
  }

  public resume(): void {
    this.session.resume();
  }
}

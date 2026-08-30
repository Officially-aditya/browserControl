import { TabSession } from "../chrome/session.js";

export interface ViewportMetrics {
  cssVisualViewport: {
    pageX: number;
    pageY: number;
    clientWidth: number;
    clientHeight: number;
    scale: number;
    zoom?: number;
  };
  cssLayoutViewport: {
    pageX: number;
    pageY: number;
    clientWidth: number;
    clientHeight: number;
  };
  cssContentSize: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  devicePixelRatio: number;
}

export class ViewportManager {
  private session: TabSession;

  constructor(session: TabSession) {
    this.session = session;
  }

  /**
   * Retrieve current layout and visual viewport metrics
   */
  public async getMetrics(): Promise<ViewportMetrics> {
    const res = await this.session.send<{
      cssVisualViewport?: {
        pageX: number;
        pageY: number;
        clientWidth: number;
        clientHeight: number;
        scale: number;
        zoom?: number;
      };
      cssLayoutViewport: {
        pageX: number;
        pageY: number;
        clientWidth: number;
        clientHeight: number;
      };
      cssContentSize?: {
        x: number;
        y: number;
        width: number;
        height: number;
      };
      visualViewport?: {
        offsetX: number;
        offsetY: number;
        pageX: number;
        pageY: number;
        clientWidth: number;
        clientHeight: number;
        scale: number;
        zoom?: number;
      };
      contentSize?: {
        x: number;
        y: number;
        width: number;
        height: number;
      };
    }>("Page.getLayoutMetrics");

    // Retrieve devicePixelRatio via runtime evaluation if available
    let dpr = 1;
    try {
      const evalRes = await this.session.send<{ result: { value?: number } }>("Runtime.evaluate", {
        expression: "window.devicePixelRatio || 1",
        returnByValue: true,
      });
      if (evalRes.result && typeof evalRes.result.value === "number") {
        dpr = evalRes.result.value;
      }
    } catch {
      dpr = 1;
    }

    const visual = res.cssVisualViewport || {
      pageX: res.visualViewport?.pageX || 0,
      pageY: res.visualViewport?.pageY || 0,
      clientWidth: res.visualViewport?.clientWidth || res.cssLayoutViewport.clientWidth,
      clientHeight: res.visualViewport?.clientHeight || res.cssLayoutViewport.clientHeight,
      scale: res.visualViewport?.scale || 1,
      zoom: res.visualViewport?.zoom || 1,
    };

    const content = res.cssContentSize || {
      x: res.contentSize?.x || 0,
      y: res.contentSize?.y || 0,
      width: res.contentSize?.width || visual.clientWidth,
      height: res.contentSize?.height || visual.clientHeight,
    };

    return {
      cssVisualViewport: visual,
      cssLayoutViewport: res.cssLayoutViewport,
      cssContentSize: content,
      devicePixelRatio: dpr,
    };
  }
}

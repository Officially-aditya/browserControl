export interface CoordinateSpace {
  imageWidth: number;
  imageHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  scaleX: number;
  scaleY: number;
  devicePixelRatio?: number;
  zoom?: number;
}

export interface DialogInfo {
  type: "alert" | "confirm" | "prompt" | "beforeunload";
  message: string;
  defaultPrompt?: string;
  url: string;
  timestamp: number;
}

export interface Observation {
  observationId: string;
  image: string; // Base64 PNG/JPEG/WebP
  imageWidth: number;
  imageHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  width?: number; // Backward compatibility alias for viewportWidth
  height?: number; // Backward compatibility alias for viewportHeight
  targetId: string;
  url: string;
  title?: string;
  coordinateSpace: CoordinateSpace;
  timestamp: number;
  cursorPosition?: { x: number; y: number };
  activeDialog?: DialogInfo;
}

export interface ActionResult {
  id: string;
  success: boolean;
  action: string;
  targetId?: string;
  url?: string;
  durationMs: number;
  error?: string;
  errorCode?:
    | "STALE_OBSERVATION"
    | "OUT_OF_BOUNDS"
    | "SESSION_NOT_READY"
    | "TARGET_CLOSED"
    | "CONNECTION_LOST"
    | "DIALOG_BLOCKING"
    | "INVALID_ACTION"
    | "UNKNOWN_ERROR";
  data?: any;
}

export interface TabInfo {
  targetId: string;
  type: string;
  title: string;
  url: string;
  attached: boolean;
  browserContextId?: string;
}

export interface WindowInfo {
  windowId: number;
  bounds?: {
    left?: number;
    top?: number;
    width?: number;
    height?: number;
    windowState?: string;
  };
  targetIds: string[];
  activeTargetId?: string;
}

/**
 * Summary of an executed step in the visual loop.
 * Strictly text-only: image payloads must NEVER enter memory.
 */
export interface StepSummary {
  stepIndex: number;
  actionDescription: string;
  intent?: string;
  success: boolean;
  error?: string;
  url?: string;
  timestamp: number;
}

export interface AgentMemoryState {
  objective: string;
  currentUrl?: string;
  recentSteps: StepSummary[];
  facts: string[];
  lastFailure?: string;
}

export interface AgentMemoryOptions {
  /** Maximum number of recent steps to keep in bounded history (default: 6) */
  maxSteps?: number;
  /** Maximum number of persistent task facts to retain (default: 10) */
  maxFacts?: number;
}

/**
 * Compact, bounded memory for VisionAgent.
 * Prevents context growth from scaling linearly with screenshots and actions.
 * Guarantees approximately constant token size across long tasks.
 */
export class AgentMemory {
  private objective: string;
  private currentUrl?: string;
  private recentSteps: StepSummary[] = [];
  private facts: string[] = [];
  private lastFailure?: string;
  private maxSteps: number;
  private maxFacts: number;
  private totalStepsCount = 0;

  constructor(objective: string, options: AgentMemoryOptions = {}) {
    this.objective = objective;
    this.maxSteps = options.maxSteps ?? 6;
    this.maxFacts = options.maxFacts ?? 10;
  }

  public get totalSteps(): number {
    return this.totalStepsCount;
  }

  /**
   * Record a completed step into bounded history
   */
  public recordStep(summary: Omit<StepSummary, "timestamp">): void {
    this.totalStepsCount++;
    const step: StepSummary = {
      ...summary,
      timestamp: Date.now(),
    };

    this.recentSteps.push(step);
    if (this.recentSteps.length > this.maxSteps) {
      this.recentSteps.shift();
    }

    if (summary.url) {
      this.currentUrl = summary.url;
    }

    if (!summary.success && summary.error) {
      this.lastFailure = summary.error;
    } else if (summary.success) {
      this.lastFailure = undefined;
    }
  }

  /**
   * Add a persistent factual observation (e.g. "Password field requires 8 chars")
   */
  public addFact(fact: string): void {
    const trimmed = fact.trim();
    if (trimmed && !this.facts.includes(trimmed)) {
      this.facts.push(trimmed);
      if (this.facts.length > this.maxFacts) {
        this.facts.shift();
      }
    }
  }

  /**
   * Update current page URL
   */
  public setUrl(url: string): void {
    this.currentUrl = url;
  }

  /**
   * Return a snapshot of current memory state
   */
  public getState(): AgentMemoryState {
    return {
      objective: this.objective,
      currentUrl: this.currentUrl,
      recentSteps: [...this.recentSteps],
      facts: [...this.facts],
      lastFailure: this.lastFailure,
    };
  }

  /**
   * Formats a concise, token-efficient text prompt suitable for vision model requests.
   */
  public formatSummary(): string {
    const lines: string[] = [];
    lines.push(`OBJECTIVE:\n${this.objective}`);

    const stateLines: string[] = [];
    if (this.currentUrl) {
      stateLines.push(`- Current URL: ${this.currentUrl}`);
    }
    if (this.lastFailure) {
      stateLines.push(`- Last Failure/Notice: ${this.lastFailure}`);
    }
    if (this.facts.length > 0) {
      for (const fact of this.facts) {
        stateLines.push(`- Fact: ${fact}`);
      }
    }

    if (stateLines.length > 0) {
      lines.push(`\nSTATE:\n${stateLines.join("\n")}`);
    }

    if (this.recentSteps.length > 0) {
      lines.push(
        `\nRECENT ACTIONS (last ${this.recentSteps.length} of ${this.totalStepsCount} steps):`
      );
      this.recentSteps.forEach((s) => {
        const status = s.success ? "✓" : `✗ (${s.error || "failed"})`;
        const desc = s.intent
          ? `${s.actionDescription} [Intent: ${s.intent}]`
          : s.actionDescription;
        lines.push(`${s.stepIndex}. ${desc} -> ${status}`);
      });
    }

    return lines.join("\n");
  }
}

import { describe, it, expect } from "vitest";
import { ObservationPlanner } from "../../src/vision/planner.js";
import { VisionDecision } from "../../src/vision/types.js";
import { createOverviewFrame, createRegionFrame } from "../../src/vision/frame.js";

describe("ObservationPlanner State Machine & Policy", () => {
  const dummyOverview = createOverviewFrame({
    sourceObservationId: "obs_1",
    visualEpoch: 1,
    image: "b64",
    mimeType: "image/webp",
    width: 1280,
    height: 800,
    sourceImageWidth: 1280,
    sourceImageHeight: 800,
  });

  it("1. Normal confident action flow: overview -> decision -> act -> success -> next overview", () => {
    const planner = new ObservationPlanner();

    // Start state requires capture_overview
    expect(planner.getNextStep().nextAction).toBe("capture_overview");

    // Overview captured
    planner.onFrameCaptured(dummyOverview);
    expect(planner.getNextStep().nextAction).toBe("request_decision");

    // Model returns certain click action
    const clickDecision: VisionDecision = {
      type: "computer_action",
      action: { type: "click", x: 500, y: 500, button: "left" },
      certainty: "certain",
    };
    const next = planner.onDecisionReceived(clickDecision);
    expect(next.nextAction).toBe("execute_action");
    expect(planner.state).toBe("ACT");

    // Action succeeds
    planner.onActionResult(
      { id: "act_1", success: true, action: "click" },
      clickDecision.action
    );

    // Planner should transition back to OVERVIEW for the next perception cycle
    expect(planner.state).toBe("OVERVIEW");
    expect(planner.getNextStep().nextAction).toBe("capture_overview");
  });

  it("2. Uncertain decision inspect_region flow", () => {
    const planner = new ObservationPlanner();
    planner.onFrameCaptured(dummyOverview);

    // Model requests inspect_region on uncertain area
    const inspectDecision: VisionDecision = {
      type: "inspect_region",
      region: { x: 400, y: 300, width: 200, height: 200 },
      certainty: "uncertain",
      reasoning: "Target button text blurry",
    };

    const next = planner.onDecisionReceived(inspectDecision);
    expect(next.nextAction).toBe("capture_region");
    expect(next.region).toEqual({ x: 400, y: 300, width: 200, height: 200 });
    expect(planner.state).toBe("REGION_INSPECTION");

    // Region captured
    const regionFrame = createRegionFrame({
      sourceObservationId: "obs_1",
      visualEpoch: 1,
      image: "b64_crop",
      mimeType: "image/png",
      width: 200,
      height: 200,
      sourceRegion: { x: 400, y: 300, width: 200, height: 200 },
    });
    planner.onFrameCaptured(regionFrame);

    // Model now feels certain on region frame
    const confidentClick: VisionDecision = {
      type: "computer_action",
      action: { type: "click", x: 500, y: 500, button: "left" },
      certainty: "certain",
    };
    const nextStep = planner.onDecisionReceived(confidentClick);
    expect(nextStep.nextAction).toBe("execute_action");
    expect(planner.state).toBe("ACT");
  });

  it("3. Stale observation error triggers recovery to fresh overview", () => {
    const planner = new ObservationPlanner();
    planner.onFrameCaptured(dummyOverview);

    const clickDecision: VisionDecision = {
      type: "computer_action",
      action: { type: "click", x: 200, y: 300, button: "left" },
      certainty: "certain",
    };
    planner.onDecisionReceived(clickDecision);

    // Action fails with STALE_OBSERVATION
    planner.onActionResult(
      { id: "act_1", success: false, action: "click", errorCode: "STALE_OBSERVATION" },
      clickDecision.action
    );

    expect(planner.state).toBe("RECOVER");
    expect(planner.recoveryReason).toBe("STALE_OBSERVATION");
    expect(planner.getNextStep().nextAction).toBe("capture_overview");
  });

  it("4. Out-of-bounds error handling", () => {
    const planner = new ObservationPlanner();
    planner.onFrameCaptured(dummyOverview);

    const clickDecision: VisionDecision = {
      type: "computer_action",
      action: { type: "click", x: 100, y: 100, button: "left" },
      certainty: "certain",
    };
    planner.onDecisionReceived(clickDecision);

    planner.onActionResult(
      { id: "act_1", success: false, action: "click", errorCode: "OUT_OF_BOUNDS" },
      clickDecision.action
    );

    expect(planner.state).toBe("RECOVER");
    expect(planner.recoveryReason).toBe("OUT_OF_BOUNDS");
  });

  it("5. Repeated same-coordinate failure triggers recovery", () => {
    const planner = new ObservationPlanner();
    planner.onFrameCaptured(dummyOverview);

    const action = { type: "click" as const, x: 350, y: 450, button: "left" as const };
    const clickDecision: VisionDecision = {
      type: "computer_action",
      action,
      certainty: "certain",
    };

    // First failure
    planner.onDecisionReceived(clickDecision);
    planner.onActionResult({ id: "act_1", success: false, action: "click", error: "Failed" }, action);

    // Second failure on same signature
    planner.onFrameCaptured(dummyOverview);
    planner.onDecisionReceived(clickDecision);
    planner.onActionResult({ id: "act_2", success: false, action: "click", error: "Failed again" }, action);

    expect(planner.state).toBe("RECOVER");
    expect(planner.recoveryReason).toBe("REPEATED_ACTION_FAILURE");
  });

  it("6. Target recovery notification", () => {
    const planner = new ObservationPlanner();
    planner.onTargetRecovered();

    expect(planner.state).toBe("RECOVER");
    expect(planner.recoveryReason).toBe("TARGET_RECOVERED");
    expect(planner.getNextStep().nextAction).toBe("capture_overview");
  });

  it("7. Task completion done state", () => {
    const planner = new ObservationPlanner();
    planner.onFrameCaptured(dummyOverview);

    const doneDecision: VisionDecision = {
      type: "done",
      result: "Settings dark mode enabled",
      success: true,
    };

    const next = planner.onDecisionReceived(doneDecision);
    expect(next.nextAction).toBe("done");
    expect(planner.state).toBe("DONE");
    expect(planner.isDone).toBe(true);
  });

  it("8. Max region inspections per step loop prevention", () => {
    const planner = new ObservationPlanner({ maxRegionInspectionsPerStep: 2 });
    planner.onFrameCaptured(dummyOverview);

    const inspectDecision: VisionDecision = {
      type: "inspect_region",
      region: { x: 100, y: 100, width: 200, height: 200 },
      certainty: "uncertain",
    };

    // 1st inspect
    planner.onDecisionReceived(inspectDecision);
    // 2nd inspect
    planner.onDecisionReceived(inspectDecision);

    // 3rd inspect exceeds max: planner forces overview refresh
    const next = planner.onDecisionReceived(inspectDecision);
    expect(next.nextAction).toBe("capture_overview");
    expect(planner.state).toBe("OVERVIEW");
    expect(planner.recoveryReason).toBe("MAX_INSPECTIONS_EXCEEDED");
  });

  it("9. Max steps timeout failure", () => {
    const planner = new ObservationPlanner({ maxSteps: 3 });

    for (let i = 0; i < 3; i++) {
      planner.onFrameCaptured(dummyOverview);
      planner.onDecisionReceived({
        type: "computer_action",
        action: { type: "click", x: 100, y: 100, button: "left" },
        certainty: "certain",
      });
      planner.onActionResult({ id: `act_${i}`, success: true, action: "click" }, { type: "click", x: 100, y: 100 });
    }

    const next = planner.getNextStep();
    expect(next.nextAction).toBe("fail");
    expect(next.reason).toContain("Maximum steps");
    expect(planner.isDone).toBe(true);
  });
});

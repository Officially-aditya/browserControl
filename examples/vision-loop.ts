/**
 * Example: Pure Visual Computer-Use Loop
 *
 * Demonstrates the core Computer-Use loop:
 *   1. Observe (Capture Viewport Screenshot)
 *   2. Vision Reasoning (Determine screenshot coordinates)
 *   3. Execute Action (Mouse / Keyboard / Drag / Scroll)
 *   4. Observe again
 */
import { ChromeController } from "../src/controller.js";

async function runVisionAgentLoop() {
  console.log("Starting Chrome Computer-Use Vision Loop Example...");

  const controller = new ChromeController({
    mode: "auto",
    port: 9222,
  });

  try {
    console.log("Connecting to Chrome...");
    await controller.connect();
    console.log("Connected to active tab:", controller.currentTargetId);

    // Goal: Search and navigate
    const objective = "Interact with user interface purely through pixel coordinates";
    console.log(`Objective: "${objective}"`);

    // Step 1: Initial Observation
    console.log("\n[Step 1] Capturing observation...");
    const obs1 = await controller.observe();
    console.log(`Received observation: ${obs1.observationId}`);
    console.log(`Decoded Image: ${obs1.imageWidth}x${obs1.imageHeight} px, Viewport: ${obs1.viewportWidth}x${obs1.viewportHeight} CSS px`);
    console.log(`Scale factors: ${obs1.coordinateSpace.scaleX} x ${obs1.coordinateSpace.scaleY}`);

    // Step 2: Simulate Vision Model determining a click target at (150, 100)
    console.log("\n[Step 2] Executing click at coordinate (150, 100)...");
    const clickResult = await controller.executeComputerAction({
      type: "click",
      observationId: obs1.observationId,
      x: 150,
      y: 100,
      button: "left",
    });
    console.log(`Click result: success=${clickResult.success} (${clickResult.durationMs}ms)`);

    // Step 3: Type text into focused control
    console.log("\n[Step 3] Typing text into focused control...");
    const typeResult = await controller.executeComputerAction({
      type: "type",
      text: "Chrome Computer-Use Bridge",
      method: "auto",
    });
    console.log(`Type result: success=${typeResult.success}`);

    // Step 4: Follow-up Observation
    console.log("\n[Step 4] Capturing post-action observation...");
    const obs2 = await controller.observe();
    console.log(`Received new observation: ${obs2.observationId}`);

    console.log("\n✓ Vision computer-use cycle completed successfully without DOM selectors!");
  } catch (err: any) {
    console.error("Vision loop error:", err.message);
  } finally {
    await controller.disconnect();
  }
}

if (process.argv[1]?.endsWith("vision-loop.ts") || process.argv[1]?.endsWith("vision-loop.js")) {
  runVisionAgentLoop().catch(console.error);
}

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { OpenAIVisionAdapter } from "../../src/vision/openai-adapter.js";
import { VisionAgent } from "../../src/agent/runtime.js";
import { ChromeController } from "../../src/controller.js";
import { launchRealChrome, LaunchedChrome } from "../helpers/chrome-launcher.js";
import { startTestServer, TestServer } from "../fixtures/test-server.js";

describe("OpenAIVisionAdapter Multimodal Protocol Implementation", () => {
  let chrome: LaunchedChrome;
  let server: TestServer;
  let controller: ChromeController;

  beforeAll(async () => {
    server = await startTestServer(0);
    chrome = await launchRealChrome({ windowSize: "1280,800" });
    controller = new ChromeController({
      mode: "ws-endpoint",
      wsEndpoint: chrome.wsUrl,
    });
    await controller.connect();
  }, 20000);

  afterAll(async () => {
    if (controller) await controller.disconnect();
    if (chrome) await chrome.close();
    if (server) await server.close();
  });

  it("1. should format multimodal messages accurately", () => {
    const adapter = new OpenAIVisionAdapter();
    const messages = adapter.formatMessages({
      objective: "Click login button",
      historySummary: "STATE:\n- On home page",
      stepIndex: 1,
      maxSteps: 5,
      currentUrl: "https://example.com",
      frames: [
        {
          image: "dGVzdA==",
          mimeType: "image/webp",
          width: 1280,
          height: 800,
          kind: "overview",
          sourceRegion: { x: 0, y: 0, width: 1280, height: 800 },
        },
        {
          image: "Y3JvcA==",
          mimeType: "image/png",
          width: 300,
          height: 200,
          kind: "region",
          sourceRegion: { x: 100, y: 100, width: 300, height: 200 },
        },
      ],
    });

    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("system");
    expect(messages[1].role).toBe("user");

    const content = messages[1].content;
    expect(content).toHaveLength(3); // text + 2 images
    expect(content[0].type).toBe("text");
    expect(content[0].text).toContain("OBJECTIVE: Click login button");
    expect(content[1].image_url.url).toContain("data:image/webp;base64,dGVzdA==");
    expect(content[1].image_url.detail).toBe("low");
    expect(content[2].image_url.url).toContain("data:image/png;base64,Y3JvcA==");
    expect(content[2].image_url.detail).toBe("high");
  });

  it("2. should parse markdown codeblocks and raw JSON into validated VisionDecision", () => {
    const adapter = new OpenAIVisionAdapter();

    // Raw JSON
    const res1 = adapter.parseResponse(
      JSON.stringify({
        type: "computer_action",
        action: { type: "click", x: 100, y: 200, button: "left" },
        certainty: "certain",
      })
    );
    expect(res1.type).toBe("computer_action");

    // Markdown fence
    const res2 = adapter.parseResponse(
      "```json\n" +
        JSON.stringify({
          type: "inspect_region",
          region: { x: 50, y: 50, width: 200, height: 200 },
          certainty: "uncertain",
        }) +
        "\n```"
    );
    expect(res2.type).toBe("inspect_region");
  });

  it("3. should execute live VisionAgent loop with mocked OpenAI fetch API", async () => {
    let callCount = 0;
    const mockFetch: typeof fetch = async (url, init) => {
      callCount++;
      const body = JSON.parse(init?.body as string);
      expect(body.model).toBe("gpt-4o-mini");
      expect(body.messages).toBeDefined();

      let content = "";
      if (callCount === 1) {
        content = JSON.stringify({
          type: "computer_action",
          action: { type: "click", x: 68, y: 151, button: "left" },
          certainty: "certain",
          intent: "click test button",
        });
      } else {
        content = JSON.stringify({
          type: "done",
          success: true,
          result: "Objective accomplished by OpenAI adapter",
        });
      }

      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content,
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    const adapter = new OpenAIVisionAdapter({
      apiKey: "sk-mock-key",
      fetchFn: mockFetch,
    });

    const agent = new VisionAgent({
      controller,
      model: adapter,
    });

    const result = await agent.run({
      objective: "Click target button",
      initialUrl: `${server.url}/interactive.html`,
      maxSteps: 5,
    });

    expect(result.success).toBe(true);
    expect(result.resultMessage).toBe("Objective accomplished by OpenAI adapter");
    expect(callCount).toBe(2);
    expect(result.metrics.modelCalls).toBe(2);
  });
});

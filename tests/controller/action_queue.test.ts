import { describe, it, expect, vi } from "vitest";
import { ActionQueue } from "../../src/controller.js";

describe("ActionQueue & Cancellation Architecture", () => {
  it("should execute actions in strict FIFO order", async () => {
    const queue = new ActionQueue();
    const executionOrder: number[] = [];

    const task1 = queue.run(async () => {
      await new Promise((r) => setTimeout(r, 40));
      executionOrder.push(1);
      return "res1";
    });

    const task2 = queue.run(async () => {
      await new Promise((r) => setTimeout(r, 20));
      executionOrder.push(2);
      return "res2";
    });

    const task3 = queue.run(async () => {
      executionOrder.push(3);
      return "res3";
    });

    const results = await Promise.all([task1, task2, task3]);

    expect(results).toEqual(["res1", "res2", "res3"]);
    expect(executionOrder).toEqual([1, 2, 3]);
  });

  it("should ensure only one action executes simultaneously (mutual exclusion)", async () => {
    const queue = new ActionQueue();
    let concurrentCount = 0;
    let maxConcurrent = 0;

    const createTask = (id: number) =>
      queue.run(async () => {
        concurrentCount++;
        maxConcurrent = Math.max(maxConcurrent, concurrentCount);
        await new Promise((r) => setTimeout(r, 25));
        concurrentCount--;
        return id;
      });

    const promises = [createTask(1), createTask(2), createTask(3), createTask(4)];
    const results = await Promise.all(promises);

    expect(results).toEqual([1, 2, 3, 4]);
    expect(maxConcurrent).toBe(1);
    expect(concurrentCount).toBe(0);
  });

  it("should signal AbortSignal to currently running action and cancel queued actions on abort()", async () => {
    const queue = new ActionQueue();
    let runningSignalAborted = false;

    // Running task that listens to AbortSignal
    const runningTask = queue.run(async (signal) => {
      const waitPromise = new Promise((resolve) => {
        const timeout = setTimeout(resolve, 2000);
        signal.addEventListener("abort", () => {
          clearTimeout(timeout);
          runningSignalAborted = true;
          resolve("aborted_cleanup");
        });
      });
      await waitPromise;
      if (signal.aborted) {
        throw { errorCode: "ACTION_CANCELLED", message: "Task was aborted" };
      }
      return "finished";
    });

    // Queued task waiting to run
    const queuedTask1 = queue.run(async () => {
      return "queued1";
    });

    const queuedTask2 = queue.run(async () => {
      return "queued2";
    });

    // Let runningTask start
    await new Promise((r) => setTimeout(r, 30));

    // Abort the queue
    queue.abort();

    // Verify running task
    const runningResult = await runningTask.catch((err) => err);
    expect(runningSignalAborted).toBe(true);
    expect(runningResult.errorCode).toBe("ACTION_CANCELLED");

    // Verify queued tasks rejected immediately with ACTION_CANCELLED
    const queued1Result = await queuedTask1.catch((err) => err);
    expect(queued1Result.errorCode).toBe("ACTION_CANCELLED");

    const queued2Result = await queuedTask2.catch((err) => err);
    expect(queued2Result.errorCode).toBe("ACTION_CANCELLED");
  });

  it("should never settle (resolve or reject) any promise twice", async () => {
    const queue = new ActionQueue();
    let settleCount = 0;

    const task = queue.run(async (signal) => {
      await new Promise((r) => setTimeout(r, 60));
      return "done";
    });

    task
      .then(() => settleCount++)
      .catch(() => settleCount++);

    // Abort while running
    await new Promise((r) => setTimeout(r, 20));
    queue.abort();

    await new Promise((r) => setTimeout(r, 80));

    expect(settleCount).toBe(1); // Settle count is strictly 1
  });

  it("should prevent unhandled rejections for cancelled tasks", async () => {
    const queue = new ActionQueue();
    const unhandledRejections: any[] = [];

    const onUnhandled = (reason: any) => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      const task1 = queue.run(async (signal) => {
        await new Promise((r) => setTimeout(r, 200));
        return "t1";
      });

      const task2 = queue.run(async () => {
        return "t2";
      });

      await new Promise((r) => setTimeout(r, 20));
      queue.abort();

      // Catch expectations cleanly
      await Promise.all([task1.catch(() => {}), task2.catch(() => {})]);
      await new Promise((r) => setTimeout(r, 50));

      expect(unhandledRejections.length).toBe(0);
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
    }
  });

  it("should be safely reusable after an intentional reset()", async () => {
    const queue = new ActionQueue();

    // 1. Run and abort first batch
    const t1 = queue.run(async () => {
      await new Promise((r) => setTimeout(r, 100));
      return "t1";
    });
    queue.abort();
    await t1.catch(() => {});

    // 2. Reset queue for reuse
    queue.reset();

    // 3. New tasks must execute successfully
    const t2 = queue.run(async () => {
      return "reused_success_1";
    });
    const t3 = queue.run(async () => {
      return "reused_success_2";
    });

    const [res2, res3] = await Promise.all([t2, t3]);
    expect(res2).toBe("reused_success_1");
    expect(res3).toBe("reused_success_2");
  });
});

import { describe, expect, it, vi } from "vite-plus/test";

/**
 * The SDK Container lives in the Workers runtime (it imports
 * cloudflare:workers), so this unit test replaces it with a fake whose
 * `start` mirrors the part of the contract under test: it builds a start
 * configuration and hands it to the raw container handle — possibly more
 * than once per logical start, like the SDK's internal retry loop.
 */
type RawStartConfig = {
  enableInternet?: boolean;
  env?: Record<string, string>;
  instance?: { vcpu: number; memoryMib: number; diskMb: number };
};

type TestEnvironment = Record<string, never>;

vi.mock("@cloudflare/containers", () => {
  class Container {
    constructor(
      public ctx: { container: { start: (config?: RawStartConfig) => void } },
      public env: TestEnvironment,
    ) {}

    async start(options: { envVars?: Record<string, string> } | undefined) {
      const config = { enableInternet: true, env: options?.envVars ?? {} };
      this.ctx.container.start(config);
      this.ctx.container.start(config);
    }
  }
  return { Container, getContainer: vi.fn<() => void>() };
});

import { InstanceSizedContainer } from "../src/instance-sized-container";

function containerHandle() {
  return {
    running: false,
    start: vi.fn<(config?: RawStartConfig) => void>(),
  };
}

function durableObjectState<const State extends object>(state: State): DurableObjectState<{}> {
  // SAFETY: this test double supplies exactly the ctx.container handle consumed by the code under test.
  return state as DurableObjectState<{}>;
}

class TestRunner extends InstanceSizedContainer<TestEnvironment> {
  startInstanceSized(instance: { vcpu: number; memoryMib: number; diskMb: number }) {
    return this.start({ envVars: { ACTIONS_RUNNER_JIT_CONFIG: "jit" }, instance });
  }
}

describe("InstanceSizedContainer", () => {
  it("merges the per-start instance resources into every raw container start", async () => {
    const handle = containerHandle();
    const startSpy = handle.start;
    const runner = new TestRunner(durableObjectState({ container: handle }), {});

    await runner.startInstanceSized({ vcpu: 2, memoryMib: 8192, diskMb: 16000 });

    expect(startSpy).toHaveBeenCalledTimes(2);
    for (const call of startSpy.mock.calls) {
      expect(call[0]).toMatchObject({
        enableInternet: true,
        env: { ACTIONS_RUNNER_JIT_CONFIG: "jit" },
        instance: { vcpu: 2, memoryMib: 8192, diskMb: 16000 },
      });
    }
  });

  it("does not leak the instance resources after the start settles", async () => {
    const handle = containerHandle();
    const startSpy = handle.start;
    const runner = new TestRunner(durableObjectState({ container: handle }), {});

    await runner.startInstanceSized({ vcpu: 1, memoryMib: 6144, diskMb: 12000 });
    startSpy.mockClear();

    // A raw start issued after the logical start has settled passes the
    // configuration through unchanged.
    handle.start({ enableInternet: true, env: { KEY: "value" } });

    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(startSpy.mock.calls[0]?.[0]).toEqual({ enableInternet: true, env: { KEY: "value" } });
  });
});

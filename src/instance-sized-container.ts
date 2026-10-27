import { Container } from "@cloudflare/containers";

/**
 * The per-start instance resources accepted by the raw Durable Object
 * `ctx.container.start()` API. The pinned `@cloudflare/containers` SDK does
 * not expose this option, although the platform types already define the
 * resource tuple as `ContainerStartResources`.
 */
export type ContainerInstanceSpec = ContainerStartResources;

type ContainerStartOptions = Parameters<Container["start"]>[0];
type ContainerWaitOptions = Parameters<Container["start"]>[1];

/** SDK start options plus the per-start instance resources. */
export type InstanceSizedStartOptions = ContainerStartOptions & {
  instance: ContainerInstanceSpec;
};

/** The raw start configuration, extended with the optional instance option. */
interface InstanceStartConfig extends ContainerStartupOptions {
  instance?: ContainerInstanceSpec;
}

function withInstance(
  config: ContainerStartupOptions,
  instance: ContainerInstanceSpec | undefined,
): InstanceStartConfig {
  return instance === undefined ? config : { ...config, instance };
}

/**
 * A `@cloudflare/containers` Container whose instance resources (vCPU,
 * memory, disk) are chosen per `start()` call, instead of being fixed per
 * container application in wrangler.jsonc.
 *
 * The SDK (0.3.x) only exposes per-instance overrides for `envVars`,
 * `entrypoint`, `enableInternet`, and `labels`, so this base class wraps the
 * underlying platform handle's `start()` and merges the requested instance
 * resources into whatever start configuration the SDK builds. The wrapper is
 * installed lazily on the first `start()` and the handle is a shared object
 * (`this.container === ctx.container`), so every SDK code path — including
 * its internal start retries and concurrent callers joining an in-flight
 * start — passes through it. No other handle behavior changes, and all SDK
 * lifecycle machinery (monitor, hibernation recovery, `sleepAfter`, DO
 * naming, `getState`) is preserved.
 */
export abstract class InstanceSizedContainer<Env = unknown> extends Container<Env> {
  private pendingInstance?: ContainerInstanceSpec;
  private startWrapperInstalled = false;

  override async start(startOptions: InstanceSizedStartOptions, waitOptions?: ContainerWaitOptions) {
    const { instance, ...sdkOptions } = startOptions;
    this.installStartWrapper();
    this.pendingInstance = instance;
    try {
      return await super.start(sdkOptions, waitOptions);
    } finally {
      this.pendingInstance = undefined;
    }
  }

  private installStartWrapper() {
    if (this.startWrapperInstalled) {
      return;
    }
    this.startWrapperInstalled = true;
    const handle = this.ctx.container;
    if (handle === undefined) {
      throw new Error("InstanceSizedContainer requires a Durable Object container context");
    }
    const originalStart = handle.start.bind(handle);
    handle.start = (config?: ContainerStartupOptions): void => {
      const pending = this.pendingInstance;
      originalStart(pending === undefined || config === undefined ? config : withInstance(config, pending));
    };
  }
}

import { describe, expect, it } from "vite-plus/test";

import { RUNNER_PROFILES } from "../src/runner-profiles";
import { DEFAULT_ACCOUNT_CAPACITY, fitsAccountCapacity } from "../src/scheduler-policy";

describe("account runner scheduler policy", () => {
  it("admits only requests that fit every account resource dimension", () => {
    expect(
      fitsAccountCapacity(
        { vcpu: 1_499, memoryMib: 6 * 1_024 * 1_024 - 6_144, diskMb: 30_000_000 - 12_000 },
        RUNNER_PROFILES["standard-2"],
      ),
    ).toBe(true);
    expect(fitsAccountCapacity({ vcpu: 1_499.5, memoryMib: 0, diskMb: 0 }, RUNNER_PROFILES["standard-2"])).toBe(false);
  });

  it("rejects a request that overflows any single reserved resource dimension", () => {
    expect(
      fitsAccountCapacity(
        {
          vcpu: DEFAULT_ACCOUNT_CAPACITY.vcpu - 3,
          memoryMib: DEFAULT_ACCOUNT_CAPACITY.memoryMib,
          diskMb: 0,
        },
        { vcpu: 2, memoryMib: 1, diskMb: 1 },
      ),
    ).toBe(false);
    expect(
      fitsAccountCapacity(
        {
          vcpu: DEFAULT_ACCOUNT_CAPACITY.vcpu,
          memoryMib: DEFAULT_ACCOUNT_CAPACITY.memoryMib - 1,
          diskMb: DEFAULT_ACCOUNT_CAPACITY.diskMb,
        },
        { vcpu: 1, memoryMib: 2, diskMb: 1 },
      ),
    ).toBe(false);
    expect(
      fitsAccountCapacity(
        {
          vcpu: DEFAULT_ACCOUNT_CAPACITY.vcpu,
          memoryMib: DEFAULT_ACCOUNT_CAPACITY.memoryMib,
          diskMb: DEFAULT_ACCOUNT_CAPACITY.diskMb - 1,
        },
        { vcpu: 1, memoryMib: 1, diskMb: 2 },
      ),
    ).toBe(false);
  });
});

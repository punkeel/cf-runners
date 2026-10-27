export interface ResourceVector {
  vcpu: number;
  memoryMib: number;
  diskMb: number;
}

/**
 * Total resources the account may reserve across every admitted runner. Each
 * active job reserves its full instance shape, and FIFO admission is gated on
 * these reserved totals through fitsAccountCapacity.
 */
export const DEFAULT_ACCOUNT_CAPACITY: Readonly<ResourceVector> = {
  vcpu: 1_500,
  memoryMib: 6 * 1_024 * 1_024,
  diskMb: 30_000_000,
};

export function fitsAccountCapacity(
  reserved: ResourceVector,
  requested: ResourceVector,
  limit: ResourceVector = DEFAULT_ACCOUNT_CAPACITY,
): boolean {
  return (
    reserved.vcpu + requested.vcpu <= limit.vcpu &&
    reserved.memoryMib + requested.memoryMib <= limit.memoryMib &&
    reserved.diskMb + requested.diskMb <= limit.diskMb
  );
}

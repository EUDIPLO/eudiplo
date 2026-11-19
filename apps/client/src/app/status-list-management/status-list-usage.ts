import type { StatusListResponseDto } from '@eudiplo/sdk-core';

/** Share of the list's entries in use, in percent. */
export function getUsagePercentage(list: StatusListResponseDto): number {
  return (list.usedEntries / list.capacity) * 100;
}

/** Material colour of the usage bar: warn from 90 %, accent from 70 %. */
export function getUsageColor(list: StatusListResponseDto): 'warn' | 'accent' | 'primary' {
  const percentage = getUsagePercentage(list);
  if (percentage >= 90) return 'warn';
  if (percentage >= 70) return 'accent';
  return 'primary';
}

/** Capacity in thousands or millions, such as "10.0K". */
export function formatCapacity(capacity: number): string {
  if (capacity >= 1000000) {
    return `${(capacity / 1000000).toFixed(1)}M`;
  }
  if (capacity >= 1000) {
    return `${(capacity / 1000).toFixed(1)}K`;
  }
  return capacity.toString();
}

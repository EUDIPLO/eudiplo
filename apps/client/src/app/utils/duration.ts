/** A duration in its largest whole unit, for example "24 hours" or "3 days". */
export function formatDuration(seconds: number): string {
  const units: [number, string][] = [
    [86_400, 'day'],
    [3_600, 'hour'],
    [60, 'minute'],
  ];
  for (const [size, unit] of units) {
    if (seconds >= size && seconds % size === 0) {
      const count = seconds / size;
      return `${count} ${unit}${count === 1 ? '' : 's'}`;
    }
  }
  return `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;
}

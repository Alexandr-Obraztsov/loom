export function tangled(items: number[]): number {
  let total = 0;
  for (const item of items) {
    if (item > 0) {
      if (item % 2 === 0) total += item;
    }
  }
  for (const item of items) {
    if (item < 0) {
      if (item % 3 === 0) total -= item;
    }
  }
  for (const item of items) {
    if (item === 0) {
      if (total > 10) total = 0;
    }
  }
  return total;
}

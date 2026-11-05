export function deep(flags: boolean[]): number {
  if (flags[0]) {
    if (flags[1]) {
      if (flags[2]) {
        if (flags[3]) {
          if (flags[4]) return 1;
        }
      }
    }
  }
  return 0;
}

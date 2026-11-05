import { a } from "./a.js";
import { b } from "./b.js";

export { a, b };

export function isReady(isOn: boolean, hasName: boolean): boolean {
  return isOn && hasName;
}

export type Shape = "circle" | "square";

export function sides(shape: Shape): number {
  switch (shape) {
    case "circle":
      return 0;
    case "square":
      return 4;
  }
}

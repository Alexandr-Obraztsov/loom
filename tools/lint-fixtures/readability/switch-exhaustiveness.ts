export type Kind = "a" | "b" | "c";

export function label(kind: Kind): string {
  switch (kind) {
    case "a":
      return "A";
    case "b":
      return "B";
  }
  return "?";
}

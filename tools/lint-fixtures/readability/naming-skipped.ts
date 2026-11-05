// Deliberately not reported: object-literal keys and type properties are data contracts (wire, manifests, plugin API).
export interface Flags {
  readonly multiple: boolean;
}

export const flags: Flags = { multiple: true };

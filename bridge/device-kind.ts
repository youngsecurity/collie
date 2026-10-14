/** Attribution provenance, separate from admission. A name alone is never an identity namespace. */
export type DeviceKind = "paired" | "header" | "anonymous";

/** Missing provenance is the legacy paired-device contract. Only an admitted crew caller supplies it. */
export function deviceKind(value: string | null): DeviceKind {
  return value === "header" || value === "anonymous" ? value : "paired";
}

import type { BoardConfig, EnumDef } from "@AiDailyTaks/shared";

const FALLBACK = "#64748b";

function lookup(defs: EnumDef[] | undefined, id: string | null | undefined): string {
  if (!defs || !id) return FALLBACK;
  const def = defs.find((d) => d.id === id);
  return def?.color ?? FALLBACK;
}

export function statusColor(config: BoardConfig | undefined, id: string | null | undefined): string {
  return lookup(config?.statuses, id);
}

export function categoryColor(config: BoardConfig | undefined, id: string | null | undefined): string {
  return lookup(config?.categories, id);
}

export function severityColor(config: BoardConfig | undefined, id: string | null | undefined): string {
  return lookup(config?.severities, id);
}

export function riskColor(config: BoardConfig | undefined, id: string | null | undefined): string {
  return lookup(config?.risks, id);
}

export type ColorKind = "status" | "category" | "severity" | "risk";

export function colorFor(
  config: BoardConfig | undefined,
  kind: ColorKind,
  id: string | null | undefined,
): string {
  switch (kind) {
    case "status":
      return statusColor(config, id);
    case "category":
      return categoryColor(config, id);
    case "severity":
      return severityColor(config, id);
    case "risk":
      return riskColor(config, id);
    default:
      return FALLBACK;
  }
}

/** Append an 8-bit alpha to a 6-digit hex color, e.g. tint("#3b82f6", 0.13). */
export function tint(hex: string, alpha: number): string {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return hex;
  const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255)
    .toString(16)
    .padStart(2, "0");
  return `${hex}${a}`;
}

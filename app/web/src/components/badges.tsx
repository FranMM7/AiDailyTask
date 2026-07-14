import type { ReactNode } from "react";
import type { Category, Level, Status } from "@AiDailyTasks/shared";
import { useConfig } from "@/api/hooks";
import { categoryColor, riskColor, severityColor, statusColor, tint } from "@/lib/colors";

function Pill({ color, children }: { color: string; children: ReactNode }) {
  return (
    <span
      className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium leading-none whitespace-nowrap"
      style={{ backgroundColor: tint(color, 0.16), color, borderColor: tint(color, 0.5) }}
    >
      {children}
    </span>
  );
}

function Dot({ color }: { color: string }) {
  return (
    <span
      className="mr-1 inline-block h-2 w-2 rounded-full"
      style={{ backgroundColor: color }}
    />
  );
}

export function StatusBadge({ status }: { status: Status }) {
  const { data: config } = useConfig();
  const color = statusColor(config, status);
  return (
    <Pill color={color}>
      <Dot color={color} />
      {status}
    </Pill>
  );
}

export function CategoryBadge({ category }: { category: Category }) {
  const { data: config } = useConfig();
  return <Pill color={categoryColor(config, category)}>{category}</Pill>;
}

export function LevelBadge({
  kind,
  level,
}: {
  kind: "severity" | "risk";
  level: Level;
}) {
  const { data: config } = useConfig();
  const color = kind === "severity" ? severityColor(config, level) : riskColor(config, level);
  return (
    <Pill color={color}>
      <span className="opacity-60">{kind === "risk" ? "risk" : "sev"}</span>
      <span className="ml-1">{level}</span>
    </Pill>
  );
}

export function InvalidBadge() {
  return (
    <span className="inline-flex items-center rounded-full border border-red-500/50 bg-red-500/15 px-2 py-0.5 text-xs font-semibold text-red-500">
      invalid
    </span>
  );
}

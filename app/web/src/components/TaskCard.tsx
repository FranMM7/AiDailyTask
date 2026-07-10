import { Paperclip, MessageSquare, AlertTriangle } from "lucide-react";
import type { TaskSummaryOrInvalid } from "@AiDailyTaks/shared";
import { useConfig } from "@/api/hooks";
import { useUiStore } from "@/store/ui";
import { categoryColor, severityColor } from "@/lib/colors";
import { useTaskDrawer } from "@/lib/navigation";
import { CategoryBadge, InvalidBadge, LevelBadge } from "./badges";

export function TaskCard({ task }: { task: TaskSummaryOrInvalid }) {
  const { data: config } = useConfig();
  const colorBy = useUiStore((s) => s.colorBy);
  const { openTask } = useTaskDrawer();

  if (!task.valid) {
    return (
      <button
        type="button"
        onClick={() => openTask(task.id)}
        className="w-full rounded-lg border border-red-500/40 bg-white p-3 text-left shadow-sm transition hover:shadow-md dark:bg-slate-900"
        style={{ borderLeftWidth: 4, borderLeftColor: "#ef4444" }}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-xs text-slate-500">{task.id}</span>
          <InvalidBadge />
        </div>
        <div className="mt-1 flex items-start gap-1 text-sm text-red-500">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span className="line-clamp-2">{task.parseError}</span>
        </div>
      </button>
    );
  }

  const accent =
    colorBy === "severity"
      ? severityColor(config, task.severity)
      : categoryColor(config, task.category);

  return (
    <button
      type="button"
      onClick={() => openTask(task.id)}
      className="w-full rounded-lg border border-slate-200 bg-white p-3 text-left shadow-sm transition hover:shadow-md dark:border-slate-800 dark:bg-slate-900"
      style={{ borderLeftWidth: 4, borderLeftColor: accent }}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-xs text-slate-500">{task.id}</span>
        <span className="text-[11px] text-slate-400">{task.project}</span>
      </div>
      <div className="mt-1 line-clamp-2 text-sm font-medium">{task.title}</div>

      <div className="mt-2 flex flex-wrap items-center gap-1">
        <CategoryBadge category={task.category} />
        <LevelBadge kind="severity" level={task.severity} />
      </div>

      {task.status_detail ? (
        <div className="mt-2 line-clamp-1 text-xs italic text-slate-500">{task.status_detail}</div>
      ) : null}

      <div className="mt-2 flex items-center gap-3 text-xs text-slate-400">
        {task.attachmentCount > 0 && (
          <span className="inline-flex items-center gap-1">
            <Paperclip size={12} />
            {task.attachmentCount}
          </span>
        )}
        {task.observationCount > 0 && (
          <span className="inline-flex items-center gap-1">
            <MessageSquare size={12} />
            {task.observationCount}
          </span>
        )}
      </div>
    </button>
  );
}

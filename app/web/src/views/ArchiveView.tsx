import { useMemo, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { RotateCcw } from "lucide-react";
import type { TaskFilter, TaskSummary } from "@AiDailyTasks/shared";
import { useTasks, useUnarchiveTask } from "@/api/hooks";
import { readFilter } from "@/lib/filters";
import { useTaskDrawer } from "@/lib/navigation";
import { CategoryBadge, LevelBadge } from "@/components/badges";

function fmtDate(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().slice(0, 10);
}

/** Archived tasks (completed and aged out, or archived by hand). Hidden from the other views; restorable. */
export function ArchiveView() {
  const [params] = useSearchParams();
  // Show ONLY archived tasks; ignore any status chips, but keep project/date/search filters.
  const filter = useMemo<TaskFilter>(
    () => ({ ...readFilter(params), archived: "only", status: undefined }),
    [params],
  );
  const { data, isLoading, isError } = useTasks(filter);
  const { openTask } = useTaskDrawer();
  const unarchive = useUnarchiveTask();

  if (isLoading) return <Msg>Loading archive…</Msg>;
  if (isError) return <Msg>Failed to load archive.</Msg>;

  const tasks = (data?.tasks ?? []).filter((t): t is TaskSummary => t.valid);

  return (
    <div className="h-full overflow-auto p-4">
      <p className="mb-3 text-xs text-slate-500">
        Completed tasks are archived automatically once their completion date ages out, and kept here.
        Restore brings one back to the Completed column.
      </p>
      <table className="w-full border-collapse text-sm">
        <thead className="sticky top-0 z-10 bg-slate-100 dark:bg-slate-900">
          <tr>
            {["ID", "Title", "Category", "Severity", "Completed", "Archived", ""].map((h) => (
              <th
                key={h}
                className="border-b border-slate-200 px-3 py-2 text-left font-semibold dark:border-slate-800"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {tasks.map((t) => (
            <tr
              key={t.id}
              className="border-b border-slate-100 hover:bg-slate-100 dark:border-slate-800/60 dark:hover:bg-slate-800/50"
            >
              <td className="cursor-pointer px-3 py-2 font-mono text-xs" onClick={() => openTask(t.id)}>
                {t.id}
              </td>
              <td className="cursor-pointer px-3 py-2 font-medium" onClick={() => openTask(t.id)}>
                {t.title}
              </td>
              <td className="px-3 py-2">
                <CategoryBadge category={t.category} />
              </td>
              <td className="px-3 py-2">
                <LevelBadge kind="severity" level={t.severity} />
              </td>
              <td className="px-3 py-2 text-xs text-slate-500">{fmtDate(t.completed)}</td>
              <td className="px-3 py-2 text-xs text-slate-500">{fmtDate(t.archived_at)}</td>
              <td className="px-3 py-2 text-right">
                <button
                  type="button"
                  disabled={unarchive.isPending}
                  onClick={() => unarchive.mutate({ id: t.id, baseRev: t.rev })}
                  className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-800"
                >
                  <RotateCcw size={12} /> Restore
                </button>
              </td>
            </tr>
          ))}
          {tasks.length === 0 && (
            <tr>
              <td colSpan={7} className="px-3 py-8 text-center text-slate-500">
                Nothing archived yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function Msg({ children }: { children: ReactNode }) {
  return <div className="p-8 text-center text-sm text-slate-500">{children}</div>;
}

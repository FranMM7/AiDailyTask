import { useMemo, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
  type DragEndEvent,
} from "@dnd-kit/core";
import type { Status, TaskSummary, TaskSummaryOrInvalid } from "@AiDailyTasks/shared";
import { useConfig, usePatchTask, useTasks } from "@/api/hooks";
import { readFilter } from "@/lib/filters";
import { TaskCard } from "@/components/TaskCard";

// Fallback cap for the Completed column when board.completedColumnLimit is unset.
const DEFAULT_COMPLETED_LIMIT = 10;

function DraggableCard({ task }: { task: TaskSummaryOrInvalid }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: task.id,
    disabled: !task.valid,
  });
  const style = transform
    ? {
        transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`,
        opacity: isDragging ? 0.6 : 1,
        zIndex: isDragging ? 50 : undefined,
      }
    : undefined;
  return (
    <div ref={setNodeRef} style={style} {...listeners} {...attributes} className="touch-none">
      <TaskCard task={task} />
    </div>
  );
}

function Column({
  status,
  color,
  tasks,
  count,
  footer,
}: {
  status: string;
  color: string;
  tasks: TaskSummaryOrInvalid[];
  /** Total in this bucket; defaults to tasks.length. Differs when the column is capped. */
  count?: number;
  footer?: ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  return (
    <div className="flex w-72 shrink-0 flex-col">
      <div className="mb-2 flex items-center gap-2 px-1">
        <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: color }} />
        <span className="text-sm font-semibold">{status}</span>
        <span className="text-xs text-slate-400">{count ?? tasks.length}</span>
      </div>
      <div
        ref={setNodeRef}
        className={`flex min-h-24 flex-1 flex-col gap-2 rounded-lg p-2 transition ${
          isOver ? "bg-blue-500/10 ring-2 ring-blue-500/40" : "bg-slate-200/40 dark:bg-slate-900/40"
        }`}
      >
        {tasks.map((t) => (
          <DraggableCard key={t.id} task={t} />
        ))}
        {footer}
      </div>
    </div>
  );
}

/** Day key used to order Completed cards newest-first (completed date, else last-updated). */
function completedRecencyKey(t: TaskSummary): string {
  return (t.completed || t.updatedEffective || t.updated || "").slice(0, 10);
}

export function BoardView() {
  const [params] = useSearchParams();
  // Archived tasks are hidden from the board — they live in the Archive tab. Keeping the
  // board's default "exclude" means the auto-archive sweep quietly clears aged-out Completed
  // cards off the board.
  const filter = useMemo(
    () => ({ ...readFilter(params), archived: "exclude" as const }),
    [params],
  );
  const { data: config } = useConfig();
  const { data, isLoading, isError } = useTasks(filter);
  const patch = usePatchTask();

  const completedLimit = config?.board?.completedColumnLimit ?? DEFAULT_COMPLETED_LIMIT;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  // Backlog has its own tab and stays off the board by default; Settings can opt it into
  // the Kanban alongside any other configured, non-hidden status.
  const statusDefs = useMemo(() => {
    const hidden = new Set(config?.board?.hiddenColumns ?? []);
    const defs = (config?.statuses ?? []).filter(
      (s) => !hidden.has(s.id) && (s.id !== "Backlog" || config?.board?.showBacklogColumn),
    );
    return [...defs].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }, [config]);

  const { byStatus, invalid } = useMemo(() => {
    const map = new Map<string, TaskSummaryOrInvalid[]>();
    for (const s of config?.statuses ?? []) map.set(s.id, []);
    const inv: TaskSummaryOrInvalid[] = [];
    for (const t of data?.tasks ?? []) {
      if (!t.valid) {
        inv.push(t);
        continue;
      }
      const arr = map.get(t.status);
      if (arr) arr.push(t);
      else map.set(t.status, [t]);
    }
    // Completed can grow without bound; show only the most-recent cards so it stays compact.
    // The rest remain reachable in the Table/Archive views (and auto-archive after the window).
    const completed = (map.get("Completed") ?? []).filter(
      (t): t is TaskSummary => t.valid,
    );
    completed.sort((a, b) => completedRecencyKey(b).localeCompare(completedRecencyKey(a)));
    map.set("Completed", completed);
    return { byStatus: map, invalid: inv };
  }, [config?.statuses, data]);

  const onDragEnd = (e: DragEndEvent) => {
    const overId = e.over?.id;
    if (!overId) return;
    const newStatus = String(overId) as Status;
    const task = data?.tasks.find((t) => t.id === e.active.id);
    if (!task || !task.valid) return;
    if (task.status === newStatus) return;
    patch.mutate({
      id: task.id,
      body: { baseRev: task.rev, fields: { status: newStatus } },
    });
  };

  if (isLoading) return <ViewMessage>Loading board…</ViewMessage>;
  if (isError) return <ViewMessage>Failed to load tasks.</ViewMessage>;

  return (
    <div className="h-full overflow-x-auto p-4">
      <DndContext sensors={sensors} onDragEnd={onDragEnd}>
        {/* w-max + mx-auto centers the columns when they fit, yet stays fully scrollable
            (left column reachable) if they ever overflow the viewport. */}
        <div className="mx-auto flex h-full w-max gap-4">
          {statusDefs.map((s) => {
            const all = byStatus.get(s.id) ?? [];
            if (s.id !== "Completed") {
              return <Column key={s.id} status={s.id} color={s.color} tasks={all} />;
            }
            const shown = all.slice(0, completedLimit);
            const hidden = all.length - shown.length;
            return (
              <Column
                key={s.id}
                status={s.id}
                color={s.color}
                tasks={shown}
                count={all.length}
                footer={
                  hidden > 0 ? (
                    <Link
                      to="/table?status=Completed&sort=completed&order=desc"
                      className="rounded-md px-2 py-1.5 text-center text-xs text-slate-500 hover:bg-slate-200/60 hover:text-slate-700 dark:hover:bg-slate-800/60 dark:hover:text-slate-200"
                    >
                      +{hidden} older completed → view all
                    </Link>
                  ) : undefined
                }
              />
            );
          })}
          {invalid.length > 0 && (
            <div className="flex w-72 shrink-0 flex-col">
              <div className="mb-2 flex items-center gap-2 px-1">
                <span className="inline-block h-2.5 w-2.5 rounded-full bg-red-500" />
                <span className="text-sm font-semibold">Invalid</span>
                <span className="text-xs text-slate-400">{invalid.length}</span>
              </div>
              <div className="flex flex-1 flex-col gap-2 rounded-lg bg-red-500/5 p-2">
                {invalid.map((t) => (
                  <TaskCard key={t.id} task={t} />
                ))}
              </div>
            </div>
          )}
        </div>
      </DndContext>
    </div>
  );
}

function ViewMessage({ children }: { children: ReactNode }) {
  return <div className="p-8 text-center text-sm text-slate-500">{children}</div>;
}

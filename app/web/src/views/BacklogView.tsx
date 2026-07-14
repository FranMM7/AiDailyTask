import { useMemo, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import type { Status } from "@AiDailyTasks/shared";
import { useTasks } from "@/api/hooks";
import { readFilter } from "@/lib/filters";
import { TaskCard } from "@/components/TaskCard";

const BACKLOG: Status[] = ["Backlog"];

/** Parked work: tasks whose status is Backlog, kept off the active board so "Not started" stays lean. */
export function BacklogView() {
  const [params] = useSearchParams();
  // Force status = Backlog; other URL filters (project, date, search) still apply.
  const filter = useMemo(() => ({ ...readFilter(params), status: BACKLOG }), [params]);
  const { data, isLoading, isError } = useTasks(filter);

  if (isLoading) return <Msg>Loading backlog…</Msg>;
  if (isError) return <Msg>Failed to load backlog.</Msg>;

  const tasks = (data?.tasks ?? []).filter((t) => t.valid);

  if (tasks.length === 0) {
    return (
      <Msg>
        Nothing in the backlog. Set a task&apos;s status to <strong>Backlog</strong> to park it here,
        away from the active board.
      </Msg>
    );
  }

  return (
    <div className="h-full overflow-auto p-4">
      <div className="grid grid-cols-[repeat(auto-fill,minmax(18rem,1fr))] gap-3">
        {tasks.map((t) => (
          <TaskCard key={t.id} task={t} />
        ))}
      </div>
    </div>
  );
}

function Msg({ children }: { children: ReactNode }) {
  return <div className="p-8 text-center text-sm text-slate-500">{children}</div>;
}

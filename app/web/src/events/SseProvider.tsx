import { useEffect, useRef, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { SseEvent, TaskSummaryOrInvalid } from "@AiDailyTaks/shared";
import { useUiStore } from "@/store/ui";
import type { TaskResponse, TasksResponse } from "@/api/hooks";

const SSE_TYPES: SseEvent["type"][] = [
  "hello",
  "task.created",
  "task.updated",
  "task.deleted",
  "task.invalid",
  "attachments.changed",
  "config.updated",
];

/** Read the currently-cached rev for a task (detail first, then any summary). */
function cachedRev(
  qc: ReturnType<typeof useQueryClient>,
  id: string,
): number | undefined {
  const detail = qc.getQueryData<TaskResponse>(["task", id]);
  if (detail?.task?.rev !== undefined) return detail.task.rev;
  const lists = qc.getQueriesData<TasksResponse>({ queryKey: ["tasks"] });
  for (const [, data] of lists) {
    const found = data?.tasks.find((t) => t.id === id);
    if (found) return found.rev;
  }
  return undefined;
}

export function SseProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const setSseStatus = useUiStore((s) => s.setSseStatus);

  const sourceRef = useRef<EventSource | null>(null);
  const backoffRef = useRef(1000);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closedRef = useRef(false);

  useEffect(() => {
    closedRef.current = false;

    const handle = (raw: MessageEvent) => {
      let evt: SseEvent;
      try {
        evt = JSON.parse(raw.data) as SseEvent;
      } catch {
        return;
      }
      switch (evt.type) {
        case "hello":
          break;
        case "task.created": {
          const summary: TaskSummaryOrInvalid = evt.task;
          qc.setQueriesData<TasksResponse>({ queryKey: ["tasks"] }, (old) =>
            old && !old.tasks.some((t) => t.id === summary.id)
              ? { tasks: [...old.tasks, summary] }
              : old,
          );
          void qc.invalidateQueries({ queryKey: ["tasks"] });
          void qc.invalidateQueries({ queryKey: ["graph"] });
          break;
        }
        case "task.updated": {
          // ignore our own echo: the cache already holds this rev
          if (cachedRev(qc, evt.id) === evt.rev) break;
          void qc.invalidateQueries({ queryKey: ["task", evt.id] });
          void qc.invalidateQueries({ queryKey: ["tasks"] });
          void qc.invalidateQueries({ queryKey: ["graph"] });
          break;
        }
        case "task.deleted": {
          qc.removeQueries({ queryKey: ["task", evt.id] });
          void qc.invalidateQueries({ queryKey: ["tasks"] });
          void qc.invalidateQueries({ queryKey: ["graph"] });
          break;
        }
        case "task.invalid": {
          void qc.invalidateQueries({ queryKey: ["task", evt.id] });
          void qc.invalidateQueries({ queryKey: ["tasks"] });
          break;
        }
        case "attachments.changed": {
          void qc.invalidateQueries({ queryKey: ["attachments", evt.id] });
          void qc.invalidateQueries({ queryKey: ["task", evt.id] });
          break;
        }
        case "config.updated": {
          void qc.invalidateQueries({ queryKey: ["config"] });
          break;
        }
      }
    };

    const connect = () => {
      if (closedRef.current) return;
      setSseStatus("connecting");
      const es = new EventSource("/api/events");
      sourceRef.current = es;

      es.onopen = () => {
        backoffRef.current = 1000;
        setSseStatus("open");
        // (re)connect: refetch everything so we never miss an edit made while offline
        void qc.invalidateQueries();
      };

      for (const type of SSE_TYPES) es.addEventListener(type, handle as EventListener);
      // also accept unnamed default messages defensively
      es.onmessage = handle;

      es.onerror = () => {
        setSseStatus("error");
        es.close();
        if (closedRef.current) return;
        const delay = backoffRef.current;
        backoffRef.current = Math.min(backoffRef.current * 2, 30000);
        reconnectTimer.current = setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      closedRef.current = true;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      sourceRef.current?.close();
      sourceRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <>{children}</>;
}

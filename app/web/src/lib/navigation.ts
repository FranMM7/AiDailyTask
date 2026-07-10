import { useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import { normalizeId } from "@AiDailyTaks/shared";

/** Returns helpers to open / close the global task drawer via the ?task= param. */
export function useTaskDrawer() {
  const [params, setParams] = useSearchParams();

  const openTask = useCallback(
    (id: string) => {
      const next = new URLSearchParams(params);
      next.set("task", normalizeId(id));
      setParams(next);
    },
    [params, setParams],
  );

  const closeTask = useCallback(() => {
    const next = new URLSearchParams(params);
    next.delete("task");
    setParams(next);
  }, [params, setParams]);

  const openTaskId = params.get("task");

  return { openTask, closeTask, openTaskId };
}

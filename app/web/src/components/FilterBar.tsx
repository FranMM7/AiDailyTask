import { WorkflowPanels } from "./WorkflowPanels";
import { ActionFilters } from "./ActionFilters";
import { useEffect, useState, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useSearchParams } from "react-router-dom";
import { SlidersHorizontal, X } from "lucide-react";
import { orderedDefs } from "@AiDailyTasks/shared";
import { useConfig } from "@/api/hooks";
import { toggleParam, setParam } from "@/lib/filters";
import { tint } from "@/lib/colors";

interface ChipGroupProps {
  paramKey: string;
  options: { id: string; color: string }[];
}

function ChipGroup({ paramKey, options }: ChipGroupProps) {
  const [params, setParams] = useSearchParams();
  const active = new Set(params.getAll(paramKey));

  return (
    <div className="flex flex-wrap items-center gap-1">
      {options.map((opt) => {
        const isActive = active.has(opt.id);
        return (
          <button
            key={opt.id}
            type="button"
            aria-pressed={isActive}
            onClick={() => setParams(toggleParam(params, paramKey, opt.id), { replace: true })}
            className="rounded-full border px-2 py-0.5 text-xs font-medium transition"
            style={
              isActive
                ? { backgroundColor: tint(opt.color, 0.22), color: opt.color, borderColor: opt.color }
                : { borderColor: "transparent", color: "inherit" }
            }
          >
            {opt.id}
          </button>
        );
      })}
    </div>
  );
}

export function FilterBar() {
  const { data: config } = useConfig();
  const [params, setParams] = useSearchParams();
  const [open, setOpen] = useState(false);
  const task = params.get("task");
  useEffect(() => { if (task) setOpen(false); }, [task]);

  if (!config) return null;

  const filterKeys = ["priority", "next_action_owner", "next_action_date_from", "next_action_date_to",
    "has_next_action", "action_undated", "include_closed", "status", "category", "severity",
    "q", "project", "archived", "tag", "dateField", "dateFrom", "dateTo"];
  const activeCount = filterKeys.filter(key => !!params.get(key)).length;
  const hasFilters = activeCount > 0;

  const clearAll = () => {
    const next = new URLSearchParams(params);
    for(const key of ["priority","next_action_owner","next_action_date_from","next_action_date_to","has_next_action","action_undated","include_closed"]) next.delete(key);
    next.delete("q");
    next.delete("project");
    next.delete("archived");
    next.delete("status");
    next.delete("category");
    next.delete("severity");
    next.delete("tag");
    next.delete("dateField");
    next.delete("dateFrom");
    next.delete("dateTo");
    setParams(next, { replace: true });
  };

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button type="button" className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-sm ${hasFilters ? "border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-200" : "border-slate-300 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"}`}>
          <SlidersHorizontal size={15} /> Filters {hasFilters && <span className="rounded-full bg-blue-600 px-1.5 text-xs text-white">{activeCount}</span>}
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[90dvh] w-[calc(100%-2rem)] max-w-3xl -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-slate-200 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-900">
          <div className="flex items-start justify-between border-b border-slate-200 p-5 dark:border-slate-700">
            <div><Dialog.Title className="text-lg font-semibold">Filters & activity</Dialog.Title>
              <Dialog.Description className="mt-1 text-sm text-slate-500">Narrow your tasks or review recent activity. Filters apply as you choose.</Dialog.Description></div>
            <Dialog.Close aria-label="Close filters" className="rounded p-1 hover:bg-slate-100 dark:hover:bg-slate-800"><X size={20}/></Dialog.Close>
          </div>
          <div className="space-y-5 overflow-y-auto p-5 text-slate-600 dark:text-slate-300">
      <FilterSection label="Next actions"><ActionFilters /></FilterSection>
      <FilterSection label="Status">
        <ChipGroup paramKey="status" options={orderedDefs(config.statuses)} />
      </FilterSection>
      <FilterSection label="Category">
        <ChipGroup paramKey="category" options={config.categories} />
      </FilterSection>
      <FilterSection label="Severity">
        <ChipGroup paramKey="severity" options={config.severities} />
      </FilterSection>
      <FilterSection label="Date">
        <DateRangeFilter />
      </FilterSection>
      <FilterSection label="Activity"><WorkflowPanels onNavigate={() => setOpen(false)} /></FilterSection>
          </div>
          <div className="flex items-center justify-between border-t border-slate-200 p-4 dark:border-slate-700">
      {hasFilters && (
        <button
          type="button"
          onClick={clearAll}
          className="inline-flex items-center gap-1 rounded px-2 py-1 text-sm text-slate-500 hover:text-slate-900 dark:hover:text-white"
        >
          <X size={12} /> Clear filters
        </button>
      )}
          <Dialog.Close className="ml-auto rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">Done</Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Filter active tasks by a date field (created/updated/completed) within an inclusive [from, to] range. */
function DateRangeFilter() {
  const [params, setParams] = useSearchParams();
  const mode = params.get("dateField") ?? "";
  const from = params.get("dateFrom") ?? "";
  const to = params.get("dateTo") ?? "";
  const effectiveMode = mode || "updated";

  const update = (key: "dateField" | "dateFrom" | "dateTo", value: string) => {
    let next = setParam(params, key, value);
    // Setting a bound with no field chosen yet would not filter — pin the field so it takes effect.
    if ((key === "dateFrom" || key === "dateTo") && value && !next.get("dateField")) {
      next = setParam(next, "dateField", effectiveMode);
    }
    setParams(next, { replace: true });
  };

  const clear = () => {
    let next = setParam(params, "dateField", "");
    next = setParam(next, "dateFrom", "");
    next = setParam(next, "dateTo", "");
    setParams(next, { replace: true });
  };

  const hasRange = Boolean(mode || from || to);
  const inputCls =
    "rounded-md border border-slate-300 bg-transparent px-1.5 py-0.5 text-xs outline-none focus:border-blue-500 dark:border-slate-700";

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <select
        value={effectiveMode}
        onChange={(e) => update("dateField", e.target.value)}
        className={inputCls}
        aria-label="Date field"
      >
        <option value="created">Created</option>
        <option value="updated">Updated</option>
        <option value="completed">Completed</option>
      </select>
      <input
        type="date"
        value={from}
        max={to || undefined}
        onChange={(e) => update("dateFrom", e.target.value)}
        className={inputCls}
        aria-label="From date"
      />
      <span className="text-xs text-slate-400">→</span>
      <input
        type="date"
        value={to}
        min={from || undefined}
        onChange={(e) => update("dateTo", e.target.value)}
        className={inputCls}
        aria-label="To date"
      />
      {hasRange && (
        <button
          type="button"
          onClick={clear}
          title="Clear date filter"
          className="text-slate-400 hover:text-slate-700 dark:hover:text-white"
        >
          <X size={12} />
        </button>
      )}
    </div>
  );
}

function FilterSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
        {label}
      </span>
      {children}
    </div>
  );
}

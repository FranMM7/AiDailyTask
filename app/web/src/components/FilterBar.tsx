import type { ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { X } from "lucide-react";
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

  if (!config) return null;

  const hasFilters =
    params.getAll("status").length > 0 ||
    params.getAll("category").length > 0 ||
    params.getAll("severity").length > 0 ||
    !!params.get("tag") ||
    !!params.get("dateField") ||
    !!params.get("dateFrom") ||
    !!params.get("dateTo");

  const clearAll = () => {
    const next = new URLSearchParams(params);
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
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-slate-200 bg-slate-50 px-4 py-2 text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300">
      <FilterSection label="Status">
        <ChipGroup paramKey="status" options={config.statuses} />
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
      {hasFilters && (
        <button
          type="button"
          onClick={clearAll}
          className="ml-auto inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs text-slate-500 hover:text-slate-900 dark:hover:text-white"
        >
          <X size={12} /> Clear
        </button>
      )}
    </div>
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
    <div className="flex items-center gap-1.5">
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
    <div className="flex items-center gap-2">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
        {label}
      </span>
      {children}
    </div>
  );
}

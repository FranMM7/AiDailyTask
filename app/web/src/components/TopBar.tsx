import { useEffect, useState } from "react";
import { NavLink, useSearchParams } from "react-router-dom";
import {
  LayoutGrid,
  Inbox,
  Table2,
  Share2,
  Waypoints,
  Archive,
  BarChart3,
  Plug,
  Search,
  Download,
  Plus,
  FolderPlus,
  FolderCog,
  Moon,
  Sun,
} from "lucide-react";
import { useConfig } from "@/api/hooks";
import { useUiStore } from "@/store/ui";
import { ExportDialog } from "./ExportDialog";
import { NewTaskDialog } from "./NewTaskDialog";
import { AddProjectDialog } from "./AddProjectDialog";

const NAV = [
  { to: "/", label: "Board", icon: LayoutGrid, end: true },
  { to: "/backlog", label: "Backlog", icon: Inbox, end: false },
  { to: "/table", label: "Table", icon: Table2, end: false },
  { to: "/graph", label: "Graph", icon: Share2, end: false },
  { to: "/code-graph", label: "Code map", icon: Waypoints, end: false },
  { to: "/projects", label: "Projects", icon: FolderCog, end: false },
  { to: "/archive", label: "Archive", icon: Archive, end: false },
  { to: "/stats", label: "Stats", icon: BarChart3, end: false },
  { to: "/connect", label: "Connect", icon: Plug, end: false },
];

function SseDot() {
  const status = useUiStore((s) => s.sseStatus);
  const color =
    status === "open" ? "#22c55e" : status === "connecting" ? "#eab308" : "#ef4444";
  const label =
    status === "open" ? "Live" : status === "connecting" ? "Connecting…" : "Disconnected";
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-slate-500" title={label}>
      <span
        className="inline-block h-2.5 w-2.5 rounded-full"
        style={{ backgroundColor: color, boxShadow: `0 0 6px ${color}` }}
      />
      <span className="hidden sm:inline">{label}</span>
    </span>
  );
}

export function TopBar() {
  const { data: config } = useConfig();
  const [params, setParams] = useSearchParams();
  const { theme, toggleTheme } = useUiStore();
  const [exportOpen, setExportOpen] = useState(false);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [addProjectOpen, setAddProjectOpen] = useState(false);

  // debounced search box synced to ?q
  const [q, setQ] = useState(params.get("q") ?? "");
  useEffect(() => {
    setQ(params.get("q") ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.get("q")]);
  useEffect(() => {
    const t = setTimeout(() => {
      const current = params.get("q") ?? "";
      if (q === current) return;
      const next = new URLSearchParams(params);
      if (q) next.set("q", q);
      else next.delete("q");
      setParams(next, { replace: true });
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const project = params.get("project") ?? "All";
  const onProject = (value: string) => {
    const next = new URLSearchParams(params);
    if (value === "All") next.delete("project");
    else next.set("project", value);
    setParams(next, { replace: true });
  };

  return (
    <header className="flex flex-wrap items-center gap-3 border-b border-slate-200 bg-white px-4 py-2 dark:border-slate-800 dark:bg-slate-950">
      <div className="flex items-center gap-2">
        <span className="text-lg font-bold tracking-tight">AiDailyTasks</span>
      </div>

      <nav className="flex items-center gap-1">
        {NAV.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={{ pathname: to, search: window.location.search }}
            end={end}
            className={({ isActive }) =>
              `inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm font-medium transition ${
                isActive
                  ? "bg-blue-600 text-white"
                  : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
              }`
            }
          >
            <Icon size={15} />
            <span className="hidden sm:inline">{label}</span>
          </NavLink>
        ))}
      </nav>

      <div className="ml-auto flex flex-wrap items-center gap-2">
        <label className="relative">
          <Search
            size={14}
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-slate-400"
          />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search…"
            className="w-40 rounded-md border border-slate-300 bg-transparent py-1.5 pl-7 pr-2 text-sm outline-none focus:border-blue-500 dark:border-slate-700 sm:w-56"
          />
        </label>

        <button
          type="button"
          onClick={() => setNewTaskOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-2.5 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
        >
          <Plus size={15} />
          <span className="hidden sm:inline">New task</span>
        </button>

        <div className="flex items-center">
          <select
            value={project}
            onChange={(e) => onProject(e.target.value)}
            className="rounded-md border border-slate-300 bg-transparent py-1.5 px-2 text-sm outline-none focus:border-blue-500 dark:border-slate-700"
          >
            <option value="All">All projects</option>
            {config?.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => setAddProjectOpen(true)}
            title="Add project"
            className="ml-1 rounded-md border border-slate-300 p-1.5 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
          >
            <FolderPlus size={15} />
          </button>
        </div>

        <button
          type="button"
          onClick={() => setExportOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-2.5 py-1.5 text-sm hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
        >
          <Download size={15} />
          <span className="hidden sm:inline">Export</span>
        </button>

        <button
          type="button"
          onClick={toggleTheme}
          title="Toggle theme"
          className="rounded-md border border-slate-300 p-1.5 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
        >
          {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
        </button>

        <SseDot />
      </div>

      <ExportDialog open={exportOpen} onOpenChange={setExportOpen} />
      <NewTaskDialog open={newTaskOpen} onOpenChange={setNewTaskOpen} />
      <AddProjectDialog open={addProjectOpen} onOpenChange={setAddProjectOpen} />
    </header>
  );
}

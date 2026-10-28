import { useEffect, useRef, useState } from "react";
import { NavLink, useLocation, useSearchParams } from "react-router-dom";
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
  Settings,
  Plus,
  FolderPlus,
  FolderCog,
  Moon,
  Sun,
  BookOpen,
} from "lucide-react";
import { useConfig } from "@/api/hooks";
import { useUiStore } from "@/store/ui";
import { ExportDialog } from "./ExportDialog";
import { NewTaskDialog } from "./NewTaskDialog";
import { AddProjectDialog } from "./AddProjectDialog";
import { FilterBar } from "./FilterBar";
import { ShareDialog } from "./ShareDialog";

const NAV = [
  { to: "/", label: "Board", icon: LayoutGrid, end: true },
  { to: "/backlog", label: "Backlog", icon: Inbox, end: false },
  { to: "/table", label: "Table", icon: Table2, end: false },
  { to: "/resources", label: "Resources", icon: BookOpen, end: false },
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
  const location = useLocation();
  const { theme, toggleTheme } = useUiStore();
  const [exportOpen, setExportOpen] = useState(false);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [addProjectOpen, setAddProjectOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const searchInput = useRef<HTMLInputElement>(null);

  // Navigation cancels pending input so a delayed search cannot undo a reset.
  const [q, setQ] = useState(params.get("q") ?? "");
  const searchTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    clearTimeout(searchTimer.current);
    setQ(new URLSearchParams(location.search).get("q") ?? "");
    return () => clearTimeout(searchTimer.current);
  }, [location.key, location.search]);

  const onSearch = (value: string) => {
    setQ(value);
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      setParams((current) => {
        const next = new URLSearchParams(current);
        if (value) next.set("q", value);
        else next.delete("q");
        return next;
      }, { replace: true });
    }, 250);
  };
  useEffect(() => {
    if (searchOpen) requestAnimationFrame(() => searchInput.current?.focus());
  }, [searchOpen]);

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

      <nav className="flex max-w-full flex-wrap items-center gap-1">
        {NAV.filter((item) => !(config?.navigation?.hiddenTabs ?? []).includes(item.to)).map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={{ pathname: to, search: to === "/" ? "" : location.search }}
            aria-label={label}
            title={to === "/" ? "Board - reset filters" : label}
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
        <div className={`relative flex items-center overflow-hidden transition-[width] duration-200 ease-out ${searchOpen ? "w-48 sm:w-56" : "w-8"}`}>
          <button type="button" onClick={() => setSearchOpen((open) => !open)} title="Search tasks" aria-label="Search tasks" aria-expanded={searchOpen} className="absolute left-0 z-10 rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-100">
            <Search size={15} />
          </button>
          <input
            ref={searchInput}
            value={q}
            onChange={(e) => onSearch(e.target.value)}
            onBlur={() => { if (!q) setSearchOpen(false); }}
            onKeyDown={(e) => { if (e.key === "Escape") { setSearchOpen(false); searchInput.current?.blur(); } }}
            placeholder="Search tasks…"
            tabIndex={searchOpen ? 0 : -1}
            className={`h-8 w-full rounded-md border border-slate-300 bg-transparent py-1.5 pl-8 pr-2 text-sm outline-none transition-opacity focus:border-blue-500 dark:border-slate-700 ${searchOpen ? "opacity-100" : "pointer-events-none opacity-0"}`}
          />
        </div>
        {/* Search is intentionally collapsed by default so the board toolbar has room for actions. */}
        <FilterBar />
        {false && <label className="relative">
          <Search
            size={14}
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-slate-400"
          />
          <input
            value={q}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="Search…"
            className="w-40 rounded-md border border-slate-300 bg-transparent py-1.5 pl-7 pr-2 text-sm outline-none focus:border-blue-500 dark:border-slate-700 sm:w-56"
          />
        </label>}

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

        <ShareDialog />
        <button
          type="button"
          onClick={() => setExportOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-2.5 py-1.5 text-sm hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
        >
          <Download size={15} />
          <span className="hidden sm:inline">Export</span>
        </button>

        <NavLink
          to={{ pathname: "/settings", search: window.location.search }}
          title="Settings"
          aria-label="Settings"
          className={({ isActive }) =>
            `rounded-md border p-1.5 transition ${
              isActive
                ? "border-blue-600 bg-blue-600 text-white"
                : "border-slate-300 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
            }`
          }
        >
          <Settings size={16} />
        </NavLink>

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

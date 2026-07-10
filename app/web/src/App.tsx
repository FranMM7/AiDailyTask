import { useEffect } from "react";
import { Link, Route, Routes } from "react-router-dom";
import { useConfig } from "@/api/hooks";
import { useUiStore } from "@/store/ui";
import { TopBar } from "@/components/TopBar";
import { FilterBar } from "@/components/FilterBar";
import { TaskDrawer } from "@/components/TaskDrawer";
import { Toaster } from "@/components/Toaster";
import { BoardView } from "@/views/BoardView";
import { TableView } from "@/views/TableView";
import { GraphView } from "@/views/GraphView";
import { BacklogView } from "@/views/BacklogView";
import { ArchiveView } from "@/views/ArchiveView";
import { StatsView } from "@/views/StatsView";
import { McpConfigView } from "@/views/McpConfigView";

function NotFound() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-slate-500">
      <p className="text-lg font-semibold">Page not found</p>
      <Link to="/" className="text-blue-500 underline">
        Back to board
      </Link>
    </div>
  );
}

export default function App() {
  const { data: config } = useConfig();
  const theme = useUiStore((s) => s.theme);
  const seedColorBy = useUiStore((s) => s.seedColorBy);

  // apply theme class to <html>
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "dark") root.classList.add("dark");
    else root.classList.remove("dark");
  }, [theme]);

  // seed colorBy from config once
  useEffect(() => {
    if (config) seedColorBy(config.card.colorBy);
  }, [config, seedColorBy]);

  return (
    <div className="flex h-full flex-col">
      <TopBar />
      <FilterBar />
      <main className="min-h-0 flex-1">
        <Routes>
          <Route path="/" element={<BoardView />} />
          <Route path="/backlog" element={<BacklogView />} />
          <Route path="/table" element={<TableView />} />
          <Route path="/graph" element={<GraphView />} />
          <Route path="/archive" element={<ArchiveView />} />
          <Route path="/stats" element={<StatsView />} />
          <Route path="/connect" element={<McpConfigView />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
      <TaskDrawer />
      <Toaster />
    </div>
  );
}

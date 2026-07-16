import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { BookOpen, CheckCircle2, Folder, Loader2, Network, Save, Upload } from "lucide-react";
import type { CodeGraphIndexer, ProjectDef } from "@AiDailyTasks/shared";
import {
  useCodeGraph, useConfig, useGenerateCodeGraph, useImportProjectReadme,
  useProjectDocumentation, useUpdateProject, useUpdateProjectDocumentation,
} from "@/api/hooks";
import { MarkdownView } from "@/components/MarkdownView";
import { toast } from "@/store/toast";

const inputCls = "w-full rounded-md border border-slate-300 bg-transparent px-3 py-2 text-sm outline-none focus:border-blue-500 dark:border-slate-700";

export function ProjectsView() {
  const { projectId } = useParams();
  const { data: config, isLoading } = useConfig();
  const project = config?.projects.find((item) => item.id === projectId);

  if (projectId && project) return <ProjectDetails project={project} />;
  if (projectId && !isLoading) return <Message>Project not found.</Message>;

  return (
    <div className="h-full overflow-y-auto p-5 sm:p-8">
      <div className="mx-auto max-w-6xl">
        <div className="mb-6">
          <h1 className="text-2xl font-bold">Projects</h1>
          <p className="mt-1 text-sm text-slate-500">Source details, code context, and durable instructions shared with agents.</p>
        </div>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {config?.projects.map((item) => <ProjectCard key={item.id} project={item} />)}
        </div>
      </div>
    </div>
  );
}

function ProjectCard({ project }: { project: ProjectDef }) {
  return (
    <Link to={`/projects/${encodeURIComponent(project.id)}`} className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:border-blue-400 hover:shadow-md dark:border-slate-800 dark:bg-slate-900">
      <div className="mb-4 flex items-start justify-between gap-3"><Folder className="text-blue-500" /><span className="font-mono text-xs text-slate-400">{project.id}</span></div>
      <h2 className="font-semibold">{project.label}</h2>
      <p className="mt-2 truncate font-mono text-xs text-slate-500">{project.root || "No source path configured"}</p>
      <div className="mt-4 inline-flex items-center gap-1 text-xs font-medium text-blue-600 dark:text-blue-400"><BookOpen size={13} /> Open project context</div>
    </Link>
  );
}

function ProjectDetails({ project }: { project: ProjectDef }) {
  const update = useUpdateProject();
  const generate = useGenerateCodeGraph();
  const saveDocs = useUpdateProjectDocumentation();
  const importReadme = useImportProjectReadme();
  const { data: docs, isLoading: docsLoading } = useProjectDocumentation(project.id);
  const { data: graph } = useCodeGraph(project.root ? project.id : undefined);
  const [label, setLabel] = useState(project.label);
  const [root, setRoot] = useState(project.root ?? "");
  const [indexer, setIndexer] = useState<CodeGraphIndexer>(project.indexer ?? "builtin");
  const [instructions, setInstructions] = useState("");
  useEffect(() => setInstructions(docs?.instructions ?? ""), [docs?.instructions]);

  const saveProject = () => update.mutate({ id: project.id, body: { label: label.trim() || project.label, root: root.trim(), indexer } }, { onSuccess: () => toast("Project details saved", "success") });
  return (
    <div className="h-full overflow-y-auto p-5 sm:p-8">
      <div className="mx-auto max-w-6xl">
        <Link to="/projects" className="text-sm text-blue-600 hover:underline dark:text-blue-400">← All projects</Link>
        <div className="mt-3 flex flex-wrap items-end justify-between gap-3"><div><span className="font-mono text-xs text-slate-400">{project.id}</span><h1 className="text-2xl font-bold">{project.label}</h1></div><GraphStatus project={project} /></div>
        <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
          <main className="space-y-6">
            <Section title="Agent and project instructions" description="Markdown guidance agents receive when they request this project's documentation through MCP.">
              {docsLoading ? <Loader /> : <><textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={12} placeholder="# Working with this project\n\nBuild commands, architecture notes, conventions, and constraints…" className={`${inputCls} min-h-64 font-mono text-xs`} /><div className="mt-3 flex justify-end"><button onClick={() => saveDocs.mutate({ id: project.id, instructions }, { onSuccess: () => toast("Project instructions saved", "success") })} disabled={saveDocs.isPending} className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"><Save size={15} />Save instructions</button></div></>}
            </Section>
            <Section title="Imported README" description="A private snapshot copied from the configured source root. Re-import to refresh it.">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-2"><span className="text-xs text-slate-500">{docs?.readme ? `${docs.readme.name} · imported ${new Date(docs.readme.importedAt).toLocaleString()}` : "No README imported yet."}</span><button onClick={() => importReadme.mutate(project.id, { onSuccess: () => toast("README imported", "success") })} disabled={!project.root || importReadme.isPending} className="inline-flex items-center gap-2 rounded-md border border-slate-300 px-3 py-2 text-sm disabled:opacity-50 dark:border-slate-700"><Upload size={14} />{docs?.readme ? "Refresh README" : "Import README"}</button></div>
              {docs?.readme ? <div className="rounded-lg border border-slate-200 p-5 dark:border-slate-800"><MarkdownView markdown={docs.readme.markdown} /></div> : <p className="text-sm text-slate-400">Configure a source path, then import its root README.md.</p>}
            </Section>
          </main>
          <aside><Section title="Project settings" description="Local source and indexing configuration."><div className="space-y-4"><Field label="Label"><input className={inputCls} value={label} onChange={(e) => setLabel(e.target.value)} /></Field><Field label="Source path"><input className={`${inputCls} font-mono text-xs`} value={root} onChange={(e) => setRoot(e.target.value)} /></Field><Field label="Code graph engine"><select className={inputCls} value={indexer} onChange={(e) => setIndexer(e.target.value as CodeGraphIndexer)}><option value="builtin">Built-in</option><option value="graphify">Graphify</option></select></Field><button onClick={saveProject} disabled={update.isPending} className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white dark:bg-slate-100 dark:text-slate-900"><Save size={14} />Save project</button><button onClick={() => generate.mutate(project.id)} disabled={!project.root || graph?.meta.status === "indexing"} className="inline-flex w-full items-center justify-center gap-2 rounded-md border border-slate-300 px-3 py-2 text-sm disabled:opacity-50 dark:border-slate-700"><Network size={14} />Generate code graph</button></div></Section></aside>
        </div>
      </div>
    </div>
  );
}

function GraphStatus({ project }: { project: ProjectDef }) { const { data } = useCodeGraph(project.root ? project.id : undefined); if (!project.root) return <span className="text-xs text-slate-400">No source path</span>; if (data?.meta.status === "indexing") return <span className="inline-flex items-center gap-1 text-xs text-amber-500"><Loader2 size={13} className="animate-spin" /> Indexing</span>; if (data?.meta.status === "ready") return <span className="inline-flex items-center gap-1 text-xs text-emerald-500"><CheckCircle2 size={13} /> {data.meta.fileCount} files indexed</span>; return <span className="text-xs text-slate-400">Code graph not generated</span>; }
function Section({ title, description, children }: { title: string; description: string; children: React.ReactNode }) { return <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900"><h2 className="font-semibold">{title}</h2><p className="mb-4 mt-1 text-xs text-slate-500">{description}</p>{children}</section>; }
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="block"><span className="mb-1 block text-xs font-medium text-slate-500">{label}</span>{children}</label>; }
function Loader() { return <div className="flex items-center gap-2 text-sm text-slate-500"><Loader2 size={14} className="animate-spin" />Loading…</div>; }
function Message({ children }: { children: React.ReactNode }) { return <div className="flex h-full items-center justify-center text-slate-500">{children}</div>; }

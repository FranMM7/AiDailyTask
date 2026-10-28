import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { BookOpen, Copy, ExternalLink, FileText, FileUp, FolderOpen, Loader2, Plus, Search, Trash2, X } from "lucide-react";
import type { CreateLibraryResource, LibraryResource } from "@AiDailyTasks/shared";
import { useCreateLibraryResource, useDeleteLibraryResource, useLibraryResources, useUploadLibraryResourceFile } from "@/api/hooks";
import { toast } from "@/store/toast";

const inlineBlank = (): CreateLibraryResource => ({ title: "", purpose: "", kind: "instruction", content: "", tags: [] });
const fileBlank = (): CreateLibraryResource => ({ title: "", purpose: "", kind: "file", tags: [] });
const TEXT_FILE_EXTENSIONS = new Set(["csv", "css", "html", "js", "json", "log", "md", "markdown", "ps1", "sql", "text", "ts", "tsx", "txt", "xml", "yaml", "yml"]);

function isPreviewableFile(resource: LibraryResource): boolean {
  const extension = resource.fileName?.split(".").pop()?.toLowerCase();
  return !!extension && TEXT_FILE_EXTENSIONS.has(extension);
}

function FileResourcePreview({ resource, onClose }: { resource: LibraryResource; onClose: () => void }) {
  const [content, setContent] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const url = `/api/resources/${encodeURIComponent(resource.id)}/file`;

  useEffect(() => {
    const controller = new AbortController();
    setContent(null);
    setFailed(false);
    void fetch(url, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        if (Number(response.headers.get("content-length") ?? 0) > 2_000_000) throw new Error("File exceeds preview limit");
        return response.text();
      })
      .then(setContent)
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setFailed(true);
      });
    return () => controller.abort();
  }, [url]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return <div className="fixed inset-0 z-[60]" role="dialog" aria-modal="true" aria-labelledby="resource-preview-title">
    <button type="button" className="absolute inset-0 bg-black/60" onClick={onClose} aria-label="Close file preview" />
    <section className="fixed left-1/2 top-1/2 z-[70] flex h-[70vh] w-[min(760px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white text-slate-900 shadow-2xl dark:border-slate-800 dark:bg-slate-950 dark:text-slate-100">
      <header className="flex items-center justify-between gap-3 border-b border-slate-200 bg-slate-50 px-4 py-3 dark:border-slate-800 dark:bg-slate-900">
        <div className="min-w-0"><h2 id="resource-preview-title" className="truncate text-sm font-semibold">{resource.fileName}</h2><p className="truncate text-xs text-slate-500">{resource.title}</p></div>
        <div className="flex shrink-0 items-center gap-3"><a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline dark:text-blue-400"><ExternalLink size={12} />Download</a><button type="button" onClick={onClose} aria-label="Close file preview" className="rounded p-1 text-slate-500 hover:bg-slate-200 dark:hover:bg-slate-800"><X size={17} /></button></div>
      </header>
      <div className="min-h-0 flex-1 overflow-auto bg-slate-950 p-4"><pre className="whitespace-pre-wrap break-words font-mono text-xs leading-5 text-slate-100">{content ?? (failed ? "This file could not be previewed. Download it to open it with a compatible application." : <span className="inline-flex items-center gap-2 text-slate-400"><Loader2 size={14} className="animate-spin" />Loading preview…</span>)}</pre></div>
    </section>
  </div>;
}

export function ResourcesView() {
  const { data, isLoading } = useLibraryResources();
  const create = useCreateLibraryResource();
  const remove = useDeleteLibraryResource();
  const upload = useUploadLibraryResourceFile();
  const [draft, setDraft] = useState<CreateLibraryResource | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [q, setQ] = useState("");
  const [preview, setPreview] = useState<LibraryResource | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const resources = useMemo(() => (data?.resources ?? []).filter((r) => `${r.title} ${r.purpose} ${r.kind} ${r.tags.join(" ")}`.toLowerCase().includes(q.toLowerCase())), [data, q]);
  const reset = () => { setDraft(null); setFile(null); setDragging(false); };
  const selectFile = (next?: File) => { if (!next) return; setFile(next); setDraft((current) => ({ ...(current ?? fileBlank()), kind: "file", title: current?.title || next.name.replace(/\.[^.]+$/, "") })); };
  const onDrop = (event: DragEvent<HTMLButtonElement>) => { event.preventDefault(); setDragging(false); selectFile(event.dataTransfer.files[0]); };
  const save = async () => { if (!draft?.title.trim() || !draft.purpose.trim() || (draft.kind === "file" && !file)) return; const result = await create.mutateAsync(draft); if (file) await upload.mutateAsync({ id: result.resource.id, file }); reset(); };

  if (isLoading) return <div className="p-6 text-sm text-slate-500">Loading resources…</div>;
  return <div className="mx-auto max-w-5xl space-y-5 p-5">
    <header className="flex flex-wrap items-end justify-between gap-4"><div><div className="mb-2 inline-flex rounded-lg bg-blue-500/10 p-2 text-blue-600 dark:text-blue-400"><BookOpen size={20} /></div><h1 className="text-2xl font-semibold tracking-tight">Resource library</h1><p className="mt-1 text-sm text-slate-500">Reusable runbooks, queries, scripts, and files — independent of any task.</p></div><div className="flex gap-2"><button type="button" onClick={() => { reset(); setDraft(fileBlank()); }} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium transition hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-900"><FileUp size={16} />Upload file</button><button type="button" onClick={() => { reset(); setDraft(inlineBlank()); }} className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-blue-700 active:scale-[.98]"><Plus size={16} />Add resource</button></div></header>
    <label className="relative block"><Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by title, purpose, type, or tag" className="w-full rounded-lg border border-slate-300 bg-transparent py-2.5 pl-9 pr-3 text-sm outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-500/15 dark:border-slate-700" /></label>
    {draft ? <section className="origin-top animate-[resource-enter_.18s_ease-out] rounded-xl border border-slate-300 bg-slate-50/40 p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900/20"><div className="mb-4 flex items-center justify-between"><div><h2 className="font-medium">New resource</h2><p className="text-xs text-slate-500">Add reusable text or a file to the board library.</p></div><button type="button" onClick={reset} aria-label="Close resource editor" className="rounded p-1 text-slate-500 hover:bg-slate-200 dark:hover:bg-slate-800"><X size={17} /></button></div><div className="grid gap-3 sm:grid-cols-2"><input autoFocus value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder="Title" className="rounded-lg border border-slate-300 bg-transparent p-2.5 text-sm dark:border-slate-700" /><select value={draft.kind} onChange={(e) => { const kind = e.target.value as CreateLibraryResource["kind"]; setDraft({ ...draft, kind, content: kind === "file" ? undefined : draft.content ?? "" }); if (kind !== "file") setFile(null); }} className="rounded-lg border border-slate-300 bg-transparent p-2.5 text-sm dark:border-slate-700"><option value="instruction">Instructions</option><option value="query">Query</option><option value="script">Script</option><option value="file">File</option></select></div><input value={draft.purpose} onChange={(e) => setDraft({ ...draft, purpose: e.target.value })} placeholder="Purpose — what is this useful for?" className="mt-3 w-full rounded-lg border border-slate-300 bg-transparent p-2.5 text-sm dark:border-slate-700" />{draft.kind === "file" ? <><input ref={fileInput} type="file" className="hidden" onChange={(e) => selectFile(e.target.files?.[0])} /><button type="button" onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={onDrop} onClick={() => fileInput.current?.click()} className={`mt-3 flex w-full flex-col items-center rounded-lg border border-dashed px-4 py-7 text-center transition ${dragging ? "border-blue-500 bg-blue-500/10" : "border-slate-300 hover:border-blue-400 hover:bg-slate-100/70 dark:border-slate-700 dark:hover:bg-slate-900"}`}><FileUp size={24} strokeWidth={1.75} className="mb-2 text-blue-500" /><span className="text-sm font-medium">{file ? file.name : "Drop a file here"}</span><span className="mt-1 text-xs text-slate-500">or click to browse your computer</span></button>{file && <p className="mt-2 text-xs text-slate-500">{Math.ceil(file.size / 1024)} KB selected</p>}</> : <><input value={draft.language ?? ""} onChange={(e) => setDraft({ ...draft, language: e.target.value || undefined })} placeholder="Language (optional, e.g. SQL)" className="mt-3 w-full rounded-lg border border-slate-300 bg-transparent p-2.5 text-sm dark:border-slate-700" /><textarea value={draft.content ?? ""} onChange={(e) => setDraft({ ...draft, content: e.target.value })} rows={8} placeholder="Resource contents" className="mt-3 w-full rounded-lg border border-slate-300 bg-transparent p-3 font-mono text-xs dark:border-slate-700" /></>}<div className="mt-4 flex justify-end gap-2"><button type="button" onClick={reset} className="rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-700">Cancel</button><button type="button" onClick={save} disabled={!draft.title.trim() || !draft.purpose.trim() || (draft.kind === "file" && !file) || create.isPending || upload.isPending} className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50">{upload.isPending ? "Uploading…" : "Save resource"}</button></div></section> : null}
    <div className="grid gap-3 sm:grid-cols-2">{resources.map((r) => <article key={r.id} className="rounded-xl border border-slate-200 p-4 transition hover:-translate-y-0.5 hover:border-blue-300 hover:shadow-md dark:border-slate-800 dark:hover:border-blue-800"><div className="flex justify-between gap-2"><div className="min-w-0"><span className="text-[11px] font-medium uppercase tracking-wide text-blue-600 dark:text-blue-400">{r.kind}{r.language ? ` · ${r.language}` : ""}</span><h2 className="mt-1 truncate font-medium">{r.title}</h2><p className="mt-1 text-sm text-slate-500">{r.purpose}</p></div><button type="button" onClick={() => remove.mutate(r.id)} aria-label={`Delete ${r.title}`} className="h-fit rounded p-1 text-slate-400 hover:bg-red-500/10 hover:text-red-500"><Trash2 size={16} /></button></div>{r.content !== undefined ? <><pre className="mt-3 max-h-36 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-100 p-2.5 text-xs dark:bg-slate-900">{r.content}</pre><button type="button" onClick={async () => { await navigator.clipboard.writeText(r.content ?? ""); toast("Copied", "success"); }} className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:underline"><Copy size={12} />Copy contents</button></> : <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-sm">{isPreviewableFile(r) && <button type="button" onClick={() => setPreview(r)} className="inline-flex items-center gap-1 text-blue-600 hover:underline"><FileText size={14} />Preview {r.fileName}</button>}<a href={`/api/resources/${encodeURIComponent(r.id)}/file`} className="inline-flex items-center gap-1 text-blue-600 hover:underline"><FolderOpen size={14} />Download {r.fileName}</a></div>}</article>)}</div>
    {!resources.length && <div className="rounded-xl border border-dashed border-slate-300 p-10 text-center text-sm text-slate-500 dark:border-slate-700"><BookOpen className="mx-auto mb-3 text-slate-400" /><p className="font-medium text-slate-600 dark:text-slate-300">{q ? "No resources match that search." : "Your library is ready for its first resource."}</p><p className="mt-1 text-xs">Save a reusable instruction, script, query, or file here.</p></div>}
    {preview && <FileResourcePreview resource={preview} onClose={() => setPreview(null)} />}
  </div>;
}

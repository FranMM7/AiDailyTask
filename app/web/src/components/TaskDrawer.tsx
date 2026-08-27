import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type Dispatch,
  type ReactNode,
  type RefObject,
  type SetStateAction,
} from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  X,
  Upload,
  Trash2,
  FileText,
  Send,
  AlertTriangle,
  ImagePlus,
  Loader2,
  ExternalLink,
  ClipboardCheck,
  Paperclip,
  ListTree,
  Pencil,
  Copy,
  ChevronUp,
  ChevronDown,
  Plus,
  Save,
  Grid2X2,
  List,
} from "lucide-react";
import type { Attachment, Observation, TaskDetail, TaskResource } from "@AiDailyTasks/shared";
import {
  useAddObservation,
  useDeleteAttachment,
  usePatchTask,
  useTask,
  useUploadAttachments,
  useUploadResourceFiles,
  useDeleteResourceFile,
} from "@/api/hooks";
import { extractDocxText } from "@/lib/docxText";
import { useTaskDrawer } from "@/lib/navigation";
import { toast } from "@/store/toast";
import { MarkdownView } from "./MarkdownView";
import { MetadataPanel } from "./MetadataPanel";
import { InvalidBadge } from "./badges";

const IMAGE_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "image/bmp": ".bmp",
  "image/tiff": ".tiff",
};

function extForImage(mime: string): string {
  return IMAGE_EXT[mime] ?? `.${mime.split("/")[1] || "png"}`;
}

function isImage(mime: string): boolean {
  return mime.startsWith("image/");
}

function isMarkdown(attachment: Attachment): boolean {
  return attachment.mime === "text/markdown" || /\.(?:md|markdown)$/i.test(attachment.name);
}

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function fmtFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function attachmentTypeLabel(attachment: Attachment): string {
  if (isMarkdown(attachment)) return "Markdown";
  const extension = attachment.name.split(".").pop()?.trim();
  if (extension && extension !== attachment.name) return extension.toUpperCase();
  return attachment.mime.split("/").pop()?.replace(/[.+-]/g, " ") || "File";
}

function fmtAttachmentModified(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * Textarea helpers shared by the Observations composer and the QA editor: insert markdown
 * at the caret, and paste a screenshot (or any image) to upload it as an attachment AND
 * embed it inline — the image is kept on the task, so the context isn't lost once the
 * clipboard is cleared.
 */
function useMarkdownComposer(taskId: string, taRef: RefObject<HTMLTextAreaElement>, setText: Dispatch<SetStateAction<string>>) {
  const upload = useUploadAttachments();
  const [pasting, setPasting] = useState(false);

  const insertAtCaret = (snippet: string) => {
    const ta = taRef.current;
    setText((prev) => {
      if (!ta) return prev ? `${prev}\n${snippet}\n` : `${snippet}\n`;
      const start = ta.selectionStart ?? prev.length;
      const end = ta.selectionEnd ?? prev.length;
      const next = `${prev.slice(0, start)}${snippet}${prev.slice(end)}`;
      const caret = start + snippet.length;
      requestAnimationFrame(() => {
        ta.focus();
        ta.setSelectionRange(caret, caret);
      });
      return next;
    });
  };

  const handlePaste = async (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const imageItems = Array.from(e.clipboardData?.items ?? []).filter(
      (it) => it.kind === "file" && it.type.startsWith("image/"),
    );
    if (imageItems.length === 0) return; // ordinary text paste — leave it alone

    e.preventDefault();
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const files: File[] = [];
    imageItems.forEach((it, i) => {
      const blob = it.getAsFile();
      if (!blob) return;
      // Clipboard blobs are usually the generic "image.png" (or unnamed): give them a
      // descriptive, timestamped name so multiple pastes stay distinct on disk.
      const hasRealName = !!blob.name && blob.name.toLowerCase() !== "image.png";
      const suffix = imageItems.length > 1 ? `-${i + 1}` : "";
      const name = hasRealName ? blob.name : `pasted-${stamp}${suffix}${extForImage(blob.type)}`;
      files.push(new File([blob], name, { type: blob.type }));
    });
    if (files.length === 0) return;

    setPasting(true);
    try {
      const { attachments } = await upload.mutateAsync({ id: taskId, files });
      insertAtCaret(attachments.map((a) => `![${a.name}](${a.url})`).join("\n"));
      toast(
        `Embedded ${attachments.length} image${attachments.length > 1 ? "s" : ""}`,
        "success",
      );
    } catch {
      toast("Couldn't upload the pasted image.", "error");
    } finally {
      setPasting(false);
    }
  };

  return { handlePaste, pasting };
}

function ObservationsSection({ task }: { task: TaskDetail }) {
  const addObs = useAddObservation();
  const [text, setText] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);
  const { handlePaste, pasting } = useMarkdownComposer(task.id, taRef, setText);

  const submit = () => {
    const value = text.trim();
    if (!value) return;
    addObs.mutate(
      { id: task.id, body: { baseRev: task.rev, author: "human", text: value } },
      { onSuccess: () => setText("") },
    );
  };

  return (
    <section>
      <h3 className="mb-2 text-sm font-semibold">Observations ({task.observations.length})</h3>
      <ol className="space-y-3">
        {task.observations.map((o: Observation, i) => (
          <li
            key={`${o.at}-${i}`}
            className="rounded-lg border border-slate-200 p-3 dark:border-slate-800"
          >
            <div className="mb-1 flex items-center gap-2 text-xs text-slate-500">
              <span className="font-medium text-slate-600 dark:text-slate-300">{o.author}</span>
              <span>{fmtWhen(o.at)}</span>
            </div>
            <MarkdownView markdown={o.markdown} />
          </li>
        ))}
        {task.observations.length === 0 && (
          <li className="text-xs text-slate-500">No observations yet.</li>
        )}
      </ol>

      <div className="mt-3">
        <textarea
          ref={taRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPaste={handlePaste}
          placeholder="Add a note (markdown supported; paste a screenshot to embed it)…"
          rows={3}
          className="w-full rounded-md border border-slate-300 bg-transparent p-2 text-sm outline-none focus:border-blue-500 dark:border-slate-700"
        />
        <div className="mt-1 flex items-center justify-between">
          <span className="inline-flex items-center gap-1 text-xs text-slate-400">
            {pasting ? (
              <>
                <Loader2 size={12} className="animate-spin" />
                Uploading image…
              </>
            ) : (
              <>
                <ImagePlus size={12} />
                Paste a screenshot to attach &amp; embed it
              </>
            )}
          </span>
          <button
            type="button"
            onClick={submit}
            disabled={!text.trim() || addObs.isPending || pasting}
            className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            <Send size={14} />
            {addObs.isPending ? "Adding…" : "Add note"}
          </button>
        </div>
      </div>
    </section>
  );
}

function FilePreview({ attachment, onClose }: { attachment: Attachment; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [query, setQuery] = useState("");
  const ext = attachment.name.split(".").pop()?.toLowerCase() ?? "";
  const markdown = isMarkdown(attachment);
  const textLike = markdown || attachment.mime.startsWith("text/") || ["log", "txt", "json", "xml", "csv", "sql", "ps1", "js", "ts", "tsx", "css", "html", "yml", "yaml"].includes(ext);
  const docx = ext === "docx";
  const pdf = attachment.mime === "application/pdf" || ext === "pdf";

  useEffect(() => {
    const controller = new AbortController();
    setText(null);
    setError(false);
    if (!textLike && !docx) return () => controller.abort();
    void fetch(attachment.url, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        if (Number(response.headers.get("content-length") ?? 0) > 2_000_000) throw new Error("File exceeds preview limit");
        return docx ? response.arrayBuffer().then(extractDocxText) : response.text();
      })
      .then(setText)
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setError(true);
      });

    return () => controller.abort();
  }, [attachment.url, docx, textLike]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[60]" role="dialog" aria-modal="true" aria-labelledby="file-preview-title">
      <button type="button" className="absolute inset-0 bg-black/60" onClick={onClose} aria-label="Close file preview" />
        <div className="fixed left-1/2 top-1/2 z-[70] flex h-[70vh] min-h-80 w-[min(760px,calc(100vw-2rem))] min-w-80 max-h-[calc(100vh-2rem)] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 resize flex-col overflow-hidden rounded-xl border border-slate-200 bg-white text-slate-900 shadow-2xl outline-none dark:border-slate-800 dark:bg-slate-950 dark:text-slate-100">
          <div className="flex items-center justify-between gap-3 border-b border-slate-200 bg-slate-50 px-4 py-3 dark:border-slate-800 dark:bg-slate-900">
            <h2 id="file-preview-title" className="min-w-0 truncate text-sm font-semibold" title={attachment.name}>
              {attachment.name}
            </h2>
            <div className="flex shrink-0 items-center gap-3">
              {(textLike || docx) && <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find in preview" aria-label="Find in preview" className="w-36 rounded border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-950" />}
              <a
                href={attachment.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline dark:text-blue-400"
              >
                <ExternalLink size={12} />
                Download
              </a>
              <button
                type="button"
                onClick={onClose}
                className="rounded p-1 text-slate-500 hover:bg-slate-200 hover:text-slate-900 dark:hover:bg-slate-800 dark:hover:text-slate-100"
                title="Close preview"
                aria-label={`Close preview of ${attachment.name}`}
              >
                <X size={16} />
              </button>
            </div>
          </div>
          <div className="min-h-40 overflow-auto p-5">
            {isImage(attachment.mime) ? <img src={attachment.url} alt={attachment.name} className="mx-auto max-h-full max-w-full object-contain" /> :
            pdf ? <iframe src={attachment.url} title={`Preview ${attachment.name}`} className="h-full min-h-[55vh] w-full border-0" /> :
            error ? (
              <div className="space-y-2 text-sm"><p className="text-red-600 dark:text-red-400">This file cannot be previewed safely.</p><p className="text-slate-500">Download it to open it with a compatible application.</p></div>
            ) : text !== null ? (
              markdown ? <MarkdownView markdown={text} /> : <pre className="whitespace-pre-wrap break-words text-xs">{query ? text.split(new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "ig")).map((part, i) => part.toLowerCase() === query.toLowerCase() ? <mark key={i}>{part}</mark> : part) : text}</pre>
            ) : textLike || docx ? (
              <div className="flex items-center gap-2 text-sm text-slate-500">
                <Loader2 size={14} className="animate-spin" />
                Loading preview…
              </div>
            ) : <div className="space-y-2 text-sm"><p>No safe in-app preview is available for this file type.</p><p className="text-slate-500">Use Download to view it in a compatible application.</p></div>}
          </div>
        </div>
    </div>
  );
}

/**
 * Drag-and-drop / click-to-upload zone. `compact` renders the small always-visible
 * variant that sits under Save & Archive in the metadata panel, so uploading never
 * requires scrolling past a long conversation.
 */
export function UploadDropzone({ taskId, compact = false }: { taskId: string; compact?: boolean }) {
  const upload = useUploadAttachments();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const doUpload = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    upload.mutate({ id: taskId, files: Array.from(files) });
  };

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        doUpload(e.dataTransfer.files);
      }}
      onClick={() => inputRef.current?.click()}
      className={`flex cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed text-xs text-slate-500 transition ${
        compact ? "mt-3 p-2.5" : "mt-2 p-4"
      } ${dragOver ? "border-blue-500 bg-blue-500/10" : "border-slate-300 dark:border-slate-700"}`}
    >
      <Upload size={compact ? 14 : 18} />
      <span>{upload.isPending ? "Uploading…" : "Drop files or click to upload"}</span>
      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          doUpload(e.target.files);
          e.target.value = "";
        }}
      />
    </div>
  );
}

function AttachmentsSection({ task }: { task: TaskDetail }) {
  const del = useDeleteAttachment();
  const [preview, setPreview] = useState<Attachment | null>(null);
  const [view, setView] = useState<"preview" | "list">("preview");

  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">Attachments ({task.attachments.length})</h3>
        <div className="inline-flex rounded-md border border-slate-200 p-0.5 dark:border-slate-700" role="group" aria-label="Attachment view">
          <button type="button" onClick={() => setView("preview")} aria-pressed={view === "preview"} title="Preview view" className={`rounded p-1.5 ${view === "preview" ? "bg-slate-200 text-slate-900 dark:bg-slate-700 dark:text-slate-100" : "text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"}`}>
            <Grid2X2 size={15} aria-hidden="true" /><span className="sr-only">Preview view</span>
          </button>
          <button type="button" onClick={() => setView("list")} aria-pressed={view === "list"} title="List view" className={`rounded p-1.5 ${view === "list" ? "bg-slate-200 text-slate-900 dark:bg-slate-700 dark:text-slate-100" : "text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"}`}>
            <List size={15} aria-hidden="true" /><span className="sr-only">List view</span>
          </button>
        </div>
      </div>

      {task.attachments.length > 0 && (
        <div className={view === "preview" ? "grid grid-cols-2 gap-2 sm:grid-cols-3" : "divide-y divide-slate-200 overflow-hidden rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-800"}>
          {task.attachments.map((a: Attachment) => (
            <div
              key={a.name}
              className={view === "preview" ? "group relative overflow-hidden rounded-lg border border-slate-200 dark:border-slate-800" : "group flex min-w-0 items-center gap-3 p-2"}
            >
              <button
                type="button"
                onClick={() => setPreview(a)}
                className={view === "preview" ? "block w-full text-left" : "flex min-w-0 flex-1 items-center gap-3 text-left"}
                title={`Preview ${a.name} (${fmtFileSize(a.size)})`}
              >
                {view === "list" && isImage(a.mime) ? (
                  <img src={a.url} alt="" className="h-10 w-10 shrink-0 rounded object-cover" />
                ) : isMarkdown(a) ? (
                  <div className={`flex flex-col items-center justify-center gap-1 bg-slate-100 text-slate-500 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 ${view === "preview" ? "h-24 w-full" : "h-10 w-10 shrink-0 rounded"}`}>
                    <FileText size={22} />
                    {view === "preview" && <span className="max-w-full truncate px-1 text-[10px]">Markdown</span>}
                  </div>
                ) : isImage(a.mime) ? (
                  <img src={a.url} alt={a.name} className={view === "preview" ? "h-24 w-full object-cover" : "h-10 w-10 shrink-0 rounded object-cover"} />
                ) : (
                  <div className={`flex flex-col items-center justify-center gap-1 bg-slate-100 text-slate-500 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 ${view === "preview" ? "h-24 w-full" : "h-10 w-10 shrink-0 rounded"}`}>
                    <FileText size={22} />
                    {view === "preview" && <span className="max-w-full truncate px-1 text-[10px]">{attachmentTypeLabel(a)}</span>}
                  </div>
                )}
                {view === "list" && (
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{a.name}</span>
                    <span className="mt-1 flex items-center gap-1.5 text-xs text-slate-500">
                      <span className="max-w-[14rem] truncate rounded bg-slate-100 px-1.5 py-0.5 font-medium uppercase tracking-wide text-[10px] dark:bg-slate-800" title={a.mime || "File"}>
                        {attachmentTypeLabel(a)}
                      </span>
                      <span aria-hidden="true">&middot;</span>
                      <span className="shrink-0">{fmtFileSize(a.size)}</span>
                      <span aria-hidden="true">&middot;</span>
                      <time className="min-w-0 truncate" dateTime={a.modified} title={`Last modified ${fmtWhen(a.modified)}`}>
                        Modified {fmtAttachmentModified(a.modified)}
                      </time>
                    </span>
                  </span>
                )}
              </button>
              <div className={view === "preview" ? "flex items-center justify-between gap-1 px-1.5 py-1" : "shrink-0"}>
                {view === "preview" && <span className="truncate text-[11px]">{a.name}</span>}
                <button
                  type="button"
                  onClick={() => {
                    if (preview?.name === a.name) setPreview(null);
                    del.mutate({ id: task.id, name: a.name });
                  }}
                  className="text-slate-400 hover:text-red-500"
                  title="Delete attachment"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {task.attachments.length === 0 && (
        <p className="text-xs text-slate-500">No attachments yet.</p>
      )}

      {preview ? <FilePreview attachment={preview} onClose={() => setPreview(null)} /> : null}

      <UploadDropzone taskId={task.id} />
    </section>
  );
}

function ResourcesSection({ task }: { task: TaskDetail }) {
  const patch = usePatchTask();
  const upload = useUploadResourceFiles();
  const deleteFile = useDeleteResourceFile();
  const [editing, setEditing] = useState<TaskResource | null>(null);
  const [preview, setPreview] = useState<Attachment | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const resources = [...task.resources].sort((a, b) => a.order - b.order);
  const saveAll = (next: TaskResource[]) => patch.mutate({ id: task.id, body: { baseRev: task.rev, fields: { resources: next.map((r, order) => ({ ...r, order })) } } });
  const addInline = () => setEditing({ id: `r_${Date.now()}`, title: "", kind: "instruction", order: resources.length, content: "" });
  const saveEdit = () => {
    if (!editing?.title.trim()) return;
    const index = resources.findIndex((r) => r.id === editing.id);
    saveAll(index < 0 ? [...resources, editing] : resources.map((r) => r.id === editing.id ? editing : r));
    setEditing(null);
  };
  const move = (index: number, delta: number) => {
    const next = [...resources];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    saveAll(next);
  };
  const copyRunbook = async () => {
    const value = resources.map((r) => `## ${r.title}\n\n${r.kind === "file" ? r.fileName : r.content ?? ""}`).join("\n\n");
    await navigator.clipboard.writeText(value);
    toast("Runbook copied", "success");
  };

  return <section className="space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div><h3 className="text-sm font-semibold">Resources ({resources.length})</h3><p className="text-xs text-slate-500">Reusable references that carry forward with recurring tasks.</p></div>
      <div className="flex gap-2">
        {resources.length > 0 ? <button type="button" onClick={copyRunbook} className="inline-flex items-center gap-1 rounded border px-2 py-1 text-xs"><Copy size={12}/>Copy runbook</button> : null}
        <button type="button" onClick={addInline} className="inline-flex items-center gap-1 rounded bg-blue-600 px-2 py-1 text-xs text-white"><Plus size={12}/>Add resource</button>
        <button type="button" onClick={() => fileInput.current?.click()} className="inline-flex items-center gap-1 rounded border px-2 py-1 text-xs"><Upload size={12}/>Add file</button>
        <input ref={fileInput} type="file" multiple className="hidden" onChange={async (e) => {
          const selected = Array.from(e.target.files ?? []); e.target.value = ""; if (!selected.length) return;
          const result = await upload.mutateAsync({ id: task.id, files: selected });
          saveAll([...resources, ...result.files.map((file, i): TaskResource => ({ id: `r_${Date.now()}_${i}`, title: file.name.replace(/\.[^.]+$/, ""), kind: "file", order: resources.length + i, fileName: file.name }))]);
        }}/>
      </div>
    </div>
    {resources.map((resource, index) => {
      const file = resource.kind === "file" ? task.resourceFiles.find((f) => f.name === resource.fileName) : undefined;
      return <article key={resource.id} className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
        <div className="flex items-start justify-between gap-3"><div className="min-w-0"><h4 className="truncate text-sm font-medium">{resource.title}</h4><span className="text-[11px] uppercase text-slate-500">{resource.kind}{resource.language ? ` · ${resource.language}` : ""}</span></div>
          <div className="flex shrink-0 gap-1"><button title="Move up" onClick={() => move(index,-1)} disabled={index===0}><ChevronUp size={14}/></button><button title="Move down" onClick={() => move(index,1)} disabled={index===resources.length-1}><ChevronDown size={14}/></button>{file ? <button title="Preview file" onClick={() => setPreview(file)}><FileText size={14}/></button> : null}<button title="Edit resource" onClick={() => setEditing(resource)}><Pencil size={14}/></button><button title="Delete resource" className="text-red-500" onClick={() => { if (file) void deleteFile.mutateAsync({id:task.id,name:file.name}); saveAll(resources.filter((r)=>r.id!==resource.id)); }}><Trash2 size={14}/></button></div>
        </div>
        {resource.kind !== "file" ? <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-slate-100 p-2 text-xs dark:bg-slate-900">{resource.content}</pre> : <p className="mt-2 truncate text-xs text-slate-500">{resource.fileName}</p>}
      </article>;
    })}
    {!resources.length ? <p className="rounded-lg border border-dashed p-6 text-center text-sm text-slate-500">No reusable resources yet. Add instructions, a query, a script, or a reference file.</p> : null}
    {editing ? <div className="rounded-lg border border-blue-300 p-3 dark:border-blue-800"><div className="grid gap-2 sm:grid-cols-2"><input autoFocus value={editing.title} onChange={(e)=>setEditing({...editing,title:e.target.value})} placeholder="Resource title" className="rounded border bg-transparent p-2 text-sm"/><select value={editing.kind} onChange={(e)=>setEditing({...editing,kind:e.target.value as TaskResource["kind"],content:editing.content??""})} className="rounded border bg-transparent p-2 text-sm"><option value="instruction">Instructions</option><option value="query">Query</option><option value="script">Script</option></select></div><input value={editing.language??""} onChange={(e)=>setEditing({...editing,language:e.target.value||undefined})} placeholder="Language (optional, e.g. SQL)" className="mt-2 w-full rounded border bg-transparent p-2 text-sm"/><textarea value={editing.content??""} onChange={(e)=>setEditing({...editing,content:e.target.value})} rows={8} className="mt-2 w-full rounded border bg-transparent p-2 font-mono text-xs"/><div className="mt-2 flex justify-end gap-2"><button onClick={()=>setEditing(null)} className="rounded border px-3 py-1 text-xs">Cancel</button><button onClick={saveEdit} disabled={!editing.title.trim()} className="inline-flex items-center gap-1 rounded bg-blue-600 px-3 py-1 text-xs text-white disabled:opacity-50"><Save size={12}/>Save</button></div></div> : null}
    {preview ? <FilePreview attachment={preview} onClose={()=>setPreview(null)}/> : null}
  </section>;
}

/**
 * The "## QA" section: how to test this task — manual steps, expected results, screenshots.
 * Not every task needs one, so the empty state says exactly that; editing supports markdown
 * with the same paste-a-screenshot-to-embed behavior as the Observations composer.
 */
function QaSection({ task }: { task: TaskDetail }) {
  const patch = usePatchTask();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(task.qaMarkdown);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const { handlePaste, pasting } = useMarkdownComposer(task.id, taRef, setText);

  // Re-sync the draft when the task changes on disk while not editing.
  useEffect(() => {
    if (!editing) setText(task.qaMarkdown);
  }, [task.rev, task.id, editing, task.qaMarkdown]);

  const save = () => {
    patch.mutate(
      { id: task.id, body: { baseRev: task.rev, body: { qa: text } } },
      {
        onSuccess: () => {
          setEditing(false);
          toast("QA notes saved", "success");
        },
      },
    );
  };

  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold">QA — how to test</h3>
        {!editing && (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            <Pencil size={12} />
            {task.qaMarkdown.trim() ? "Edit" : "Write QA steps"}
          </button>
        )}
      </div>

      {editing ? (
        <div>
          <textarea
            ref={taRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onPaste={handlePaste}
            placeholder={"1. Open …\n2. Do …\n3. Expect …\n\nMarkdown supported; paste a screenshot to embed it."}
            rows={10}
            className="w-full rounded-md border border-slate-300 bg-transparent p-2 text-sm outline-none focus:border-blue-500 dark:border-slate-700"
          />
          <div className="mt-1 flex items-center justify-between">
            <span className="inline-flex items-center gap-1 text-xs text-slate-400">
              {pasting ? (
                <>
                  <Loader2 size={12} className="animate-spin" />
                  Uploading image…
                </>
              ) : (
                <>
                  <ImagePlus size={12} />
                  Paste a screenshot to attach &amp; embed it
                </>
              )}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setText(task.qaMarkdown);
                  setEditing(false);
                }}
                className="rounded-md px-3 py-1.5 text-sm text-slate-500 hover:text-slate-900 dark:hover:text-white"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={save}
                disabled={patch.isPending || pasting}
                className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {patch.isPending ? "Saving…" : "Save QA notes"}
              </button>
            </div>
          </div>
        </div>
      ) : task.qaMarkdown.trim() ? (
        <MarkdownView markdown={task.qaMarkdown} />
      ) : (
        <p className="text-xs text-slate-500">
          No QA steps documented. Not every task needs QA — when this one does, write the manual
          test steps here (markdown; screenshots can be pasted right in).
        </p>
      )}
    </section>
  );
}

type DrawerTab = "details" | "attachments" | "qa";

function TabButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition ${
        active
          ? "border-blue-600 text-blue-600 dark:text-blue-400"
          : "border-transparent text-slate-500 hover:text-slate-900 dark:hover:text-slate-100"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

function DrawerBody({ id }: { id: string }) {
  const { data, isLoading, isError } = useTask(id);
  const [tab, setTab] = useState<DrawerTab>("details");

  // A different task always opens on its Details tab.
  useEffect(() => setTab("details"), [id]);

  if (isLoading)
    return <div className="p-8 text-center text-sm text-slate-500">Loading {id}…</div>;
  if (isError || !data)
    return <div className="p-8 text-center text-sm text-slate-500">Failed to load {id}.</div>;

  const task = data.task;

  if (!task.valid) {
    return (
      <div className="space-y-3 p-5">
        <div className="flex items-center gap-2 text-red-500">
          <AlertTriangle size={16} />
          <InvalidBadge />
          <span className="font-mono text-sm">{task.id}</span>
        </div>
        <p className="text-sm text-red-500">{task.parseError}</p>
        {task.rawFrontmatter && (
          <pre className="overflow-auto rounded-lg bg-slate-900 p-3 text-xs text-slate-100">
            {task.rawFrontmatter}
          </pre>
        )}
        {task.rawBody && (
          <pre className="overflow-auto rounded-lg bg-slate-900 p-3 text-xs text-slate-100">
            {task.rawBody}
          </pre>
        )}
      </div>
    );
  }

  return (
    <div className="grid gap-6 p-5 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="min-w-0 lg:order-1 lg:col-start-1">
        <div className="mb-4 flex items-center overflow-x-auto border-b border-slate-200 dark:border-slate-800">
          <TabButton
            active={tab === "details"}
            onClick={() => setTab("details")}
            icon={<ListTree size={14} />}
            label="Details"
          />
          <TabButton
            active={tab === "attachments"}
            onClick={() => setTab("attachments")}
            icon={<Paperclip size={14} />}
            label={`Attachments (${task.attachments.length})`}
          />
          <TabButton
            active={tab === "qa"}
            onClick={() => setTab("qa")}
            icon={<ClipboardCheck size={14} />}
            label={task.qaMarkdown.trim() ? "QA ✓" : "QA"}
          />
        </div>

        {tab === "details" && (
          <div className="space-y-6">
            {task.summaryMarkdown && (
              <section>
                <h3 className="mb-2 text-sm font-semibold">Summary</h3>
                <MarkdownView markdown={task.summaryMarkdown} />
              </section>
            )}
            <section>
              <h3 className="mb-2 text-sm font-semibold">Scope</h3>
              {task.scopeMarkdown ? (
                <MarkdownView markdown={task.scopeMarkdown} />
              ) : (
                <p className="text-xs text-slate-500">No scope has been written yet.</p>
              )}
            </section>
            <ObservationsSection task={task} />
          </div>
        )}
        {tab === "attachments" && <AttachmentsSection task={task} />}
        {tab === "qa" && <QaSection task={task} />}
      </div>

      <aside className="lg:order-2 lg:col-start-2">
        <MetadataPanel task={task} />
        {/* Always-reachable upload target: no scrolling past a long conversation to attach a file. */}
        <UploadDropzone taskId={task.id} compact />
      </aside>
    </div>
  );
}

export function TaskDrawer() {
  const { openTaskId, closeTask } = useTaskDrawer();
  const { data } = useTask(openTaskId);
  const [drawerWidth, setDrawerWidth] = useState<number | null>(null);
  const resizing = useRef(false);

  // title for the header
  const [heading, setHeading] = useState<string>("");
  useEffect(() => {
    if (data?.task) {
      setHeading(data.task.valid ? `${data.task.id} · ${data.task.title}` : data.task.id);
    } else if (openTaskId) {
      setHeading(openTaskId);
    }
  }, [data, openTaskId]);

  const resizeDrawer = (clientX: number) => {
    const minimum = Math.min(352, window.innerWidth);
    setDrawerWidth(Math.min(window.innerWidth, Math.max(minimum, window.innerWidth - clientX)));
  };

  const adjustDrawerWidth = (amount: number) => {
    const current = drawerWidth ?? Math.min(1000, window.innerWidth * 0.72);
    const minimum = Math.min(352, window.innerWidth);
    setDrawerWidth(Math.min(window.innerWidth, Math.max(minimum, current + amount)));
  };

  return (
    <Dialog.Root open={!!openTaskId} onOpenChange={(o) => (!o ? closeTask() : undefined)}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50 data-[state=open]:animate-in" />
        <Dialog.Content
          className="fixed right-0 top-0 z-50 flex h-full w-[min(72vw,1000px)] min-w-0 flex-col overflow-hidden border-l border-slate-200 bg-white text-slate-900 shadow-2xl outline-none sm:min-w-[22rem] dark:border-slate-800 dark:bg-slate-950 dark:text-slate-100"
          style={drawerWidth ? { width: `${drawerWidth}px` } : undefined}
        >
          <button
            type="button"
            aria-label="Resize task window"
            title="Drag to resize task window"
            className="absolute inset-y-0 left-0 z-10 w-2 cursor-ew-resize touch-none border-r border-transparent hover:border-blue-500 focus:outline-none focus-visible:border-blue-500"
            onPointerDown={(event) => {
              resizing.current = true;
              event.currentTarget.setPointerCapture(event.pointerId);
              event.preventDefault();
            }}
            onPointerMove={(event) => {
              if (resizing.current) resizeDrawer(event.clientX);
            }}
            onPointerUp={(event) => {
              resizing.current = false;
              event.currentTarget.releasePointerCapture(event.pointerId);
            }}
            onPointerCancel={() => {
              resizing.current = false;
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowLeft") {
                adjustDrawerWidth(48);
                event.preventDefault();
              }
              if (event.key === "ArrowRight") {
                adjustDrawerWidth(-48);
                event.preventDefault();
              }
            }}
          />
          <div className="flex items-center justify-between gap-2 border-b border-slate-200 px-5 py-3 dark:border-slate-800">
            <Dialog.Title className="truncate text-base font-semibold">{heading}</Dialog.Title>
            <Dialog.Description className="sr-only">Task details</Dialog.Description>
            <Dialog.Close className="rounded p-1 hover:bg-slate-100 dark:hover:bg-slate-800">
              <X size={18} />
            </Dialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {openTaskId ? <DrawerBody id={openTaskId} /> : null}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

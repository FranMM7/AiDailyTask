import { useEffect, useRef, useState, type ClipboardEvent } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X, Upload, Trash2, FileText, Send, AlertTriangle, ImagePlus, Loader2, ExternalLink } from "lucide-react";
import type { Attachment, Observation, TaskDetail } from "@AiDailyTasks/shared";
import {
  useAddObservation,
  useDeleteAttachment,
  useTask,
  useUploadAttachments,
} from "@/api/hooks";
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

function ObservationsSection({ task }: { task: TaskDetail }) {
  const addObs = useAddObservation();
  const upload = useUploadAttachments();
  const [text, setText] = useState("");
  const [pasting, setPasting] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const submit = () => {
    const value = text.trim();
    if (!value) return;
    addObs.mutate(
      { id: task.id, body: { baseRev: task.rev, author: "human", text: value } },
      { onSuccess: () => setText("") },
    );
  };

  // Insert markdown at the caret (append when the caret is unknown), leaving the
  // caret just after the inserted text so the user can keep typing.
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

  // Paste a screenshot (or any image) to upload it as an attachment AND embed it
  // inline in the note. The image is then kept on the task and reviewable any time,
  // so the context isn't lost once the clipboard is cleared.
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
      const { attachments } = await upload.mutateAsync({ id: task.id, files });
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

function MarkdownAttachmentPreview({ attachment, onClose }: { attachment: Attachment; onClose: () => void }) {
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setMarkdown(null);
    setError(false);

    void fetch(attachment.url, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.text();
      })
      .then(setMarkdown)
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setError(true);
      });

    return () => controller.abort();
  }, [attachment.url]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[60]" role="dialog" aria-modal="true" aria-labelledby="markdown-preview-title">
      <button type="button" className="absolute inset-0 bg-black/60" onClick={onClose} aria-label="Close Markdown preview" />
        <div className="fixed left-1/2 top-1/2 z-[70] flex h-[70vh] min-h-80 w-[min(760px,calc(100vw-2rem))] min-w-80 max-h-[calc(100vh-2rem)] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 resize flex-col overflow-hidden rounded-xl border border-slate-200 bg-white text-slate-900 shadow-2xl outline-none dark:border-slate-800 dark:bg-slate-950 dark:text-slate-100">
          <div className="flex items-center justify-between gap-3 border-b border-slate-200 bg-slate-50 px-4 py-3 dark:border-slate-800 dark:bg-slate-900">
            <h2 id="markdown-preview-title" className="min-w-0 truncate text-sm font-semibold" title={attachment.name}>
              {attachment.name}
            </h2>
            <div className="flex shrink-0 items-center gap-3">
              <a
                href={attachment.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline dark:text-blue-400"
              >
                <ExternalLink size={12} />
                Open original
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
            {error ? (
              <p className="text-sm text-red-600 dark:text-red-400">Couldn&apos;t load this Markdown attachment.</p>
            ) : markdown !== null ? (
              <MarkdownView markdown={markdown} />
            ) : (
              <div className="flex items-center gap-2 text-sm text-slate-500">
                <Loader2 size={14} className="animate-spin" />
                Loading preview…
              </div>
            )}
          </div>
        </div>
    </div>
  );
}

function AttachmentsSection({ task }: { task: TaskDetail }) {
  const upload = useUploadAttachments();
  const del = useDeleteAttachment();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [preview, setPreview] = useState<Attachment | null>(null);

  const doUpload = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    upload.mutate({ id: task.id, files: Array.from(files) });
  };

  return (
    <section>
      <h3 className="mb-2 text-sm font-semibold">Attachments ({task.attachments.length})</h3>

      {task.attachments.length > 0 && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {task.attachments.map((a: Attachment) => (
            <div
              key={a.name}
              className="group relative overflow-hidden rounded-lg border border-slate-200 dark:border-slate-800"
            >
              {isMarkdown(a) ? (
                <button
                  type="button"
                  onClick={() => setPreview(a)}
                  className="block w-full text-left"
                  title={`Preview ${a.name} (${Math.round(a.size / 1024)} KB)`}
                >
                  <div className="flex h-24 w-full flex-col items-center justify-center gap-1 bg-slate-100 text-slate-500 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700">
                    <FileText size={22} />
                    <span className="px-1 text-[10px]">Markdown</span>
                  </div>
                </button>
              ) : (
                <a
                  href={a.url}
                  target="_blank"
                  rel="noreferrer"
                  className="block"
                  title={`${a.name} (${Math.round(a.size / 1024)} KB)`}
                >
                {isImage(a.mime) ? (
                  <img src={a.url} alt={a.name} className="h-24 w-full object-cover" />
                ) : (
                  <div className="flex h-24 w-full flex-col items-center justify-center gap-1 bg-slate-100 text-slate-500 dark:bg-slate-800">
                    <FileText size={22} />
                    <span className="px-1 text-[10px]">{a.mime || "file"}</span>
                  </div>
                )}
                </a>
              )}
              <div className="flex items-center justify-between gap-1 px-1.5 py-1">
                <span className="truncate text-[11px]">{a.name}</span>
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

      {preview ? <MarkdownAttachmentPreview attachment={preview} onClose={() => setPreview(null)} /> : null}

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
        className={`mt-2 flex cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed p-4 text-xs text-slate-500 transition ${
          dragOver ? "border-blue-500 bg-blue-500/10" : "border-slate-300 dark:border-slate-700"
        }`}
      >
        <Upload size={18} />
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
    </section>
  );
}

function DrawerBody({ id }: { id: string }) {
  const { data, isLoading, isError } = useTask(id);

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
      <div className="min-w-0 space-y-6 lg:order-1 lg:col-start-1">
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
            <p className="text-xs text-slate-500">No scope written.</p>
          )}
        </section>
        <ObservationsSection task={task} />
        <AttachmentsSection task={task} />
      </div>

      <aside className="lg:order-2 lg:col-start-2">
        <MetadataPanel task={task} />
      </aside>
    </div>
  );
}

export function TaskDrawer() {
  const { openTaskId, closeTask } = useTaskDrawer();
  const { data } = useTask(openTaskId);

  // title for the header
  const [heading, setHeading] = useState<string>("");
  useEffect(() => {
    if (data?.task) {
      setHeading(data.task.valid ? `${data.task.id} · ${data.task.title}` : data.task.id);
    } else if (openTaskId) {
      setHeading(openTaskId);
    }
  }, [data, openTaskId]);

  return (
    <Dialog.Root open={!!openTaskId} onOpenChange={(o) => (!o ? closeTask() : undefined)}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50 data-[state=open]:animate-in" />
        <Dialog.Content className="fixed right-0 top-0 z-50 flex h-full w-[min(1000px,100vw)] flex-col border-l border-slate-200 bg-white text-slate-900 shadow-2xl outline-none dark:border-slate-800 dark:bg-slate-950 dark:text-slate-100">
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

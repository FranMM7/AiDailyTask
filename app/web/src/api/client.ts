import type {
  Attachment,
  BoardConfig,
  ConflictResponse,
  CreateProjectRequest,
  CreateRequest,
  ExportRequest,
  ExportResult,
  GraphData,
  McpInfo,
  ObservationRequest,
  PatchRequest,
  ProjectDef,
  TaskDetail,
  TaskDetailOrInvalid,
  TaskFilter,
  TaskSummaryOrInvalid,
} from "@AiDailyTaks/shared";

const BASE = "/api";

export interface ExportListItem {
  filename: string;
  path: string;
  size: number;
  modified: string;
}

/** Thrown on any non-2xx response; carries the HTTP status and parsed body. */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.body = body;
  }

  /** The parsed 409 body, or null when this is not a conflict. */
  get conflict(): ConflictResponse | null {
    if (
      this.status === 409 &&
      this.body &&
      typeof this.body === "object" &&
      (this.body as { conflict?: unknown }).conflict === true
    ) {
      return this.body as ConflictResponse;
    }
    return null;
  }
}

function messageFrom(body: unknown, status: number): string {
  if (body && typeof body === "object") {
    const err = (body as { error?: { message?: string } }).error;
    if (err?.message) return err.message;
  }
  if (typeof body === "string" && body.trim()) return body;
  return `Request failed with status ${status}`;
}

async function parseBody(res: Response): Promise<unknown> {
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) return res.json().catch(() => undefined);
  return res.text().catch(() => undefined);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, init);
  if (!res.ok) {
    const body = await parseBody(res);
    throw new ApiRequestError(res.status, body, messageFrom(body, res.status));
  }
  if (res.status === 204) return undefined as T;
  return (await parseBody(res)) as T;
}

function buildTaskQuery(filter: TaskFilter): string {
  const p = new URLSearchParams();
  if (filter.project) p.set("project", filter.project);
  filter.status?.forEach((s) => p.append("status", s));
  filter.category?.forEach((c) => p.append("category", c));
  filter.severity?.forEach((s) => p.append("severity", s));
  if (filter.tag) p.set("tag", filter.tag);
  if (filter.q) p.set("q", filter.q);
  if (filter.dateField) p.set("dateField", filter.dateField);
  if (filter.dateFrom) p.set("dateFrom", filter.dateFrom);
  if (filter.dateTo) p.set("dateTo", filter.dateTo);
  if (filter.archived && filter.archived !== "exclude") p.set("archived", filter.archived);
  if (filter.sort) p.set("sort", filter.sort);
  if (filter.order) p.set("order", filter.order);
  const qs = p.toString();
  return qs ? `?${qs}` : "";
}

// ── Endpoint wrappers ────────────────────────────────────────────────────────

export function getConfig(): Promise<BoardConfig> {
  return request<BoardConfig>("/config");
}

export function getMcpInfo(): Promise<McpInfo> {
  return request<McpInfo>("/mcp-info");
}

export function addProject(body: CreateProjectRequest): Promise<{ projects: ProjectDef[] }> {
  return request<{ projects: ProjectDef[] }>("/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function getTasks(filter: TaskFilter): Promise<{ tasks: TaskSummaryOrInvalid[] }> {
  return request<{ tasks: TaskSummaryOrInvalid[] }>(`/tasks${buildTaskQuery(filter)}`);
}

export function getTask(id: string): Promise<{ task: TaskDetailOrInvalid }> {
  return request<{ task: TaskDetailOrInvalid }>(`/tasks/${encodeURIComponent(id)}`);
}

export function createTask(body: CreateRequest): Promise<{ task: TaskDetail }> {
  return request<{ task: TaskDetail }>("/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function patchTask(id: string, body: PatchRequest): Promise<{ task: TaskDetail }> {
  return request<{ task: TaskDetail }>(`/tasks/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function archiveTask(id: string, baseRev?: number): Promise<{ task: TaskDetail }> {
  return request<{ task: TaskDetail }>(`/tasks/${encodeURIComponent(id)}/archive`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(baseRev === undefined ? {} : { baseRev }),
  });
}

export function unarchiveTask(id: string, baseRev?: number): Promise<{ task: TaskDetail }> {
  return request<{ task: TaskDetail }>(`/tasks/${encodeURIComponent(id)}/unarchive`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(baseRev === undefined ? {} : { baseRev }),
  });
}

export function addObservation(
  id: string,
  body: ObservationRequest,
): Promise<{ task: TaskDetail }> {
  return request<{ task: TaskDetail }>(`/tasks/${encodeURIComponent(id)}/observations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function getAttachments(id: string): Promise<{ attachments: Attachment[] }> {
  return request<{ attachments: Attachment[] }>(`/tasks/${encodeURIComponent(id)}/attachments`);
}

export function uploadAttachments(
  id: string,
  files: File[],
): Promise<{ attachments: Attachment[] }> {
  const form = new FormData();
  for (const file of files) form.append("files", file, file.name);
  return request<{ attachments: Attachment[] }>(
    `/tasks/${encodeURIComponent(id)}/attachments`,
    { method: "POST", body: form },
  );
}

export function deleteAttachment(id: string, name: string): Promise<void> {
  return request<void>(
    `/tasks/${encodeURIComponent(id)}/attachments/${encodeURIComponent(name)}`,
    { method: "DELETE" },
  );
}

/** Absolute API url for an attachment (matches Attachment.url shape). */
export function attachmentUrl(id: string, name: string): string {
  return `${BASE}/tasks/${encodeURIComponent(id)}/attachments/${encodeURIComponent(name)}`;
}

export function postExport(body: ExportRequest): Promise<{ result: ExportResult }> {
  return request<{ result: ExportResult }>("/export", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function getExports(): Promise<{ exports: ExportListItem[] }> {
  return request<{ exports: ExportListItem[] }>("/exports");
}

export function getGraph(project?: string): Promise<{ graph: GraphData }> {
  const qs = project && project !== "All" ? `?project=${encodeURIComponent(project)}` : "";
  return request<{ graph: GraphData }>(`/graph${qs}`);
}

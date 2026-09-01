import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import type {
  BoardConfig,
  CodeGraphData,
  CreateProjectRequest,
  CreateRequest,
  EditableFields,
  ExportRequest,
  GraphData,
  ObservationRequest,
  PatchRequest,
  TaskDetail,
  TaskDetailOrInvalid,
  TaskFilter,
  TaskSummaryOrInvalid,
  UpdateProjectRequest,
  CreateLibraryResource,
  ProjectDocumentation,
} from "@AiDailyTasks/shared";
import * as api from "./client";
import { ApiRequestError } from "./client";
import { beginTaskWrite, endTaskWrite } from "@/events/pendingTaskWrites";
import { toast } from "@/store/toast";

export type TasksResponse = { tasks: TaskSummaryOrInvalid[] };
export type TaskResponse = { task: TaskDetailOrInvalid };

// ── Queries ──────────────────────────────────────────────────────────────────

export function useConfig() {
  return useQuery<BoardConfig>({
    queryKey: ["config"],
    queryFn: api.getConfig,
    staleTime: 5 * 60 * 1000,
  });
}

export function useUpdateConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.updateConfig,
    onSuccess: (config) => qc.setQueryData(["config"], config),
    onError: (err) => toast(err instanceof ApiRequestError ? err.message : "Couldn't save settings.", "error"),
  });
}

export function useMcpInfo() {
  return useQuery({
    queryKey: ["mcp-info"],
    queryFn: api.getMcpInfo,
    staleTime: 60 * 60 * 1000,
  });
}

export function useTasks(filter: TaskFilter) {
  return useQuery<TasksResponse>({
    queryKey: ["tasks", filter],
    queryFn: () => api.getTasks(filter),
  });
}

export function useTask(id: string | null | undefined) {
  return useQuery<TaskResponse>({
    queryKey: ["task", id],
    queryFn: () => api.getTask(id as string),
    enabled: !!id,
  });
}

export function useGraph(project?: string) {
  return useQuery<{ graph: GraphData }>({
    queryKey: ["graph", project ?? "All"],
    queryFn: () => api.getGraph(project),
  });
}

export function useExports() {
  return useQuery({
    queryKey: ["exports"],
    queryFn: api.getExports,
  });
}

export function useCodeGraph(projectId: string | null | undefined) {
  return useQuery<CodeGraphData>({
    queryKey: ["code-graph", projectId],
    queryFn: () => api.getCodeGraph(projectId as string),
    enabled: !!projectId,
    // While indexing, poll as a fallback in case the SSE nudge is missed.
    refetchInterval: (query) =>
      query.state.data?.meta.status === "indexing" ? 2500 : false,
  });
}

export function useProjectDocumentation(projectId: string | null | undefined) {
  return useQuery<ProjectDocumentation>({
    queryKey: ["project-documentation", projectId],
    queryFn: () => api.getProjectDocumentation(projectId as string),
    enabled: !!projectId,
  });
}

export function useAttachments(id: string | null | undefined) {
  return useQuery({
    queryKey: ["attachments", id],
    queryFn: () => api.getAttachments(id as string),
    enabled: !!id,
  });
}

// ── Optimistic helpers ─────────────────────────────────────────────────────────

function applyFieldsToSummary(
  data: TasksResponse | undefined,
  id: string,
  fields: EditableFields,
): TasksResponse | undefined {
  if (!data) return data;
  return {
    tasks: data.tasks.map((t) =>
      t.id === id && t.valid ? { ...t, ...fields } : t,
    ),
  };
}

function applyFieldsToDetail(
  data: TaskResponse | undefined,
  fields: EditableFields,
): TaskResponse | undefined {
  if (!data || !data.task.valid) return data;
  return { task: { ...data.task, ...fields } };
}

interface PatchVars {
  id: string;
  body: PatchRequest;
}

interface PatchContext {
  id: string;
  prevTasks: [readonly unknown[], TasksResponse | undefined][];
  prevTask: TaskResponse | undefined;
}

function invalidateTaskViews(qc: QueryClient, id: string): void {
  void qc.invalidateQueries({ queryKey: ["tasks"] });
  void qc.invalidateQueries({ queryKey: ["task", id] });
  void qc.invalidateQueries({ queryKey: ["graph"] });
}

/** The rev this tab currently believes a task is at. */
function currentRev(qc: QueryClient, id: string): number | undefined {
  return qc.getQueryData<TaskResponse>(["task", id])?.task?.rev;
}

/**
 * Close out a write and decide whether the echoes we swallowed while it ran were
 * really ours. Anything at a different rev came from another writer (or another
 * tab) and still needs to be picked up.
 */
function settleTaskWrite(qc: QueryClient, id: string): void {
  const suppressed = endTaskWrite(id);
  if (suppressed.some((rev) => rev !== currentRev(qc, id))) invalidateTaskViews(qc, id);
}

// ── Mutations ──────────────────────────────────────────────────────────────────

export function useAddProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateProjectRequest) => api.addProject(body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["config"] });
    },
    onError: (err) => {
      const message =
        err instanceof ApiRequestError ? err.message : "Couldn't add the project.";
      toast(message, "error");
    },
  });
}

export function useUpdateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateProjectRequest }) =>
      api.updateProject(id, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["config"] });
    },
    onError: (err) => {
      const message =
        err instanceof ApiRequestError ? err.message : "Couldn't update the project.";
      toast(message, "error");
    },
  });
}

export function useDeleteProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteProject(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["config"] });
    },
    onError: (err) => {
      const message =
        err instanceof ApiRequestError ? err.message : "Couldn't delete the project.";
      toast(message, "error");
    },
  });
}

export function useUpdateProjectDocumentation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, instructions }: { id: string; instructions: string }) =>
      api.updateProjectDocumentation(id, instructions),
    onSuccess: (data, { id }) => qc.setQueryData(["project-documentation", id], data),
    onError: (err) => toast(err instanceof ApiRequestError ? err.message : "Couldn't save project documentation.", "error"),
  });
}

export function useImportProjectReadme() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.importProjectReadme(id),
    onSuccess: (data, id) => qc.setQueryData(["project-documentation", id], data),
    onError: (err) => toast(err instanceof ApiRequestError ? err.message : "Couldn't import the project README.", "error"),
  });
}

export function useGenerateCodeGraph() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (projectId: string) => api.generateCodeGraph(projectId),
    onSuccess: ({ meta }, projectId) => {
      // Reflect the "indexing" status immediately; SSE/polling take it from here.
      qc.setQueryData<CodeGraphData>(["code-graph", projectId], (old) =>
        old ? { ...old, meta } : { meta, nodes: [], edges: [] },
      );
    },
    onError: (err) => {
      const message =
        err instanceof ApiRequestError ? err.message : "Couldn't start graph generation.";
      toast(message, "error");
    },
  });
}

export function useCreateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateRequest) => api.createTask(body),
    onSuccess: ({ task }) => {
      qc.setQueryData<TaskResponse>(["task", task.id], { task });
      void qc.invalidateQueries({ queryKey: ["tasks"] });
      void qc.invalidateQueries({ queryKey: ["graph"] });
    },
  });
}

export function usePatchTask() {
  const qc = useQueryClient();
  return useMutation<{ task: TaskDetail }, unknown, PatchVars, PatchContext>({
    mutationFn: ({ id, body }) => api.patchTask(id, body),
    onMutate: async ({ id, body }) => {
      beginTaskWrite(id);
      await qc.cancelQueries({ queryKey: ["tasks"] });
      await qc.cancelQueries({ queryKey: ["task", id] });

      const prevTasks = qc.getQueriesData<TasksResponse>({ queryKey: ["tasks"] }) as [
        readonly unknown[],
        TasksResponse | undefined,
      ][];
      const prevTask = qc.getQueryData<TaskResponse>(["task", id]);

      const fields = body.fields;
      if (fields) {
        qc.setQueriesData<TasksResponse>({ queryKey: ["tasks"] }, (old) =>
          applyFieldsToSummary(old, id, fields),
        );
        qc.setQueryData<TaskResponse>(["task", id], (old) =>
          applyFieldsToDetail(old, fields),
        );
      }

      return { id, prevTasks, prevTask };
    },
    onError: (err, _vars, ctx) => {
      // roll back the optimistic write
      if (ctx) {
        for (const [key, data] of ctx.prevTasks) qc.setQueryData(key, data);
        qc.setQueryData(["task", ctx.id], ctx.prevTask);
      }
      if (err instanceof ApiRequestError && err.conflict) {
        // adopt the on-disk state so the user can review + retry
        qc.setQueryData<TaskResponse>(["task", ctx!.id], {
          task: err.conflict.current,
        });
        toast("Reloaded — this task changed on disk. Review and retry.", "error");
      }
    },
    onSuccess: ({ task }, { id }) => {
      qc.setQueryData<TaskResponse>(["task", id], { task });
    },
    onSettled: (_data, _err, { id }) => {
      endTaskWrite(id);
      invalidateTaskViews(qc, id);
    },
  });
}

export function useAddObservation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: ObservationRequest }) =>
      api.addObservation(id, body),
    // Registered before the request goes out so the server's SSE echo — which can
    // beat the response back — is recognised as ours instead of triggering a
    // full board refetch.
    onMutate: ({ id }) => {
      beginTaskWrite(id);
    },
    onSettled: (_data, _err, { id }) => {
      settleTaskWrite(qc, id);
    },
    onSuccess: ({ task }, { id }) => {
      qc.setQueryData<TaskResponse>(["task", id], { task });
      // The save response already has the current task. Updating its compact card
      // in place avoids a full board scan after every appended note.
      qc.setQueriesData<TasksResponse>({ queryKey: ["tasks"] }, (old) =>
        old
          ? {
              tasks: old.tasks.map((entry) =>
                entry.valid && entry.id === id
                  ? {
                      ...entry,
                      rev: task.rev,
                      updated: task.updated,
                      updatedEffective: task.updatedEffective,
                      observationCount: task.observationCount,
                    }
                  : entry,
              ),
            }
          : old,
      );
    },
    onError: (err, { id }) => {
      if (err instanceof ApiRequestError && err.conflict) {
        qc.setQueryData<TaskResponse>(["task", id], { task: err.conflict.current });
        toast("Reloaded — this task changed on disk. Review and retry.", "error");
      }
    },
  });
}

export function useArchiveTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, baseRev }: { id: string; baseRev?: number }) => api.archiveTask(id, baseRev),
    onMutate: ({ id }) => {
      beginTaskWrite(id);
    },
    onSettled: (_data, _err, { id }) => {
      endTaskWrite(id);
    },
    onSuccess: ({ task, successor }, { id }) => {
      qc.setQueryData<TaskResponse>(["task", id], { task });
      invalidateTaskViews(qc, id);
      if (successor) invalidateTaskViews(qc, successor.id);
    },
    onError: (err, { id }) => {
      if (err instanceof ApiRequestError && err.conflict) {
        qc.setQueryData<TaskResponse>(["task", id], { task: err.conflict.current });
        toast("Reloaded — this task changed on disk. Review and retry.", "error");
      }
    },
  });
}

export function useUnarchiveTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, baseRev }: { id: string; baseRev?: number }) => api.unarchiveTask(id, baseRev),
    onMutate: ({ id }) => {
      beginTaskWrite(id);
    },
    onSettled: (_data, _err, { id }) => {
      endTaskWrite(id);
    },
    onSuccess: ({ task }, { id }) => {
      qc.setQueryData<TaskResponse>(["task", id], { task });
      invalidateTaskViews(qc, id);
    },
    onError: (err, { id }) => {
      if (err instanceof ApiRequestError && err.conflict) {
        qc.setQueryData<TaskResponse>(["task", id], { task: err.conflict.current });
        toast("Reloaded — this task changed on disk. Review and retry.", "error");
      }
    },
  });
}

export function useUploadAttachments() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, files }: { id: string; files: File[] }) =>
      api.uploadAttachments(id, files),
    onSuccess: (_data, { id }) => {
      void qc.invalidateQueries({ queryKey: ["attachments", id] });
      void qc.invalidateQueries({ queryKey: ["task", id] });
      void qc.invalidateQueries({ queryKey: ["tasks"] });
    },
  });
}

export function useDeleteAttachment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      api.deleteAttachment(id, name),
    onSuccess: (_data, { id }) => {
      void qc.invalidateQueries({ queryKey: ["attachments", id] });
      void qc.invalidateQueries({ queryKey: ["task", id] });
      void qc.invalidateQueries({ queryKey: ["tasks"] });
    },
  });
}

export function useLibraryResources() { return useQuery({ queryKey: ["library-resources"], queryFn: api.getLibraryResources }); }
export function useCreateLibraryResource() { const qc = useQueryClient(); return useMutation({ mutationFn: api.createLibraryResource, onSuccess: () => void qc.invalidateQueries({ queryKey: ["library-resources"] }), onError: () => toast("Couldn't save resource.", "error") }); }
export function useDeleteLibraryResource() { const qc = useQueryClient(); return useMutation({ mutationFn: api.deleteLibraryResource, onSuccess: () => void qc.invalidateQueries({ queryKey: ["library-resources"] }), onError: () => toast("Couldn't delete resource.", "error") }); }
export function useUploadLibraryResourceFile() { const qc = useQueryClient(); return useMutation({ mutationFn: ({ id, file }: { id: string; file: File }) => api.uploadLibraryResourceFile(id, file), onSuccess: () => void qc.invalidateQueries({ queryKey: ["library-resources"] }), onError: () => toast("Couldn't upload the resource file.", "error") }); }

export function useUploadResourceFiles() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, files }: { id: string; files: File[] }) => api.uploadResourceFiles(id, files),
    onSuccess: (_data, { id }) => void qc.invalidateQueries({ queryKey: ["task", id] }),
  });
}

/** Prepend one older page without replacing the drawer's currently-rendered notes. */
export function useLoadOlderObservations() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, cursor }: { id: string; cursor: string }) => api.getObservations(id, cursor),
    onSuccess: (page, { id }) => {
      qc.setQueryData<TaskResponse>(["task", id], (old) => {
        if (!old?.task.valid) return old;
        return {
          task: {
            ...old.task,
            observations: [...page.observations, ...old.task.observations],
            observationCount: page.total,
            nextObservationCursor: page.nextCursor,
          },
        };
      });
    },
    onError: () => toast("Couldn't load older observations.", "error"),
  });
}

export function useDeleteResourceFile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => api.deleteResourceFile(id, name),
    onSuccess: (_data, { id }) => void qc.invalidateQueries({ queryKey: ["task", id] }),
  });
}

export function useExport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ExportRequest) => api.postExport(body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["exports"] });
    },
  });
}

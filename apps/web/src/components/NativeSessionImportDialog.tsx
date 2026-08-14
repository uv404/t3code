import { useAtomValue, useAtomRefresh } from "@effect/atom-react";
import type {
  DiscoveredNativeSession,
  EnvironmentId,
  ImportNativeSessionInput,
  NativeSessionActivity,
  NativeSessionImportState,
  ProviderDriverKind,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import {
  AlertTriangleIcon,
  CheckIcon,
  ChevronDownIcon,
  DownloadIcon,
  FolderIcon,
  LoaderCircleIcon,
  SearchIcon,
  TerminalIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "@tanstack/react-router";

import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useAtomCommand } from "../state/use-atom-command";
import { nativeSessionEnvironment } from "../state/nativeSessions";
import { environmentShell } from "../state/shell";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { useProjects } from "../state/entities";
import { buildThreadRouteParams } from "../threadRoutes";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

type SelectedSession = {
  readonly environmentId: EnvironmentId;
  readonly discovered: DiscoveredNativeSession;
};

function providerLabel(provider: ProviderDriverKind): string {
  return provider
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function activityLabel(activity: NativeSessionActivity): string {
  switch (activity) {
    case "notLoaded":
      return "Ready to import";
    case "unknown":
      return "Activity unknown";
    case "idle":
      return "Open in another process";
    case "running":
      return "Running in another process";
    case "error":
      return "Provider reported an error";
  }
}

function importStateLabel(state: NativeSessionImportState): string {
  return state._tag === "imported" ? "Open thread" : "Import";
}

function sessionTitle(session: DiscoveredNativeSession["session"]): string {
  return session.title ?? session.nativeId;
}

function sessionSubtitle(session: DiscoveredNativeSession["session"]): string {
  const parts = [providerLabel(session.provider)];
  if (session.model) parts.push(session.model);
  if (session.cwd) parts.push(session.cwd);
  return parts.join(" · ");
}

function NativeSessionEnvironmentList(props: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly searchTerm: string;
  readonly selected: SelectedSession | null;
  readonly onSelect: (selected: SelectedSession) => void;
  readonly onOpenImported: (environmentId: EnvironmentId, threadId: string) => void;
}) {
  const result = useAtomValue(
    nativeSessionEnvironment.discover({
      environmentId: props.environmentId,
      input: props.searchTerm.trim().length > 0 ? { searchTerm: props.searchTerm.trim() } : {},
    }),
  );
  const sessions = Option.getOrElse(AsyncResult.value(result), () => null)?.sessions ?? [];
  const unsupportedProviders =
    Option.getOrElse(AsyncResult.value(result), () => null)?.unsupportedProviders ?? [];
  const error = AsyncResult.isFailure(result) ? Cause.squash(result.cause) : null;

  return (
    <section className="flex min-h-0 flex-col gap-2">
      <div className="flex items-center justify-between gap-2 text-xs font-medium text-muted-foreground">
        <span className="truncate">{props.environmentLabel}</span>
        {result.waiting ? <LoaderCircleIcon className="size-3.5 animate-spin" /> : null}
      </div>
      {error ? (
        <p className="rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-sm text-destructive">
          {error instanceof Error ? error.message : "Could not discover native sessions."}
        </p>
      ) : null}
      {!result.waiting && sessions.length === 0 && !error ? (
        <p className="rounded-lg border border-border/70 px-3 py-4 text-center text-sm text-muted-foreground">
          No native sessions found.
        </p>
      ) : null}
      <div className="flex min-h-0 flex-col gap-1 overflow-y-auto">
        {sessions.map((discovered) => {
          const session = discovered.session;
          const imported = discovered.importState._tag === "imported";
          const blocked =
            !imported && session.activity !== "notLoaded" && session.activity !== "unknown";
          const isSelected =
            props.selected?.environmentId === props.environmentId &&
            props.selected.discovered.session.nativeId === session.nativeId;
          return (
            <button
              key={`${props.environmentId}:${session.nativeId}`}
              type="button"
              disabled={blocked}
              className={cn(
                "flex w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors",
                isSelected
                  ? "border-primary/60 bg-primary/8"
                  : "border-border/70 hover:bg-muted/60",
                blocked && "cursor-not-allowed opacity-55",
              )}
              onClick={() => {
                if (imported) {
                  props.onOpenImported(
                    props.environmentId,
                    discovered.importState._tag === "imported"
                      ? discovered.importState.threadId
                      : "",
                  );
                } else {
                  props.onSelect({ environmentId: props.environmentId, discovered });
                }
              }}
            >
              <TerminalIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{sessionTitle(session)}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {sessionSubtitle(session)}
                </span>
                <span
                  className={cn(
                    "mt-1 block text-[11px]",
                    blocked ? "text-destructive" : "text-muted-foreground",
                  )}
                >
                  {imported
                    ? importStateLabel(discovered.importState)
                    : activityLabel(session.activity)}
                </span>
              </span>
              {isSelected ? <CheckIcon className="mt-0.5 size-4 shrink-0 text-primary" /> : null}
            </button>
          );
        })}
      </div>
      {unsupportedProviders.length > 0 ? (
        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
          {unsupportedProviders.map(providerLabel).join(", ")} cannot be searched yet.
        </p>
      ) : null}
    </section>
  );
}

export function NativeSessionImportDialog() {
  const [open, setOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [selected, setSelected] = useState<SelectedSession | null>(null);
  const [projectId, setProjectId] = useState<ProjectId | "">("");
  const [title, setTitle] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projects = useProjects();
  const router = useRouter();
  const importSession = useAtomCommand(nativeSessionEnvironment.import, {
    label: "native-session-import",
  });
  const refreshShell = useAtomRefresh(
    environmentShell.stateAtom(
      selected?.environmentId ?? primaryEnvironmentId ?? ("native-session" as EnvironmentId),
    ),
  );

  const selectedProjects = useMemo(() => {
    if (!selected) return [];
    const cwd = selected.discovered.session.cwd;
    const inEnvironment = projects.filter(
      (project) => project.environmentId === selected.environmentId,
    );
    if (!cwd) return inEnvironment;
    const exact = inEnvironment.filter((project) => project.workspaceRoot === cwd);
    return exact.length > 0 ? exact : inEnvironment;
  }, [projects, selected]);

  const selectedSessionIsUnknown = selected?.discovered.session.activity === "unknown";
  const canImport =
    selected !== null && projectId !== "" && (!selectedSessionIsUnknown || acknowledged);

  useEffect(() => {
    if (!open) {
      setSearchTerm("");
      setSelected(null);
      setProjectId("");
      setTitle("");
      setAcknowledged(false);
      setError(null);
    }
  }, [open]);

  useEffect(() => {
    if (!selected) {
      setProjectId("");
      return;
    }
    const cwd = selected.discovered.session.cwd;
    const hasExactProject =
      cwd !== undefined && selectedProjects.some((project) => project.workspaceRoot === cwd);
    setProjectId(
      selectedProjects.length === 1 && (!cwd || hasExactProject) ? selectedProjects[0]!.id : "",
    );
    setTitle(selected.discovered.session.title ?? "");
    setAcknowledged(false);
    setError(null);
  }, [selected, selectedProjects]);

  const handleOpenImported = useCallback(
    (environmentId: EnvironmentId, threadId: string) => {
      if (!threadId) return;
      setOpen(false);
      void router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(environmentId, threadId as ThreadId)),
      });
    },
    [router],
  );

  const handleImport = useCallback(async () => {
    if (!selected || projectId === "") return;
    setError(null);
    const input: ImportNativeSessionInput = {
      provider: selected.discovered.session.provider,
      ...(selected.discovered.session.providerInstanceId
        ? { providerInstanceId: selected.discovered.session.providerInstanceId }
        : {}),
      nativeId: selected.discovered.session.nativeId,
      projectId,
      ...(title.trim().length > 0 ? { title: title.trim() } : {}),
      ...(selectedSessionIsUnknown ? { acknowledgeUnknownActivity: acknowledged } : {}),
    };
    const result = await importSession({ environmentId: selected.environmentId, input });
    if (AsyncResult.isFailure(result)) {
      const cause = Cause.squash(result.cause);
      setError(cause instanceof Error ? cause.message : "Could not import native session.");
      return;
    }
    refreshShell();
    setOpen(false);
    void router.navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(selected.environmentId, result.value.threadId)),
    });
  }, [
    acknowledged,
    importSession,
    projectId,
    refreshShell,
    router,
    selected,
    selectedSessionIsUnknown,
    title,
  ]);

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label="Import native session"
              onClick={() => setOpen(true)}
            />
          }
        >
          <DownloadIcon />
        </TooltipTrigger>
        <TooltipPopup side="right">Import native session</TooltipPopup>
      </Tooltip>
      <Dialog open={open} onOpenChange={setOpen}>
        {open ? (
          <DialogPopup className="max-w-2xl" bottomStickOnMobile={false}>
            <DialogHeader>
              <DialogTitle>Import native session</DialogTitle>
              <DialogDescription>
                Resume a session started in a provider’s terminal or another client.
              </DialogDescription>
              <div className="relative mt-2">
                <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={searchTerm}
                  onChange={(event) => setSearchTerm(event.currentTarget.value)}
                  placeholder="Search sessions"
                  aria-label="Search native sessions"
                  className="pl-9"
                />
              </div>
            </DialogHeader>
            <DialogPanel className="flex min-h-0 flex-col gap-5">
              {environments.length === 0 ? (
                <p className="text-sm text-muted-foreground">No connected environments.</p>
              ) : (
                environments.map((environment) => (
                  <NativeSessionEnvironmentList
                    key={environment.environmentId}
                    environmentId={environment.environmentId}
                    environmentLabel={environment.label}
                    searchTerm={searchTerm}
                    selected={selected}
                    onSelect={setSelected}
                    onOpenImported={handleOpenImported}
                  />
                ))
              )}
              {selected ? (
                <div className="flex flex-col gap-3 rounded-xl border border-border/70 bg-muted/25 p-4">
                  <div>
                    <p className="text-sm font-medium">Import settings</p>
                    <p className="text-xs text-muted-foreground">
                      Choose where this session should appear in T3.
                    </p>
                  </div>
                  <label className="flex flex-col gap-1.5 text-sm">
                    <span className="text-xs font-medium text-muted-foreground">Project</span>
                    <span className="relative">
                      <FolderIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                      <select
                        value={projectId}
                        onChange={(event) => setProjectId(event.currentTarget.value as ProjectId)}
                        className="h-9 w-full appearance-none rounded-md border border-input bg-background pl-9 pr-8 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        aria-label="Import project"
                      >
                        <option value="">Select a project</option>
                        {selectedProjects.map((project) => (
                          <option key={project.id} value={project.id}>
                            {project.workspaceRoot}
                          </option>
                        ))}
                      </select>
                      <ChevronDownIcon className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    </span>
                  </label>
                  <label className="flex flex-col gap-1.5 text-sm">
                    <span className="text-xs font-medium text-muted-foreground">
                      Thread title (optional)
                    </span>
                    <Input
                      value={title}
                      onChange={(event) => setTitle(event.currentTarget.value)}
                    />
                  </label>
                  {selectedSessionIsUnknown ? (
                    <label className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/8 p-3 text-sm">
                      <input
                        type="checkbox"
                        checked={acknowledged}
                        onChange={(event) => setAcknowledged(event.currentTarget.checked)}
                        className="mt-0.5 size-4 accent-amber-600"
                      />
                      <span>
                        <span className="block font-medium">Activity cannot be verified</span>
                        <span className="block text-xs text-muted-foreground">
                          T3 cannot tell whether a terminal still has this session open. Importing
                          may create two writers.
                        </span>
                      </span>
                    </label>
                  ) : null}
                </div>
              ) : null}
              {selected && selectedProjects.length === 0 ? (
                <p className="text-sm text-destructive">
                  This session is not inside a configured project. Add the project first, then try
                  again.
                </p>
              ) : null}
              {error ? <p className="text-sm text-destructive">{error}</p> : null}
            </DialogPanel>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="button" disabled={!canImport} onClick={() => void handleImport()}>
                Import session
              </Button>
            </DialogFooter>
          </DialogPopup>
        ) : null}
      </Dialog>
    </>
  );
}

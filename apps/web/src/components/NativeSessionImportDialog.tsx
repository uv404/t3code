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
import { ProjectFavicon } from "./ProjectFavicon";
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
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "./ui/menu";
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
    <section className="flex min-h-0 flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2 px-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
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
      <div className="flex min-h-0 flex-col gap-1">
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
                "flex w-full items-start gap-2 rounded-md border px-2.5 py-2 text-left transition-colors",
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
              <TerminalIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium leading-5">
                  {sessionTitle(session)}
                </span>
                <span className="flex min-w-0 items-center gap-1.5 text-[11px] leading-4 text-muted-foreground">
                  <span className="min-w-0 truncate">{sessionSubtitle(session)}</span>
                  <span aria-hidden="true">·</span>
                  <span className={cn("shrink-0", blocked && "text-destructive")}>
                    {imported
                      ? importStateLabel(discovered.importState)
                      : activityLabel(session.activity)}
                  </span>
                </span>
              </span>
              {isSelected ? <CheckIcon className="mt-0.5 size-3.5 shrink-0 text-primary" /> : null}
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

  const selectedProject = useMemo(
    () => selectedProjects.find((project) => project.id === projectId) ?? null,
    [selectedProjects, projectId],
  );

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
          <DialogPopup
            className="max-h-[min(760px,calc(100dvh-1rem))] max-w-2xl overflow-hidden"
            bottomStickOnMobile={false}
          >
            <DialogHeader className="shrink-0 p-4 pb-2">
              <DialogTitle>
                {selected ? "Choose import location" : "Import native session"}
              </DialogTitle>
              <DialogDescription>
                {selected
                  ? "Choose the T3 project for this session."
                  : "Resume a session started in a provider’s terminal or another client."}
              </DialogDescription>
              {!selected ? (
                <div className="relative mt-1">
                  <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={searchTerm}
                    onChange={(event) => setSearchTerm(event.currentTarget.value)}
                    placeholder="Search sessions"
                    aria-label="Search native sessions"
                    className="pl-9"
                  />
                </div>
              ) : null}
            </DialogHeader>
            <DialogPanel className="flex h-full min-h-0 flex-1 flex-col gap-3 overflow-hidden p-4">
              {selected ? (
                <div className="shrink-0 rounded-lg border border-border/70 bg-muted/25 p-3">
                  <div className="mb-2 flex min-w-0 items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">
                        {sessionTitle(selected.discovered.session)}
                      </p>
                      <p className="truncate text-[11px] text-muted-foreground">
                        {providerLabel(selected.discovered.session.provider)}
                      </p>
                    </div>
                    <span className="shrink-0 text-[11px] text-muted-foreground">Import to</span>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
                    <label className="flex min-w-0 flex-col gap-1 text-sm">
                      <span className="text-[11px] font-medium text-muted-foreground">Project</span>
                      <Menu>
                        <MenuTrigger
                          aria-label="Import project"
                          className="flex h-8 w-full items-center gap-1.5 rounded-md border border-input bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          {selectedProject ? (
                            <ProjectFavicon
                              environmentId={selectedProject.environmentId}
                              cwd={selectedProject.workspaceRoot}
                              faviconPath={selectedProject.faviconPath}
                              className="size-3.5 shrink-0"
                            />
                          ) : null}
                          <span className="min-w-0 flex-1 truncate text-left">
                            {selectedProject?.title ?? "Select a project"}
                          </span>
                          <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
                        </MenuTrigger>
                        <MenuPopup align="start" className="w-(--anchor-width)">
                          <MenuRadioGroup
                            value={projectId}
                            onValueChange={(value) => setProjectId(value as ProjectId)}
                          >
                            {selectedProjects.map((project) => (
                              <MenuRadioItem key={project.id} value={project.id}>
                                <span className="flex min-w-0 items-center gap-1.5">
                                  <ProjectFavicon
                                    environmentId={project.environmentId}
                                    cwd={project.workspaceRoot}
                                    faviconPath={project.faviconPath}
                                    className="size-3.5 shrink-0"
                                  />
                                  <span className="truncate" title={project.workspaceRoot}>
                                    {project.title}
                                  </span>
                                </span>
                              </MenuRadioItem>
                            ))}
                          </MenuRadioGroup>
                        </MenuPopup>
                      </Menu>
                    </label>
                    <label className="flex min-w-0 flex-col gap-1 text-sm">
                      <span className="text-[11px] font-medium text-muted-foreground">
                        Thread title
                      </span>
                      <Input
                        value={title}
                        onChange={(event) => setTitle(event.currentTarget.value)}
                        className="h-8 text-xs"
                        placeholder="Use session title"
                      />
                    </label>
                  </div>
                  {selectedSessionIsUnknown ? (
                    <label className="mt-2 flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/8 p-2 text-xs">
                      <input
                        type="checkbox"
                        checked={acknowledged}
                        onChange={(event) => setAcknowledged(event.currentTarget.checked)}
                        className="mt-0.5 size-3.5 accent-amber-600"
                      />
                      <span>
                        <span className="block font-medium">Activity cannot be verified</span>
                        <span className="block text-[11px] text-muted-foreground">
                          T3 cannot tell whether a terminal still has this session open. Importing
                          may create two writers.
                        </span>
                      </span>
                    </label>
                  ) : null}
                </div>
              ) : null}
              {selected && selectedProjects.length === 0 ? (
                <p className="shrink-0 text-xs text-destructive">
                  This session is not inside a configured project. Add the project first, then try
                  again.
                </p>
              ) : null}
              {error ? <p className="shrink-0 text-xs text-destructive">{error}</p> : null}
              {!selected ? (
                <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1">
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
                </div>
              ) : null}
            </DialogPanel>
            <DialogFooter className="shrink-0 px-4 py-2.5">
              <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              {selected ? (
                <>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setSelected(null);
                      setError(null);
                    }}
                  >
                    Back
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    disabled={!canImport}
                    onClick={() => void handleImport()}
                  >
                    Import session
                  </Button>
                </>
              ) : null}
            </DialogFooter>
          </DialogPopup>
        ) : null}
      </Dialog>
    </>
  );
}

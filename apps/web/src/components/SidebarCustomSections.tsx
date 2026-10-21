import { useAtomValue } from "@effect/atom-react";
import { useDroppable } from "@dnd-kit/core";
import type { EnvironmentServerConfig } from "@t3tools/client-runtime/connection";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type SidebarSectionId,
  type SidebarSectionsUpdateInput,
  type ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useEffect, useId, useState, type ReactNode } from "react";
import { create } from "zustand";

import { useLocalStorage } from "../hooks/useLocalStorage";
import { readLocalApi } from "../localApi";
import { environmentIdsKey } from "../state/environmentAtomList";
import { readEnvironmentScope } from "../state/session";
import { sidebarSectionsStates, updateSidebarSections } from "../state/sidebarSections";
import { useAtomCommand } from "../state/use-atom-command";
import {
  type CustomSectionKey,
  type CustomSectionView,
  type SidebarSectionsIndex,
  type SidebarThreadLists,
  customSectionDroppableId,
  indexSidebarSections,
} from "./SidebarCustomSections.logic";
import { Button } from "./ui/button";
import { CollapsibleSectionHeader } from "./ui/collapsible-section-header";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { stackedThreadToast, toastManager } from "./ui/toast";

type NameRequest = {
  readonly title: string;
  readonly initial: string;
  readonly resolve: (name: string | null) => void;
};
const useNameRequest = create<{ request: NameRequest | null }>(() => ({ request: null }));

function requestSectionName(title: string, initial = ""): Promise<string | null> {
  useNameRequest.getState().request?.resolve(null);
  return new Promise((resolve) =>
    useNameRequest.setState({ request: { title, initial, resolve } }),
  );
}

function finishNameRequest(name: string | null) {
  const request = useNameRequest.getState().request;
  useNameRequest.setState({ request: null });
  request?.resolve(name);
}

export function SectionNameDialogHost() {
  const request = useNameRequest((state) => state.request);
  useEffect(() => () => finishNameRequest(null), []);
  return request ? <SectionNameDialog request={request} /> : null;
}

function SectionNameDialog({ request }: { readonly request: NameRequest }) {
  const id = useId();
  const [name, setName] = useState(request.initial);
  const trimmed = name.trim();
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) finishNameRequest(null);
      }}
    >
      <DialogPopup className="sm:max-w-sm">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (trimmed.length > 0) finishNameRequest(trimmed);
          }}
        >
          <DialogHeader>
            <DialogTitle>{request.title}</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <Input
              id={id}
              aria-label="Section name"
              autoFocus
              maxLength={80}
              placeholder="Heavy mode"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => finishNameRequest(null)}>
              Cancel
            </Button>
            <Button type="submit" disabled={trimmed.length === 0}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

export function useSidebarSectionsIndex(
  serverConfigs: ReadonlyMap<EnvironmentId, EnvironmentServerConfig>,
): SidebarSectionsIndex {
  const environmentIds = [...serverConfigs].flatMap(([environmentId, config]) =>
    config.environment.capabilities.sidebarSections === true ? [environmentId] : [],
  );
  const states = useAtomValue(sidebarSectionsStates(environmentIdsKey(environmentIds)));
  return indexSidebarSections(
    environmentIds.map((environmentId, index) => ({ environmentId, state: states[index]! })),
    (environmentId, threadId) => scopedThreadKey(scopeThreadRef(environmentId, threadId)),
  );
}

export function useCustomSectionActions() {
  const update = useAtomCommand(updateSidebarSections, { reportFailure: false });
  const run = async (
    environmentId: EnvironmentId,
    input: SidebarSectionsUpdateInput,
    failureTitle: string,
  ) => {
    if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return null;
    const result = await update({ environmentId, input });
    if (result._tag === "Success") return result.value;
    if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: failureTitle,
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    }
    return null;
  };
  return {
    assign: (
      environmentId: EnvironmentId,
      threadIds: ReadonlyArray<ThreadId>,
      sectionId: SidebarSectionId | null,
    ) =>
      run(
        environmentId,
        { type: "assign", threadIds, sectionId },
        sectionId === null ? "Failed to remove from section" : "Failed to move to section",
      ),
    create: async (environmentId: EnvironmentId, threadIds: ReadonlyArray<ThreadId>) => {
      const title = await requestSectionName("New section");
      if (title === null) return;
      await run(environmentId, { type: "create", title, threadIds }, "Failed to create section");
    },
    rename: async (view: CustomSectionView) => {
      const title = await requestSectionName("Rename section", view.section.title);
      if (title === null || title === view.section.title) return;
      await run(
        view.environmentId,
        { type: "rename", sectionId: view.section.id, title },
        "Failed to rename section",
      );
    },
    move: (view: CustomSectionView, beforeSectionId: SidebarSectionId | null) =>
      run(
        view.environmentId,
        { type: "move", sectionId: view.section.id, beforeSectionId },
        "Failed to move section",
      ),
    remove: async (view: CustomSectionView) => {
      const api = readLocalApi();
      if (!api) return;
      const confirmed = await settlePromise(() =>
        api.dialogs.confirm(
          `Delete section "${view.section.title}"? Its threads move back to the main list.`,
        ),
      );
      if (confirmed._tag === "Failure" || !confirmed.value) return;
      await run(
        view.environmentId,
        { type: "delete", sectionId: view.section.id },
        "Failed to delete section",
      );
    },
  };
}

/** Rename, reorder and delete, from the section header's context menu. */
export function showCustomSectionMenu(input: {
  readonly view: CustomSectionView;
  readonly siblings: ReadonlyArray<CustomSectionView>;
  readonly position: { readonly x: number; readonly y: number };
  readonly actions: ReturnType<typeof useCustomSectionActions>;
}) {
  const { view, siblings, position, actions } = input;
  const api = readLocalApi();
  if (!api) return;
  const index = siblings.findIndex((sibling) => sibling.key === view.key);
  const canOperate = readEnvironmentScope(view.environmentId, AuthOrchestrationOperateScope);
  void (async () => {
    const clicked = await settlePromise(() =>
      api.contextMenu.show(
        [
          { id: "rename", label: "Rename section…", icon: "pencil", disabled: !canOperate },
          {
            id: "up",
            label: "Move up",
            disabled: !canOperate || index <= 0,
            separatorBefore: true,
          },
          {
            id: "down",
            label: "Move down",
            disabled: !canOperate || index === -1 || index >= siblings.length - 1,
          },
          {
            id: "delete",
            label: "Delete section…",
            icon: "trash",
            destructive: true,
            disabled: !canOperate,
            separatorBefore: true,
          },
        ] as const,
        position,
      ),
    );
    if (clicked._tag === "Failure") return;
    switch (clicked.value) {
      case "rename":
        await actions.rename(view);
        return;
      case "up":
        await actions.move(view, siblings[index - 1]!.section.id);
        return;
      case "down":
        await actions.move(view, siblings[index + 2]?.section.id ?? null);
        return;
      case "delete":
        await actions.remove(view);
        return;
    }
  })();
}

const COLLAPSED_SECTIONS_KEY = "t3code:sidebar:custom-sections-collapsed";
const CollapsedSections = Schema.Array(Schema.String);

/** Per-client, like the other shelves' expanded state. */
export function useCollapsedCustomSections() {
  const [collapsed, setCollapsed] = useLocalStorage(
    COLLAPSED_SECTIONS_KEY,
    [] as ReadonlyArray<string>,
    CollapsedSections,
  );
  return {
    collapsed: new Set(collapsed),
    toggle: (key: CustomSectionKey) =>
      setCollapsed((current) =>
        current.includes(key) ? current.filter((entry) => entry !== key) : [...current, key],
      ),
  };
}

type RowSection = "pinned" | "active" | "working" | "snoozed" | "settled";

export function CustomSectionBlock(props: {
  readonly view: CustomSectionView;
  readonly lists: SidebarThreadLists<EnvironmentThreadShell> | undefined;
  readonly collapsed: boolean;
  readonly onToggle: () => void;
  readonly environmentLabel: string | null;
  readonly routeThreadKey: string | null;
  readonly onHeaderContextMenu: (position: { x: number; y: number }) => void;
  readonly renderRow: (thread: EnvironmentThreadShell, section: RowSection) => ReactNode;
}) {
  const { view, lists, collapsed, routeThreadKey, renderRow } = props;
  const { setNodeRef, isOver } = useDroppable({ id: customSectionDroppableId(view.key) });
  const [snoozedExpanded, setSnoozedExpanded] = useState(false);
  const [settledExpanded, setSettledExpanded] = useState(false);
  const keyOf = (thread: EnvironmentThreadShell) =>
    scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
  // A collapsed fold still shows the open thread, like the main list's shelves.
  const visible = (threads: ReadonlyArray<EnvironmentThreadShell>, expanded: boolean) =>
    expanded ? threads : threads.filter((thread) => keyOf(thread) === routeThreadKey);
  const live = [
    ...(lists?.pinnedThreads.map((thread) => [thread, "pinned"] as const) ?? []),
    ...(lists?.activeThreads.map((thread) => [thread, "active"] as const) ?? []),
    ...(lists?.workingThreads.map((thread) => [thread, "working"] as const) ?? []),
  ];
  const snoozed = lists?.snoozedThreads ?? [];
  const settled = lists?.settledThreads ?? [];
  const count = live.length + snoozed.length + settled.length;
  const title =
    props.environmentLabel === null
      ? view.section.title
      : `${view.section.title} · ${props.environmentLabel}`;
  return (
    <li
      ref={setNodeRef}
      data-thread-selection-safe
      data-testid="sidebar-custom-section"
      data-sidebar-custom-section={view.key}
      className="list-none"
    >
      <div className="mx-0.5">
        <CollapsibleSectionHeader
          expanded={!collapsed}
          onClick={props.onToggle}
          onContextMenu={(event) => {
            event.preventDefault();
            props.onHeaderContextMenu({ x: event.clientX, y: event.clientY });
          }}
          tone={isOver ? "accent" : "emphasized"}
          accessory={
            collapsed && count > 0 ? (
              <span className="shrink-0 tabular-nums">{count}</span>
            ) : undefined
          }
        >
          {title}
        </CollapsibleSectionHeader>
      </div>
      {collapsed ? (
        <ul role="presentation" className="flex flex-col gap-px">
          {[
            ...live,
            ...snoozed.map((thread) => [thread, "snoozed"] as const),
            ...settled.map((thread) => [thread, "settled"] as const),
          ]
            .filter(([thread]) => keyOf(thread) === routeThreadKey)
            .map(([thread, section]) => renderRow(thread, section))}
        </ul>
      ) : (
        <ul role="presentation" className="flex flex-col gap-px">
          {count === 0 ? (
            <li className="mx-0.5 flex h-8 items-center rounded-md px-2 text-xs text-sidebar-muted-foreground/55">
              Drag threads here
            </li>
          ) : null}
          {live.map(([thread, section]) => renderRow(thread, section))}
          {snoozed.length > 0 ? (
            <li className="mx-0.5 list-none">
              <CollapsibleSectionHeader
                expanded={snoozedExpanded}
                onClick={() => setSnoozedExpanded((value) => !value)}
                tone="info"
              >
                {snoozedExpanded ? "Snoozed" : `Snoozed (${snoozed.length})`}
              </CollapsibleSectionHeader>
            </li>
          ) : null}
          {visible(snoozed, snoozedExpanded).map((thread) => renderRow(thread, "snoozed"))}
          {settled.length > 0 ? (
            <li className="mx-0.5 list-none">
              <CollapsibleSectionHeader
                expanded={settledExpanded}
                onClick={() => setSettledExpanded((value) => !value)}
              >
                {settledExpanded ? "Settled" : `Settled (${settled.length})`}
              </CollapsibleSectionHeader>
            </li>
          ) : null}
          {visible(settled, settledExpanded).map((thread) => renderRow(thread, "settled"))}
        </ul>
      )}
    </li>
  );
}

/** Marks where the sections end and the usual list starts. */
export function CustomSectionsEnd() {
  return (
    <li
      aria-hidden
      className="mx-0.5 flex h-8 list-none items-center gap-2 px-2 text-xs font-medium text-sidebar-muted-foreground/60"
    >
      <span className="shrink-0">Other threads</span>
      <span className="h-px min-w-2 flex-1 bg-sidebar-border/60" />
    </li>
  );
}

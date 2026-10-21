import { type EnvironmentId, type SidebarSectionsState, WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { environmentAtomList } from "./environmentAtomList";

const sidebarSectionsLive = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "environment-data:sidebar-sections:live",
  tag: WS_METHODS.sidebarSectionsSubscribe,
});

export const updateSidebarSections = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:sidebar-sections:update",
  tag: WS_METHODS.sidebarSectionsUpdate,
});

const EMPTY_STATE: SidebarSectionsState = { sections: [], threads: {} };

const sidebarSectionsState = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) =>
    Option.getOrElse(
      AsyncResult.value(get(sidebarSectionsLive({ environmentId, input: {} }))),
      () => EMPTY_STATE,
    ),
  ),
);

/** Keyed by `environmentIdsKey`; only environments that advertise `sidebarSections`. */
export const sidebarSectionsStates = environmentAtomList(
  "web-sidebar-sections",
  sidebarSectionsState,
);

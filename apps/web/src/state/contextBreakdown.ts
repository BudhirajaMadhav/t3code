import { WS_METHODS } from "@t3tools/contracts";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

export const readContextBreakdown = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-command:provider:read-context-breakdown",
  tag: WS_METHODS.providerReadContextBreakdown,
});

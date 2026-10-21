import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as SidebarSections from "./SidebarSections.ts";

/** The real store in a throwaway state directory, for tests of code that places threads. */
export const layer = SidebarSections.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-sidebar-sections-" })),
  Layer.provide(NodeServices.layer),
);

import { useAtomValue } from "@effect/atom-react";
import type { KeybindingCommand } from "@t3tools/contracts";
import { ArrowLeftIcon, ArrowRightIcon } from "lucide-react";
import { useSyncExternalStore, type ReactNode } from "react";

import { shortcutLabelForCommand } from "~/keybindings";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

// Browsers without the Navigation API (older Safari and Firefox) cannot say whether
// history has an entry to move to, so both buttons stay enabled there.
const hasNavigationApi = () => "navigation" in window;
const subscribeHistory = (onChange: () => void) => {
  if (!hasNavigationApi()) return () => {};
  window.navigation.addEventListener("currententrychange", onChange);
  return () => window.navigation.removeEventListener("currententrychange", onChange);
};
const readCanGoBack = () => !hasNavigationApi() || window.navigation.canGoBack;
const readCanGoForward = () => !hasNavigationApi() || window.navigation.canGoForward;

/** The `navigation.back` / `navigation.forward` shortcuts as buttons. */
export function NavigationHistoryButtons() {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const canGoBack = useSyncExternalStore(subscribeHistory, readCanGoBack);
  const canGoForward = useSyncExternalStore(subscribeHistory, readCanGoForward);
  const button = (
    label: string,
    command: KeybindingCommand,
    icon: ReactNode,
    enabled: boolean,
    go: () => void,
  ) => {
    const shortcut = shortcutLabelForCommand(keybindings, command);
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon-xs"
              variant="ghost-muted"
              aria-label={label}
              disabled={!enabled}
              onClick={go}
            />
          }
        >
          {icon}
        </TooltipTrigger>
        <TooltipPopup side="bottom">
          {label}
          {shortcut ? ` (${shortcut})` : ""}
        </TooltipPopup>
      </Tooltip>
    );
  };

  return (
    <div className="flex items-center max-sm:hidden">
      {button("Back", "navigation.back", <ArrowLeftIcon />, canGoBack, () => window.history.back())}
      {button("Forward", "navigation.forward", <ArrowRightIcon />, canGoForward, () =>
        window.history.forward(),
      )}
    </div>
  );
}

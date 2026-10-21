import { describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { NavigationHistoryButtons } from "./NavigationHistoryButtons";

const nextHistoryEntry = () =>
  new Promise<void>((resolve) =>
    window.navigation.addEventListener("currententrychange", () => resolve(), { once: true }),
  );

describe("NavigationHistoryButtons", () => {
  it("moves through the visited pages and disables a direction with nowhere to go", async () => {
    window.history.pushState(null, "", "#navigation-history-buttons");
    // The buttons drive the window's history, which a test router's memory history never touches.
    await using screen = await render(<NavigationHistoryButtons />, { router: false });
    const back = screen.getByRole("button", { name: "Back" });
    const forward = screen.getByRole("button", { name: "Forward" });
    await expect.element(back).toBeEnabled();
    await expect.element(forward).toBeDisabled();

    await back.hover();
    await expect.element(page.getByText(/^Back \(.*\[\)$/)).toBeVisible();

    const wentBack = nextHistoryEntry();
    await back.click();
    await wentBack;
    await expect.element(forward).toBeEnabled();

    const wentForward = nextHistoryEntry();
    await forward.click();
    await wentForward;
    expect(window.location.hash).toBe("#navigation-history-buttons");
    await expect.element(forward).toBeDisabled();
  });
});

// issue 1982 — an overlay opened from the compose line must survive the TAP
// that opened it, on EVERY overlay that line can open, not just the two
// issue 1831 happened to reach.
//
// The mechanism is issue 1831's, entire, and is not restated here: a command
// that reaches its opener with no `await` ahead of it mounts a full-region
// scrim while the finger is still on the send button; the tap's compat mouse
// events are synthesised after the touch ends and hit-tested against the
// layout as it stands THEN, so the click lands on the scrim and a
// dismiss-on-any-click fires in the gesture that opened the overlay. See
// `issue1831-tap-send-modal-survives.spec.ts` and `lib/backdropDismiss.ts`.
//
// What this spec adds is the SET. The compose command path reaches exactly
// five overlays — measured, by grepping every opener referenced from
// `lib/commands/` and `lib/compose.ts`:
//
//     openBanlistModal      BanlistModal     cured by 1831
//     openModeModal         ModeModal        cured by 1831
//     openUmodeModal        UmodeModal       NOT cured  <- covered below
//     openServiceModal      ServiceModal     NOT cured
//     requestOpenSettings   SettingsDrawer   NOT cured  <- covered below, as reported
//
// 1831 cured two of the five and the other three kept the defect. #1982 is
// what the third one looks like when a user finds it. So the arms below drive
// TWO DIFFERENT VERBS through TWO DIFFERENT PARSERS onto two different
// settings sub-pages: a green that only ever exercised `/notify` would show
// that one string had been patched, not that the class had been closed.
//
// 🔴 WHY BOTH VERBS LAND ON THE DRAWER, when the stronger spec would put the
// second one on a different overlay. It was tried, with `/umode` → UmodeModal,
// and the arm was a FALSE GREEN: it passed against the PRE-CURE tree. A
// document-level capture probe on that tree says why, and the answer is
// geometry, not mechanism:
//
//     /notify   pointerdown -> polygon                        (send button glyph)
//               click       -> div.settings-drawer-backdrop.open
//               …drawer dismissed inside the gesture.  THE DEFECT.
//
//     /umode    pointerdown -> polygon
//               click       -> div.mode-modal-body            (the DIALOG, not the scrim)
//               …modal survives.
//
// On a Pixel 7 the umode toggle list is tall enough that the centred dialog
// covers the point the send button occupied, and the dialog's own
// `stopPropagation` eats the click before any scrim sees it. UmodeModal is
// still defective by construction — its scrim dismissed on a bare click, and a
// network advertising few umodes yields a short dialog that leaves the scrim
// exposed — but that is NOT reproducible at this viewport, and an arm that
// cannot fail is worth less than no arm. Do not re-add it without first
// re-running that probe.
//
// So the honest split: SettingsDrawer has engine evidence, UmodeModal and
// ServiceModal have unit evidence only (`src/__tests__/`). ServiceModal could
// not be driven here at all — a bare `/ns` needs services this testnet does
// not run.
//
// 🔴 WHY `@touch` AND ONLY `@touch`. `chromium-pixel-touch` is the only
// project whose `tap()` produces the compat mouse events a real tap produces;
// on `webkit-iphone-15` the same tap dispatches `pointerdown / touchstart /
// pointerup` and stops, so a spec about what a synthesised click hits is
// unanswerable there and goes green whatever the code does. That is measured
// in `playwright.config.ts:110-117` and was measured again on the pre-cure
// tree for 1831. Do not add a `@webkit` twin: it would pass without touching
// the defect.
//
// PLATFORM LIMIT, stated rather than buried: this is Blink with `isMobile` +
// `hasTouch`. The device in the report is a Samsung phone running Chrome —
// the same engine family, which is a closer match than 1831 had (that report
// was Android Firefox, and Gecko is not reachable from this harness at all).
// It is still not "Android coverage": it measures that an engine does this,
// and which gesture does it.
//
// The pair per verb is deliberate and the control is the load-bearing half:
//
//   * ENTER — a keydown synthesises no trailing click, so this arm is green on
//     both sides of the cure. Its job is to fail loudly if the STACK broke
//     rather than the mechanism, which is what makes a red TAP arm mean the
//     mechanism.
//   * TAP — the same verb through the send button. Red before the cure, green
//     after. Everything but the GESTURE is held fixed.
import { composeSend, composeTextarea, loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";
const CHANNEL = AUTOJOIN_CHANNELS[0];
test.setTimeout(90_000);
// Type into the compose line and activate the SEND BUTTON with a tap.
//
// Tap, never click. A `click()` synthesises a mouse sequence whose `mousedown`
// PRECEDES the overlay mount, so the click resolves to the common ancestor of
// button and scrim instead of to the scrim — the case that never reproduced,
// and the reason a mouse never saw this bug.
const tapSend = async (page, body) => {
    const ta = composeTextarea(page);
    await expect(ta).toBeVisible();
    await ta.tap();
    await ta.pressSequentially(body, { delay: 20 });
    await page.getByRole("button", { name: /send message/i }).tap();
    // Dispatch signal first, so a red below is an OVERLAY failure and not a
    // submit that never happened.
    await expect(ta).toHaveValue("", { timeout: 5_000 });
};
test("@touch issue 1982 — bare /notify sent with Enter opens the watch lists (gesture control)", async ({ page, }) => {
    await loginAs(page, specUser());
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
    await composeSend(page, "/notify");
    await expect(page.getByTestId("watchlists-subpage")).toBeVisible({ timeout: 15_000 });
});
test("@touch issue 1982 — bare /notify sent by TAPPING send opens the watch lists and they stay", async ({ page, }) => {
    await loginAs(page, specUser());
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
    await tapSend(page, "/notify");
    const subpage = page.getByTestId("watchlists-subpage");
    await expect(subpage).toBeVisible({ timeout: 15_000 });
    // …and still there once the gesture has fully settled. The defect dismissed
    // the drawer within the same tap, and its opacity transition is 200ms, so it
    // never painted at all; `toBeVisible` alone already catches that. This
    // second look separates "opened and stayed" from "the assertion won a race".
    await page.waitForTimeout(1_000);
    await expect(subpage).toBeVisible();
});
test("@touch issue 1982 — bare /alias sent with Enter opens the aliases page (gesture control)", async ({ page, }) => {
    await loginAs(page, specUser());
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
    await composeSend(page, "/alias");
    await expect(page.getByTestId("aliases-subpage")).toBeVisible({ timeout: 15_000 });
});
// The second verb. `/alias` is not in the watch family, is parsed by
// `parseAlias` and not `parseNotify`, and deep-links to a DIFFERENT sub-page —
// so a cure that had special-cased the reported verb, its parser or its
// section leaves this arm red. It reaches the same scrim on purpose: that is
// the only scrim this harness can put under the send button (see the probe in
// the header).
test("@touch issue 1982 — bare /alias sent by TAPPING send opens the aliases page and it stays", async ({ page, }) => {
    await loginAs(page, specUser());
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
    await tapSend(page, "/alias");
    const subpage = page.getByTestId("aliases-subpage");
    await expect(subpage).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(1_000);
    await expect(subpage).toBeVisible();
});

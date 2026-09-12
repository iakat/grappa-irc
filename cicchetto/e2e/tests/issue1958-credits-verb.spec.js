// #1958 — `/credits` opens the end titles one verb deep, instead of menu →
// settings → scroll to the bottom of the drawer.
//
// The unit layer (slashCommands.test.ts, compose.test.ts) pins the parse and
// the dispatch against a MOCKED `openCreditsModal`; what it cannot see is that
// the signal the verb flips is the one the mounted modal listens to. This spec
// drives the VISIBLE outcome against the real bundle: the verb, typed into the
// compose box of a channel window, paints the same modal the drawer's
// `credits` entry does — and the drawer entry itself still works afterwards
// (the issue's second open question: the verb is a shortcut, not a
// replacement).
//
// SCOPE. The roll's CONTENT (sha, date, contributors) is #1773's spec, not
// this one's; here the title alone proves the modal is up. Subject-shape
// agnostic (the verb resolves no network and puts nothing on the wire), so
// registered vjt suffices — the same parity argument as #1773.
import { composeSend, composeTextarea, loginAs, openSettingsDrawer, selectChannel, } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specUser, test } from "../fixtures/test";
const CHANNEL = AUTOJOIN_CHANNELS[0];
test("#1958 — /credits opens the end-titles modal, and the drawer entry still does too", async ({ page, }) => {
    const vjt = specUser();
    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { awaitWsReady: false });
    await expect(composeTextarea(page)).toBeVisible();
    const modal = page.getByTestId("credits-modal");
    await expect(modal).toHaveCount(0);
    // ── the verb ────────────────────────────────────────────────────────────
    await composeSend(page, "/credits");
    await expect(modal).toBeVisible({ timeout: 5_000 });
    // Text, never geometry: the roll is a CSS animation (see #1773).
    await expect(page.getByTestId("credits-title")).toHaveText("GRAPPA IRC");
    // A silent success: the draft is gone and nothing was printed as an error.
    await expect(composeTextarea(page)).toHaveValue("");
    await expect(page.locator(".compose-box-error")).toHaveCount(0);
    await page.getByTestId("credits-close").click();
    await expect(modal).toHaveCount(0);
    // ── the drawer entry stays ──────────────────────────────────────────────
    await openSettingsDrawer(page);
    await page.getByTestId("credits-entry").click();
    await expect(modal).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId("credits-title")).toHaveText("GRAPPA IRC");
});

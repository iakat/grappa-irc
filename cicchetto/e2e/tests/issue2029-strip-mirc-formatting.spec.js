// #2029 — the per-viewer "strip mIRC formatting" preference, asserted on the
// VISIBLE OUTCOME rather than on the toggle's existence.
//
// Requested by `morph` (Azzurra staff) after a channel filled with heavily
// coloured bot output. Deliberately NOT channel mode `+c`: that is an
// operator's channel-wide policy and it REJECTS the message, costing the
// reader the words along with the colours. This strips on RENDER, per viewer.
//
// ## What this spec is FOR, and why vitest is not enough
//
// The unit tests pin the parser projection and the chokepoint's class/style
// output in jsdom, which is blind to CSS. Two claims need a real engine and a
// real server, and they are the two the issue actually makes:
//
//   1. the colour a reader SEES goes away — asserted as a computed CSS colour
//      on the rendered run, not as the absence of a class name;
//   2. it goes away and comes back **without a reconnect and without a
//      refetch** — so the message is put on screen ONCE, before the toggle is
//      ever touched, and the same on-screen line is re-read after each flip.
//      No reload, no rejoin, no second PRIVMSG. That is the whole contract:
//      the raw line is untouched on the wire and in scrollback, and only its
//      projection changes.
//
// The toggle also round-trips to the server (it is the fifth #449 synced
// display pref), so the flip exercised here is the production path — signal +
// localStorage + PUT — not a test-only seam.
import { closeSettings, loginAs, openSettingsSection, scrollbackLines, selectChannel, } from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";
const TEST_CHANNEL = AUTOJOIN_CHANNELS[0];
// \x034 = mIRC palette red (#ff0000 → rgb(255, 0, 0)), closed by \x03.
const RED = "rgb(255, 0, 0)";
async function setStripToggle(page, on) {
    await openSettingsSection(page, "display");
    const toggle = page.getByTestId("strip-formatting-toggle");
    await expect(toggle).toBeVisible({ timeout: 5_000 });
    if (on)
        await toggle.check();
    else
        await toggle.uncheck();
    await expect(toggle).toBeChecked({ checked: on });
    await closeSettings(page);
}
test("#2029: a coloured line goes flat and comes back, with no reconnect", async ({ page }) => {
    const vjt = specUser();
    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, TEST_CHANNEL, { awaitWsReady: false });
    // Live per-channel WS gate (same rationale as the sibling mIRC specs).
    await expect(page.locator(".members-pane li", { hasText: specNick() })).toBeVisible({
        timeout: 10_000,
    });
    const sid = crypto.randomUUID().slice(0, 6);
    const redTag = `red-${sid}`;
    const boldTag = `bold-${sid}`;
    const plainTag = `plain-${sid}`;
    const peer = await IrcPeer.connect({ nick: `strippeer-${sid}` });
    try {
        await peer.join(TEST_CHANNEL);
        // One line carrying a colour, a bold, and an untouched tail — so the
        // assertions can tell "formatting removed" from "text eaten".
        peer.privmsg(TEST_CHANNEL, `\x034${redTag}\x03 \x02${boldTag}\x02 ${plainTag}`);
        const lines = scrollbackLines(page);
        // ---- 1. DEFAULT OFF: the colours are there. This is also the negative
        // control for everything below — without it, a spec that never rendered
        // the formatting in the first place would "pass" the strip assertions.
        await expect(lines.locator(".scrollback-mirc-bold", { hasText: boldTag })).toHaveCount(1, {
            timeout: 10_000,
        });
        await expect(page.getByText(redTag, { exact: true })).toHaveCSS("color", RED);
        // ---- 2. TURN IT ON. Nothing is reloaded, rejoined or re-sent: the same
        // line that is already on screen has to change.
        await setStripToggle(page, true);
        await expect(lines.locator(".scrollback-mirc-bold", { hasText: boldTag })).toHaveCount(0, {
            timeout: 10_000,
        });
        // The colour is gone as PAINT, not merely as a class: the run now inherits
        // the surrounding text colour, so it is no longer red.
        await expect(page.getByText(redTag, { exact: true })).not.toHaveCSS("color", RED);
        // …and the reader lost nothing but the decoration. All three words remain.
        await expect(lines.filter({ hasText: redTag })).toContainText(boldTag);
        await expect(lines.filter({ hasText: redTag })).toContainText(plainTag);
        // ---- 3. TURN IT BACK OFF. "Toggling it back must restore colours without
        // a reconnect" — again on the same on-screen line, with no refetch.
        await setStripToggle(page, false);
        await expect(lines.locator(".scrollback-mirc-bold", { hasText: boldTag })).toHaveCount(1, {
            timeout: 10_000,
        });
        await expect(page.getByText(redTag, { exact: true })).toHaveCSS("color", RED);
    }
    finally {
        await peer.disconnect("done");
    }
});

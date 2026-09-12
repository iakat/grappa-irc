// #100 — reconnecting badge (presentational). Asserts the transient
// per-network "reconnecting…" sidebar badge appears while a Session is
// (re)establishing the upstream socket and clears once connected.
//
// The badge is driven by the server's `connection_progress`
// user-topic event: "connecting" (a Session.Server client-start
// attempt) → reconnectingByNetwork()[slug] = true → badge shows;
// "connected" (001 RPL_WELCOME) → false → badge clears. It is
// PRESENTATIONAL ONLY — distinct from the durable connection_state
// (which stays :connected through a transient reconnect); the badge is
// an ephemeral overlay cic mirrors, never originates.
//
// Driver: the proven park→Reconnect cycle. Clicking the Home Reconnect chip
// fires Networks.connect → eager SpawnOrchestrator → a fresh Session.Server
// whose do_start_client broadcasts `connecting` — so the badge shows during
// the multi-second connect + SASL + register window against the real bahamut
// testnet, then clears on 001.
//
// issue 1985 (2026-09-10) — THIS SPEC NOW ASSERTS THE OPPOSITE OUTCOME, and
// the change is here because THE PRODUCT OWNER RULED THE ASSERTED BEHAVIOUR
// WRONG — NOT because the spec was flaky, and NOT to make it pass.
//
// It used to assert the badge SHOWS during a park→Reconnect cycle, which
// worked because the parked network kept a greyed sidebar row for the badge
// to live on. Under vjt's ruling a parked network LEAVES the sidebar
// entirely, and the badge has exactly one render site — inside the
// per-network `<For>` in `Sidebar.tsx`. No row, no host, no badge.
//
// vjt was asked precisely this and answered (2026-09-10, ⚠️ RELAYED into the
// authoring session, not read on IRC by its author): *"ci si riconnette da
// HOME"*, *"non SERVE nient'ALTRO"*. So the badge is NOT to be given a new
// home, the button is NOT to be taught a progress state, and this spec must
// stop demanding a badge the product deliberately no longer shows.
//
// AN EARLIER REVISION OF THIS COMMENT WAS WRONG AND IS CORRECTED HERE RATHER
// THAN QUIETLY DROPPED. It argued the badge would surface anyway on an
// ORDERING: the reconnect PATCH spawns first and commits `:connected` on
// spawn success, `Session.start_session/3` returns at GenServer start rather
// than at registration, so the row returns in milliseconds while `connecting`
// (which clears only on 001) is still set. MEASURED: the ordering half is
// TRUE — the section does come back, and this spec still asserts that — but
// the conclusion drawn from it was FALSE. The badge never entered the DOM in
// three consecutive runs; at timeout the page showed the network back and
// fully registered (`+ix`, unread counts). Whatever the flag's timing, the
// operator sees no badge, and that is what gets asserted.
//
// ⚠️ COVERAGE LOST, STATED PLAINLY. This was the ONLY e2e spec asserting the
// badge RENDERS (the two other specs naming it only borrow its cleanup
// ritual). Re-aimed this way, no e2e test covers the badge appearing at all —
// including on a spontaneous link drop, where the row is present and the
// badge presumably still works. That path was never covered here either (this
// spec always drove through a park), so nothing that WAS covered is being
// dropped silently; but the badge's render is now unguarded end-to-end. Its
// machinery keeps unit coverage in `userTopic.test.ts` (the
// `connection_progress` → `setReconnecting` dispatch); the RENDER has none.
//
// CLEANUP: afterEach reconnects the network (best-effort) and polls
// GET /channels until autojoin restores #spec-wN — same discipline as
// cp15-b6-parked-disconnect-reconnect so the next spec inherits a live
// session.
import { composeSend, loginAs, selectChannel, sidebarWindow } from "../fixtures/cicchettoPage";
import { GRAPPA_BASE_URL } from "../fixtures/grappaApi";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";
const SEED_CHANNEL = AUTOJOIN_CHANNELS[0];
const PARK_REASON = "testing reconnect badge #100";
// 90s — body (~5s) + Reconnect connect window + afterEach autojoin
// poll (~30s) + testnet-load safety margin. Same budget as the sibling
// park→reconnect spec.
test.setTimeout(90_000);
test.afterEach(async () => {
    // Best-effort reconnect + poll #spec-wN back to joined so a mid-run
    // failure doesn't leave the network parked for the next spec (same
    // rationale as cp15-b6-parked-disconnect-reconnect).
    const vjt = specUser();
    const { patchNetworkConnectionState } = await import("../fixtures/grappaApi");
    await patchNetworkConnectionState(vjt.token, NETWORK_SLUG, {
        connection_state: "connected",
    }).catch(() => { });
    const channelsUrl = `${GRAPPA_BASE_URL}/networks/${NETWORK_SLUG}/channels`;
    for (let attempt = 0; attempt < 60; attempt++) {
        const res = await fetch(channelsUrl, {
            headers: { authorization: `Bearer ${vjt.token}` },
        }).catch(() => null);
        if (res?.ok) {
            const channels = (await res.json());
            const bofh = channels.find((c) => c.name === SEED_CHANNEL);
            if (bofh?.joined)
                return;
        }
        await new Promise((r) => setTimeout(r, 500));
    }
});
// Title carries no regex metacharacter on purpose: `--grep` is a REGEX, and a
// title that cannot match itself collects zero tests, which reports as green.
// Short handle: `--grep "#100 — reconnecting badge"`. Plain `#100` is NOT
// safe — it is a prefix of #1004, #1061 and others.
test("#100 — reconnecting badge has no surface while a parked network reconnects, and the network returns anyway", async ({ page, }) => {
    const vjt = specUser();
    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, SEED_CHANNEL, { ownNick: specNick() });
    const channelRow = sidebarWindow(page, NETWORK_SLUG, SEED_CHANNEL);
    await expect(channelRow).toHaveCount(1);
    const networkSection = page.locator(".sidebar-network-section", {
        has: page.locator(".sidebar-network-header", { hasText: NETWORK_SLUG }),
    });
    const reconnectingBadge = networkSection.locator('[data-testid="reconnecting-badge"]');
    // Baseline: connected → no reconnecting badge.
    await expect(reconnectingBadge).toHaveCount(0);
    // Park the network. Selection redirects to Home and — issue 1985 — the
    // sidebar network section LEAVES, taking the badge's host with it.
    await composeSend(page, `/disconnect ${NETWORK_SLUG} ${PARK_REASON}`, { expectUnmount: true });
    // The disappearance is asserted here rather than left as background: it is
    // the precondition that makes the rest of this spec a real test of the
    // ordering. Without it, a badge seen later could be a badge that never
    // went away.
    await expect(networkSection).toHaveCount(0, { timeout: 10_000 });
    const parkedCard = page.locator(".home-pane-network-row-parked", {
        has: page.locator(".home-pane-network-slug", { hasText: NETWORK_SLUG }),
    });
    await expect(parkedCard).toHaveCount(1, { timeout: 10_000 });
    const reconnectBtn = parkedCard.getByRole("button", { name: `Reconnect ${NETWORK_SLUG}` });
    await expect(reconnectBtn).toBeEnabled();
    // The SAME MutationObserver latch as before the ruling, doing the same job
    // in the opposite direction. It watches the WHOLE document — not the
    // network section — and flips the instant a badge enters the DOM anywhere,
    // however briefly. Before the ruling that made a transient appearance
    // provable without racing it; now it makes a NON-appearance provable, which
    // a polled `toHaveCount(0)` never could: a sub-second flash between two
    // polls would pass an assertion that claims the badge never showed.
    await page.evaluate(() => {
        const w = window;
        w.__cic_reconnectBadgeSeen = false;
        const seen = () => document.querySelector('[data-testid="reconnecting-badge"]') !== null;
        if (seen()) {
            w.__cic_reconnectBadgeSeen = true;
            return;
        }
        const obs = new MutationObserver(() => {
            if (seen()) {
                w.__cic_reconnectBadgeSeen = true;
                obs.disconnect();
            }
        });
        obs.observe(document.body, { childList: true, subtree: true });
    });
    // Reconnect → fresh SpawnOrchestrator → Session.Server do_start_client
    // broadcasts `connecting` → the badge appears during the upstream
    // connect + SASL + register window.
    await reconnectBtn.click();
    // The network comes BACK. Asserted FIRST, and it is what keeps the
    // no-badge assertion below from being vacuous: an absence proves nothing on
    // a client that never reconnected at all. The ordering behind the return is
    // real and still worth naming — spawn-then-commit, `Session.start_session/3`
    // returning at GenServer start rather than at registration — so the row is
    // back long before 001.
    await expect(networkSection).toHaveCount(1, { timeout: 20_000 });
    // Reconnect fully completed: the channel row RETURNS un-greyed after
    // autojoin. This closes the observation window — everything the badge could
    // possibly have had to say has now been said.
    await expect(channelRow).toHaveCount(1, { timeout: 15_000 });
    await expect(channelRow.locator(".sidebar-window-greyed")).toHaveCount(0);
    // THE RULED OUTCOME: across the whole window just closed — from before the
    // Reconnect click to a fully restored network — the badge never existed
    // anywhere in the document. Not "is absent now", which a flash would
    // satisfy: never appeared, once, at any moment.
    //
    // The badge is not broken and is not being worked around. It renders in one
    // place, inside the per-network row, and a parked network has no row — the
    // accepted collateral of the ruling, asserted here so it stays a decision
    // and does not quietly become a regression nobody notices.
    const badgeEverSeen = await page.evaluate(() => window.__cic_reconnectBadgeSeen);
    expect(badgeEverSeen).toBe(false);
    // Steady state agrees with the latch, from the other direction.
    await expect(reconnectingBadge).toHaveCount(0);
});

// CP19 T32 — parked-network cic derivation cascade.
//
// UX-7-F (2026-05-22) — spec rewritten for the post-UX-4-D contract.
// Pre-UX-4-D, `/disconnect` left selection on the parked channel and
// the spec asserted ComposeBox cascaded `.compose-box-greyed`. Post-
// UX-4-D (commit cdc5470), `cicchetto/src/lib/selection.ts:287-316`
// auto-redirects selection to Home whenever a network transitions to
// `:parked` or `:failed` — the user-intent encoded by every park
// trigger (sidebar ×, compose `/disconnect`, sidebar circuit-breaker
// park, `bin/grappa disconnect`) is "this network is done; surface
// the parked summary on Home." The ComposeBox unmounts because Home
// renders no compose; asserting `.compose-box-greyed` on a parked
// channel is asserting buggy behavior (the redirect IS the contract).
//
// vjt 2026-05-22 chose "keep redirect, fix spec" over "skip redirect
// for /disconnect" — the redirect is intentional UX and the spec is
// what was wrong. This spec is the authoritative encoding of the
// post-UX-4-D contract.
//
// Scenario:
//   1. vjt logged in, autojoin lands → SEED_CHANNEL row appears as
//      live (no greyed class).
//   2. Operator types `/disconnect <network> <reason>` in compose.
//      Server-side: NetworksController.update → Networks.disconnect/2
//      → terminate Session.Server + flip credential.connection_state
//      to :parked + broadcast connection_state_changed on user-topic.
//      Cic-side: userTopic.ts → refetchNetworks() → networkBySlug
//      surfaces connection_state=parked → selection.ts:287-316 fires
//      → selection jumps to Home.
//   3. Assert: selection is Home, HomePane renders the parked network
//      card (slug + nick + reason + Reconnect button). The sidebar
//      network section is GONE, and its channel rows with it.
//   4. Operator clicks `[Reconnect bahamut-test]` on the Home card
//      (mirrors the same patchNetwork verb /connect would invoke).
//      Server-side: Networks.connect → eager SpawnOrchestrator → DB
//      flip + broadcast. Cic-side: networkBySlug.connection_state =
//      connected → home card re-renders as connected.
//   5. Assert: the sidebar network section is BACK (not greyed);
//      SEED_CHANNEL row returns un-greyed after autojoin (typed events
//      flow through subscribe.ts as before).
//
// issue 1985 (2026-09-10) — steps 3 and 5 were rewritten from
// "stays, greyed" to "leaves, comes back". The spec is not being
// relaxed: the product owner ruled the previously asserted behaviour
// wrong. See the in-body comment at the disappearance assertion.
//
// Why click Reconnect instead of typing `/connect`: from Home, there
// IS no ComposeBox — the only way to issue `/connect` from the Home
// pane is via the typed Reconnect chip. Mirrors what every operator
// does in practice (they don't navigate back to the parked channel
// to type `/connect`; they tap the Home card).
//
// CHANNEL CLEANUP: only touches the seeded autojoin channel — no
// per-run setup needed. The Reconnect click triggers a fresh
// SpawnOrchestrator → autojoin loop, which re-JOINs SEED_CHANNEL and
// gets the row back to its baseline live state.
import { composeSend, loginAs, selectChannel, sidebarWindow } from "../fixtures/cicchettoPage";
import { settleNetworkAutojoin } from "../fixtures/grappaApi";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";
const SEED_CHANNEL = AUTOJOIN_CHANNELS[0];
const PARK_REASON = "testing parked state cp19";
// Test timeout bumped to 90s — the cleanup afterEach polls for up to
// 30s waiting for SpawnOrchestrator → IRC connect → SASL → autojoin
// → JOIN echo → state.members write to complete. Default 30s test
// timeout would leave only seconds for afterEach after the body runs,
// then exhaust it during the autojoin wait. 90s = body (~5s) +
// afterEach poll (~30s) + safety margin for testnet load.
test.setTimeout(90_000);
test.afterEach(async () => {
    // If the spec failed mid-run the network may still be parked, and the
    // testnet does not reset between specs. `settleNetworkAutojoin` is the
    // reconnect + poll-until-NAMES-seeded ritual this spec originated; it moved
    // to the fixtures in #1796 when a second network-parking spec needed it, and
    // the whole argument (why `joined` is not enough, why 30s) lives on it.
    const vjt = specUser();
    await settleNetworkAutojoin(vjt.token, NETWORK_SLUG, SEED_CHANNEL, specNick());
});
// The title says LEAVES/RETURNS, not "ungreys": under issue 1985 the section
// disappears rather than greying, and the old title asserted in prose what the
// body no longer asserts in code. A test title is read as documentation by
// everyone who never opens the body.
//
// It also carries NO regex metacharacter, and that is deliberate. `--grep` is
// a REGEX, so the previous title could not select itself: it contained
// `network + redirects`, where `+` quantifies the preceding SPACE, so the
// pattern demanded two spaces the title does not have. Measured with the JS
// RegExp engine Playwright uses — `new RegExp(oldTitle).test(oldTitle)` is
// FALSE, while it is TRUE for this one. A handle that cannot match its own
// test collects zero tests, and zero tests reports as green.
//
// The short, safe handle is `--grep "CP19 T32"`: it is unique among e2e titles
// (the other CP19 T32 mentions are cic source comments and vitest describes,
// which Playwright never collects).
test("CP19 T32 — /disconnect parks network and redirects to Home; the sidebar section leaves and returns un-greyed on Reconnect", async ({ page, }) => {
    const vjt = specUser();
    await loginAs(page, vjt);
    // Establish baseline: focus the seeded autojoin channel, wait for
    // the self-JOIN scrollback line, then verify the row is NOT greyed.
    await selectChannel(page, NETWORK_SLUG, SEED_CHANNEL, { ownNick: specNick() });
    const channelRow = sidebarWindow(page, NETWORK_SLUG, SEED_CHANNEL);
    await expect(channelRow).toHaveCount(1);
    await expect(channelRow.locator(".sidebar-window-greyed")).toHaveCount(0);
    // Network header section + ComposeBox baseline: not greyed.
    const networkSection = page.locator(".sidebar-network-section", {
        has: page.locator(".sidebar-network-header", { hasText: NETWORK_SLUG }),
    });
    await expect(networkSection).not.toHaveClass(/sidebar-network-greyed/);
    await expect(page.locator(".compose-box")).not.toHaveClass(/compose-box-greyed/);
    // Operator parks the network via /disconnect. compose.ts dispatches
    // patchNetwork → server-side disconnect/2 → user-topic broadcast →
    // userTopic.ts refetchNetworks → networkBySlug surfaces parked →
    // selection.ts:287-316 redirects to Home. ComposeBox unmounts mid-
    // await, so composeSend uses `expectUnmount: true` to wait for the
    // textarea-gone signal instead of textarea-empty (which would race
    // the unmount). Draft IS cleared in the composeByChannel signal
    // regardless — re-navigating to #spec-wN later shows an empty compose.
    await composeSend(page, `/disconnect ${NETWORK_SLUG} ${PARK_REASON}`, { expectUnmount: true });
    // Selection redirected to Home — HomePane renders the parked
    // network card. `.home-pane-network-row-parked` is the load-bearing
    // class (HomePane.tsx:110 — parked-specific styling hook). The card
    // carries the slug + nick + reason text + a typed Reconnect chip.
    const parkedCard = page.locator(".home-pane-network-row-parked", {
        has: page.locator(".home-pane-network-slug", { hasText: NETWORK_SLUG }),
    });
    await expect(parkedCard).toHaveCount(1, { timeout: 10_000 });
    await expect(parkedCard.locator(".home-pane-network-reason")).toHaveText(PARK_REASON);
    // Reviewer LOW-1 (UX-7-F): chip is rendered in the same synchronous
    // JSX block as the card so `toBeVisible()` is redundant with the
    // card-found assertion above. `toBeEnabled()` also asserts the
    // `pending()` disabled-state edge isn't surfaced (which would
    // indicate a click was already in flight — wrong state for the spec).
    const reconnectBtn = parkedCard.getByRole("button", { name: `Reconnect ${NETWORK_SLUG}` });
    await expect(reconnectBtn).toBeEnabled();
    // issue 1985 — THE SIDEBAR SECTION LEAVES. It used to gain
    // `.sidebar-network-greyed` and stay, and this spec asserted that, with a
    // comment calling the greyed row the cue "this network is parked, no live
    // messages" and the operator's way back to the parked channels' scrollback.
    //
    // That assertion changed because THE PRODUCT OWNER RULED THE ASSERTED
    // BEHAVIOUR WRONG — not because it was flaky, and not to make this spec
    // pass. vjt, 2026-09-07: *"sparisce se è disconnected (parked)"*, and on
    // 2026-09-10 that the parked window's history is reachable from the
    // ARCHIVE, which is what replaces the greyed row as the way back. A
    // parked network and every row under it leave the sidebar and come back on
    // reconnect. `failed` still greys in place; the asymmetry is deliberate.
    //
    // The whole section goes, so the reason tooltip that used to sit on the
    // network header (`.sidebar-network-header .sidebar-channel-name`,
    // `title=`) has no host any more. The reason is NOT lost to the operator —
    // it is asserted above on the Home card's `.home-pane-network-reason`,
    // which is now its only surface.
    await expect(networkSection).toHaveCount(0, { timeout: 10_000 });
    // The channel rows go with it — they render inside that section, so this
    // is the same disappearance seen one level down rather than a second
    // claim. Asserted because "the network header is gone" and "the operator
    // has no parked channel row" are what a reader will want separated.
    await expect(channelRow).toHaveCount(0);
    // Operator unparks via the Home card's Reconnect chip. Server-side:
    // Networks.connect → eager SpawnOrchestrator → DB flip + broadcast.
    // Cic-side: networkBySlug.connection_state = :connected → network
    // derivation drops greyed cascade; the parked Home card re-renders
    // as a connected row.
    await reconnectBtn.click();
    // issue 1985 — the section COMES BACK, which is the other half of the
    // ruling and the half a disappearance-only assertion would let rot: "and
    // come back when it reconnects". Was: ungreys in place.
    await expect(networkSection).toHaveCount(1, { timeout: 10_000 });
    await expect(networkSection).not.toHaveClass(/sidebar-network-greyed/);
    // Parked card flips off the Home pane (the network re-renders as
    // a connected `home-pane-network-row-connected` row, not parked).
    await expect(parkedCard).toHaveCount(0, { timeout: 10_000 });
    // The reason tooltip does not come back either: the derivation only
    // attaches a `title=` in a greyed state, and a reconnected network is not
    // one. Re-derived from the returned section rather than the pre-park
    // locator, which pointed at a node that has since been unmounted.
    await expect(networkSection.locator(".sidebar-network-header .sidebar-channel-name")).not.toHaveAttribute("title", PARK_REASON);
    // Channel row RETURNS post-autojoin, un-greyed: SpawnOrchestrator spawns a
    // fresh Session.Server, the autojoin loop re-JOINs SEED_CHANNEL, and the
    // typed window-state event flows through subscribe.ts as before.
    //
    // Both halves are asserted since issue 1985. `toHaveCount(0)` on the greyed
    // child alone is satisfied by a row that never came back at all — it was a
    // fair assertion while the row could only ever be present-and-greyed, and
    // it is a hole now that disappearance is a real state.
    await expect(channelRow).toHaveCount(1, { timeout: 15_000 });
    await expect(channelRow.locator(".sidebar-window-greyed")).toHaveCount(0);
});

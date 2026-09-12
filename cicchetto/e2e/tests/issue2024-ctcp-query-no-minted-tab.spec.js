// issue 2024 — a stranger's CTCP probe must not hand the operator a tab.
//
// The defect was server-side routing: a DM-targeted CTCP query persisted at
// `channel = own_nick`, which set `dm_with = sender`, and the auto-open keys
// on `dm_with || channel`. So anyone who asked the bouncer for a VERSION
// string minted a query window with somebody the operator had never talked
// to. vjt ruled the row belongs in the network window (the #546 door).
//
// WHY THIS SPEC EXISTS ON TOP OF THE UNIT + INTEGRATION COVERAGE. Those two
// prove the routing KEY and the absence of a `query_windows` row. Neither
// proves the thing the operator actually reported, which is a TAB. The
// sidebar is projected from `windowStateByChannel` fed by the user topic, so
// "no row in the table" and "no tab on the screen" are two claims with a
// whole client between them. This asserts the second one, in a browser,
// against a real peer on the real testnet ircd.
//
// THE ABSENCE IS A MEASUREMENT, NOT AN EMPTY READ (#1336's rule), and it is
// guarded twice:
//   1. the tab is only looked for AFTER the visibility row has provably
//      landed — so the probe was routed, not merely still in flight;
//   2. the locator is positive-controlled on the same page against a window
//      that MUST be there. A `toHaveCount(0)` from a selector that matches
//      nothing anywhere is a green that proves the selector is broken.
//
// NOT claimed: anything about the reply the bouncer sends back. That it
// answers a VERSION query is #391's contract and has its own coverage; this
// spec is about where the INBOUND half lands.
import { loginAs, scrollbackLine, selectChannel, sidebarWindow } from "../fixtures/cicchettoPage";
import { fetchAllMessagesAsc } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specLiveNick, specUser, test } from "../fixtures/test";
// The CTCP framing byte. Built from a char code rather than written as an
// escape so the wire shape survives any lint that rewrites string escapes.
const DELIM = String.fromCharCode(1);
// The synthetic network window. Same literal `SERVER_WINDOW_NAME` the
// production tag carries; `sidebarWindow` maps its legacy aliases onto it.
// A COPY, not an import: the runner mounts `cicchetto/e2e` alone at `/work`,
// so `src/lib/windowKinds` is not resolvable here. #1646's mirror table holds
// the two in lockstep — this name is pinned in `e2eConstantMirrors.test.ts`,
// and changing either side alone turns that test red.
const SERVER_WINDOW = "$server";
const CHANNEL = AUTOJOIN_CHANNELS[0];
// The server-emitted visibility row. Prefix only: the version suffix is
// `Grappa.Version.current/0`, which changes on every release cut, and
// pinning it here would rot the spec on a tag rather than on a defect.
const ROW_PREFIX = "CTCP VERSION query → grappa";
// 60s — peer registration on the mesh plus login, select, and one round
// trip. The budget is for the ircd hops, not for settling.
test.setTimeout(60_000);
test("2024 — an inbound CTCP query lands in the network window and mints no tab", async ({ page, }) => {
    const vjt = specUser();
    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: await specLiveNick() });
    // POSITIVE CONTROL for the locator, taken BEFORE the claim so a broken
    // selector cannot be mistaken for a missing tab. The channel just selected
    // must be findable by exactly the helper the claim uses.
    await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL), "the sidebar locator finds nothing at all — the absence below would be vacuous").toHaveCount(1);
    const peer = await IrcPeer.connect({ nick: "ctcpprobe2024" });
    try {
        // The probe. A CTCP query IS a PRIVMSG whose body is delimiter-wrapped,
        // so this is the ordinary send verb — no new fixture seam is needed, and
        // adding one would have been a shared-fixture edit that buys nothing.
        peer.privmsg(await specLiveNick(), `${DELIM}VERSION${DELIM}`);
        // BARRIER + DESTINATION, in one act. Polling the network window's own
        // scrollback proves the probe was routed AND proves where it went. Read
        // over REST rather than off the screen because the two claims that
        // follow are about the DOM, and a barrier that shares their failure mode
        // cannot witness them.
        await expect
            .poll(async () => {
            const rows = await fetchAllMessagesAsc(vjt.token, NETWORK_SLUG, SERVER_WINDOW);
            // `body` is nullable on the wire (presence rows carry none), so
            // the guard is part of the predicate rather than an assertion —
            // a null body is simply not the row being waited for.
            return rows.some((r) => (r.body ?? "").startsWith(ROW_PREFIX));
        }, { timeout: 30_000 })
            .toBe(true);
        // THE CLAIM. No tab for the stranger — not greyed, not unread, absent.
        await expect(sidebarWindow(page, NETWORK_SLUG, peer.nick), "a CTCP probe from a stranger minted a query tab").toHaveCount(0);
        // …and the row is READABLE where it was sent, which is the other half of
        // the ruling: routed to the network window, not routed to nowhere.
        // Dropping it silently would also have produced no tab.
        await sidebarWindow(page, NETWORK_SLUG, SERVER_WINDOW).click();
        await expect(scrollbackLine(page, "notice", new RegExp(ROW_PREFIX))).toBeVisible({
            timeout: 15_000,
        });
    }
    finally {
        await peer.disconnect("2024 done");
    }
});

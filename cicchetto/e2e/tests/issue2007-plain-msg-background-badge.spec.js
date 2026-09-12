// issue 2007 — a PLAIN PRIVMSG into a BACKGROUND channel window raises no
// msg-unread badge, reported from the deployed mobile PWA and reproduced by
// vjt on `#sbiffo` twice on 2026-09-08.
//
// This spec exists to answer ONE question the field report cannot: does the
// defect reproduce at all under the harness, and if so on which side of the
// fork — the live append, or the count derived from it.
//
// WHY IT IS NOT THE M2 SPEC, WHICH IS GREEN.
// `m2-irssi-to-chan-defocused` already asserts "peer PRIVMSG to a defocused
// channel bumps msg-unread by exactly 1", and it passes. It therefore proves
// the mechanism works in ONE configuration, and the field report says there is
// a configuration where it does not. The single deliberate delta here is WHERE
// THE OPERATOR IS PARKED: M2 defocuses onto the `Server` pseudo-window,
// explicitly chosen there to avoid "the JOIN-self auto-focus path" — i.e. M2
// avoids, by construction, the very thing every real operator does, which is
// sit on ANOTHER REAL CHANNEL. The reporter was on a real window. Everything
// else — plain body, foreign sender, one message, badge assertion — is held
// identical to M2 on purpose, so a red here is attributable to that delta and
// to nothing else.
//
// The body carries NO mention of the operator's nick and no highlight token:
// the mention path is server-owned (`window_counts.mentions`) and masks the
// defect — that is exactly what invalidated the reporter's own first round.
// `assertMessagePersisted` runs BEFORE the badge assertion so that a red
// separates "the server never got the line" (harness fault) from "the server
// has it and the badge is still absent" (the defect).
//
// TWO ENTRIES, ONE BODY. The reporter is on a mobile PWA, and the badge is a
// DIFFERENT element there — `sidebarMessageBadge` resolves
// `.bottom-bar-msg-unread` under a mobile viewport and `.sidebar-msg-unread`
// otherwise. A desktop-only green therefore says nothing about the platform
// the defect was reported on. The tags are how a spec reaches the mobile
// projects (`@touch` → chromium-pixel-touch, `@webkit` → webkit-iphone-15),
// and they are EXCLUSIVE: `chromium` carries `grepInvert: /@webkit|@touch/`,
// so tagging the one entry would have MOVED it off the desktop rather than
// widened it. Hence a tagged entry and an untagged one over a shared body —
// three projects, no second copy of the scenario to drift.
import { composeSend, loginAs, selectChannel, sidebarMessageBadge, } from "../fixtures/cicchettoPage";
import { assertMessagePersisted } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";
// The BACKGROUND window — the one whose badge is under test.
const BACKGROUND_CHANNEL = AUTOJOIN_CHANNELS[0];
// A plain line: no operator nick, no highlight token, nothing that could
// route down the server-owned mention path and mask the count.
const MESSAGE_BODY = "issue2007: plain line into a backgrounded window";
// `variant` keeps the per-run channel and the peer nick disjoint between the
// desktop and mobile entries: the projects can run concurrently against the
// one shared testnet, and two peers on one nick would collide upstream.
async function backgroundBadgeScenario(page, variant) {
    const vjt = specUser();
    const parkChannel = `#i2007${variant}-${Date.now()}`;
    const peerNick = `i2007-${variant}`;
    await loginAs(page, vjt);
    // Visit the BACKGROUND channel first, with the WS-ready sync: the peer's
    // PRIVMSG must not race the per-channel subscribe (M2's note), and the
    // window must be locally hydrated — a hydrated key is the one whose count
    // comes from local scrollback rather than the server seed.
    await selectChannel(page, NETWORK_SLUG, BACKGROUND_CHANNEL, { ownNick: specNick() });
    try {
        // Park on ANOTHER REAL CHANNEL — the delta from M2.
        await composeSend(page, `/join ${parkChannel}`);
        await selectChannel(page, NETWORK_SLUG, parkChannel, { ownNick: specNick() });
        const peer = await IrcPeer.connect({ nick: peerNick });
        try {
            await peer.join(BACKGROUND_CHANNEL);
            peer.privmsg(BACKGROUND_CHANNEL, MESSAGE_BODY);
            // Server-side truth first: if this fails the harness never delivered the
            // line and the badge assertion below would be meaningless.
            await assertMessagePersisted({
                token: vjt.token,
                networkSlug: NETWORK_SLUG,
                channel: BACKGROUND_CHANNEL,
                sender: peer.nick,
                body: MESSAGE_BODY,
            });
            // The reported defect: no badge at all. Asserting the exact text "1"
            // (M2's BUG 6 contract) keeps a double-bump from reading as a pass.
            await expect(sidebarMessageBadge(page, NETWORK_SLUG, BACKGROUND_CHANNEL)).toHaveText("1", {
                timeout: 5_000,
            });
        }
        finally {
            await peer.disconnect("issue2007 done");
        }
    }
    finally {
        await composeSend(page, `/part ${parkChannel}`).catch(() => { });
    }
}
test("issue 2007 — plain PRIVMSG to a background channel bumps its msg-unread badge while parked on ANOTHER real channel", async ({ page, }) => {
    await backgroundBadgeScenario(page, "d");
});
test("@webkit @touch issue 2007 — the same background badge holds on the mobile layouts, where the badge is a different element", async ({ page, }) => {
    await backgroundBadgeScenario(page, "m");
});

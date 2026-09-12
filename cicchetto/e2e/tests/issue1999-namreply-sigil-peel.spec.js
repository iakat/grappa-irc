// issue 1999 — a 353 RPL_NAMREPLY sigil must be PEELED off the nick, and the
// peeled set must come from the network's own 005 PREFIX.
//
// The defect, reported on #grappa by Kerd: `split_mode_prefix` matched a
// hardcoded `@ % +`, so on a network advertising founder/admin a `~nick`
// token fell through unchanged and the sigil became part of the members-map
// KEY. Clicking that nick opened a query against `~nick` — a nick that does
// not exist — and the user could not write in it.
//
// ⚠️ WHAT THIS SPEC CANNOT COVER, AND WHY — read before trusting it as
// coverage of the reported case. Neither ircd in the testnet can advertise a
// PREFIX-rich network, so `~` and `&` are NOT reachable end to end here.
// Measured on the live stack rather than assumed:
//
//   * bahamut leaf (`bahamut-test`) → `PREFIX=(ohv)@%+`
//   * solanum (`azzurra2-solanum`)  → `PREFIX=(ov)@+`, and its
//     reference.conf carries no `use_owner`/`use_admin`/`use_halfop` knob —
//     solanum has no founder/admin channel modes to enable.
//
// So the rich case is covered where it CAN be measured: server-side by
// `Session.ServerTest`'s "a PREFIX-rich network" case, which drives a real
// `005 PREFIX=(qaohv)~&@%+` through the fake ircd, plus the `ISupport`,
// `EventRouter` and `Identifier` unit cases; client-side by the `sigilRank`,
// `memberSigil`, `members` and `MembersPane` unit cases, which seed the
// isupport store with the rich table. A spec that claimed the browser had
// seen a founder would be claiming a measurement nobody took.
//
// What this DOES buy, on the sigils the testnet does advertise: the peel was
// rewritten from a compile-time guard clause into a run derived from 005, and
// this is the only place that rewrite is exercised against a real ircd, a
// real 353, and the real render — `@` and `%` must still peel, the nick text
// must be BARE, and the click must still address the real nick. That is a
// regression guard for the refactor, deliberately not a demonstration of the
// bug being fixed.
//
// Shape — the ORDER is load-bearing:
//   1. an op peer founds a fresh per-run channel (the founder auto-ops, @)
//   2. a second peer joins and the op peer gives it `+h` (%)
//   3. ONLY THEN does cic join — so the sigils reach it inside the 353,
//      which is the `split_mode_prefix` door. Joining first would deliver
//      them through the MODE walker instead, a different code path that has
//      been PREFIX-aware since #216, and the spec would prove nothing.
//
// This spec is green on the base too — the peel of `@`/`%` worked before the
// refactor — so it was FALSIFIED rather than trusted: with `member_sigils/1`
// stubbed to `[]` on an otherwise unchanged tree, the run goes rc=1 on the
// positive control ("element(s) not found" for `.nick-prefix`), because the
// unpeeled `@nick` keys the member and carries no grade. The exact
// `.nick-text` assertion below bites on the same break for the same reason.
// A green that was never shown to be capable of red is not evidence.
//
// Platform note: the peel is server-side and the render is a members-pane
// text node — no touch, viewport or engine dependency, so desktop chromium
// IS the defect's own platform rather than a proxy for it.
//
// Parity matrix: UI shape contract, subject-shape-agnostic. Registered seed
// (vjt + autojoin) suffices.
import { composeSend, loginAs, selectChannel, sidebarWindow } from "../fixtures/cicchettoPage";
import { partChannel } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";
test.setTimeout(120_000);
test("issue 1999 — a 353 sigil peels off the nick; the click addresses the real nick", async ({ page, }) => {
    // Per-run unique channel + peer nicks: module-level constants make a spec
    // un-`--repeat-each`-able (a second pass re-founds a channel it already
    // parted and races a 433 on the peer nicks).
    const suffix = crypto.randomUUID().slice(0, 5);
    const channel = `#s1999-${suffix}`;
    const opNick = `o1999${suffix}`;
    const halfNick = `h1999${suffix}`;
    const vjt = specUser();
    await loginAs(page, vjt);
    // Focus the autojoin channel first to confirm login + WS-ready and mount
    // the compose box before issuing the /join (issue240 boot order — after
    // login cic lands on Home, which renders no ComposeBox).
    await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: specNick() });
    const opPeer = await IrcPeer.connect({ nick: opNick });
    let halfPeer = null;
    try {
        // The founding JOINer auto-ops on the testnet leaf (NO_CHANOPS_WHEN_SPLIT
        // undef'd), so this peer holds @ and can grant +h below.
        await opPeer.join(channel);
        halfPeer = await IrcPeer.connect({ nick: halfNick });
        await halfPeer.join(channel);
        await opPeer.mode(channel, "+h", halfNick);
        // Both grades are in place BEFORE cic joins, so they arrive in the 353.
        await composeSend(page, `/join ${channel}`);
        await expect(sidebarWindow(page, NETWORK_SLUG, channel)).toBeVisible({ timeout: 15_000 });
        await selectChannel(page, NETWORK_SLUG, channel, { ownNick: specNick() });
        const opRow = page.locator(".members-pane .member-name", { hasText: opNick });
        const halfRow = page.locator(".members-pane .member-name", { hasText: halfNick });
        // POSITIVE CONTROL — the grades really did survive the 353, so the
        // assertions below are reading a peeled token rather than an empty pane.
        // Without this, "the nick text is bare" would pass on a plain member.
        await expect(opRow.locator(".nick-prefix")).toHaveText("@", { timeout: 15_000 });
        await expect(halfRow.locator(".nick-prefix")).toHaveText("%", { timeout: 15_000 });
        // THE PEEL: the sigil lives in its own span and the nick text is the BARE
        // nick. Pre-fix, an unrecognised sigil stayed glued and this node read
        // `~nick`; `toHaveText` is exact, so a glued sigil fails here.
        await expect(opRow.locator(".nick-text")).toHaveText(opNick);
        await expect(halfRow.locator(".nick-text")).toHaveText(halfNick);
        // THE RANK: op above halfop above the plain operator, from the advertised
        // order rather than a hardcoded ladder. `member_sort_tier` used not to
        // rank `%` at all, which put a halfop in the plain tier.
        const rendered = await page.locator(".members-pane li .nick-text").allTextContents();
        expect(rendered.indexOf(opNick)).toBeGreaterThanOrEqual(0);
        expect(rendered.indexOf(opNick)).toBeLessThan(rendered.indexOf(halfNick));
        expect(rendered.indexOf(halfNick)).toBeLessThan(rendered.indexOf(specNick()));
        // THE REPORTED SYMPTOM: clicking a sigil-bearing nick opens a query
        // against the real nick. A glued sigil opened `@nick` instead — a nick
        // the ircd has never heard of, so the window could not be written in.
        await expect(sidebarWindow(page, NETWORK_SLUG, opNick)).toHaveCount(0);
        await opRow.click();
        await expect(sidebarWindow(page, NETWORK_SLUG, opNick)).toHaveCount(1, { timeout: 15_000 });
        await expect(sidebarWindow(page, NETWORK_SLUG, `@${opNick}`)).toHaveCount(0);
    }
    finally {
        if (halfPeer)
            await halfPeer.disconnect("issue1999 done");
        await opPeer.disconnect("issue1999 done");
        // `/join` persists the channel into vjt's autojoin set; PART restores
        // pre-test state. Idempotent — swallow 404 if the test bailed early.
        await partChannel(vjt.token, NETWORK_SLUG, channel).catch(() => { });
    }
});

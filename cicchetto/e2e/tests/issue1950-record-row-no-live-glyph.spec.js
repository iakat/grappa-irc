// issue 1950 — a scrollback RECORD row must never re-prefix itself.
//
// The defect: `ScrollbackPane`'s `prefixFor` derived the sender glyph of every
// non-content row from the LIVE members store, so a nick who was opped AFTER
// the event retroactively acquired an `@` on their own history. The reporter
// saw both halves of it on Azzurra:
//
//     20:30:23 * @Mezmerize [mezmerize@staff.azzurra.chat] has joined #italia
//     20:31:21 * @ULIAK [~ULIAK@5uo2.l.time4vps.cloud] has quit (Read/Dead Error: ...)
//
// The join line is wrong on the protocol outright — JOIN carries no grade, the
// `@` always arrives afterwards in a separate MODE — and it bites hardest the
// people with ChanServ auto-op, who read every one of their own joins as
// `@nick`. The part/quit line is the same defect with a later re-render as its
// trigger. It is the class #25 removed from CONTENT rows (which read the
// server's send-time `meta.sender_prefix` snapshot), left standing on the
// record rows.
//
// Why this needs a real stack, and what would go green without it:
//   1. the unit test seeds the members store by hand. Only the live stack
//      proves the store is genuinely populated by the SAME MODE the server
//      relayed — the positive control below reads the glyph off the members
//      pane, which is the store's other consumer.
//   2. the members store is repopulated from a fresh NAMES on RELOAD, while
//      the rows come back from persisted scrollback over REST. Those are two
//      different doors, and a fix that only held while the live session was
//      warm would pass the first half of this spec and fail the second.
//
// Platform note: the defect is a members-store read inside the row renderer,
// with no touch, viewport or engine dependency, so desktop chromium IS the
// defect's own platform rather than a proxy for it.
//
// Two tests, one contract, because the rows reach the glyph by two different
// arguments and each needs its own fixture.
//
// Shape (presence rows):
//   1. an op peer founds a fresh per-run channel → the founder auto-ops (@)
//   2. the operator (vjt-grappa) joins it, so cic witnesses what follows
//   3. the subject peer joins  → a JOIN row, subject plain at that instant
//   4. the subject peer parts  → a PART row, subject plain at that instant
//   5. the subject peer rejoins and the op peer ops it → subject is @ NOW
//   6. neither historical row may carry a glyph — live, and after a reload
//
// Shape (the `mode` row — see the second test's own header for WHY it needed
// /OPER to build): a plain member self-ops, and the row that GRANTS the `@`
// must not be painted with it.
//
// Parity matrix: UI shape contract, subject-shape-agnostic. Registered seed
// (vjt + autojoin) suffices.
import { composeSend, loginAs, scrollbackLine, selectChannel, sidebarWindow, } from "../fixtures/cicchettoPage";
import { partChannel } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";
test.setTimeout(120_000);
// Testnet O: line — `conf.leaf*.tmpl` interpolates OPER_NICK / OPER_PASS,
// whose compose defaults are these. Local constants, matching the two specs
// that already need them (issue367, issue554); they are triplicated now and
// belong in `seedData`, but hoisting them would edit two specs this change
// has no business touching.
const OPER_NAME = "testoper";
const OPER_PASS = "testoperpass";
test("issue 1950 — a historical join/part row keeps no glyph after the nick is opped", async ({ page, }) => {
    // Per-run unique channel + peer nicks: a module-level constant makes the
    // spec un-`--repeat-each`-able (a second pass would re-found a channel it
    // already parted and race a 433 on the peer nicks).
    const suffix = crypto.randomUUID().slice(0, 5);
    const channel = `#s1950-${suffix}`;
    const opNick = `o1950${suffix}`;
    const subjectNick = `s1950${suffix}`;
    const vjt = specUser();
    await loginAs(page, vjt);
    // Focus the autojoin channel first to confirm login + WS-ready and mount
    // the compose box before issuing the /join (issue240 boot order — after
    // login cic lands on Home, which renders no ComposeBox).
    await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: specNick() });
    const opPeer = await IrcPeer.connect({ nick: opNick });
    let subject = null;
    try {
        // The founding JOINer auto-ops on the testnet leaf (NO_CHANOPS_WHEN_SPLIT
        // undef'd), so this peer holds @ and can op the subject later.
        await opPeer.join(channel);
        await composeSend(page, `/join ${channel}`);
        await expect(sidebarWindow(page, NETWORK_SLUG, channel)).toBeVisible({ timeout: 15_000 });
        await selectChannel(page, NETWORK_SLUG, channel, { ownNick: specNick() });
        // The two record rows, both produced while the subject is a PLAIN member.
        subject = await IrcPeer.connect({ nick: subjectNick });
        await subject.join(channel);
        const joinRows = scrollbackLine(page, "join", subjectNick);
        await expect(joinRows).toHaveCount(1, { timeout: 15_000 });
        await subject.part(channel, "issue 1950 — leaving plain");
        const partRow = scrollbackLine(page, "part", subjectNick);
        await expect(partRow).toHaveCount(1, { timeout: 15_000 });
        // Now the trigger: the subject comes back and is opped. Everything the
        // rows above describe already happened; nothing about them changed.
        await subject.join(channel);
        await expect(joinRows).toHaveCount(2, { timeout: 15_000 });
        await opPeer.mode(channel, "+o", subjectNick);
        // POSITIVE CONTROL — the members store really did take the `@`. Without
        // it every "no glyph" assertion below would pass on an empty store, i.e.
        // on nothing. The members pane is the store's other consumer, so this
        // reads the same state `prefixFor` used to read.
        const memberGlyph = page
            .locator(".members-pane .member-name", { hasText: subjectNick })
            .locator(".nick-prefix");
        await expect(memberGlyph).toHaveText("@", { timeout: 15_000 });
        // LIVE: `prefixFor` is read inside a JSX prop, so Solid re-runs it when
        // the members signal changes — pre-fix the rows re-prefix in place, with
        // no reload needed.
        await expect(joinRows.locator(".nick-prefix")).toHaveCount(0);
        await expect(partRow.locator(".nick-prefix")).toHaveCount(0);
        // RELOADED: the rows now arrive from persisted scrollback over REST and
        // the members store from a fresh NAMES. Different doors, same contract.
        await page.reload();
        await expect(page.locator(".sidebar-network-header").first()).toBeVisible({ timeout: 10_000 });
        await selectChannel(page, NETWORK_SLUG, channel, { ownNick: specNick() });
        await expect(memberGlyph).toHaveText("@", { timeout: 15_000 });
        await expect(joinRows).toHaveCount(2, { timeout: 15_000 });
        await expect(joinRows.locator(".nick-prefix")).toHaveCount(0);
        await expect(partRow).toHaveCount(1);
        await expect(partRow.locator(".nick-prefix")).toHaveCount(0);
    }
    finally {
        if (subject)
            await subject.disconnect("issue1950 done");
        await opPeer.disconnect("issue1950 done");
        // `/join` persists the channel into vjt's autojoin set; PART restores
        // pre-test state. Idempotent — swallow 404 if the test bailed early.
        await partChannel(vjt.token, NETWORK_SLUG, channel).catch(() => { });
    }
});
// The `mode` row was the last carve-out, argued as honest because "its subject
// IS the grade change". The reporter closed it with a line that refutes itself
// without any knowledge of the channel's history:
//
//     20:58:09 * @Mezmerize sets mode +o Mezmerize on #grappa
//
// Setter and target are the same nick, so the `@` the setter is painted with
// is the one THIS LINE grants — it provably was not held when the event
// happened. Every other `mode` row has the same defect, just without the
// self-evidence: a setter deopped since reads plain on the line where they
// were opping people.
//
// Why this reproduces here and not on a plain channel op: setting `+o` needs
// chanop, so a setter who lacks the grade cannot normally produce the row at
// all. The reporter could because he is Azzurra staff — the earlier field
// line shows `mezmerize@staff.azzurra.chat`. The testnet is the SAME ircd
// (bahamut), so the spec buys the same standing the same way, out of band.
//
// 🔴 THE JOIN ORDER IS MATERIAL — do not "fix" a red here by making `staff`
// join first. Sixteen of the suite's seventeen `.mode()` sites have their
// peer join first because that is how a peer gets chanop on this testnet
// (auto-op, `NO_CHANOPS_WHEN_SPLIT` deleted from the image), and copying
// that shape here would silently delete the scenario: a `staff` who joined
// first ALREADY holds `@` when the row is written, and the row would then be
// bare-vs-decorated for a reason the reporter's line is not about. The
// assertion is not "a mode row is bare"; it is "a mode row is bare EVEN
// WHEN its setter demonstrably could not have held the glyph at the time".
// Joining second is what makes the second clause true, so it stays.
test("issue 1950 — the mode row that grants an op renders its setter bare", async ({ page }) => {
    const suffix = crypto.randomUUID().slice(0, 5);
    const channel = `#m1950-${suffix}`;
    const founderNick = `m1950f${suffix}`;
    const staffNick = `m1950s${suffix}`;
    const vjt = specUser();
    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: specNick() });
    // Someone has to hold the channel open while cic joins; the founding JOINer
    // auto-ops on the testnet leaf (the image drops `NO_CHANOPS_WHEN_SPLIT`).
    // This peer never sets a mode — it exists so the channel is not empty.
    const founder = await IrcPeer.connect({ nick: founderNick });
    let staff = null;
    try {
        await founder.join(channel);
        await composeSend(page, `/join ${channel}`);
        await expect(sidebarWindow(page, NETWORK_SLUG, channel)).toBeVisible({ timeout: 15_000 });
        await selectChannel(page, NETWORK_SLUG, channel, { ownNick: specNick() });
        // Joins SECOND, so it is a PLAIN member — the whole premise of the repro.
        staff = await IrcPeer.connect({ nick: staffNick });
        await staff.join(channel);
        await expect(scrollbackLine(page, "join", staffNick)).toHaveCount(1, { timeout: 15_000 });
        // The self-op, through the only door bahamut leaves open to a member
        // who is not chanop. Plain MODE is NOT that door and never can be:
        // `m_mode` gates override on `(IsSAdmin || IsAdmin) && !MyClient(sptr)`,
        // and a peer connected to this very leaf IS MyClient — so /OPER alone
        // earns a 482 and a fixture timeout. SAMODE has no such conjunct; it
        // wants `IsPrivileged` (the /OPER) plus `IsAdmin` (umode `+A`, which
        // sticks because the leaf's O: line carries the `A` oflag). All three
        // steps await their own echo, so whichever one a config change breaks
        // fails by name instead of surfacing as a mystery MODE timeout.
        await staff.oper(OPER_NAME, OPER_PASS);
        await staff.umode("+A");
        await staff.samode(channel, "+o", staffNick);
        // POSITIVE CONTROL — the members store really did take the `@`. Without
        // it the absence below would be the absence of nothing. The members pane
        // is the store's other consumer, and the one surface where a CURRENT
        // grade is the right thing to show.
        const memberGlyph = page
            .locator(".members-pane .member-name", { hasText: staffNick })
            .locator(".nick-prefix");
        await expect(memberGlyph).toHaveText("@", { timeout: 15_000 });
        // The row this very MODE produced. Matching on the mode text as well as
        // the nick keeps it off the founder's own join-time channel modes.
        const modeRow = scrollbackLine(page, "mode", new RegExp(`sets mode \\+o ${staffNick}\\b`));
        await expect(modeRow).toHaveCount(1, { timeout: 15_000 });
        await expect(modeRow.locator(".nick-prefix")).toHaveCount(0);
        // RELOADED: the row now arrives from persisted scrollback over REST and
        // the members store from a fresh NAMES. Different doors, same contract —
        // and the control has to hold on the far side too, or the reloaded
        // absence is once again an absence of nothing.
        await page.reload();
        await expect(page.locator(".sidebar-network-header").first()).toBeVisible({ timeout: 10_000 });
        await selectChannel(page, NETWORK_SLUG, channel, { ownNick: specNick() });
        await expect(memberGlyph).toHaveText("@", { timeout: 15_000 });
        await expect(modeRow).toHaveCount(1, { timeout: 15_000 });
        await expect(modeRow.locator(".nick-prefix")).toHaveCount(0);
    }
    finally {
        if (staff)
            await staff.disconnect("issue1950 mode done");
        await founder.disconnect("issue1950 mode done");
        await partChannel(vjt.token, NETWORK_SLUG, channel).catch(() => { });
    }
});

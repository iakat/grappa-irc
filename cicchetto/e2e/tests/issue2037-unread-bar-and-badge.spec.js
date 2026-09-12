// issue 2037 — three unread numbers on one screen for what the reporter read
// as one quantity: a far-behind bar saying 1807, a bold sidebar pill saying
// 187 and a faint one saying 216.
//
// The measurement that framed the fix is in DESIGN_NOTES #2037a and is NOT
// re-run here: the bar's anchor term is bounded above by zero, so re-anchoring
// the probe moves the bar DOWN by at most one page and leaves the residual
// exactly where it is. Two things were built on top of that ruling, and this
// is the only place either of them is checked against a real server:
//
//   A. `far().missed` IS the messages bucket — the same partition the bold
//      pill carries. Not a second value that agrees with it; the SAME
//      variable, read twice.
//   B. the faint `!messaggi` pill is behind `show_event_badge`, OFF by
//      default, and the bucket it hides is wider than join/part.
//
// ── WHY AN e2e AND NOT THE UNIT TESTS THAT ALREADY EXIST ─────────────────
//
// Both sides are covered and neither side can see the seam. The cic specs
// drive `probeGap` / `perChannelUnread` / `WindowBadges` against a stubbed
// API, so they pin the wiring and the defaults but never the server's actual
// numbers. The server specs pin the response shape and the posture sharing
// but never the render. #2037's defect lived exactly between them: the server
// was answering two different questions correctly and the client was drawing
// both answers as one quantity.
//
// ── WHY THE TWO NUMBERS ARE NOT MERELY COMPARED TO EACH OTHER ────────────
//
// A spec that asserts "bar === pill" and stops passes if both are wrong the
// same way — which, under A, they now would be, since they are one variable.
// So the bar is also pinned BELOW the raw gap, and then pinned exactly, by a
// decomposition the spec can state without re-implementing the server's kind
// predicate:
//
//     bar + faint pill + own-authored rows === raw rows past the cursor
//
// `bar` and `faint pill` come from the UI. `raw rows past the cursor` is a
// count of the server's own ordered list. `own-authored rows` is an IDENTITY
// count over that same list (rows whose sender is the operator), not a kind
// classification. Every row past the cursor is exactly one of the three by
// construction — own, non-own message, non-own event — so the identity holds
// for any correct implementation and fails for a bucket that double-counts,
// loses a kind, or forgets the own-authored exclusion. That is the assertion
// `count_after_split/6`'s own ExUnit probe makes on constructed rows; this is
// it on rows a real bahamut produced.
//
// ── WHY THE FAR-BEHIND WINDOW STAYS BADGED WHILE IT IS FOCUSED ───────────
//
// Reading the bar requires the window to be selected, and #981 zeroes the
// badge on the window the pane reports it is reading at the tail. A
// far-behind window is deliberately excluded from that suppression
// (`selection.ts`: its cursor is frozen, the arm cannot advance it, and the
// rows the operator is at the bottom of are not the unread region). If that
// exclusion is ever dropped, the bold-pill assertion below is what notices.
//
// ── NOT COVERED HERE, DELIBERATELY ───────────────────────────────────────
//
// The THRESHOLD. `count_after/6` keeps its predicate and its caller
// (`probeGap` → `isFarBehind`); vjt's 09:00 ruling put it out of scope and
// the reason is a correctness one, not a scheduling one — a messages-only
// threshold would have a channel with 3000 hidden JOINs and 40 messages
// report a 40-row gap and take a contiguous-paging path it cannot serve.
//
// And the 1404-row residual. A+B unify the quantity; they do not explain the
// report, they are not claimed to, and no assertion here should be read as
// evidence about it.
import { closeSettings, composeSend, loginAs, openSettingsSection, selectChannel, sidebarEventsBadge, sidebarMessageBadge, sidebarWindow, } from "../fixtures/cicchettoPage";
import { fetchAllMessagesAsc, resetSubject, restoreReadCursorToTail, setReadCursorToId, } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededAdmin, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";
const CHANNEL = AUTOJOIN_CHANNELS[0];
// Enough history that the cursor can be planted well behind the tail with a
// read context above it.
const SEED_COUNT = 400;
const SEED_SENDER = "seed-bot";
// How far behind the planted cursor sits, in RAW rows. It must exceed the
// far-behind threshold, and it is NOT mirrored from the production constant
// on purpose: if the threshold ever rises past this, the far-behind bar
// simply does not appear and the spec fails LOUDLY on its first assertion,
// which is the honest failure. A mirrored copy would instead have to be kept
// in step by hand.
const UNREAD_GAP = 250;
// Own-authored content, sent through the real compose box. Its only job is to
// make the own-exclusion term of the decomposition non-zero — a fixture where
// the operator never spoke would satisfy the identity trivially.
const OWN_LINES = [
    "issue2037: a line the operator typed, one",
    "issue2037: a line the operator typed, two",
    "issue2037: a line the operator typed, three",
];
const PEER_LINES = [
    "issue2037: peer content after the operator's own",
    "issue2037: peer content, second",
];
const OUTCOME_TIMEOUT_MS = 15_000;
// The operator's own rows, counted by IDENTITY rather than by kind. Lowercased
// on both sides because this is a setup guard over wire rows and not a
// production fold-MATCH site — `sender` is stored raw for display and bahamut
// echoes back what we sent, so a case difference here would be a harness
// artefact rather than the thing under test.
const authoredBy = (rows, nick) => rows.filter((r) => r.sender.toLowerCase() === nick.toLowerCase()).length;
// "1807 unread — jump back" → 1807. Reading the rendered string rather than a
// signal is the point: this is the number the operator saw.
const barNumber = async (page) => {
    const text = (await page.getByTestId("far-behind-jump").innerText()).trim();
    const match = /^(\d+)\s+unread/.exec(text);
    if (match === null)
        throw new Error(`#2037 spec: far-behind bar text unparseable: ${text}`);
    return Number(match[1]);
};
const badgeNumber = async (locator) => Number((await locator.innerText()).trim());
test.describe("issue 2037 — the far-behind bar and the sidebar badges", () => {
    // No `afterEach` restoring `show_event_badge`. There was one, and its
    // stated reason — that leaving the pref on would poison the badge specs
    // that follow in this worker — is FALSE: every test runs on its own
    // throwaway subject (`provisionSpecSubject`, named off the title path and
    // DELETEd at teardown), so the pref dies with the user. Both tests below
    // read the OFF default as a fresh fact, and the second one proves it: it
    // asserts the default while running after a test that turned the pref on.
    test("the far-behind bar and the bold pill are ONE number, it is strictly below the raw gap, and bar + events + own accounts for every row", async ({ page, }) => {
        if (!CHANNEL)
            throw new Error("AUTOJOIN_CHANNELS empty");
        const vjt = specUser();
        const admin = getSeededAdmin();
        const ownNick = specNick();
        const peerNick = `i2037a-${Date.now().toString(36)}`;
        await resetSubject(admin.token, vjt.name, { [NETWORK_SLUG]: AUTOJOIN_CHANNELS }, { [NETWORK_SLUG]: [{ name: CHANNEL, seedCount: SEED_COUNT, seedSender: SEED_SENDER }] });
        const peer = await IrcPeer.connect({ nick: peerNick });
        try {
            // The peer's JOIN is a scrollback row like any other, and it is one of
            // the non-message kinds the decomposition needs on the far side of the
            // cursor. Waited for by its persisted row, not by the peer's own echo:
            // the echo says bahamut saw it, not that grappa stored it, and the
            // cursor is planted by id off the stored list.
            await peer.join(CHANNEL);
            await expect
                .poll(async () => {
                const seen = await fetchAllMessagesAsc(vjt.token, NETWORK_SLUG, CHANNEL);
                return seen.some((r) => r.kind === "join" && r.sender === peerNick);
            }, { timeout: OUTCOME_TIMEOUT_MS })
                .toBe(true);
            await loginAs(page, vjt);
            await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick });
            for (const line of OWN_LINES)
                await composeSend(page, line);
            for (const line of PEER_LINES)
                peer.privmsg(CHANNEL, line);
            // The peer's PART closes the fixture: once its row is stored, every row
            // this spec plants is in the table and the id list is stable.
            await peer.part(CHANNEL, "issue2037 fixture complete");
            await expect
                .poll(async () => {
                const seen = await fetchAllMessagesAsc(vjt.token, NETWORK_SLUG, CHANNEL);
                const own = seen.filter((r) => r.body === OWN_LINES[OWN_LINES.length - 1]).length;
                const peerSaid = seen.filter((r) => r.body === PEER_LINES[PEER_LINES.length - 1]).length;
                const parted = seen.some((r) => r.kind === "part" && r.sender === peerNick);
                return own === 1 && peerSaid === 1 && parted;
            }, { timeout: OUTCOME_TIMEOUT_MS })
                .toBe(true);
            // Leave the window BEFORE forcing the cursor backward. With the pane
            // still on it, the settle writer would race the force and put the
            // cursor back at the tail.
            await selectChannel(page, NETWORK_SLUG, "$server", { awaitWsReady: false });
            const rows = await fetchAllMessagesAsc(vjt.token, NETWORK_SLUG, CHANNEL);
            expect(rows.length).toBeGreaterThan(UNREAD_GAP + 20);
            const cursorRow = rows[rows.length - 1 - UNREAD_GAP];
            if (!cursorRow)
                throw new Error("#2037 spec: cursor row index missing");
            const past = rows.filter((r) => r.id > cursorRow.id);
            // Preconditions, guarded rather than assumed. A region with no
            // own-authored rows or no event rows would satisfy "strictly below the
            // raw gap" and the decomposition for the wrong reason.
            expect(past.length).toBe(UNREAD_GAP);
            const ownPast = authoredBy(past, ownNick);
            expect(ownPast, "no own-authored rows past the cursor — fixture degenerate").toBeGreaterThan(0);
            expect(past.some((r) => r.kind === "join") && past.some((r) => r.kind === "part"), "no peer presence rows past the cursor — fixture degenerate").toBe(true);
            await setReadCursorToId(vjt.token, NETWORK_SLUG, CHANNEL, cursorRow.id);
            // A RELOAD, and it is load-bearing rather than tidiness. `probeGap`
            // fires from `loadInitialScrollback`, which sits behind a load-once gate
            // (`loadedChannels`, `scrollback.ts`): this window was already hydrated
            // by the visit above, so simply selecting it again re-renders the store
            // and takes no probe. Measured — the first version of this spec switched
            // away and back, and the bar never appeared while the pane happily
            // rendered the already-loaded rows. The gate is cleared on identity
            // transition and by a fresh document; the document is the cheap one.
            await page.reload();
            await selectChannel(page, NETWORK_SLUG, CHANNEL, { awaitWsReady: false });
            await expect(page.getByTestId("far-behind-bar")).toBeVisible({
                timeout: OUTCOME_TIMEOUT_MS,
            });
            const bar = await barNumber(page);
            const boldPill = sidebarMessageBadge(page, NETWORK_SLUG, CHANNEL);
            // (A) the acceptance criterion — one number, two surfaces.
            await expect(boldPill).toHaveText(String(bar), { timeout: OUTCOME_TIMEOUT_MS });
            // (A) and it is not the raw gap. `toBeGreaterThan(0)` is not decoration:
            // a bar and a pill that both read 0 would satisfy the equality above.
            expect(bar).toBeGreaterThan(0);
            expect(bar, "the bar is still counting raw rows").toBeLessThan(UNREAD_GAP);
            // (B) OFF by default: the faint pill is absent, and so is its accessible
            // name. Both, because zeroing the count is what this change does and an
            // element hidden with its `aria-label` intact would be the wrong half.
            await expect(sidebarEventsBadge(page, NETWORK_SLUG, CHANNEL)).toHaveCount(0);
            await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL).getByRole("img", { name: /event/i })).toHaveCount(0);
            // (B) the toggle brings it back with no reload — the pref is read as a
            // signal at render time, not once at boot.
            const display = await openSettingsSection(page, "display");
            await display.getByTestId("show-event-badge-toggle").check();
            await closeSettings(page);
            const faintPill = sidebarEventsBadge(page, NETWORK_SLUG, CHANNEL);
            await expect(faintPill).toBeVisible({ timeout: OUTCOME_TIMEOUT_MS });
            const events = await badgeNumber(faintPill);
            expect(events).toBeGreaterThan(0);
            // The decomposition. Every row past the cursor is own, or a non-own
            // message, or a non-own event — so these three must account for all of
            // them, exactly.
            expect(bar + events + ownPast, `bar ${bar} + events ${events} + own ${ownPast} != raw gap ${UNREAD_GAP}`).toBe(UNREAD_GAP);
        }
        finally {
            await peer.disconnect("issue2037 done").catch(() => { });
            // BUGHUNT-3 cascade rule — the planted cursor is backward and would
            // change what every later spec on this channel sees.
            await restoreReadCursorToTail(vjt.token, NETWORK_SLUG, CHANNEL).catch(() => { });
        }
    });
    test("a KICK earns no badge while the events pref is off, and is NOT smuggled into the message bucket", async ({ page, }) => {
        // The deliberate behaviour change, given its own spec rather than a
        // comment. `topic`, `kick` and `server_event` sit OUTSIDE
        // `suppressed_presence_kinds/0` on purpose (#458) because the PANE still
        // renders them on a denoised channel — but they are `kind not in
        // @content_kinds`, so they are `!messaggi` and they follow the bucket into
        // the opt-in. Rendering in the pane and earning a badge are different
        // questions and this pref answers only the second.
        //
        // The other half is the one a "fix" would get wrong: a kick must not be
        // promoted into the MESSAGE bucket to keep it loud. That would put a
        // non-message back into the very number the bar now shares with the bold
        // pill and undo A. A kick that must stay loud belongs in the
        // mention/severity channel (#267).
        if (!CHANNEL)
            throw new Error("AUTOJOIN_CHANNELS empty");
        const vjt = specUser();
        const ownNick = specNick();
        const stamp = Date.now().toString(36);
        const kickChannel = `#i2037k-${stamp}`;
        const opNick = `i2037op-${stamp}`;
        const victimNick = `i2037v-${stamp}`;
        // The founding JOINer auto-ops on the testnet bahamut (cp15-b6), so the
        // op joins first. The victim is a THIRD party on purpose: a kick aimed at
        // the operator would flip the window to `:kicked` and change what is
        // being measured from "which bucket does a kick land in" to "what does a
        // kicked window look like", which is cp15-b6's question.
        const op = await IrcPeer.connect({ nick: opNick });
        const victim = await IrcPeer.connect({ nick: victimNick });
        try {
            await op.join(kickChannel);
            await victim.join(kickChannel);
            await loginAs(page, vjt);
            await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick });
            await composeSend(page, `/join ${kickChannel}`);
            await expect(page
                .locator('[data-testid="scrollback-line"][data-kind="join"]')
                .filter({ hasText: ownNick })
                .filter({ hasText: kickChannel })
                .first()).toBeVisible({ timeout: OUTCOME_TIMEOUT_MS });
            // Park elsewhere so the kick lands in a BACKGROUND window and stays
            // unread — the focused window's cursor would advance over it.
            await selectChannel(page, NETWORK_SLUG, CHANNEL, { awaitWsReady: false });
            await expect(sidebarWindow(page, NETWORK_SLUG, kickChannel)).toHaveCount(1);
            await op.kick(kickChannel, victimNick, "issue2037: the bucket a kick lands in");
            // Server-side truth first: a red below then separates "the kick never
            // reached grappa" from "it did and the badge is wrong".
            await expect
                .poll(async () => {
                const seen = await fetchAllMessagesAsc(vjt.token, NETWORK_SLUG, kickChannel);
                return seen.some((r) => r.kind === "kick");
            }, { timeout: OUTCOME_TIMEOUT_MS })
                .toBe(true);
            // No faint pill, no accessible name, and no BOLD pill either: the kick
            // must not have been counted as a message.
            await expect(sidebarEventsBadge(page, NETWORK_SLUG, kickChannel)).toHaveCount(0);
            await expect(sidebarWindow(page, NETWORK_SLUG, kickChannel).getByRole("img", { name: /event/i })).toHaveCount(0);
            await expect(sidebarMessageBadge(page, NETWORK_SLUG, kickChannel), "a kick was counted as a message").toHaveCount(0);
            // Opting in shows it, and shows it as ONE event — the kick, and nothing
            // the operator's own join contributed (own rows are never unread).
            const display = await openSettingsSection(page, "display");
            await display.getByTestId("show-event-badge-toggle").check();
            await closeSettings(page);
            await expect(sidebarEventsBadge(page, NETWORK_SLUG, kickChannel)).toHaveText("1", {
                timeout: OUTCOME_TIMEOUT_MS,
            });
            await expect(sidebarMessageBadge(page, NETWORK_SLUG, kickChannel)).toHaveCount(0);
        }
        finally {
            await victim.disconnect("issue2037 done").catch(() => { });
            await op.disconnect("issue2037 done").catch(() => { });
            await composeSend(page, `/part ${kickChannel}`).catch(() => { });
        }
    });
});

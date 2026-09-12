// Issue 2031 — sending with the `── XX unread messages ──` marker on screen
// leaves the just-sent row CLIPPED at the bottom of the scrollback.
//
// ## Why this spec exists next to issue625, which already sends with a marker
//
// `issue625-single-send-scroll-jump.spec.ts` second case builds the SAME
// shape — mid-page cursor, marker rendered, send from history — and it is
// green. So the defect does not live in what that spec asserts; it lives in
// the gap between those assertions and "the reader can see what they sent".
// Both of its visibility assertions pass with the row mostly off-screen:
//
//   * `distance-to-tail <= SCROLL_BOTTOM_THRESHOLD_PX` is 50px of declared
//     slack, and a message row is shorter than that. A pane every existing
//     assertion calls "at the tail" can hold a whole row below the fold.
//   * `toBeInViewport()` defaults to `ratio: 0` — ANY non-empty intersection
//     passes, so a row showing one pixel is "in viewport". It also measures
//     against the browser viewport, not the scroller, so it cannot describe a
//     row the pane itself clips.
//
// This spec asserts the row's BOX against the PANE's BOX (`rowClearance`), and
// that is the whole point: the 50px tolerance is the thing under accusation,
// so the assertion may not be written in terms of it.
//
// ## The second face, from the report
//
// vjt's comment adds: when the row sits slightly off, "after a moment it
// shifts by a few pixels on its own". That is a scroll write landing AFTER the
// send settled, which is #625's own signature, so it is asserted here too —
// on the reported platform, which #625 never runs on.
//
// ## What this actually measured, before any cure existed
//
// Nine runs on the untouched tree (`--repeat-each 3`), and the terminal state
// is two-valued:
//
//   webkit-iphone-15   3/3   distanceFromBottom = 7   overflowBelow = +0.203
//   chromium           2/3   distanceFromBottom = 7   overflowBelow = +0.359
//   chromium           1/3   distanceFromBottom = 0   overflowBelow = -6.640
//
// So the pane does NOT stop inside the 50px slack by a wide margin — it stops
// SEVEN pixels short of its own tail, which is the extent of the scroller's
// own `padding-bottom`. `scrollIntoView({ block: "end" })` brings the row's
// bottom to the pane's bottom EDGE and leaves that padding unscrolled; the row
// then sits flush, with zero clearance and a fraction of a pixel cut off. The
// remaining 7px is never corrected, because 7 <= 50 makes the #625 fail-safe
// read the pane as "at the tail" and skip its write.
//
// That is the issue's own candidate mechanism, now MEASURED rather than
// inherited — with one correction to it: the marker collapse is not what
// leaves the pane short. `scrollIntoView`'s padding blind spot is.
//
// The report's SECOND face did NOT reproduce. Every one of the nine runs
// recorded exactly ONE scroll write, so nothing moved the pane after the send
// settled and assertion (b) below is green on the untouched tree. It is
// asserted anyway: it is the invariant #625 bought, this is the first spec to
// state it on webkit, and a cure that reintroduced a delayed write would
// otherwise land unnoticed. A green there is a guard, not a reproduction.
//
// ## Platform
//
// Reported from iPhone, and not a regression. On webkit the shortfall is
// DETERMINISTIC (3/3); on chromium it is 2/3, so the desktop case is expected
// to be an unreliable red before the cure and a solid green after. Both are
// kept: the defect is geometry rather than engine, and that is worth pinning
// on both rather than assuming.
//
// ## Two hypotheses this spec falsified — kept because a dead end that is
// ## written down is not walked twice
//
// 1. THE SOFT KEYBOARD IS NOT INVOLVED. A third case sent with
//    `visualViewport` shrunk to 300px the way issue253 stubs it, and produced
//    numbers IDENTICAL to its keyboard-less twin to the third decimal
//    (distance 7, overflow +0.203, 3/3). The case and its fixture were removed
//    rather than kept green-and-meaningless.
// 2. THE LAYOUT MECHANISM IS NOT THIS ONE. `themes/default.css` records "last
//    messages hide behind BottomBar" on iOS WebKit (UX-6 bucket D v2), which
//    is the same complaint from a different cause — a pane painted past its
//    own box. Measured, `composeTopPx` equals `paneBottomPx` exactly on both
//    engines, so nothing is painted under the compose and that cure is not the
//    one needed here. `rowClearance` still reports the field, so the next
//    reader can tell the two apart instead of re-deriving it.
import { composeSend, loginAs, rowClearance, scrollbackDistanceFromBottom, scrollbackLines, selectChannel, waitForScrollbackRefreshed, } from "../fixtures/cicchettoPage";
import { fetchScrollbackPage, setReadCursorToId } from "../fixtures/grappaApi";
import { delayedWrites, dumpScrollProbe, installScrollProbe } from "../fixtures/scrollWriteProbe";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";
const CHANNEL = AUTOJOIN_CHANNELS[0];
// Mirror of `lib/scrollThresholds.ts` SCROLL_BOTTOM_THRESHOLD_PX — used ONLY
// to build the precondition (the pane parked in history is more than this from
// the tail) and to cross-read a failure. Never as the visibility assertion:
// that is the tolerance under accusation.
const SCROLL_BOTTOM_THRESHOLD_PX = 50;
// REST default page size (Grappa.Web.MessagesController.@default_limit).
const REST_PAGE_SIZE = 50;
// 🔴 ZERO, and the first draft of this spec got it wrong at 1px.
//
// A 1px "sub-pixel slack" was written in defensively, and MEASURED over nine
// runs it swallowed the defect whole: the clipped state overflows the pane's
// bottom edge by +0.203px (webkit) / +0.359px (chromium), so the spec passed
// while photographing exactly what it was written to catch.
//
// Zero is not a knife edge here, which is the reason it is safe. The two
// states are ~7px apart and neither is near the boundary:
//   correct   distanceFromBottom = 0, overflowBelow = -6.64 … -7.44  (clear)
//   defective distanceFromBottom = 7, overflowBelow = +0.20 … +0.36  (clipped)
// There is no sub-pixel path from -6.6 to +0.2, so rounding cannot flip the
// verdict; only the shortfall can.
const SUBPIXEL_TOLERANCE_PX = 0;
// Must outlast every #608 deferred writer: SETTLE_MAX_FRAMES (30) ≈ 0.5s,
// SCROLL_SETTLE_DEBOUNCE_MS = 500, PRESENCE_CURSOR_SETTLE_MS = 500. Same
// window issue625 samples over, for the same reason.
const SAMPLE_WINDOW_MS = 2500;
// A send's ONE legitimate tail-follow fires at frame 0 of its poll; the
// delayed one lands SETTLE_MAX_FRAMES ≈ 0.5s later. Measured from the first
// observed write, never from probe-install — see `delayedWrites`.
const SETTLE_GRACE_MS = 300;
// Park the reader in history with the unread marker rendered, then assert the
// marker is REALLY on screen — the issue's precondition is "with the marker
// visible", and a marker that exists below the fold is a different scenario.
async function parkOnVisibleMarker(page) {
    const vjt = specUser();
    if (!CHANNEL)
        throw new Error("AUTOJOIN_CHANNELS empty");
    const page0 = await fetchScrollbackPage(vjt.token, NETWORK_SLUG, CHANNEL);
    expect(page0.length).toBeGreaterThanOrEqual(REST_PAGE_SIZE);
    const cursorRow = page0[25];
    if (!cursorRow)
        throw new Error("seeded page too short for cursor placement");
    await setReadCursorToId(vjt.token, NETWORK_SLUG, CHANNEL, cursorRow.id);
    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
    await waitForScrollbackRefreshed(page, NETWORK_SLUG, CHANNEL);
    await expect
        .poll(async () => await scrollbackLines(page).count(), { timeout: 10_000 })
        .toBeGreaterThanOrEqual(REST_PAGE_SIZE);
    const marker = page.locator('[data-testid="unread-marker"]');
    await expect(marker).toHaveCount(1);
    // ON SCREEN, not merely present: the report's trigger is a visible marker.
    await expect(marker).toBeInViewport();
    // Parked in history: the pane is above the fold when the send happens.
    await expect
        .poll(async () => (await scrollbackDistanceFromBottom(page)) ?? 0, { timeout: 10_000 })
        .toBeGreaterThan(SCROLL_BOTTOM_THRESHOLD_PX);
}
// The body of both cases. Kept as one function because the two differ ONLY in
// the engine they run on, and a copy would let them drift into testing
// different things on the two platforms — which is the one comparison the
// pair exists to make.
async function sendWithMarkerAndAssertVisible(page, tag) {
    await parkOnVisibleMarker(page);
    await installScrollProbe(page, SAMPLE_WINDOW_MS);
    const body = `i2031 ${tag} ${Date.now()}`;
    await composeSend(page, body);
    const sentLine = scrollbackLines(page).filter({ hasText: body });
    await expect(sentLine).toHaveCount(1, { timeout: 10_000 });
    // VACUITY GUARD. The scenario is "a send that collapses a visible marker",
    // and the marker collapse is the follow-on rows change the candidate
    // mechanism turns on. If the re-latch never ran, the run under test never
    // happened and a green below would mean nothing. `lastOwnSend` fires after
    // the POST resolves, so this is also the barrier that the send CONFIRMED.
    await expect(page.locator('[data-testid="unread-marker"]')).toHaveCount(0, {
        timeout: 10_000,
    });
    // Let every deferred writer land before reading the terminal geometry.
    await page.waitForTimeout(SAMPLE_WINDOW_MS + 200);
    const { samples, writes } = await dumpScrollProbe(page, tag);
    expect(samples.length).toBeGreaterThan(10);
    // ── (a) the sent row is FULLY visible in the pane that clips it ──────────
    const clearance = await rowClearance(sentLine);
    console.log(`[#2031 ${tag}] clearance=${JSON.stringify(clearance)}`);
    expect(clearance.overflowBelowPx, `the sent row is clipped at the pane's bottom edge. ` +
        `overflowBelow=${clearance.overflowBelowPx.toFixed(1)}px, ` +
        `distanceFromBottom=${clearance.distanceFromBottomPx.toFixed(1)}px ` +
        `(threshold ${SCROLL_BOTTOM_THRESHOLD_PX}), ` +
        `hiddenBehindCompose=${clearance.hiddenBehindComposePx?.toFixed(1) ?? "n/a"}px. ` +
        `overflowBelow>0 ⇒ SCROLL (pane short of its tail); ` +
        `overflowBelow<=0 with hiddenBehindCompose>0 ⇒ LAYOUT (pane painted under the compose).`).toBeLessThanOrEqual(SUBPIXEL_TOLERANCE_PX);
    // The same row must not be covered by the compose either — the LAYOUT face
    // of the identical complaint, which the pane-box comparison alone cannot see.
    //
    // ⚠️ Today this is DEGENERATE and says nothing the assertion above did not:
    // measured, `composeTopPx === paneBottomPx` exactly on both engines (the two
    // are flush flex siblings), so `hiddenBehindCompose` equals `overflowBelow`
    // to the bit. It earns its place only in the state it exists to catch — a
    // pane painted PAST its own box, where `composeTop < paneBottom` and the two
    // numbers separate. Stated rather than dropped: a reader who finds two
    // assertions agreeing on every run deserves to know which one is load-bearing
    // now and which is a tripwire for later.
    if (clearance.hiddenBehindComposePx !== null) {
        expect(clearance.hiddenBehindComposePx, `the sent row is inside the pane but painted under the compose: ` +
            `rowBottom=${clearance.rowBottomPx.toFixed(1)}, composeTop=${clearance.composeTopPx?.toFixed(1)}`).toBeLessThanOrEqual(SUBPIXEL_TOLERANCE_PX);
    }
    // ── (b) nothing writes scroll after the send settled ─────────────────────
    // The report's second face: "after a moment it shifts by a few pixels on its
    // own". Same invariant #625 pins on chromium; asserted here on the reported
    // platform too.
    expect(writes.length, `expected the send's tail-follow write; writes=${JSON.stringify(writes)}`).toBeGreaterThanOrEqual(1);
    expect(delayedWrites(writes, SETTLE_GRACE_MS), `scroll write(s) landed after the send settled: ${JSON.stringify(writes)}`).toEqual([]);
}
test.describe("issue 2031 — a send with the unread marker on screen (desktop)", () => {
    // Tiny viewport so the seeded buffer overflows and the geometry is real —
    // the same 800×300 issue580 / issue625 use.
    test.use({ viewport: { width: 800, height: 300 } });
    test("the sent row lands fully inside the pane, and nothing scrolls after", async ({ page }) => {
        await sendWithMarkerAndAssertVisible(page, "desktop");
    });
});
test.describe("issue 2031 — a send with the unread marker on screen (iPhone)", () => {
    // No `test.use({ viewport })` here on purpose: the `webkit-iphone-15`
    // project's device descriptor owns the viewport, and overriding it would
    // throw away the fidelity that makes this the reported platform's case.
    test("@webkit the sent row lands fully inside the pane, and nothing scrolls after", async ({ page, }) => {
        await sendWithMarkerAndAssertVisible(page, "iphone");
    });
});

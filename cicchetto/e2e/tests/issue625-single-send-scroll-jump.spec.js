// Issue #625 — a single send must NOT jump the pane UP before it settles at
// the tail. (Refs #608 — the single-scroll-authority refactor whose headline
// promise "no double scroll" this pins.)
//
// ## The field report (vjt, staging serving main)
//
// After sending a message the pane scrolls "too far up" and then falls back
// down to the bottom. Discriminating facts from vjt's observations:
//   1. it happens on a SINGLE send, not only in rapid succession — so it is
//      not two writes racing IN FLIGHT; it is two writes in sequence per send;
//   2. "something resets the scroll after a while" — the errant write is
//      DELAYED (a timer / a later render), NOT synchronous with the keypress.
//
// Consequence for the test: a snapshot taken right after the send finds the
// pane at the bottom and FALSE-GREENs. The bug is only visible by sampling the
// scroll geometry OVER TIME, across a window that outlasts every #608 deferred
// writer (the tail-follow's SETTLE_MAX_FRAMES ≈ 0.5s poll, the 0.5s
// scroll-settle / presence-settle timers). This spec samples for ~2.5s.
//
// ## The invariant
//
// The reader is following (or has just sent, which #608 arms follow). After a
// send the pane is carried DOWN with the new tail and must STAY there — it must
// never travel back UP. Appending one short line lifts distance-to-tail by ≪
// the 50px bottom threshold, so any sample above the threshold AFTER the pane
// first reached the tail means the pane was dragged away — the "too far up"
// jump.
//
// Harness mirrors issue580 (DB-seeded 200-row #spec-wN; tiny 800×300 viewport so
// the buffer overflows and scroll geometry is measurable).
import { composeSend, loginAs, scrollbackDistanceFromBottom, scrollbackLines, selectChannel, waitForScrollbackRefreshed, } from "../fixtures/cicchettoPage";
import { fetchScrollbackPage, restoreReadCursorToTail, setReadCursorToId, } from "../fixtures/grappaApi";
import { delayedWrites, distanceOf, dumpScrollProbe, installScrollProbe, } from "../fixtures/scrollWriteProbe";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";
const CHANNEL = AUTOJOIN_CHANNELS[0];
// Mirror of ScrollbackPane.SCROLL_BOTTOM_THRESHOLD_PX = 50 (not exported; kept
// in lockstep by hand — same as issue168 / cp14-b1 / issue580).
const SCROLL_BOTTOM_THRESHOLD_PX = 50;
// REST default page size (Grappa.Web.MessagesController.@default_limit).
const REST_PAGE_SIZE = 50;
// Sampling window — must outlast every #608 deferred writer. SETTLE_MAX_FRAMES
// (30) ≈ 0.5s, SCROLL_SETTLE_DEBOUNCE_MS = 500, PRESENCE_CURSOR_SETTLE_MS = 500.
const SAMPLE_WINDOW_MS = 2500;
// A single send's ONE legitimate tail-follow fires at frame 0 of its poll (with
// the WS echo). The regression's SECOND write is the fail-safe of a redundant
// follow-on poll, landing SETTLE_MAX_FRAMES ≈ 0.5s LATER. We measure that gap
// from the FIRST observed write, NOT from probe-install: the echo's own latency
// (fill+press CDP round-trip + WS round-trip, tolerated up to 10s below) floats
// the legitimate write's absolute timestamp, so an absolute cutoff would
// false-RED on a slow run. The defect IS the ~0.5s gap between two writes.
const SETTLE_GRACE_MS = 300;
// The sampler + scroll-write spy moved to `fixtures/scrollWriteProbe.ts` when
// issue 2031 needed the same instrument — one recorder, so the two specs
// cannot drift into disagreeing about what counts as a write.
test.describe("issue #625 — a single send must not jump the pane up before settling", () => {
    test.use({ viewport: { width: 800, height: 300 } });
    test("send while at the tail: distance-to-tail never spikes up over 2.5s", async ({ page }) => {
        const vjt = specUser();
        if (!CHANNEL)
            throw new Error("AUTOJOIN_CHANNELS empty");
        await restoreReadCursorToTail(vjt.token, NETWORK_SLUG, CHANNEL);
        await loginAs(page, vjt);
        await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
        await waitForScrollbackRefreshed(page, NETWORK_SLUG, CHANNEL);
        await expect
            .poll(async () => await scrollbackLines(page).count(), { timeout: 10_000 })
            .toBeGreaterThanOrEqual(REST_PAGE_SIZE);
        await expect
            .poll(async () => (await scrollbackDistanceFromBottom(page)) ?? 999, { timeout: 10_000 })
            .toBeLessThanOrEqual(SCROLL_BOTTOM_THRESHOLD_PX);
        await installScrollProbe(page, SAMPLE_WINDOW_MS);
        const marker = `i625 at-tail ${Date.now()}`;
        await composeSend(page, marker);
        const sentLine = scrollbackLines(page).filter({ hasText: marker });
        await expect(sentLine).toHaveCount(1, { timeout: 10_000 });
        await page.waitForTimeout(SAMPLE_WINDOW_MS + 200);
        const { samples, writes } = await dumpScrollProbe(page, "at-tail");
        expect(samples.length).toBeGreaterThan(10);
        // #625 CORE — no DELAYED second scroll write. A single send performs ONE
        // tail-follow; the regression's redundant follow-on poll fires its fail-safe
        // scroll ~0.5s later. RED on main; GREEN once that write is suppressed.
        expect(writes.length, `expected the send's tail-follow write; writes=${JSON.stringify(writes)}`).toBeGreaterThanOrEqual(1);
        const late = delayedWrites(writes, SETTLE_GRACE_MS);
        expect(late, `delayed scroll write(s) after the send's tail-follow: ${JSON.stringify(writes)}`).toEqual([]);
        // Visible-symptom guard: following a send, the pane never travels UP.
        const maxDist = Math.max(...samples.map(distanceOf));
        expect(maxDist).toBeLessThanOrEqual(SCROLL_BOTTOM_THRESHOLD_PX);
        await expect(sentLine).toBeInViewport();
    });
    test("send while reading history (unread marker): pane settles at tail and stays", async ({ page, }) => {
        const vjt = specUser();
        if (!CHANNEL)
            throw new Error("AUTOJOIN_CHANNELS empty");
        // Mid-page cursor → cold-mount lands on the unread marker, ABOVE the fold:
        // the reader is parked in history when they send (vjt's scenario).
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
        await expect(page.locator('[data-testid="unread-marker"]')).toHaveCount(1);
        // Parked in history, above the fold.
        await expect
            .poll(async () => (await scrollbackDistanceFromBottom(page)) ?? 0, { timeout: 10_000 })
            .toBeGreaterThan(SCROLL_BOTTOM_THRESHOLD_PX);
        await installScrollProbe(page, SAMPLE_WINDOW_MS);
        const marker = `i625 from-history ${Date.now()}`;
        await composeSend(page, marker);
        const sentLine = scrollbackLines(page).filter({ hasText: marker });
        await expect(sentLine).toHaveCount(1, { timeout: 10_000 });
        await page.waitForTimeout(SAMPLE_WINDOW_MS + 200);
        const { samples, writes } = await dumpScrollProbe(page, "from-history");
        expect(samples.length).toBeGreaterThan(10);
        // #625 CORE — same invariant as the at-tail case: a single send must not fire
        // a DELAYED second scroll write. (Here the follow-on rows change is the marker
        // collapse, which cannot settle and hits the fail-safe.)
        expect(writes.length, `expected the send's tail-follow write; writes=${JSON.stringify(writes)}`).toBeGreaterThanOrEqual(1);
        const late = delayedWrites(writes, SETTLE_GRACE_MS);
        expect(late, `delayed scroll write(s) after the send's tail-follow: ${JSON.stringify(writes)}`).toEqual([]);
        // #608: a send follows the tail unconditionally → the pane reaches the bottom.
        // Once there, it STAYS (a delayed writer would drag it back UP).
        const firstAtTail = samples.findIndex((s) => distanceOf(s) <= SCROLL_BOTTOM_THRESHOLD_PX);
        expect(firstAtTail).toBeGreaterThanOrEqual(0);
        const afterSettle = samples.slice(firstAtTail);
        const maxAfterSettle = Math.max(...afterSettle.map(distanceOf));
        expect(maxAfterSettle).toBeLessThanOrEqual(SCROLL_BOTTOM_THRESHOLD_PX);
        await expect(sentLine).toBeInViewport();
    });
});

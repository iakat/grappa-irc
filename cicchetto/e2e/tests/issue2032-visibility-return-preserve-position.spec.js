// issue 2032 — returning from an EXTERNAL link must leave the reader exactly
// where they were, even when an unread divider renders on the return.
//
// Reported: tapping a link that leaves the app (external browser / another tab)
// and coming back moves the reader off the position they were reading at.
// Desktop AND mobile, long-standing. Modals are unaffected — they never hide the
// document, so the pane holds position through `overlay-freeze` (a different
// writer).
//
// ## What this file adds that issue535-visibility-return-preserve-scroll.spec.ts
// ## could not catch
//
// #535 shipped `"marker-or-preserve"`, a mode that PRESERVES only when NO
// divider renders — with a divider present it `scrollIntoView`s it, i.e. it
// moves the reader. Its own spec pinned that as the contract ("return lands ON
// the divider"), so the whole divider-present half of the space was green by
// construction. The discriminating case is therefore the one with a divider
// PRESENT on the return; without one the code already preserves and any test is
// vacuous.
//
// Two writers move the reader on a visibility-return, and BOTH must be held:
//
//   1. the divider JUMP — `scrollToActivation` reads the `unread-marker` node
//      for `"marker-or-preserve"` exactly as it does for a deliberate switch;
//   2. the divider RE-LATCH — the visibility arm re-pointed `markerCursorId` at
//      the LIVE read cursor, which recomputes `rows()`; `<For>` is keyed by
//      reference and every row is a fresh object, so the DOM list is recreated
//      and scrollTop collapses to 0. Today that reset is MASKED by writer 1
//      landing somewhere immediately after it.
//
// The test below exercises BOTH: the reader reads DOWNWARD past the frozen
// divider, which arms the input-gated scroll-settle (`SCROLL_SETTLE_DEBOUNCE_MS`
// = 500) and advances the LIVE cursor past the divider — so on return the
// re-latch has somewhere new to point. Removing only writer 1 leaves the reader
// at scrollTop 0; removing only writer 2 leaves them on the divider. The
// contract holds only when both are gone.
//
// ## Contract
//
// A visibility-return is a RESUME, not a window change: it preserves the
// reader's scroll position and leaves the frozen divider where it was. Only a
// DELIBERATE activation (switch / cold-mount) lands on the divider — guarded by
// the second test here, and more fully by scroll-on-window-switch.spec.ts
// ("SWITCH into channel-with-unreads", "fresh focus / cold-mount") which this
// file deliberately does not restate.
//
// ## Oracle
//
// scrollTop in RAW PIXELS against a sub-pixel epsilon — NOT
// `SCROLL_BOTTOM_THRESHOLD_PX`. That constant is a product threshold for
// classifying follow INTENT (50px, deliberately generous); reusing it as a
// tolerance would swallow any defect smaller than the band. The defect here is
// a viewport-scale jump, but the epsilon is sized to the MEASUREMENT, not to the
// defect, so the spec stays honest if the jump ever shrinks.
//
// ## Fixture shape (matches issue535 / scroll-on-window-switch / cp14-b1)
//
// The 200 DB-seeded rows on `(specUser, bahamut-test, #spec-wN)` plus an 800×300
// viewport so the 50-row REST page overflows — without overflow "not at the
// tail" is vacuous. The per-spec subject (sha1 of the title path) owns its own
// cursor, so no afterAll restore is needed.
import { loginAs, scrollbackLines, selectChannel } from "../fixtures/cicchettoPage";
import { fetchScrollbackPage, setReadCursorToId } from "../fixtures/grappaApi";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";
const CHANNEL = AUTOJOIN_CHANNELS[0];
const REST_PAGE_SIZE = 50;
// Sub-pixel measurement epsilon. Deliberately NOT SCROLL_BOTTOM_THRESHOLD_PX
// (50) — see the "Oracle" note above.
const SCROLL_EPS_PX = 2;
// Clear of LOAD_MORE_THRESHOLD_PX (200) so paging older rows in never churns
// the buffer under the assertions.
const CLEAR_OF_TAIL_PX = 200;
// ScrollbackPane.SCROLL_SETTLE_DEBOUNCE_MS = 500 (not exported; kept in lockstep
// the same way issue535 mirrors SCROLL_BOTTOM_THRESHOLD_PX). The settle POST is
// what advances the LIVE cursor past the frozen divider — the whole premise of
// the re-latch case — so the wait must clear it with margin.
const SCROLL_SETTLE_WAIT_MS = 900;
async function scrollbackGeometry(page) {
    return await page.evaluate(() => {
        const el = document.querySelector('[data-testid="scrollback"]');
        if (!el)
            throw new Error("scrollback container not found");
        return {
            scrollTop: el.scrollTop,
            scrollHeight: el.scrollHeight,
            clientHeight: el.clientHeight,
        };
    });
}
async function distanceFromBottom(page) {
    const g = await scrollbackGeometry(page);
    return g.scrollHeight - g.scrollTop - g.clientHeight;
}
// The divider's offset from the top of the scroll container's VIEWPORT.
// ~0 → the reader is parked on it (block:"start"); negative → the reader has
// read PAST it and it is above the fold.
async function markerViewportOffset(page) {
    return await page.evaluate(() => {
        const el = document.querySelector('[data-testid="scrollback"]');
        const m = document.querySelector('[data-testid="unread-marker"]');
        if (!el)
            throw new Error("scrollback container not found");
        if (!m)
            throw new Error("unread-marker not rendered");
        return m.getBoundingClientRect().top - el.getBoundingClientRect().top;
    });
}
// WHERE the frozen divider sits in the row list, independent of scroll. The
// re-latch MOVES it; the freeze contract on a resume must not. Index among the
// container's element children is stable under a tail append (the async
// `refreshScrollback` co-trigger), which a pixel offset is not.
async function markerRowIndex(page) {
    return await page.evaluate(() => {
        const el = document.querySelector('[data-testid="scrollback"]');
        if (!el)
            throw new Error("scrollback container not found");
        const kids = Array.from(el.children);
        const idx = kids.findIndex((c) => c.getAttribute("data-testid") === "unread-marker");
        if (idx < 0)
            throw new Error("unread-marker not among scrollback children");
        return idx;
    });
}
// A REAL Chromium wheel gesture. Required twice over: `onScroll` only flips the
// follow state on a genuine gesture, and the cursor scroll-settle is gated on a
// recent INPUT event (`INPUT_EVENT_RECENCY_MS`) — a synthetic scroll event is
// deliberately gated out (BUGHUNT-2), so it would never advance the cursor and
// the re-latch premise would silently not hold. Same idiom as issue535.
async function wheelBy(page, deltaY) {
    const box = await page.locator('[data-testid="scrollback"]').boundingBox();
    if (!box)
        throw new Error("scrollback bounding box null");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, deltaY);
}
// Flip document visibility deterministically. documentVisibility.ts reads BOTH
// `document.visibilityState` AND `document.hasFocus()`, so both are overridden;
// the production listeners' events are dispatched so the Solid signal updates.
// Identical idiom to issue535 / freshness-on-activation.
async function setTabHidden(page, hidden) {
    await page.evaluate((isHidden) => {
        Object.defineProperty(document, "visibilityState", {
            configurable: true,
            get: () => (isHidden ? "hidden" : "visible"),
        });
        Object.defineProperty(document, "hasFocus", {
            configurable: true,
            value: () => !isHidden,
        });
        document.dispatchEvent(new Event("visibilitychange"));
        window.dispatchEvent(new Event(isHidden ? "blur" : "focus"));
    }, hidden);
    await page.waitForTimeout(150);
}
// Seed a cursor `back` rows from the tail so an unread divider injects, then log
// in and land on the channel. Returns nothing — callers assert their own
// preconditions off the live DOM.
async function seedCursorAndOpen(page, back) {
    const vjt = specUser();
    if (!CHANNEL)
        throw new Error("AUTOJOIN_CHANNELS empty");
    const page0 = await fetchScrollbackPage(vjt.token, NETWORK_SLUG, CHANNEL);
    expect(page0.length).toBeGreaterThanOrEqual(REST_PAGE_SIZE);
    const cursorRow = page0[back];
    if (!cursorRow)
        throw new Error(`seeded page too short for a cursor ${back} rows back`);
    await setReadCursorToId(vjt.token, NETWORK_SLUG, CHANNEL, cursorRow.id);
    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
    await expect
        .poll(async () => await scrollbackLines(page).count(), { timeout: 10_000 })
        .toBeGreaterThanOrEqual(REST_PAGE_SIZE);
}
test.describe("issue 2032 — a visibility-return resumes, it does not re-activate", () => {
    test.use({ viewport: { width: 800, height: 300 } });
    test("reader who read PAST the divider: returning preserves scrollTop and leaves the divider frozen", async ({ page, }) => {
        // 45 rows of unread puts the divider near the TOP of the 50-row REST page,
        // leaving room to read a long way DOWN past it without reaching the tail.
        await seedCursorAndOpen(page, 45);
        const marker = page.locator('[data-testid="unread-marker"]');
        await expect(marker).toHaveCount(1);
        // PREMISE 1 (and the #168 contract): the deliberate activation that opened
        // this window landed ON the divider. If this ever stops holding, the case
        // below is not the one this file claims to test and must die here rather
        // than pass for the wrong reason.
        const g0 = await scrollbackGeometry(page);
        expect(g0.scrollHeight).toBeGreaterThan(g0.clientHeight);
        // Poll the LANDING itself (the activation scroll settles inside a rAF×2),
        // not a bound the pre-landing state would also satisfy.
        await expect
            .poll(async () => await markerViewportOffset(page), { timeout: 10_000 })
            .toBeLessThan(g0.clientHeight / 2);
        expect(await markerViewportOffset(page)).toBeGreaterThanOrEqual(-5);
        // PREMISE 2: there is enough unread content BELOW the divider to read into
        // without landing at the tail. Measured, not assumed — a shorter buffer
        // would make the scroll-down below a no-op.
        const room = await distanceFromBottom(page);
        expect(room).toBeGreaterThan(2 * CLEAR_OF_TAIL_PX);
        // The reader reads DOWNWARD through the unread run — a real wheel gesture,
        // sized from the MEASURED room so it never depends on a row height. Half the
        // remaining distance keeps them clear of the tail.
        await wheelBy(page, Math.floor(room / 2));
        await expect.poll(async () => await distanceFromBottom(page)).toBeGreaterThan(CLEAR_OF_TAIL_PX);
        // Let the input-gated scroll-settle fire: it POSTs the visible-tail id and
        // advances the LIVE read cursor PAST the frozen divider. This is what gives
        // the visibility re-latch a new place to point.
        await page.waitForTimeout(SCROLL_SETTLE_WAIT_MS);
        // PREMISE 3: the reader is now BELOW the divider (it is above the fold) and
        // the divider has NOT moved while they read — the freeze contract. Both are
        // what make the re-latch on return observable.
        expect(await markerViewportOffset(page)).toBeLessThan(0);
        const beforeIndex = await markerRowIndex(page);
        const before = await scrollbackGeometry(page);
        expect(before.scrollTop).toBeGreaterThan(CLEAR_OF_TAIL_PX);
        // Tap the link, leave the app, come back.
        await setTabHidden(page, true);
        await setTabHidden(page, false);
        // Generous enough to contain the visibility effect's rAF×2 AND the async
        // refreshScrollback append that can follow it.
        await page.waitForTimeout(700);
        // CONTRACT: the reader is exactly where they left off.
        //
        // RED pre-cure, two ways at once: the re-latch recomputes `rows()` and the
        // ref-keyed `<For>` drops scrollTop to 0, then the divider jump lands the
        // reader on the re-latched divider — neither is `before.scrollTop`.
        const after = await scrollbackGeometry(page);
        expect(Math.abs(after.scrollTop - before.scrollTop)).toBeLessThanOrEqual(SCROLL_EPS_PX);
        // Not tail-snapped (the #535 regression) and not stranded at the top (the
        // <For> recreation), stated as outcomes in their own right so a failure
        // names WHICH way the reader was moved.
        expect(after.scrollHeight - after.scrollTop - after.clientHeight).toBeGreaterThan(CLEAR_OF_TAIL_PX);
        expect(after.scrollTop).toBeGreaterThan(CLEAR_OF_TAIL_PX);
        // The frozen divider stayed frozen: a resume is not a focus acquisition, so
        // it does not re-latch to the live cursor.
        await expect(marker).toHaveCount(1);
        expect(await markerRowIndex(page)).toBe(beforeIndex);
        expect(await markerViewportOffset(page)).toBeLessThan(0);
    });
    test("a DELIBERATE activation still lands on the divider (#168 must not regress)", async ({ page, }) => {
        // The cure narrows the divider query in `scrollToActivation` to the
        // deliberate modes only. This is the guard that the narrowing did not take
        // the deliberate arm with it. The pure window-SWITCH arm of the same mode is
        // guarded by scroll-on-window-switch.spec.ts ("SWITCH into
        // channel-with-unreads") and is not restated here.
        await seedCursorAndOpen(page, 25);
        const marker = page.locator('[data-testid="unread-marker"]');
        await expect(marker).toHaveCount(1);
        await expect(marker).toBeInViewport();
        // Landed ON it (block:"start" → at/near the top of the viewport), not at the
        // tail. The pane must overflow, or "did not land at the tail" is vacuous.
        const g = await scrollbackGeometry(page);
        expect(g.scrollHeight).toBeGreaterThan(g.clientHeight);
        await expect
            .poll(async () => await markerViewportOffset(page), { timeout: 10_000 })
            .toBeLessThan(g.clientHeight / 2);
        expect(await markerViewportOffset(page)).toBeGreaterThanOrEqual(-5);
    });
});

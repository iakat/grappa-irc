import { composeSend, loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });
test.setTimeout(90_000);
const CHANNEL = AUTOJOIN_CHANNELS[0];
// Outside both 20px edge zones (#1041 sidebar / #308 members), so the hold is
// the only gesture in play.
const AT = { x: 200, y: 400 };
// Past HOLD_MOVE_TOLERANCE_PX (10) and vertical, so it reads as the scroll it
// is meant to be rather than as a rightward swipe claim.
const DRIFT_PX = 40;
// How far into the hold to sample. Early enough that the timer is unambiguously
// still running whatever the threshold is — the spec never hardcodes 500, it
// reads the duration the binder hands to CSS (see `holdRow`).
const SAMPLE_AT_MS = 120;
/**
 * touchstart on the row carrying `body`, sample the paint mid-hold, then take
 * one of the three exits and sample again.
 *
 * - `release`  — touchend before the threshold: a tap.
 * - `drift`    — touchmove past the tolerance: a scroll.
 * - `fire`     — hold past the threshold so the menu opens, then release.
 *
 * The whole gesture runs inside ONE page.evaluate: the samples have to be taken
 * while the touch is live, and a round trip per step would let the threshold
 * elapse between them.
 */
async function holdRow(page, body, exit) {
    return await page.evaluate(async ({ body: text, at, exit: how, sampleAtMs, driftPx }) => {
        const rows = Array.from(document.querySelectorAll('[data-testid="scrollback-line"]'));
        const row = rows.find((r) => r.textContent?.includes(text));
        if (row === undefined)
            throw new Error(`no scrollback row containing ${text}`);
        const mk = (y) => new Touch({ identifier: 1, target: row, clientX: at.x, clientY: y });
        const fire = (type, y) => {
            const t = mk(y);
            const active = type === "touchend" ? [] : [t];
            row.dispatchEvent(new TouchEvent(type, {
                bubbles: true,
                cancelable: true,
                touches: active,
                targetTouches: active,
                changedTouches: [t],
            }));
        };
        const sample = () => ({
            paint: window.getComputedStyle(row).backgroundImage,
            holdMs: row.style.getPropertyValue("--hold-ms"),
        });
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        fire("touchstart", at.y);
        await sleep(sampleAtMs);
        const during = sample();
        if (how === "release") {
            fire("touchend", at.y);
        }
        else if (how === "drift") {
            fire("touchmove", at.y + driftPx);
        }
        else {
            // Derive the wait from what the binder itself declared, so this spec
            // cannot drift from LONG_PRESS_MS the way a hardcoded 500 would. The
            // margin covers a timer that fires a touch late under load.
            const declared = Number.parseInt(during.holdMs, 10);
            if (!Number.isFinite(declared))
                throw new Error(`no --hold-ms on the row: ${during.holdMs}`);
            await sleep(declared - sampleAtMs + 250);
            fire("touchend", at.y);
        }
        // A frame for the class removal to reach the computed style.
        await sleep(80);
        return { during, after: sample() };
    }, { body, at: AT, exit, sampleAtMs: SAMPLE_AT_MS, driftPx: DRIFT_PX });
}
// A body unique per run: the e2e sqlite scrollback persists across KEEP_STACK=1
// re-runs, and a static string would match two rows on the second run and trip
// Playwright strict mode.
function uniqueBody(tag) {
    return `issue1413 ${tag} ${Date.now()}`;
}
async function postMessage(page, body) {
    if (!CHANNEL)
        throw new Error("AUTOJOIN_CHANNELS empty");
    await loginAs(page, specUser());
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
    await composeSend(page, body);
    await expect(page.locator('[data-testid="scrollback-line"]', { hasText: body })).toBeVisible({
        timeout: 5_000,
    });
}
const menu = (page) => page.locator(".context-menu");
test("issue1413 — the row is painted while the hold runs, and unpainted once the menu arrives", async ({ page, }) => {
    const body = uniqueBody("fire");
    await postMessage(page, body);
    // The pre-state, asserted rather than assumed: a row already carrying a
    // background would make "painted during" true for the wrong reason.
    const before = await page
        .locator('[data-testid="scrollback-line"]', { hasText: body })
        .evaluate((el) => window.getComputedStyle(el).backgroundImage);
    expect(before).toBe("none");
    await expect(menu(page)).toBeHidden();
    const result = await holdRow(page, body, "fire");
    // THE outcome: something is on screen while the timer runs. Before #1413
    // this was `none` for the whole 500ms.
    expect(result.during.paint).not.toBe("none");
    expect(result.during.holdMs).toMatch(/^\d+ms$/);
    // …and the menu the cue was promising actually arrived.
    await expect(menu(page)).toBeVisible();
    // The promise is kept, so the cue is spent: nothing is left latched on the
    // row once the menu is up.
    expect(result.after.paint).toBe("none");
    expect(result.after.holdMs).toBe("");
});
test("issue1413 — a release before the threshold unpaints the row and opens no menu", async ({ page, }) => {
    const body = uniqueBody("tap");
    await postMessage(page, body);
    const result = await holdRow(page, body, "release");
    expect(result.during.paint).not.toBe("none");
    expect(result.after.paint).toBe("none");
    await expect(menu(page)).toBeHidden();
});
// The same escape the timer already honours: past the tolerance this is a
// scroll, and a row still lit under a scrolling finger would be promising a
// menu that is no longer coming.
test("issue1413 — a finger that drifts past the tolerance unpaints the row and opens no menu", async ({ page, }) => {
    const body = uniqueBody("drift");
    await postMessage(page, body);
    const result = await holdRow(page, body, "drift");
    expect(result.during.paint).not.toBe("none");
    expect(result.after.paint).toBe("none");
    // Well past the threshold: the drift killed the timer, not just the paint.
    await page.waitForTimeout(900);
    await expect(menu(page)).toBeHidden();
});

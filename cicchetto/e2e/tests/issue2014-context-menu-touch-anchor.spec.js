import { composeSend, loginAs, scrollbackLine, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";
test.setTimeout(90_000);
const CHANNEL = AUTOJOIN_CHANNELS[0];
// Comfortably above LONG_PRESS_MS (500) so the hold classification is
// deterministic under load; setTimeout never fires early. Same value, same
// reason, as the #1067 spec.
const HOLD_MS = 700;
// Roomy on purpose. The centre of a 1024×800 box leaves ~500px of slack on
// each side of both axes, which is what makes the both-anchors-fit
// precondition hold with margin instead of by luck — and `hasTouch: true` is
// what puts the pointer at coarse, NOT the viewport size.
const TOUCH_VIEWPORT = { width: 1024, height: 800 };
const MOUSE_VIEWPORT = { width: 1280, height: 800 };
// Date.now() suffix + a per-test tag: the e2e sqlite scrollback survives
// KEEP_STACK=1 re-runs and is shared by the tests in this file, so an untagged
// module-level body would match twice and die of Playwright strict mode.
const bodyFor = (tag) => `2014 ${tag} target ${Date.now()}`;
function viewportCentre(page) {
    const vp = page.viewportSize();
    if (!vp)
        throw new Error("no viewport size");
    return { x: Math.round(vp.width / 2), y: Math.round(vp.height / 2) };
}
async function menuGeometry(page) {
    return await page.evaluate(() => {
        const menu = document.querySelector(".context-menu");
        if (!(menu instanceof HTMLElement))
            throw new Error("context menu not rendered");
        const m = menu.getBoundingClientRect();
        return {
            top: m.top,
            left: m.left,
            right: m.right,
            bottom: m.bottom,
            width: m.width,
            height: m.height,
            innerWidth: window.innerWidth,
            innerHeight: window.innerHeight,
            coarsePointer: window.matchMedia("(pointer: coarse)").matches,
        };
    });
}
// The anti-hollow precondition. Both anchors have to be POSSIBLE at this point,
// or the corner assertion that follows proves nothing: near an edge the
// collision flip produces the far corner all by itself, under either
// preference, and the test would go green on a reverted fix.
function expectBothAnchorsWouldFit(g, at) {
    expect(g.width).toBeGreaterThan(0);
    expect(g.height).toBeGreaterThan(0);
    expect(at.x - g.width).toBeGreaterThanOrEqual(0);
    expect(at.x + g.width).toBeLessThanOrEqual(g.innerWidth);
    expect(at.y - g.height).toBeGreaterThanOrEqual(0);
    expect(at.y + g.height).toBeLessThanOrEqual(g.innerHeight);
}
async function seedChannel(page) {
    await loginAs(page, specUser());
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
}
async function seedRow(page, tag) {
    await seedChannel(page);
    const body = bodyFor(tag);
    await composeSend(page, body);
    await expect(scrollbackLine(page, "privmsg", body)).toBeVisible({ timeout: 5_000 });
    return body;
}
// touchstart → real wall-clock hold → touchend, with no movement: the press.
// Dispatched in-page ON the row, so it reaches the production listener by
// bubbling to `.scrollback` exactly as a finger does; the coordinates ride on
// the Touch and are what `bindMessageGestures` hands the menu as its `at`.
async function longPressRow(page, body, at, holdMs) {
    await page.evaluate(async ({ body: text, at: point, holdMs: ms }) => {
        const rows = Array.from(document.querySelectorAll('[data-testid="scrollback-line"]'));
        const row = rows.find((r) => r.textContent?.includes(text));
        if (row === undefined)
            throw new Error(`no scrollback row containing ${text}`);
        const mk = () => new Touch({ identifier: 1, target: row, clientX: point.x, clientY: point.y });
        const fire = (type) => {
            const t = mk();
            const active = type === "touchend" ? [] : [t];
            row.dispatchEvent(new TouchEvent(type, {
                bubbles: true,
                cancelable: true,
                touches: active,
                targetTouches: active,
                changedTouches: [t],
            }));
        };
        fire("touchstart");
        await new Promise((r) => setTimeout(r, ms));
        fire("touchend");
    }, { body, at, holdMs });
    await expect(page.locator(".context-menu")).toBeVisible({ timeout: 5_000 });
}
// The other door, on the other host: a synthetic `contextmenu` on the first
// members-pane nick. Same shape as the #487 spec's opener — the handler reads
// the coordinates off the event, not off the element box, so the press point is
// ours to choose.
async function contextMenuOnNick(page, at) {
    await expect(page.locator(".members-pane .member-name").first()).toBeVisible({ timeout: 5_000 });
    await page.evaluate((point) => {
        const btn = document.querySelector(".members-pane .member-name");
        if (!(btn instanceof HTMLElement))
            throw new Error("no .member-name button in members-pane");
        btn.dispatchEvent(new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: point.x,
            clientY: point.y,
        }));
    }, at);
    await expect(page.locator(".context-menu")).toBeVisible({ timeout: 5_000 });
}
test.describe("issue 2014 — coarse pointer anchors the menu's bottom-right corner", () => {
    test.use({ viewport: TOUCH_VIEWPORT, hasTouch: true });
    test("a long-press puts the message menu's bottom-right corner on the press point", async ({ page, }) => {
        const body = await seedRow(page, "longpress");
        const at = viewportCentre(page);
        await longPressRow(page, body, at, HOLD_MS);
        const g = await menuGeometry(page);
        // The harness premise, asserted rather than assumed: `hasTouch` is what
        // puts this project on the coarse branch, and if that ever stops being
        // true this file would silently be testing the mouse behaviour twice.
        expect(g.coarsePointer).toBe(true);
        expectBothAnchorsWouldFit(g, at);
        expect(g.right).toBeCloseTo(at.x, 0);
        expect(g.bottom).toBeCloseTo(at.y, 0);
        // The discriminant, stated rather than left implicit: the NEAR corner is
        // where the defect put it, and it must not be there any more.
        expect(g.left).toBeLessThan(at.x);
        expect(g.top).toBeLessThan(at.y);
    });
    test("the nick menu inherits it from the shell, passing no anchor of its own", async ({ page, }) => {
        await seedChannel(page);
        const at = viewportCentre(page);
        await contextMenuOnNick(page, at);
        const g = await menuGeometry(page);
        expect(g.coarsePointer).toBe(true);
        expectBothAnchorsWouldFit(g, at);
        expect(g.right).toBeCloseTo(at.x, 0);
        expect(g.bottom).toBeCloseTo(at.y, 0);
    });
});
test.describe("issue 2014 — a fine pointer keeps the native down-and-right menu", () => {
    test.use({ viewport: MOUSE_VIEWPORT, hasTouch: false });
    test("the same nick menu, same door, opens from the click when the pointer is a mouse", async ({ page, }) => {
        await seedChannel(page);
        const at = viewportCentre(page);
        await contextMenuOnNick(page, at);
        const g = await menuGeometry(page);
        // The one variable. Everything else in this test is the test above.
        expect(g.coarsePointer).toBe(false);
        expectBothAnchorsWouldFit(g, at);
        expect(g.left).toBeCloseTo(at.x, 0);
        expect(g.top).toBeCloseTo(at.y, 0);
        expect(g.right).toBeGreaterThan(at.x);
        expect(g.bottom).toBeGreaterThan(at.y);
    });
});

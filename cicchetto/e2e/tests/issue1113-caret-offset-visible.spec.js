import { composeCaretGeometry, composeTextarea, expectEndCaretVisible, loginAs, selectChannel, } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });
test.setTimeout(90_000);
const CHANNEL = AUTOJOIN_CHANNELS[0];
// Several wrapped lines at 390px — the same body shape #1105 used, minus its
// uniqueness suffix (nothing here reaches the scrollback, so there is no row
// to disambiguate).
const FILLER = "che va a capo parecchie volte perche' il textarea e' rows=1 e non cresce, " +
    "quindi il caret finisce fuori dalla vista e non si vede piu' nulla";
// Its job is to fail loudly if the fixture ever stops overflowing, because
// then "the caret is in view" would be true for the wrong reason. Stated
// per-caller for the reason `expectEndCaretVisible` documents.
const MIN_OVERFLOW_PX = 40;
const PASTE = "incollato ";
// Blur, then dispatch a real paste on document.body — the #352 global-paste
// door, which is one of the two ways a paste reaches `insertPastedText` (the
// other is the flood-confirm dialog). A paste into an ALREADY-focused textarea
// is performed natively by the browser, which scrolls on its own; these are
// the doors where cic moves the caret itself and therefore owes the reveal.
async function pasteWhileUnfocused(page, text) {
    await page.evaluate((t) => {
        document.activeElement?.blur?.();
        const dt = new DataTransfer();
        dt.setData("text/plain", t);
        document.body.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    }, text);
}
// Put the textarea in the state the issue describes: a caret at a known offset
// while the scroll sits at the opposite edge. Arranging the PRE-state by hand
// (rather than hoping typing produces it) is what makes the post-state exact.
async function arrangeCompose(page, args) {
    await composeTextarea(page).evaluate((el, a) => {
        el.setSelectionRange(a.caret, a.caret);
        el.scrollTop = a.scrollTo === "bottom" ? el.scrollHeight : 0;
    }, args);
}
// The caret assignment and the scroll happen in ONE microtask, so the caret
// landing at its new offset is a truthful barrier for the scroll having been
// applied too — and it is NOT the assertion: the unfixed code moves the caret
// exactly the same way, and reds on the geometry below.
async function afterCaretSettles(page, caret) {
    await expect
        .poll(async () => (await composeCaretGeometry(page)).selStart, { timeout: 5_000 })
        .toBe(caret);
    return await composeCaretGeometry(page);
}
function expectOverflowing(g) {
    expect(g.scrollHeight).toBeGreaterThan(g.clientHeight + MIN_OVERFLOW_PX);
}
// The caret sits on the FIRST line, so the minimal reveal is scrollTop 0
// exactly. The exactness is the point: `> 0 and < max` would also pass under
// a scroll that overshot, and `scrollTop = scrollHeight` — the wrong fix this
// issue exists to reject — would land at the bottom.
function expectCaretLineAtTop(g, caret) {
    expectOverflowing(g);
    expect(g.selStart).toBe(caret);
    expect(g.selEnd).toBe(caret);
    expect(g.scrollTop).toBe(0);
}
test("#1113 — a global paste reveals the caret's line, in both directions", async ({ page }) => {
    if (!CHANNEL)
        throw new Error("AUTOJOIN_CHANNELS empty");
    await loginAs(page, specUser());
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
    const ta = composeTextarea(page);
    await expect(ta).toBeVisible();
    await ta.click();
    await ta.fill(FILLER);
    await expect(ta).toHaveValue(FILLER);
    // ── A. caret ABOVE the visible box ──────────────────────────────────
    await arrangeCompose(page, { caret: 0, scrollTo: "bottom" });
    const preA = await composeCaretGeometry(page);
    expectOverflowing(preA);
    // Without this the outcome would be true for the wrong reason: a textarea
    // already at the top has nothing to reveal.
    expect(preA.scrollTop).toBeGreaterThan(0);
    await pasteWhileUnfocused(page, PASTE);
    await expect(ta).toHaveValue(PASTE + FILLER);
    expectCaretLineAtTop(await afterCaretSettles(page, PASTE.length), PASTE.length);
    // ── B. caret BELOW the visible box ──────────────────────────────────
    const full = PASTE + FILLER;
    await arrangeCompose(page, { caret: full.length, scrollTo: "top" });
    const preB = await composeCaretGeometry(page);
    expectOverflowing(preB);
    expect(preB.scrollTop).toBe(0);
    await pasteWhileUnfocused(page, PASTE);
    await expect(ta).toHaveValue(full + PASTE);
    expectEndCaretVisible(await afterCaretSettles(page, full.length + PASTE.length), MIN_OVERFLOW_PX);
});
test("#1113 — tab-complete reveals the caret's line", async ({ page }) => {
    if (!CHANNEL)
        throw new Error("AUTOJOIN_CHANNELS empty");
    await loginAs(page, specUser());
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
    const ta = composeTextarea(page);
    await expect(ta).toBeVisible();
    // Completing the CHANNEL rather than a member nick: the channel candidate
    // set is derived from `windowStateByChannel`, which `selectChannel`'s WS
    // barrier already proves populated, whereas the member list has no barrier
    // of its own on a 390px viewport (the members pane lives in a drawer).
    // Same completion engine, same caret placement — #30 keeps ONE of those.
    const partial = CHANNEL.slice(0, CHANNEL.length - 1);
    const draft = `${partial} ${FILLER}`;
    await ta.click();
    await ta.fill(draft);
    await expect(ta).toHaveValue(draft);
    // Caret on the partial (first line), scroll parked at the far end.
    await arrangeCompose(page, { caret: partial.length, scrollTo: "bottom" });
    const pre = await composeCaretGeometry(page);
    expectOverflowing(pre);
    expect(pre.scrollTop).toBeGreaterThan(0);
    // Tab does not re-focus (fill already left focus here), so nothing but the
    // completion can move the scroll.
    await ta.press("Tab");
    const completed = `${CHANNEL} ${draft.slice(partial.length)}`;
    await expect(ta).toHaveValue(completed);
    const caret = CHANNEL.length + 1;
    expectCaretLineAtTop(await afterCaretSettles(page, caret), caret);
});

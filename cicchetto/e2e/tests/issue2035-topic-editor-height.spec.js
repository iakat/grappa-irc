// issue 2035 — the topic edit box opens EIGHT text lines tall, and Enter sets
// the topic instead of inserting a line break.
//
// Both halves of the issue, and both need a real engine for a different
// reason:
//
//   (1) HEIGHT is geometry. jsdom has no layout engine, so vitest can only
//       pin the `rows={8}` ATTRIBUTE (it does — TopicBar.test.tsx); whether
//       eight LINES of text actually fit in the rendered box is a question
//       only a browser answers. It is also the exact question the issue got
//       wrong on paper: the old `min-height: 4.5em` was read as 4.5 / 1.25 =
//       3.6 lines, but `* { box-sizing: border-box }` makes that figure
//       include the padding and the border, so it rendered 3.0 — "solo tre
//       righe", as reported — and the `10em` the issue derived for "8 lines"
//       would have rendered 7.4 the same way. This spec measures the box
//       instead of trusting arithmetic: content height ÷ computed
//       line-height, which is drift-proof against both properties moving.
//
//   (2) ENTER's key handling is unit-covered (the preventDefault and the
//       Shift+Enter pairing are jsdom's — the chord is RULED, vjt 2026-09-10,
//       and agrees with #974's every-Enter-sends rule one surface over),
//       but what reaches the WIRE is not. Here an in-channel peer witnesses
//       the real `TOPIC #chan :<flattened>`, which proves in one action both
//       that Enter went through the send door and that the flatten SURVIVED
//       the reversal: the draft is seeded via `fill()` — the paste-shaped
//       route newlines still take now that Enter no longer types one — and a
//       body with a raw \r/\n is rejected upstream (:invalid_line), so an
//       unflattened submit never resolves the witness.
//
// The Enter behaviour REVERSES #263's documented decision ("Enter in the
// textarea must stay a newline"). It is reversed because the product owner
// ruled the asserted behaviour wrong, not because it was awkward to test —
// and the premise was weak anyway, since the flatten spends the newline
// before the send door regardless.
//
// 🔴 What this spec must NOT do: grow an Escape case. #232 makes the shared
// overlay stack the single Esc authority and `issue263-topic-modal-edit.spec
// .ts:114-124` already proves the edit-aware branch in a real browser with
// the textarea focused. vjt confirmed Esc works (2026-09-10); that spec stays
// untouched.
//
// Channel: a fresh per-run one, founded by vjt so he is chanop and the ✏️ is
// offered past the default +t — the same reason `issue263-topic-modal-edit`
// does it, and the same reason it does not mutate the shared autojoin
// channel's topic (seed-expansion cascade hazard). PARTed in `finally`.
//
// Parity matrix per `feedback_e2e_user_class_parity_matrix`: a CSS layout
// contract plus a topic send both users take through the same door —
// registered vjt suffices, no visitor twin.
import { composeSend, loginAs, selectChannel, sidebarWindow } from "../fixtures/cicchettoPage";
import { partChannel } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";
// The decided line count (vjt, 2026-09-10: "8 o 10", low end taken for the
// phone viewport). It is the SAME number `rows={8}` carries in TopicBar.tsx —
// stated once here so a future re-ruling has one place to move on this side.
// NOT a #1646 mirror and deliberately not in that table: a mirror is a
// production INPUT hand-copied into a fixture, where drift goes silently
// green. This is the spec's ORACLE — production moving to ten turns this red,
// which is the whole point of writing it down.
const WANTED_TEXT_LINES = 8;
async function measureEditor(editor) {
    return await editor.evaluate((el) => {
        const ta = el;
        const cs = getComputedStyle(ta);
        const round = (n) => Math.round(n * 100) / 100;
        const num = (v) => round(Number.parseFloat(v));
        const paddingTopPx = num(cs.paddingTop);
        const paddingBottomPx = num(cs.paddingBottom);
        const borderTopPx = num(cs.borderTopWidth);
        const borderBottomPx = num(cs.borderBottomWidth);
        const lineHeightPx = num(cs.lineHeight);
        const borderBoxHeightPx = round(ta.getBoundingClientRect().height);
        const contentHeightPx = round(borderBoxHeightPx - paddingTopPx - paddingBottomPx - borderTopPx - borderBottomPx);
        return {
            rows: ta.rows,
            fontSizePx: num(cs.fontSize),
            lineHeightPx,
            paddingTopPx,
            paddingBottomPx,
            borderTopPx,
            borderBottomPx,
            borderBoxHeightPx,
            clientHeightPx: ta.clientHeight,
            contentHeightPx,
            textLines: round(contentHeightPx / lineHeightPx),
        };
    });
}
// Found a fresh channel, select it, and open the modal in EDIT mode. Returns
// the editor locator. The retry absorbs the members/modes seed race (the op
// sigil is not cached the instant the JOIN lands, so the ✏️ is not yet
// rendered) — same shape as issue263-topic-modal-edit.
async function openEditor(page, channel) {
    await composeSend(page, `/join ${channel}`);
    await expect(sidebarWindow(page, NETWORK_SLUG, channel)).toBeVisible({ timeout: 10_000 });
    await selectChannel(page, NETWORK_SLUG, channel, { ownNick: specNick() });
    const strip = page.locator('[data-testid="topic-strip"]');
    const modal = page.locator(".topic-modal");
    const editToggle = page.locator('[data-testid="topic-modal-edit"]');
    await expect(async () => {
        if (!(await modal.isVisible().catch(() => false))) {
            await strip.click();
        }
        await expect(modal).toBeVisible({ timeout: 1_000 });
        await expect(editToggle).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 20_000 });
    await editToggle.click();
    const editor = page.locator('[data-testid="topic-modal-editor"]');
    await expect(editor).toBeVisible();
    return editor;
}
test.describe("issue 2035 topic editor: eight lines, Enter sets", () => {
    test("the editor opens eight text lines tall, and Enter sends the flattened topic upstream", async ({ page, }, testInfo) => {
        const vjt = specUser();
        const channel = `#e2e2035-${crypto.randomUUID().slice(0, 8)}`;
        const line1 = `enter sets ${crypto.randomUUID().slice(0, 6)}`;
        const multiline = `${line1}\nsecond line`;
        const flattened = `${line1} second line`;
        await loginAs(page, vjt);
        await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: specNick() });
        const peer = await IrcPeer.connect({ nick: `e2e2035-${crypto.randomUUID().slice(0, 4)}` });
        try {
            const editor = await openEditor(page, channel);
            await peer.join(channel);
            // (1) HEIGHT — measured, not asserted from the stylesheet.
            const geometry = await measureEditor(editor);
            console.log(`[issue2035 desktop] ${JSON.stringify(geometry)}`);
            await testInfo.attach("issue2035-editor-geometry-desktop", {
                body: JSON.stringify(geometry, null, 2),
                contentType: "application/json",
            });
            expect(geometry.rows, JSON.stringify(geometry)).toBe(WANTED_TEXT_LINES);
            // Eight, not "at least eight": the low end of vjt's 8-or-10 was picked
            // deliberately for the phone, so a silent drift UP is as wrong as down.
            expect(geometry.textLines, JSON.stringify(geometry)).toBeGreaterThan(WANTED_TEXT_LINES - 0.1);
            expect(geometry.textLines, JSON.stringify(geometry)).toBeLessThan(WANTED_TEXT_LINES + 0.1);
            // (2) ENTER — `fill` seeds the newline the way a PASTE does (Enter no
            // longer types one); `locator.press` focuses the box itself before the
            // key, so the send door under test is the editor's own keydown and
            // nothing else. The peer witness resolves ONLY on the flattened line.
            await editor.fill(multiline);
            const witnessed = peer.waitForTopic(channel, flattened);
            await editor.press("Enter");
            await witnessed;
            // Enter took the same door ✅ takes, so it inherits the #263
            // save-closes contract and the no-optimistic-write rule: the bar
            // repaints only from the server's relayed topic_changed.
            await expect(page.locator(".topic-modal")).toHaveCount(0, { timeout: 10_000 });
            await expect(page.locator(".topic-bar-topic")).toContainText(flattened, { timeout: 10_000 });
        }
        finally {
            await peer.disconnect("e2e2035 done");
            await partChannel(vjt.token, NETWORK_SLUG, channel).catch(() => { });
        }
    });
    // The mobile-fit measurement the issue explicitly did NOT make ("no
    // measurement of how the taller box lays out on any real viewport"). The
    // failure it guards is the operator-visible one: a modal that is
    // `position: fixed; top: 4rem` with no max-height and no scroller can push
    // its own ✅ off the bottom of a phone, and the taller editor is the thing
    // that would do it. @webkit is the reporter's platform family; @touch is
    // the orthogonal Blink-mobile opt-in per the config's tag rules.
    //
    // 🔴 What this does NOT measure: the SOFT KEYBOARD. Focusing the editor on
    // a real phone shrinks the visual viewport by roughly half, and Playwright
    // raises no keyboard — so this proves the layout viewport fits, which is
    // strictly weaker than "reachable while typing".
    test("@webkit @touch on a phone viewport the modal — ✅ included — stays on screen", async ({ page, }, testInfo) => {
        const vjt = specUser();
        const channel = `#e2e2035m-${crypto.randomUUID().slice(0, 8)}`;
        await loginAs(page, vjt);
        await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: specNick() });
        try {
            const editor = await openEditor(page, channel);
            const geometry = await measureEditor(editor);
            const fit = await page.locator(".topic-modal").evaluate((modal) => {
                const box = modal.getBoundingClientRect();
                const round = (n) => Math.round(n * 10) / 10;
                return {
                    viewportHeight: window.innerHeight,
                    modalTop: round(box.top),
                    modalBottom: round(box.bottom),
                    modalHeight: round(box.height),
                    slackBelow: round(window.innerHeight - box.bottom),
                };
            });
            console.log(`[issue2035 phone] ${JSON.stringify({ ...geometry, ...fit })}`);
            await testInfo.attach("issue2035-modal-fit-phone", {
                body: JSON.stringify({ ...geometry, ...fit }, null, 2),
                contentType: "application/json",
            });
            expect(geometry.textLines, JSON.stringify(geometry)).toBeGreaterThan(WANTED_TEXT_LINES - 0.2);
            expect(fit.modalBottom, JSON.stringify(fit)).toBeLessThanOrEqual(fit.viewportHeight);
            await expect(page.locator('[data-testid="topic-modal-save"]')).toBeInViewport();
        }
        finally {
            await partChannel(vjt.token, NETWORK_SLUG, channel).catch(() => { });
        }
    });
});

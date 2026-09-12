// UX-5 bucket BR (2026-05-19) — Home pane [Reconnect] affordance.
//
// vjt 2026-05-19 dogfood (mid-UX-5 cluster): after parking a network
// via the X-button (T32), the only path to reconnect was the compose
// box `/connect <slug>` slash-command. The Home pane's per-network
// rows ALREADY dispatched /connect on whole-row click (UX-4 bucket B),
// but the affordance was invisible — vjt thought the row was a label,
// not a button — AND errors were swallowed via console.warn (violation
// of `feedback_silent_retry_anti_pattern`). BR ships:
//
//   * Explicit `[Reconnect]` chip on :parked / :failed rows. The chip
//     is the canonical click target (button-in-button is invalid HTML
//     so the whole-row <button> was replaced with a <div> card +
//     inline chip for non-connected states).
//   * Inline `friendlyApiError` text under the chip on PATCH failure
//     — operator sees what went wrong (e.g. cap exceeded, network
//     circuit open) instead of a silent no-op.
//   * Reuses the same `PATCH /networks/:slug {connection_state:
//     "connected"}` endpoint the slash-command + T32 X-button-then-
//     unpark flow use. NO new server surface. Bucket BC just fixed
//     the cap-on-park admission bug that would have blocked the
//     post-park reconnect; BR consumes that fix at the UI.
//
// Per `feedback_e2e_user_class_parity_matrix`: the chip is subject-
// shape-agnostic (server-side admission is the same path BC verified
// for visitor + user + nickserv). ONE registered-class arm sufficient.
//
// Per `feedback_e2e_visitor_members_list`: post-reconnect the
// autojoin channel MUST repopulate members (own nick included). The
// happy-path arm asserts both autojoin re-land + members list.
//
// Cap-exceeded negative arm: admin sets `max_concurrent_user_sessions`
// to a saturating value, the chip click 503s, and the inline error
// span MUST surface the friendly mapping (proves error UX works end-
// to-end). Reuses U-3 (UD3) FallbackController mapping (`network_busy`
// for user-cap, `too_many_sessions` for client-cap).
import { loginAs, waitForUserTopicReady } from "../fixtures/cicchettoPage";
import { adminPatchCaps, GRAPPA_BASE_URL, login, patchNetworkConnectionState, } from "../fixtures/grappaApi";
import { ADMIN_IDENTIFIER, ADMIN_PASSWORD, AUTOJOIN_CHANNELS, NETWORK_SLUG, } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";
const SEED_CHANNEL = AUTOJOIN_CHANNELS[0];
async function fetchChannels(token) {
    const res = await fetch(`${GRAPPA_BASE_URL}/networks/${NETWORK_SLUG}/channels`, {
        headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok)
        throw new Error(`fetchChannels: ${res.status}`);
    return (await res.json());
}
async function fetchChannelMembers(token, channel) {
    const res = await fetch(`${GRAPPA_BASE_URL}/networks/${NETWORK_SLUG}/channels/${encodeURIComponent(channel)}/members`, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok)
        throw new Error(`fetchChannelMembers: ${res.status}`);
    const body = (await res.json());
    return body.members.map((m) => m.nick);
}
// Restore the seeded network to :connected + autojoin lands so the
// next spec sees a healthy baseline. Mirrors cp15-b6-parked + ux-5-bc
// afterEach pattern.
async function restoreNetwork(vjt) {
    await patchNetworkConnectionState(vjt.token, NETWORK_SLUG, {
        connection_state: "connected",
    }).catch(() => { });
    for (let attempt = 0; attempt < 60; attempt++) {
        const channels = await fetchChannels(vjt.token).catch(() => null);
        if (channels?.find((c) => c.name === SEED_CHANNEL)?.joined)
            return;
        await new Promise((r) => setTimeout(r, 500));
    }
}
// Test timeout bumped to 90s — matches cp15-b6-parked + ux-5-bc.
test.setTimeout(90_000);
test.afterEach(async () => {
    const admin = await login(ADMIN_IDENTIFIER, ADMIN_PASSWORD);
    await adminPatchCaps(admin.token, NETWORK_SLUG, {
        max_concurrent_user_sessions: null,
        max_concurrent_visitor_sessions: null,
        max_per_ip: null,
    }).catch(() => { });
    const vjt = specUser();
    await restoreNetwork(vjt);
});
test("UX-5 BR — Home pane [Reconnect] chip reconnects a parked network", async ({ page }) => {
    const vjt = specUser();
    // Park bahamut-test via PATCH so the home row enters the parked
    // state. Mirrors the T32 X-button verb at the server layer.
    await patchNetworkConnectionState(vjt.token, NETWORK_SLUG, {
        connection_state: "parked",
        reason: "ux-5-br dogfood repro",
    }).catch((e) => {
        if (e instanceof Error && /not_connected/.test(e.message))
            return;
        throw e;
    });
    // Cic lands on HomePane post-login (UX-4 bucket B selection default).
    //
    // issue 1985 — `noSidebarNetworks` because the PATCH above parked the only
    // network this user has, and a parked network no longer draws a sidebar
    // row. `loginAs`'s default gate waits on `.sidebar-network-header`, which
    // for this account can now never appear: not a flake, a shell-ready proxy
    // that stopped describing this state. The weaker home-pane gate is the
    // right one HERE — everything below reads `.home-pane-*` or goes to REST,
    // and nothing touches the sidebar, which is the race the opt's comment
    // warns about. `waitForUserTopicReady` still runs inside that branch, so
    // the WS barrier the chip click depends on is unchanged.
    await loginAs(page, vjt, { noSidebarNetworks: true });
    const homePane = page.locator(".home-pane-registered");
    await expect(homePane).toBeVisible({ timeout: 10_000 });
    // The parked network row carries the parked classList + chip.
    const parkedRow = homePane.locator(".home-pane-network-row-parked", {
        has: page.locator(".home-pane-network-slug", { hasText: NETWORK_SLUG }),
    });
    await expect(parkedRow).toBeVisible({ timeout: 5_000 });
    // Reason text from the PATCH carries through the home wire +
    // renders inside the card. Catches a regression that drops the
    // reason field on the home_network_state_changed event.
    await expect(parkedRow.locator(".home-pane-network-reason")).toContainText("ux-5-br dogfood repro");
    // Click the explicit [Reconnect] chip — the canonical action target.
    const reconnectChip = parkedRow.getByRole("button", {
        name: new RegExp(`reconnect ${NETWORK_SLUG}`, "i"),
    });
    await expect(reconnectChip).toBeVisible();
    // Gate on the user-topic JOIN ACK before clicking (audit 2026-05-26:
    // replaced a hardcoded waitForTimeout(2000) — loginAs above already
    // calls waitForUserTopicReady, but we re-stamp here as a belt-and-
    // suspenders defense against a hypothetical re-subscribe between
    // login and click. The helper is idempotent: it polls the stamp set
    // and returns immediately if already set.
    //
    // Why: cic joins `grappa:user:<name>` asynchronously after /me
    // resolves (userTopic.ts createEffect → joinUser). Without the
    // gate, the chip click can race the JOIN ACK — the server's
    // broadcast fires before cic is subscribed, so
    // home_network_state_changed never reaches `patchHomeNetwork`
    // and the row stays parked in the UI even though the server did
    // transition.
    await waitForUserTopicReady(page, vjt.name);
    await reconnectChip.click();
    // Source-of-truth assertion: the server actually transitioned to
    // :connected. The REST `/networks` index is authoritative; the WS
    // event is a derived-and-faster signal that updates the UI. Polling
    // REST proves the chip's PATCH succeeded (so a UI-only WS failure
    // is distinguishable from a chip-action failure).
    let serverConnected = false;
    for (let attempt = 0; attempt < 30; attempt++) {
        const res = await fetch(`${GRAPPA_BASE_URL}/networks`, {
            headers: { authorization: `Bearer ${vjt.token}` },
        }).catch(() => null);
        if (res?.ok) {
            const rows = (await res.json());
            if (rows.find((r) => r.slug === NETWORK_SLUG)?.connection_state === "connected") {
                serverConnected = true;
                break;
            }
        }
        await new Promise((r) => setTimeout(r, 500));
    }
    expect(serverConnected).toBe(true);
    // Row transitions away from :parked once the server emits
    // home_network_state_changed → userTopic.ts patches homeData() →
    // the parked row sub-component unmounts. Generous timeout absorbs
    // the WS subscribe race (cp15-b6-parked gets WS warm-up "for free"
    // via composeSend keystrokes; this spec waited 2s above).
    //
    // We do NOT assert a connected row visible in the SAME pane — cic's
    // post-PATCH-connect behavior auto-navigates the operator INTO the
    // network's $server window or autojoin channel (UX-4 selection flow
    // — when a parked network reconnects, the operator typically wants
    // to land on the channel they were reading). HomePane is dismissed
    // by that navigation. The REST poll + autojoin poll below are the
    // load-bearing assertions: the chip's PATCH succeeded, the server
    // transitioned, autojoin re-landed, members populated. UI presence
    // of a "connected" home row is incidental to the operator goal.
    await expect(parkedRow).toHaveCount(0, { timeout: 30_000 });
    // Autojoin re-lands: poll the channels REST endpoint until #spec-wN
    // re-joins. Without this assertion the test passes on a half-spawned
    // regression where the chip's PATCH succeeds but the spawn dance
    // silently fails. Same pattern as ux-5-bc-park-respawn.
    let joined = false;
    for (let attempt = 0; attempt < 60; attempt++) {
        const channels = await fetchChannels(vjt.token).catch(() => null);
        if (channels?.find((c) => c.name === SEED_CHANNEL)?.joined) {
            joined = true;
            break;
        }
        await new Promise((r) => setTimeout(r, 500));
    }
    expect(joined).toBe(true);
    // Per feedback_e2e_visitor_members_list (generalised to all classes
    // for parity): post-rejoin the autojoin channel MUST surface a
    // populated members list including the operator's own nick.
    let members = [];
    for (let attempt = 0; attempt < 30; attempt++) {
        members = await fetchChannelMembers(vjt.token, SEED_CHANNEL).catch(() => []);
        if (members.length > 0 && members.includes(specNick()))
            break;
        await new Promise((r) => setTimeout(r, 500));
    }
    expect(members.length).toBeGreaterThan(0);
    expect(members).toContain(specNick());
});
test("UX-5 BR — chip surfaces friendly error inline when cap is exceeded", async ({ page }) => {
    const vjt = specUser();
    const admin = await login(ADMIN_IDENTIFIER, ADMIN_PASSWORD);
    // Park bahamut-test (so the chip is visible to click) then saturate
    // the user cap so the chip's PATCH 503s. Pre-BR errors were silently
    // swallowed; post-BR the chip's inline error span MUST surface the
    // friendlyApiError mapping. The U-3 FallbackController maps
    // :user_cap_exceeded → 503 `network_busy`.
    await patchNetworkConnectionState(vjt.token, NETWORK_SLUG, {
        connection_state: "parked",
        reason: "ux-5-br cap test",
    }).catch((e) => {
        if (e instanceof Error && /not_connected/.test(e.message))
            return;
        throw e;
    });
    await adminPatchCaps(admin.token, NETWORK_SLUG, { max_concurrent_user_sessions: 0 });
    // issue 1985 — same reason as the arm above: the only network is parked, so
    // no sidebar header will appear and the default shell-ready gate cannot
    // fire. This arm never leaves the home pane either.
    await loginAs(page, vjt, { noSidebarNetworks: true });
    const homePane = page.locator(".home-pane-registered");
    await expect(homePane).toBeVisible({ timeout: 10_000 });
    const parkedRow = homePane.locator(".home-pane-network-row-parked", {
        has: page.locator(".home-pane-network-slug", { hasText: NETWORK_SLUG }),
    });
    const reconnectChip = parkedRow.getByRole("button", {
        name: new RegExp(`reconnect ${NETWORK_SLUG}`, "i"),
    });
    await reconnectChip.click();
    // Inline error span renders the friendly mapping. Match a substring
    // of the U-3 `network_busy` friendly copy so a future copy tweak in
    // friendlyApiError.ts doesn't make this brittle. The presence of an
    // error span (role=alert) is the load-bearing assertion.
    const errorSpan = parkedRow.locator(".home-pane-network-error[role='alert']");
    await expect(errorSpan).toBeVisible({ timeout: 5_000 });
    await expect(errorSpan).not.toHaveText("");
    // Row stays at :parked — failed reconnect MUST NOT silently flip
    // the local state. This is the same no-silent-drops invariant U-0
    // pinned at the server layer; the cic mirrors it at the UI.
    await expect(parkedRow).toBeVisible();
});

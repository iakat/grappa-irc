// issue 1993 — the general settings sub-page, regrouped by SCOPE and applied
// with ONE button.
//
// What the unit tests cannot reach, and why this spec exists: the merged
// apply's whole point is that it writes through TWO endpoints that each
// BOUNCE the upstream session, and a jsdom test can only prove the calls were
// made. Here the identity leg is witnessed where it actually lands — the
// subject re-registers upstream under the new nick and reappears in the
// channel's member list — while the password leg is witnessed by the only
// readback a write-only secret has: the field clears, which happens solely on
// a 200 from `PUT /networks/:slug/password`.
//
// TWO networks, on purpose. The selector this issue lifts out of the identity
// card renders only when the subject holds more than one (#497: a one-option
// picker is noise), so a single-network subject cannot show the defect this
// page rework is about — the picker being buried inside one of the four cards
// it governs. `accreteNetwork` binds azzurra2 (a different ircd, so the two
// sessions cannot collide on nick) and the spec then drives the picker to
// choose which network the apply targets.
//
// Nick discipline (#1152): the spec CHANGES the per-spec subject's nick, so
// the teardown nick guard would read a live nick the spec never addressed.
// The finally restores the provisioned nick before the guard runs — the same
// apply-and-restore issue476 uses, and load-bearing rather than tidy.
//
// Runs on chromium desktop (untagged): the drawer renders directly, and every
// server-side witness is over REST, so nothing here is layout-dependent.
import { loginAs, openSettingsSection } from "../fixtures/cicchettoPage";
import { accreteNetwork, setNetworkIdentityNick, settleNetworkAutojoin, } from "../fixtures/grappaApi";
import { ACCRETE_NETWORK_SLUG, AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";
// An accrete + spawn, a live identity apply (reconnect + autojoin) and a
// restore-and-reconnect in the finally — three upstream round trips.
test.setTimeout(150_000);
test("issue 1993 — the general page groups what the selector governs, and one apply saves identity + password", async ({ page, }) => {
    const user = specUser();
    const channel = AUTOJOIN_CHANNELS[0];
    if (!channel)
        throw new Error("issue1993: AUTOJOIN_CHANNELS is empty — seed contract broken");
    // Collision-free on bahamut-test, and inside NICKLEN.
    const newNick = `n1993${Date.now() % 100000}`;
    const nickServPassword = "issue1993-nickserv-not-secret";
    try {
        // ── GATE: the subject is live under its provisioned nick, on TWO nets ──
        await settleNetworkAutojoin(user.token, NETWORK_SLUG, channel, specNick());
        await accreteNetwork(user.token, ACCRETE_NETWORK_SLUG);
        await loginAs(page, user);
        const general = await openSettingsSection(page, "general");
        // ── (1) the selector is OUT of the card and ABOVE the group it governs ──
        const group = general.getByTestId("settings-network-scope");
        const select = group.getByTestId("settings-identity-network-select");
        await expect(select).toBeVisible({ timeout: 10_000 });
        // The burial this issue reports: the picker used to live INSIDE the
        // identity card, which is one of the four things it decides the scope of.
        await expect(general.locator("[data-testid='settings-section-identity'] [data-testid='settings-identity-network-select']")).toHaveCount(0);
        await expect(group.getByTestId("settings-section-identity")).toBeVisible();
        // …and the ACCOUNT-scoped knobs stayed out of it. Both halves matter: a
        // group that swallowed everything would say nothing.
        await expect(general.getByTestId("auto-away-select")).toBeVisible();
        await expect(group.getByTestId("auto-away-select")).toHaveCount(0);
        await expect(group.getByTestId("upload-ttl-select")).toHaveCount(0);
        // ── (3) the write-once fields are one tap deeper now ──
        await expect(general.getByTestId("settings-section-profile")).toHaveCount(0);
        await expect(general.getByTestId("settings-section-avatar")).toHaveCount(0);
        await expect(general.getByTestId("show-peer-profiles-toggle")).toHaveCount(0);
        // ── (2) ONE apply over identity + the NickServ password ──
        // Drive the lifted picker to choose the target explicitly rather than
        // inheriting whatever the focused network happens to be.
        await select.selectOption(NETWORK_SLUG);
        await expect(page.locator("#settings-nick")).toHaveValue(specNick(), { timeout: 10_000 });
        const password = page.locator("#settings-network-password");
        // The secret is edited HERE now, inside the identity card, under the name
        // of the thing it identifies with.
        await expect(general.getByLabel(/nickserv password/i)).toHaveCount(1);
        // …and the rival save button it used to carry is gone.
        await expect(general.getByTestId("settings-password-apply")).toHaveCount(0);
        await page.locator("#settings-nick").fill(newNick);
        await password.fill(nickServPassword);
        const applyBtn = general.getByTestId("settings-identity-apply");
        await applyBtn.click(); // arm
        await applyBtn.click(); // confirm
        // HEADLINE 1 — the password reached the server. A write-only value has
        // exactly one readback: the field is cleared by the success path and by
        // nothing else, so an empty input after an apply IS the 200.
        await expect(password).toHaveValue("", { timeout: 30_000 });
        await expect(general.getByTestId("settings-identity-ok")).toBeVisible({ timeout: 30_000 });
        await expect(general.getByTestId("settings-password-error")).toHaveCount(0);
        await expect(general.getByTestId("settings-identity-error")).toHaveCount(0);
        // HEADLINE 2 — the identity reached UPSTREAM, from the same single
        // gesture: the session bounced, re-registered under the new nick and
        // rejoined the channel, which is where the member list can see it.
        await settleNetworkAutojoin(user.token, NETWORK_SLUG, channel, newNick);
        // ── (3, continued) the profile door, and where back goes ──
        // Tapped directly rather than through `openSettingsSection`: this row IS
        // what the assertion is about, and it is not on the index the helper
        // drives — reaching it through the helper would be circular.
        await general.getByTestId("profile-settings-entry").click();
        const profile = page.getByTestId("profile-subpage");
        await expect(profile.getByTestId("settings-section-profile")).toBeVisible();
        await expect(profile.getByTestId("settings-section-avatar")).toBeVisible();
        await expect(profile.getByTestId("show-peer-profiles-toggle")).toBeVisible();
        // The opt-in is account-wide and must NOT sit under a group claiming a
        // network (issue 1993 point 4 — making it per-network — is deliberately
        // not in this slice).
        await expect(profile.getByTestId("settings-network-scope").getByTestId("show-peer-profiles-toggle")).toHaveCount(0);
        await profile.getByTestId("profile-back").click();
        await expect(page.getByTestId("general-subpage")).toBeVisible();
        // Back returns to GENERAL, not two levels out to the index.
        await expect(page.getByTestId("themes-settings-entry")).toHaveCount(0);
    }
    finally {
        // Restore the provisioned nick before the #1152 teardown guard reads the
        // live one. Swallowed: a cleanup hiccup must not mask the assertions.
        await setNetworkIdentityNick(user.token, NETWORK_SLUG, specNick())
            .then(() => settleNetworkAutojoin(user.token, NETWORK_SLUG, channel, specNick()))
            .catch(() => { });
    }
});

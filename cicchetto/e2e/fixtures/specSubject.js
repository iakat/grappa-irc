// #1078 — one subject per test, instead of one subject for the suite.
//
// The suite used to share a single seeded user (`vjt`) and put it back
// to a baseline after every test: an enumerated list of surfaces to
// drain, plus a truncate-and-re-seed of an enumerated list of channels.
// A list only cleans what somebody remembered to put on it. #1078
// measured what fell off it — `$server`, the pseudo-channel the reset's
// own reconnect writes its notices into, grew +14 rows per reset and
// ~5000 across the suite, because it is not in the baseline.
//
// vjt ruled option (A): namespace by construction, at the SUBJECT
// level. `$server` is per-(user, network), so a per-channel namespace
// would not have closed it. Every surface the drain enumerated — read
// cursors, query windows, push subscriptions, settings, uploads, notify
// entries, WS presence, scrollback, the credential's channel lists — is
// keyed by `user_id`. A user created a millisecond ago is empty on all
// of them, including the ones nobody has thought of yet.
//
// Server half: `Grappa.TestSupport.SubjectProvision`, behind
// `POST /admin/test/subject` + `DELETE /admin/test/subject/:name`.
import { createHash } from "node:crypto";
import { GRAPPA_BASE_URL } from "./grappaApi";
import { AUTOJOIN_CHANNELS, getSeededAdmin, NETWORK_SLUG } from "./seedData";
// Mirrors the seeder's compose-time
// `mix grappa.seed_scrollback --count 200 --sender seed-bot`, which is
// what the whole scroll/marker family of specs is calibrated against.
const SEED_COUNT = 200;
const SEED_SENDER = "seed-bot";
const PASSWORD = "test-password-not-secret";
// Derived from the test's title path, NOT from a counter: a counter
// makes a subject's name depend on where the test sorts in the run, so
// the same spec run under `--grep` would get a different name than it
// gets in the full suite, and a name in a failure log would not point
// back at anything. Eight hex characters keep the nick well inside
// NICKLEN while making a collision across ~660 tests a ~0.005% event —
// and a collision is LOUD, not silent: the second `POST /admin/users`
// fails the uniqueness constraint and the provision throws.
function subjectNameFor(testInfo) {
    const digest = createHash("sha1").update(testInfo.titlePath.join("\u0000")).digest("hex");
    return `s${digest.slice(0, 8)}`;
}
export async function provisionSpecSubject(testInfo) {
    const admin = getSeededAdmin();
    const name = subjectNameFor(testInfo);
    const res = await fetch(`${GRAPPA_BASE_URL}/admin/test/subject`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${admin.token}` },
        body: JSON.stringify({
            name,
            password: PASSWORD,
            network_slug: NETWORK_SLUG,
            nick: name,
            autojoin_channels: AUTOJOIN_CHANNELS,
            seed: AUTOJOIN_CHANNELS.map((channel) => ({
                name: channel,
                seed_count: SEED_COUNT,
                seed_sender: SEED_SENDER,
            })),
        }),
    });
    if (res.status !== 201) {
        throw new Error(`provisionSpecSubject(${name}) failed: ${res.status} ${await res.text()}\n` +
            `  test: ${testInfo.titlePath.join(" | ")}`);
    }
    const body = (await res.json());
    process.stderr.write(`__PROVISIONCOST__\t${Object.entries(body.phases)
        .sort()
        .map(([k, v]) => `${k}=${v}`)
        .join(";")}\t${testInfo.titlePath.join(" | ")}\n`);
    return {
        user: {
            name,
            password: PASSWORD,
            identifier: `${name}@grappa.test`,
            token: body.token,
            subjectJson: JSON.stringify(body.subject),
        },
        nick: name,
    };
}
// A teardown that cannot find its own subject is a fixture bug, and the
// server answers 404 rather than pretending. Throwing here is the point:
// a leaked subject would sit in /admin/users and /admin/sessions for the
// rest of the run and change what every later spec sees there.
export async function teardownSpecSubject(subject) {
    const admin = getSeededAdmin();
    const res = await fetch(`${GRAPPA_BASE_URL}/admin/test/subject/${subject.user.name}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${admin.token}` },
    });
    if (res.status !== 204) {
        throw new Error(`teardownSpecSubject(${subject.user.name}) failed: ${res.status} ${await res.text()}`);
    }
}
// Playwright runs the tests of a worker one at a time in one process,
// so "the subject of the test currently running" is a well-defined
// module-level value. The auto-fixture in `fixtures/test.ts` sets it
// before the body and clears it after; reading it outside a test throws
// rather than handing back a stale subject from the previous one.
//
// This is the shape the suite already had — `getSeededVjt()` was a
// module-level accessor over a process-wide value written by
// globalSetup. #1078 changes what the value is scoped to, not how a
// spec reaches it, which is what let ~320 spec files migrate by
// renaming a call instead of rewriting a signature.
let current = null;
// #1152 — every nick value the running test actually HANDED OUT, which is
// what the teardown guard has to judge, and it is not the same thing as
// the last value cached.
//
// Measured on this branch: 19 of the 20 specs that now call
// `specLiveNick()` also read `specNick()` earlier in the file. Guarding
// the CACHE alone would let the async call launder it — refresh to the
// live nick, teardown compares live against live, green — while the stale
// value those 19 already consumed goes unreported. Recording the values
// instead makes the guard's question the honest one: was everything this
// test addressed the nick the session was flying?
let consumed = new Set();
export function setCurrentSpecSubject(subject) {
    current = subject;
    consumed = new Set();
}
/** Every distinct nick the current test has been handed, in first-seen order. */
export function consumedSpecNicks() {
    return [...consumed];
}
function requireCurrent(caller) {
    if (!current) {
        throw new Error(`${caller}: no subject for the current test. Specs that use it MUST import ` +
            `\`test\` from ../fixtures/test — the bare @playwright/test import has no ` +
            `subject fixture.`);
    }
    return current;
}
/** The per-test user: name, password, identifier, bearer, subject envelope. */
export function specUser() {
    return requireCurrent("specUser()").user;
}
/**
 * The per-test user's upstream IRC nick, as last RESOLVED — the requested
 * one until something re-resolves it. Synchronous, so it cannot be
 * always-correct: see the #1152 note below.
 */
export function specNick() {
    const nick = requireCurrent("specNick()").nick;
    consumed.add(nick);
    return nick;
}
/**
 * Read the subject's live upstream nick off `GET /networks`, or say why it
 * could not be read. Never throws on a reachable server: a spec that
 * revokes its own bearer (the logout journeys seed `specUser().token` into
 * the page, so a UI logout kills this exact token) has not drifted, it has
 * stopped being observable, and the two must not be confused.
 */
export async function readSpecLiveNick() {
    const subject = requireCurrent("readSpecLiveNick()");
    const res = await fetch(`${GRAPPA_BASE_URL}/networks`, {
        headers: { authorization: `Bearer ${subject.user.token}` },
    });
    if (!res.ok) {
        return {
            kind: "unobservable",
            reason: res.status === 401 ? "bearer_revoked" : `${res.status}`,
        };
    }
    const rows = (await res.json());
    const row = rows.find((r) => r.slug === NETWORK_SLUG);
    if (!row)
        return { kind: "unobservable", reason: "no_row" };
    if (row.connection === null)
        return { kind: "unobservable", reason: "no_live_session" };
    return { kind: "live", nick: row.nick };
}
/**
 * The nick the subject's session is actually flying, re-resolved now, and
 * cached so the teardown guard compares against a value that was true.
 *
 * Use this wherever the nick is the STIMULUS — a DM addressed to it, a
 * mention typed into a body — because there a stale nick does not fail the
 * spec, it quietly tests nothing. Throws rather than guessing: addressing
 * a nick nobody could confirm is the whole of #1152.
 */
export async function specLiveNick() {
    const subject = requireCurrent("specLiveNick()");
    const reading = await readSpecLiveNick();
    if (reading.kind === "unobservable") {
        throw new Error(`specLiveNick(): no live nick for ${subject.user.name} (${reading.reason}). ` +
            `Last resolved: ${subject.nick}. Addressing that blind is #1152, so this throws.`);
    }
    subject.nick = reading.nick;
    consumed.add(reading.nick);
    return reading.nick;
}

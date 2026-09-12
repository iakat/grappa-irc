// #1336 (#1117 + #1152) — an absence that can only pass for the right reason.
//
// Seven specs in the push/mute family assert that NO push was delivered, and
// each one's stimulus is a bare `peer.privmsg(...)` — fire-and-forget, with no
// barrier that the message ever reached grappa. Measured on #1152: it does not
// always. On run 31324253590 the peer's DM went to a nick nobody was
// registered under (a 7 ms teardown/reconnect left bahamut holding the ghost,
// and grappa's #604 reconcile correctly adopted `vjt-grappa_`), and the peer
// nick appears ZERO times in that run's 240 MB `grappa-test.log` — a log
// carrying 135 902 message INSERTs, so the instrument was sound and the
// absence was real.
//
// On the POSITIVE spec that event is a loud 5 s `awaitPushDelivery` timeout.
// On the six negative ones the SAME event is a silent green: no message, no
// trigger, no push, assertion satisfied. The suppression under test is never
// exercised. That is the difference between "the apparatus was on" and "the
// stimulus was delivered" — every one of those specs proves the first (a real
// delivery elsewhere in the test), none proved the second.
//
// So the contract here is: prove the stimulus reached grappa, THEN watch for
// silence — and fail, naming the stimulus, when the proof cannot be had. The
// order is load-bearing in both directions. A window opened before the message
// lands can expire before the push it is meant to forbid could ever have
// fired, which is a second way to pass without observing anything.
//
// Free of `fetch` by construction (the caller adapts the push-catcher and the
// scrollback REST view to `PushAbsenceProbes`) for the reason `whoisWait.ts`
// gives: the instrument a claim is judged by has to be provable itself.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function assertNoPushAfterStimulus(probes, spec) {
    const { id, stimulus, windowMs, pollMs } = spec;
    try {
        await probes.stimulusDelivered();
    }
    catch (cause) {
        throw new Error(`assertNoPushAfterStimulus: the stimulus never reached grappa, so the absence of a push ` +
            `for id=${id} proves nothing — ${stimulus}\n  cause: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    const deadline = Date.now() + windowMs;
    while (Date.now() < deadline) {
        const count = await probes.deliveryCount();
        if (count > 0) {
            throw new Error(`assertNoPushAfterStimulus: expected zero, saw ${count} for id=${id} — ${stimulus}`);
        }
        await sleep(pollMs);
    }
}

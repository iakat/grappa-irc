// #1336 (row #1079) — what a post-send scrollback trace MEANS, decided in one
// place instead of by an anonymous number in a failing poll.
//
// #1079 reports `scroll-on-window-switch` settling 337px from the bottom
// against an expected 50, the same number twice on two trees. 337 is
// `1415 - 1078`: the pane sitting exactly ON the unread marker after a send
// that should have taken it to the tail. The S2 slice proved the pre-send
// barrier vacuous and cured it, but never observed the vacuity being
// EXPLOITED — eight recorded samples exited at the marker every time.
//
// The instrument that produced those eight samples recorded POSITIONS, and
// that is why it could not settle the question. In the candidate that explains
// the number — `scrollToActivation`'s deferred `setFollowMode(near)` landing
// after the send's own re-arm — nothing writes `scrollTop` at all: the pane
// simply never leaves the marker, and `tailFollowWhenSettled` yields on
// `!followMode()` without writing or rescheduling. A recorder of positions is
// blind to that BY CONSTRUCTION. So the input here carries three channels on
// one clock: geometry, follow transitions, and rows recreations (the second
// silent exit of the same wait, on a list node that is no longer connected).
//
// Playwright-free on purpose, for the reason `scrollGesture.ts` gives: the
// instrument a claim is judged by has to be provable itself, and that means
// unit-testable without a testnet.
const isScroll = (e) => e.kind === "scroll";
const markIndex = (events, name) => events.findIndex((e) => e.kind === "mark" && e.name === name);
// The follow state the trace ENDS on. A reverse scan rather than `findLast`,
// which the e2e tsconfig's lib target does not carry.
function lastFollowState(events) {
    for (let i = events.length - 1; i >= 0; i -= 1) {
        const event = events[i];
        if (event !== undefined && event.kind === "follow")
            return event.follow;
    }
    return null;
}
export function classifyPostSend(events, opts) {
    const sendAt = markIndex(events, "send");
    const after = sendAt < 0 ? [] : events.slice(sendAt + 1);
    const distance = opts.finalDistancePx;
    // The assertion the row is about DID pass: whatever the three channels show
    // on the way — up to and including the strongest frozen signal there is —
    // the pane ended at the tail, so there is nothing to accuse. This is the
    // gate that makes the accusation downstream of the failure rather than
    // parallel to it: below, the poll has necessarily already failed.
    if (distance <= opts.thresholdPx)
        return { kind: "OK", distance, attributedTo: null };
    // Follow OFF makes the position TERMINAL: `tailFollowWhenSettled` yields on
    // `!followMode()` writing nothing and rescheduling nothing, so nobody is
    // going to bring this pane down. That, and not "no more scroll events", is
    // what separates frozen from slow — measured: an injected freeze recorded
    // its disarm BEFORE the decrease that caused it, because the
    // MutationObserver microtask lands between two listeners on one event, and
    // an event-order rule called the frozen pane SLOW.
    if (lastFollowState(events) === "off") {
        // `onScroll` disarms on any scrollTop DECREASE, so a pane that reached the
        // tail after the send and then left it went out through that arm; one that
        // never reached the tail was disarmed by a direct write — the activation
        // class. Stated as positions rather than as event order, which the same
        // measurement showed is not reliable to a millisecond.
        const reachedTail = after
            .filter(isScroll)
            .some((e) => e.maxScroll - e.scrollTop <= opts.thresholdPx);
        return {
            kind: "FROZEN-AT-MARKER",
            distance,
            attributedTo: reachedTail ? "scroll-up" : "activation",
        };
    }
    // No disarm, and yet the pane never reached the tail: the other silent exit,
    // where the list node the deferred tail-follow was going to write has been
    // recreated under it.
    if (after.some((e) => e.kind === "rows"))
        return { kind: "FROZEN-AT-MARKER", distance, attributedTo: "rows-recreation" };
    return { kind: "SLOW", distance, attributedTo: null };
}
// The presence check, and the reason it exists: an instrument that recorded
// nothing must never read as "no exploitation observed". That is #1117's shape
// — negative assertions passing against an empty recorder — and this row sits
// inside the epic that exists to refuse it.
//
// The four markers are the ones present in BOTH outcomes. "The send's own tail
// write" is deliberately NOT among them, though an earlier draft of the design
// listed it: it is absent exactly when the defect fires, so requiring it would
// turn every real catch into an instrument failure.
export function assertTraceIsUsable(events) {
    const restExit = markIndex(events, "rest-exit");
    if (restExit < 0)
        throw new Error("scrollTrace: no rest-exit mark — the barrier never reported where it stopped");
    const sendAt = markIndex(events, "send");
    if (sendAt < 0)
        throw new Error("scrollTrace: no send mark — the trace cannot be split");
    if (!events.slice(0, sendAt).some(isScroll))
        throw new Error("scrollTrace: no scroll write before the send — the activation writes three, " +
            "so the recorder was installed too late or not at all");
    if (!events.some((e) => e.kind === "follow"))
        throw new Error("scrollTrace: no follow transition anywhere — the `data-follow` observer never fired");
}

// The scrollback scroll-write spy, extracted from
// `issue625-single-send-scroll-jump.spec.ts` when issue 2031 needed the same
// instrument.
//
// It answers a question no position sampler can: WHO WROTE, and WHEN. #625's
// defect is a second `scrollIntoView` landing ~0.5s after the send, and a
// recorder of positions cannot tell a delayed write apart from a delayed
// layout — both show up as "the number changed late". So this wraps the two
// doors a scroll write can come through (`Element.prototype.scrollIntoView`
// and the `scrollTop` setter) and timestamps each one.
//
// It is a FIXTURE and not a copy in each spec because two specs now assert
// against the same recording, and a second copy is how the two drift into
// disagreeing about what a write is. The page-context globals are namespaced
// away from any one issue number for the same reason.
//
// Page-context only: nothing here changes production behaviour. The wrap is
// installed on the live page and never restored — each spec gets a fresh page,
// so there is nothing to leak into.
// Distance from the tail for one sample. The raw float, like
// `scrollbackDistanceFromBottom` — the caller owns the rounding, because the
// caller owns the threshold it is compared against.
export function distanceOf(s) {
    return s.height - s.top - s.client;
}
// The writes that landed more than `graceMs` after the FIRST one.
//
// Measured from the first write and not from probe-install on purpose: the
// send's own latency (the CDP round-trip plus the WS echo) floats the
// legitimate write's absolute timestamp, so an absolute cutoff false-REDs on a
// slow run. The defect IS the gap between two writes, so the gap is what is
// measured.
export function delayedWrites(writes, graceMs) {
    const first = writes[0];
    if (first === undefined)
        return [];
    return writes.filter((w) => w.t - first.t > graceMs);
}
// Install the sampler + write spy on the scrollback container. Call BEFORE the
// action under test.
//
// The sampler records on every native `scroll` event AND on a rAF tick: a
// programmatic write that lands between two scroll events is invisible to the
// event alone, and that write is exactly the one under accusation.
export async function installScrollProbe(page, windowMs) {
    await page.evaluate((windowMsArg) => {
        const el = document.querySelector('[data-testid="scrollback"]');
        if (!el)
            throw new Error("scrollWriteProbe: scrollback container not found");
        const w = window;
        w.__scrollProbeSamples = [];
        w.__scrollProbeWrites = [];
        const t0 = performance.now();
        const now = () => performance.now() - t0;
        // Read through the PROTOTYPE descriptor, not `el.scrollTop`: the own
        // property installed below would otherwise make the spy read itself.
        const desc = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
        const getTop = () => (desc?.get ? desc.get.call(el) : el.scrollTop);
        if (desc?.get && desc?.set) {
            Object.defineProperty(el, "scrollTop", {
                configurable: true,
                get() {
                    return desc.get?.call(this);
                },
                set(v) {
                    w.__scrollProbeWrites.push({
                        t: Math.round(now()),
                        kind: "scrollTop=",
                        detail: String(Math.round(v)),
                        before: Math.round(getTop()),
                    });
                    desc.set?.call(this, v);
                },
            });
        }
        const rawSIV = Element.prototype.scrollIntoView;
        Element.prototype.scrollIntoView = function (arg) {
            // Only writes that move THIS scroller count — `scrollIntoView` on a node
            // elsewhere in the document is somebody else's business.
            if (this === el || el.contains(this)) {
                w.__scrollProbeWrites.push({
                    t: Math.round(now()),
                    kind: "scrollIntoView",
                    detail: JSON.stringify(arg ?? null),
                    before: Math.round(getTop()),
                });
            }
            return rawSIV.call(this, arg);
        };
        const sample = () => {
            w.__scrollProbeSamples.push({
                t: Math.round(now()),
                top: Math.round(getTop()),
                height: el.scrollHeight,
                client: el.clientHeight,
            });
        };
        sample();
        el.addEventListener("scroll", sample, { passive: true });
        const loop = () => {
            sample();
            if (now() < windowMsArg)
                requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
    }, windowMs);
}
// Read the recording back and print it. On a failure this dump is the whole
// story: `writes` names every write and its timestamp (a delayed double-scroll
// shows as a second entry ~0.5s in), `topChanges` is the compressed scrollTop
// timeline with only the frames where the position actually moved.
export async function dumpScrollProbe(page, tag) {
    const samples = await page.evaluate(() => window.__scrollProbeSamples);
    const writes = await page.evaluate(() => window.__scrollProbeWrites);
    const compact = [];
    let prevTop = Number.NaN;
    for (const s of samples) {
        if (s.top !== prevTop) {
            compact.push({ t: s.t, top: s.top, d: Math.round(distanceOf(s)) });
            prevTop = s.top;
        }
    }
    console.log(`[scroll-probe ${tag}] writes=${JSON.stringify(writes)}`);
    console.log(`[scroll-probe ${tag}] topChanges=${JSON.stringify(compact)}`);
    return { samples, writes };
}

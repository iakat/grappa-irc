// #1911 — the browser half of the OIDC round trip: the `#oidc=` landing
// codec and the door probe.
//
// The codec is the boundary that stands between the callback's redirect
// and this SPA, and it has NO generated schema behind it (the landing is
// an inline `json/2` payload the wire pin does not digest — recorded as
// debt on `GrappaWeb.OidcController`). So the shape narrowing here is the
// only thing standing between a malformed payload and a component reading
// `landing.token` as a string, and these tests hold every arm of it.
import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { beginOidcLogin, clearOidcLanding, oidcLoginAvailable, readOidcLanding } from "../lib/oidc";

const encode = (payload: unknown): string =>
  Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");

const landOn = (hash: string): void => {
  window.history.replaceState(null, "", `/login${hash}`);
};

const sessionLanding = {
  kind: "session",
  token: "bearer-token",
  subject: { kind: "user", id: "u-1", name: "vjt" },
};

afterEach(() => {
  // Unstub before touching the URL: a stubbed `window` carries no history.
  vi.unstubAllGlobals();
  landOn("");
});

describe("readOidcLanding", () => {
  it("decodes a session landing — bearer plus subject", () => {
    expect(readOidcLanding(`#oidc=${encode(sessionLanding)}`)).toEqual(sessionLanding);
  });

  it("reads the hash with or without its leading #", () => {
    expect(readOidcLanding(`oidc=${encode(sessionLanding)}`)).toEqual(sessionLanding);
  });

  it("decodes the totp, linked and error landings", () => {
    expect(readOidcLanding(`#oidc=${encode({ kind: "totp", challenge_token: "c-1" })}`)).toEqual({
      kind: "totp",
      challenge_token: "c-1",
    });
    expect(readOidcLanding(`#oidc=${encode({ kind: "linked", label: "vjt" })}`)).toEqual({
      kind: "linked",
      label: "vjt",
    });
    expect(readOidcLanding(`#oidc=${encode({ kind: "linked", label: null })}`)).toEqual({
      kind: "linked",
      label: null,
    });
    expect(readOidcLanding(`#oidc=${encode({ kind: "error", code: "not_linked" })}`)).toEqual({
      kind: "error",
      code: "not_linked",
    });
  });

  it("answers null for an ordinary visit — no fragment, or one that is not ours", () => {
    expect(readOidcLanding("")).toBeNull();
    expect(readOidcLanding("#")).toBeNull();
    expect(readOidcLanding("#signed-payload=abc")).toBeNull();
    expect(readOidcLanding(`#other=${encode(sessionLanding)}`)).toBeNull();
  });

  it("refuses a landing of an unknown kind", () => {
    expect(readOidcLanding(`#oidc=${encode({ kind: "signout" })}`)).toBeNull();
  });

  it("refuses a session landing whose bearer or subject is unusable", () => {
    const noToken = { kind: "session", subject: sessionLanding.subject };
    const noSubject = { kind: "session", token: "bearer-token" };
    const junkSubject = { kind: "session", token: "t", subject: { kind: "user" } };

    for (const landing of [noToken, noSubject, junkSubject]) {
      expect(readOidcLanding(`#oidc=${encode(landing)}`)).toBeNull();
    }
  });

  it("refuses a mangled payload rather than throwing", () => {
    // Valid base64url, not JSON.
    expect(
      readOidcLanding(`#oidc=${Buffer.from("hello", "utf8").toString("base64url")}`),
    ).toBeNull();
    // Not base64url at all.
    expect(readOidcLanding("#oidc=!!!!")).toBeNull();
    // Valid base64url of bytes that are not UTF-8 (a lone 0xFF).
    expect(readOidcLanding(`#oidc=${Buffer.from([0xff]).toString("base64url")}`)).toBeNull();
  });
});

describe("clearOidcLanding", () => {
  it("scrubs the fragment and keeps the route and the query", () => {
    landOn("#oidc=abc");
    clearOidcLanding();

    expect(window.location.hash).toBe("");
    expect(window.location.pathname).toBe("/login");
  });

  it("is a no-op on a fragment-free URL", () => {
    landOn("");
    clearOidcLanding();

    expect(window.location.pathname).toBe("/login");
  });
});

describe("oidcLoginAvailable", () => {
  it("answers true when the door redirects — the deployment has a provider", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ status: 0, type: "opaqueredirect" }) as Response),
    );

    await expect(oidcLoginAvailable()).resolves.toBe(true);
  });

  it("answers true where a runtime surfaces the real 302", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ status: 302, type: "basic" }) as Response),
    );

    await expect(oidcLoginAvailable()).resolves.toBe(true);
  });

  it("answers false when the deployment has no provider — the button must not tease", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ status: 404, type: "basic" }) as Response),
    );

    await expect(oidcLoginAvailable()).resolves.toBe(false);
  });

  it("answers false rather than throwing when the server cannot be reached", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("offline"))),
    );

    await expect(oidcLoginAvailable()).resolves.toBe(false);
  });
});

describe("beginOidcLogin", () => {
  it("navigates the BROWSER at the authorize route — the 302 is not fetchable", () => {
    const assign = vi.fn();
    // `beginOidcLogin` reaches exactly one thing — `window.location.assign` —
    // so the stub carries exactly that, rather than a spread of the jsdom
    // window.
    vi.stubGlobal("window", { location: { assign } });

    beginOidcLogin();

    expect(assign).toHaveBeenCalledWith("/auth/oidc/authorize");
  });
});

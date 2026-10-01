import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
// Explicit `.ts` extension: `npm run test:unit` runs `node --test` with native
// type-stripping (no tsx loader), and Node's ESM resolver does not guess
// extensions. Matches the convention in every other src/lib/*.test.ts.
import {
  twHref,
  untwHref,
  localeSwitch,
  isTwPath,
  parseLocale,
  pickLocale,
  NON_MIRRORED_FORUM_SEGMENTS,
} from "../i18n/translations.ts";
import type { Locale } from "../i18n/translations.ts";

const TW = "zh-TW";
const SC = "zh-CN";

// Imported, not re-declared. A local copy of this list would let the guard below
// keep passing after someone edits the real one — the test would be asserting
// against a constant it owns, not against the behaviour under test.
const NON_MIRRORED = [...NON_MIRRORED_FORUM_SEGMENTS];

// ── twHref: mirrored targets get the prefix ────────────────────────────────

test("twHref: the three mirrored shapes get the /tw prefix", () => {
  assert.equal(twHref(TW, "/forum"), "/tw/forum");
  assert.equal(twHref(TW, "/forum/thread/7187fcba-c001-4a5c-b895-59a307085d47"),
    "/tw/forum/thread/7187fcba-c001-4a5c-b895-59a307085d47");
  // A board slug is any segment that is not in the non-mirrored set.
  assert.equal(twHref(TW, "/forum/puer"), "/tw/forum/puer");
  assert.equal(twHref(TW, "/forum/classics-archive"), "/tw/forum/classics-archive");
});

test("twHref: query string and hash survive the prefix", () => {
  // The tab vocabulary is shared by both trees — `?tab=` must not be translated
  // or dropped, or every tab click inside /tw/ would silently reset to default.
  assert.equal(twHref(TW, "/forum?tab=week"), "/tw/forum?tab=week");
  assert.equal(twHref(TW, "/forum?tab=essence&page=2"), "/tw/forum?tab=essence&page=2");
  assert.equal(twHref(TW, "/forum/puer?sort=latest"), "/tw/forum/puer?sort=latest");
  assert.equal(twHref(TW, "/forum/puer?page=3#top"), "/tw/forum/puer?page=3#top");
});

// ── twHref: non-mirrored targets are left alone ────────────────────────────

test("twHref: /forum sections with no /tw mirror stay unprefixed", () => {
  // Prefixing any of these would point at a route that does not exist → 404.
  for (const seg of NON_MIRRORED) {
    assert.equal(twHref(TW, `/forum/${seg}`), `/forum/${seg}`, `${seg} must not be prefixed`);
    assert.equal(twHref(TW, `/forum/${seg}?page=2`), `/forum/${seg}?page=2`);
  }
});

test("twHref: non-forum paths are never touched", () => {
  for (const href of ["/tea/abc", "/user/abc", "/exchange", "/sessions", "/ask", "/about", "/"]) {
    assert.equal(twHref(TW, href), href, `${href} must not be prefixed`);
  }
});

test("twHref: a simplified reader gets simplified links regardless of target", () => {
  for (const href of ["/forum", "/forum/puer", "/forum/thread/x", "/forum/classics"]) {
    assert.equal(twHref(SC, href), href);
    assert.equal(twHref(undefined, href), href);
  }
});

test("twHref: does not confuse sibling routes with /forum", () => {
  // A bare `startsWith("/forum")` would swallow these and point at routes that
  // do not exist. The guard has to be segment-aware.
  for (const href of ["/forums", "/forum-x", "/forum2"]) {
    assert.equal(twHref(TW, href), href, `${href} must not be prefixed`);
  }
});

test("twHref: a deeper path under a mirrored segment is a different page", () => {
  // Regression. The old guard only inspected segment 2, so it saw
  // `/forum/thread/<id>/edit` as "a thread" and rewrote it to
  // `/tw/forum/thread/<id>/edit` — a route that does not exist. The 繁體 button
  // in the header reads usePathname(), so a reader editing a post could press
  // it and land on a 404. Only the three exact shapes may be prefixed.
  const unmirrored = [
    "/forum/thread/7187fcba-c001-4a5c-b895-59a307085d47/edit",
    "/forum/thread/abc/edit",
    "/forum/puer/settings",
  ];
  for (const href of unmirrored) {
    assert.equal(twHref(TW, href), href, `${href} must not be prefixed`);
  }
  // ...while the shapes themselves still are.
  assert.equal(twHref(TW, "/forum/thread/abc"), "/tw/forum/thread/abc");
});

// ── untwHref: the language switch can always walk back out ─────────────────

test("untwHref: strips the prefix, returns null outside the tree", () => {
  assert.equal(untwHref("/tw/forum"), "/forum");
  assert.equal(untwHref("/tw/forum/thread/x"), "/forum/thread/x");
  assert.equal(untwHref("/tw"), "/");
  assert.equal(untwHref("/forum"), null);
  assert.equal(untwHref("/tea/abc"), null);
});

test("untwHref: only /tw itself, not every path that merely starts with it", () => {
  // Same class of bug as the sibling-route cases above, on the other side of
  // the pair: `/twx/forum` starts with "/tw" but is a different route, and
  // slicing it would send the language switch to `/x/forum`.
  for (const pathname of ["/twx", "/two", "/twa/forum", "/tw-", "/twx/forum"]) {
    assert.equal(untwHref(pathname), null, `${pathname} must not be stripped`);
  }
  // A trailing slash is the tree root, not a path whose stripped form is "".
  assert.equal(untwHref("/tw/"), "/");
});

// ── isTwPath: the one predicate the server and the client both run ─────────

test("isTwPath and untwHref agree on every path", () => {
  // src/proxy.ts chooses the server-side <html lang> with isTwPath, and
  // src/i18n/context.tsx forces the client locale with the same function. They
  // are one import now, and this pins the relationship to untwHref — the other
  // place the same question is asked — so a future rewrite of either cannot
  // drift into "server renders traditional, client hydrates simplified".
  const corpus = [
    "/", "/tw", "/tw/", "/tw/forum", "/tw/forum/puer", "/tw/forum/thread/x",
    "/forum", "/forum/puer", "/forum/thread/x", "/forums", "/forum-x",
    "/twx", "/two", "/twa/forum", "/tea/abc", "/user/abc", "/tw/forum?tab=day",
  ];
  for (const pathname of corpus) {
    assert.equal(
      isTwPath(pathname),
      untwHref(pathname.split(/[?#]/)[0]) !== null,
      `${pathname}: isTwPath and untwHref disagree`,
    );
  }
  // usePathname() is typed `string` but is null outside a router, and during
  // some not-found renders — the client must not throw there.
  assert.equal(isTwPath(null), false);
  assert.equal(isTwPath(undefined), false);
  assert.equal(isTwPath(""), false);
});

// ── parseLocale: what may become a Locale ──────────────────────────────────

test("parseLocale accepts only the two known locales", () => {
  // Both callers (the cookie in the root layout, x-puer-locale in the provider)
  // read attacker-controllable input. Anything outside the union has to become
  // null so the caller falls back, not a cast that silently degrades the chrome.
  assert.equal(parseLocale("zh-TW"), "zh-TW");
  assert.equal(parseLocale("zh-CN"), "zh-CN");
  for (const bad of ["zh-Hant", "zh-Hant-TW", "tw", "ZH-TW", "zh-tw", "", "en", null, undefined]) {
    assert.equal(parseLocale(bad), null, `${String(bad)} must not parse`);
  }
});

// ── pickLocale: the URL's opinion is a force, not a vote ───────────────────

test("pickLocale: inside /tw the URL forces traditional over the cookie", () => {
  assert.equal(pickLocale("zh-TW", "zh-CN"), "zh-TW");
  assert.equal(pickLocale("zh-TW", "garbage"), "zh-TW");
  assert.equal(pickLocale("zh-TW", null), "zh-TW");
});

test("pickLocale: outside /tw the header's zh-CN is not a decision", () => {
  // Regression. src/proxy.ts stamps `x-puer-locale: zh-CN` on every route
  // outside /tw, so reading the header as a general locale made it non-null
  // everywhere and silently outranked a reader's deliberate zh-TW cookie. The
  // page then served simplified chrome over traditional content in the SSR
  // HTML, and flipped after hydration — a flash and a CLS risk. The URL only
  // ever *forces* traditional; everything else is the cookie's call.
  assert.equal(pickLocale("zh-CN", "zh-TW"), "zh-TW", "cookie must win over the header's zh-CN");
  assert.equal(pickLocale("zh-CN", "zh-CN"), "zh-CN");
  // An unusable header is "no opinion", not "an opinion of its own".
  assert.equal(pickLocale(null, "zh-TW"), "zh-TW");
  assert.equal(pickLocale("zh-Hant", "zh-TW"), "zh-TW");
  assert.equal(pickLocale("zh-tw", "zh-TW"), "zh-TW");
});

test("pickLocale: an unusable cookie falls back to no opinion, not to zh-CN", () => {
  // Both sources have to fail before the caller substitutes the default —
  // returning DEFAULT_LOCALE here would let a garbage cookie hide a missing
  // header and change what `?? DEFAULT_LOCALE` in locale-server.ts means.
  assert.equal(pickLocale("zh-CN", "garbage"), null);
  assert.equal(pickLocale(null, null), null);
  assert.equal(pickLocale(undefined, undefined), null);
});

test("pickLocale agrees with the client's forcedLocale ?? locale shape", () => {
  // src/i18n/context.tsx computes `isTwPath(p) ? "zh-TW" : cookie` on the
  // client. Where the URL is the mirror these must produce the same answer or
  // the server HTML and the hydrated chrome disagree. Only the reachable pairs
  // are listed: inside /tw the header is always "zh-TW".
  const cases: Array<[string, string, string | null, string | null]> = [
    ["/tw/forum", TW, "zh-TW", TW],
    ["/tw/forum/puer", SC, "zh-TW", TW],
    ["/forum", TW, "zh-CN", TW],
    ["/forum", SC, "zh-CN", SC],
    ["/forum", TW, null, TW],
    ["/tea/abc", TW, "zh-CN", TW],
    ["/tea/abc", SC, null, SC],
  ];
  for (const [pathname, cookie, header, expected] of cases) {
    const headerSaysTw = isTwPath(pathname);
    assert.equal(headerSaysTw, header === "zh-TW", `${pathname}: proxy stamp disagree`);
    assert.equal(
      pickLocale(header, cookie),
      expected,
      `${pathname} cookie=${cookie} header=${header}`,
    );
  }
});

test("untwHref inverts twHref for every mirrored path", () => {
  // The header's language switch navigates with untwHref(twHref(p)). If these
  // ever disagree the reader lands on a wrong or missing page, so pin the
  // round trip rather than the individual outputs.
  for (const href of ["/forum", "/forum?tab=day", "/forum/puer", "/forum/thread/abc"]) {
    const roundTripped = untwHref(twHref(TW, href));
    assert.equal(roundTripped, href);
  }
});

// ── localeSwitch: the language button's four cases ─────────────────────────

test("localeSwitch: leaving /tw walks to the simplified URL", () => {
  assert.deepEqual(localeSwitch("/tw/forum", TW), { href: "/forum", locale: SC });
  assert.deepEqual(localeSwitch("/tw/forum/puer", TW), { href: "/forum/puer", locale: SC });
  assert.deepEqual(localeSwitch("/tw", TW), { href: "/", locale: SC });
});

test("localeSwitch: simplified chrome on a mirrored page opens the mirror", () => {
  assert.deepEqual(localeSwitch("/forum", SC), { href: "/tw/forum", locale: SC });
  assert.deepEqual(localeSwitch("/forum/puer", SC), { href: "/tw/forum/puer", locale: SC });
});

test("localeSwitch: no mirror and no /tw prefix flips the locale in place", () => {
  // Nothing to navigate to, so the cookie has to carry it.
  assert.deepEqual(localeSwitch("/tea/abc", SC), { href: null, locale: TW });
  assert.deepEqual(localeSwitch("/forum/classics", SC), { href: null, locale: TW });
});

test("localeSwitch: traditional chrome on a simplified URL flips back, it does not navigate", () => {
  // Regression: a reader whose cookie says zh-TW is already on a simplified URL.
  // The button advertises 简体, so it must flip the chrome — not send them to a
  // /tw mirror they did not ask for just because one happens to exist.
  assert.deepEqual(localeSwitch("/forum", TW), { href: null, locale: SC });
  assert.deepEqual(localeSwitch("/forum/puer", TW), { href: null, locale: SC });
});

test("localeSwitch always lands the reader in the language the button advertised", () => {
  // The whole property, rather than the branches. `locale` is what the reader
  // is currently reading, so the button advertises the other one; afterwards
  // the URL decides inside /tw and the returned state decides outside it.
  //
  // Only reachable pairs are listed. Inside /tw/... the provider forces
  // `effectiveLocale` to zh-TW, so `("/tw/forum", zh-CN)` is a state no reader
  // can be in and asserting on it would pin behaviour for a caller that cannot
  // exist — see `isTwPath` in i18n/context.tsx.
  const cases: Array<[string, Locale]> = [
    ["/tw", TW],
    ["/tw/forum", TW],
    ["/tw/forum/puer", TW],
    ["/forum", SC],
    ["/forum", TW],
    ["/forum/puer", SC],
    ["/forum/puer", TW],
    ["/tea/abc", SC],
    ["/tea/abc", TW],
  ];
  for (const [pathname, locale] of cases) {
    const advertised = locale === "zh-TW" ? "zh-CN" : "zh-TW";
    const { href, locale: next } = localeSwitch(pathname, locale);
    const effective = href?.startsWith("/tw") ? "zh-TW" : next;
    assert.equal(
      effective,
      advertised,
      `${pathname} (${locale}): button advertised ${advertised} but landed on ${effective}`,
    );
  }
});

test("localeSwitch never navigates to a 404", () => {
  // Any href it hands back must be a route that exists — the same promise
  // twHref makes, checked from the other end. The only way to get this wrong
  // is to prefix a /forum section that has no mirror.
  for (const pathname of ["/forum", "/forum/puer", "/forum/classics", "/tea/abc", "/tw/forum"]) {
    for (const locale of [SC, TW] as Locale[]) {
      const { href } = localeSwitch(pathname, locale);
      if (href === null) continue;
      assert.ok(!NON_MIRRORED.some((seg) => href.startsWith(`/tw/forum/${seg}`)), `unmapped mirror: ${href}`);
    }
  }
});

test("localeSwitch round-trips: the way back is the way you came", () => {
  // /forum → 繁體 → /tw/forum → 简体 → /forum. If these disagree the reader
  // ping-pongs between trees or gets stuck in one.
  for (const href of ["/forum", "/forum/puer"]) {
    const out = localeSwitch(href, SC);
    assert.equal(out.href, `/tw${href}`);
    assert.deepEqual(localeSwitch(out.href!, TW), { href, locale: SC });
  }
});

// ── Drift guard: the routes twHref promises must actually exist ────────────

test("every shape twHref prefixes has a /tw route file", () => {
  // Derived from the route tree rather than from a list written here: asking
  // "does the mirror of each prefixed shape exist on disk" is what makes this a
  // guard. A hardcoded list of the three files would keep passing after someone
  // deleted one.
  const appDir = path.join(import.meta.dirname, "..", "app", "(main)", "tw", "forum");
  for (const [shape, rel] of [
    ["/forum", "page.tsx"],
    ["/forum/<board>", "[slug]/page.tsx"],
    ["/forum/thread/<id>", "thread/[id]/page.tsx"],
  ] as const) {
    assert.ok(existsSync(path.join(appDir, rel)), `${shape} is prefixed but ${rel} is missing`);
  }
  // And the converse: a route file under a segment twHref refuses to prefix
  // would mean real TW pages nobody can reach by link. The list comes from the
  // module itself, so it cannot silently disagree with the code under test.
  for (const seg of NON_MIRRORED) {
    assert.ok(
      !existsSync(path.join(appDir, seg)),
      `a /tw/forum/${seg} route exists but "${seg}" is in NON_MIRRORED_FORUM_SEGMENTS`,
    );
  }
});

test("/tw is redirected, not served", () => {
  // R5: the entry URL for the whole feature. It has no page.tsx, so without the
  // redirect in next.config.ts it 404s — while /tw/forum works, which is a
  // confusing way to discover the mirror. Mirrors `/` → `/forum`.
  const config = readFileSync(path.join(import.meta.dirname, "..", "..", "next.config.ts"), "utf8");
  assert.match(
    config,
    /source:\s*"\/tw"[\s\S]{0,80}?destination:\s*"\/tw\/forum"/,
    "next.config.ts no longer redirects /tw → /tw/forum",
  );
});

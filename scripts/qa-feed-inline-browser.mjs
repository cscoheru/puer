#!/usr/bin/env node
/**
 * Real Chromium matrix for the inline feed reply harness.
 * Invoked by qa-feed-inline.mjs with QA_BASE_URL / QA_MODE / QA_ARTIFACTS.
 *
 * No application modules are imported and no API responses are mocked for the
 * happy path. The only intercepted responses are the deliberate failure probes
 * (401 / unknown outcome / delayed duplicate click); those are labeled in the
 * result JSON so a green happy path can never be confused with a stubbed one.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const BASE = process.env.QA_BASE_URL;
const MODE = process.env.QA_MODE;
const OUT = process.env.QA_ARTIFACTS;
const VIEWER = {
  email: process.env.QA_VIEWER_EMAIL,
  password: process.env.QA_VIEWER_PASSWORD,
  username: process.env.QA_VIEWER_USERNAME,
};
assert.ok(BASE && OUT && MODE, "QA_BASE_URL, QA_ARTIFACTS and QA_MODE are required");
assert.ok(new URL(BASE).hostname === "127.0.0.1", "browser QA is loopback-only");
assert.ok(VIEWER.email && VIEWER.password, "viewer credentials are required");
fs.mkdirSync(OUT, { recursive: true });

const results = [];
let activeCheck = "setup";
const network = { commentGets: 0, feedGets: 0, abortedExternal: [], pageErrors: [], consoleErrors: [], intercepted: [], apiEvents: [] };
const ARTICLE = {
  main: "qa-feed-main",
  ai: "qa-feed-ai-only",
  empty: "qa-feed-empty",
  countOnly: "qa-feed-count-only",
  long: "qa-feed-long",
  otherPending: "qa-feed-other-pending",
};

function record(name, ok, detail) {
  results.push({ name, ok, detail: detail ?? null });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function check(name, fn) {
  activeCheck = name;
  try {
    const detail = await fn();
    record(name, true, detail);
  } catch (error) {
    record(name, false, error instanceof Error ? error.message.slice(0, 1200) : String(error));
  } finally {
    activeCheck = "between-checks";
  }
}

const card = (page, id) => page.locator(`#post-${id}`);
const preview = (page, id) => card(page, id).locator("section[data-comment-load-id]");
const commentText = (page, id, text) => preview(page, id).locator("p", { hasText: text });

async function shot(page, name) {
  // Full-page screenshots can move the lazy sentinel into the observer's
  // rootMargin and change the behavior under test. Card shots cover visual review.
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false }).catch(() => {});
}

async function cardShot(page, articleId, name) {
  await card(page, articleId).screenshot({ path: path.join(OUT, `${name}.png`) }).catch(() => {});
}

function guardContext(context) {
  return context.route("**/*", async (route) => {
    const url = route.request().url();
    if (/^https?:/.test(url)) {
      const host = new URL(url).hostname;
      if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
        network.abortedExternal.push(url);
        await route.abort("blockedbyclient");
        return;
      }
    }
    await route.continue();
  });
}

async function newPage(browser, options = {}) {
  const context = await browser.newContext({
    viewport: options.mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
    isMobile: options.mobile ?? false,
    hasTouch: options.mobile ?? false,
    deviceScaleFactor: options.mobile ? 2 : 1,
    locale: "zh-CN",
  });
  await guardContext(context);
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  page.on("pageerror", (error) => network.pageErrors.push(error.message));
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/comments" && request.method() === "GET") network.commentGets++;
    if (url.pathname === "/api/forum/feed") network.feedGets++;
    if (url.pathname === "/api/comments" || url.pathname === "/api/forum/feed") {
      network.apiEvents.push({ event: "request", check: activeCheck, method: request.method(), url: request.url() });
    }
  });
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.pathname === "/api/comments" || url.pathname === "/api/forum/feed") {
      network.apiEvents.push({ event: "response", check: activeCheck, method: response.request().method(), url: response.url(), status: response.status() });
    }
  });
  page.on("requestfailed", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/comments" || url.pathname === "/api/forum/feed") {
      network.apiEvents.push({ event: "failed", check: activeCheck, method: request.method(), url: request.url(), error: request.failure()?.errorText });
    }
  });
  page.on("console", (message) => {
    if (message.type() === "error") network.consoleErrors.push(message.text().slice(0, 1000));
  });
  return { context, page };
}

async function openForum(page, locale = "cn") {
  const prefix = locale === "tw" ? "/tw/forum" : "/forum";
  await page.goto(`${BASE}${prefix}?tab=latest`, { waitUntil: "domcontentloaded" });
  await card(page, ARTICLE.main).waitFor();
  // DOMContentLoaded only proves that SSR HTML exists. Reply buttons are client
  // components, so clicking before hydration can be a silent no-op.
  await page.waitForLoadState("networkidle");
}

async function login(page) {
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  // Clicking a controlled form before hydration submits a native GET /login?
  // instead of calling signIn(). Wait for the client resources, not a fixed sleep.
  await page.waitForLoadState("networkidle");
  await page.getByPlaceholder("UID、用户名或邮箱").fill(VIEWER.email);
  await page.getByPlaceholder("••••••").fill(VIEWER.password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 30_000 });
}

async function postProblem(request, body) {
  const response = await request.post(`${BASE}/api/comments`, {
    headers: { "Content-Type": "application/json", "Accept": "application/problem+json" },
    data: body,
  });
  const json = await response.json().catch(() => null);
  return { status: response.status(), json, headers: response.headers() };
}

const browser = await chromium.launch({ headless: true });
try {
  if (MODE === "off") {
    const { context, page } = await newPage(browser);
    await check("gate off renders legacy cards with no inline preview", async () => {
      await openForum(page);
      assert.equal(await page.locator("section[data-comment-load-id]").count(), 0);
      assert.equal(await page.getByText("讨论预览", { exact: true }).count(), 0);
      await shot(page, "off-desktop-forum");
    });
    await check("gate off rejects feed-surface writes with 404 problem", async () => {
      const { status, json, headers } = await postProblem(page.request, {
        articleId: ARTICLE.main, parentId: "qa-feed-comment-main-2",
        content: "gate off must not write", images: [], surface: "feed",
      });
      assert.equal(status, 404);
      assert.equal(json.code, "comment.feed_disabled");
      assert.match(headers["content-type"], /application\/problem\+json/);
      assert.ok(json.requestId);
      assert.equal("stack" in json, false);
    });
    await context.close();
  } else {
    const { context, page } = await newPage(browser);

    await check("anonymous main card is expanded, human-first and excludes nested/AI fillers", async () => {
      await openForum(page);
      const section = preview(page, ARTICLE.main);
      await section.waitFor();
      assert.equal(await section.getByRole("button", { name: "收起 ▲" }).getAttribute("aria-expanded"), "true");
      assert.equal(await commentText(page, ARTICLE.main, "第一条真人回复").count(), 1);
      assert.equal(await commentText(page, ARTICLE.main, "第二条真人回复").count(), 1);
      assert.equal(await commentText(page, ARTICLE.main, "有真人回复时").count(), 0, "AI must not fill a human thread");
      assert.equal(await commentText(page, ARTICLE.main, "这条是嵌套回复").count(), 0, "nested rows are not initial top-level previews");
      assert.equal(await commentText(page, ARTICLE.main, "本人待审评论").count(), 0, "anonymous cannot see viewer pending");
      assert.match(await section.innerText(), /查看全部 4 条回复/);
      await shot(page, "on-anonymous-desktop");
      await cardShot(page, ARTICLE.main, "on-anonymous-main-card");
    });

    await check("AI-only, empty, count-only and other-pending fixtures stay distinct", async () => {
      assert.equal(await commentText(page, ARTICLE.ai, "零可见真人顶层回复时").count(), 1);
      assert.match(await preview(page, ARTICLE.ai).innerText(), /AI/);
      assert.equal(await preview(page, ARTICLE.empty).count(), 0, "empty cards have no root composer");
      assert.match(await preview(page, ARTICLE.countOnly).innerText(), /查看全部 1 条回复/);
      assert.match(await preview(page, ARTICLE.countOnly).innerText(), /当前没有可预览的顶层回复/);
      assert.equal(await preview(page, ARTICLE.otherPending).count(), 0, "another user's pending comment is invisible");
    });

    await check("collapse is reversible and defaults back to expanded after reload", async () => {
      const section = preview(page, ARTICLE.main);
      const toggle = section.getByRole("button", { name: "收起 ▲" });
      await toggle.click();
      await section.locator(`#feed-comments-${ARTICLE.main}`).waitFor({ state: "detached" });
      assert.equal(await section.locator(`#feed-comments-${ARTICLE.main}`).count(), 0);
      assert.equal(await section.getByRole("button", { name: "展开 ▼" }).getAttribute("aria-expanded"), "false");
      await section.getByRole("button", { name: "展开 ▼" }).click();
      await section.locator(`#feed-comments-${ARTICLE.main}`).waitFor({ state: "visible" });
      assert.equal(await section.locator(`#feed-comments-${ARTICLE.main}`).count(), 1);
      // reload() preserves scroll position. Reset it so the following initial
      // SSR assertion cannot inherit a lazy-sentinel intersection from earlier checks.
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.reload({ waitUntil: "networkidle" });
      assert.equal(await preview(page, ARTICLE.main).getByRole("button", { name: "收起 ▲" }).getAttribute("aria-expanded"), "true");
    });

    await check("logged-out reply links carry a safe return intent and real parent ID", async () => {
      const link = preview(page, ARTICLE.main).getByRole("link", { name: "登录后回复" }).first();
      const href = await link.getAttribute("href");
      assert.ok(href.startsWith("/login?next="), href);
      const next = new URLSearchParams(href.slice(href.indexOf("?") + 1)).get("next");
      assert.match(next, /^\/forum\?/);
      assert.match(next, /feedReply=qa-feed-comment-main-/);
      assert.ok(!next.includes("://"));
    });

    await check("long preview is code-point capped, three-line clamped and URL-safe", async () => {
      const paragraph = preview(page, ARTICLE.long).locator("p").first();
      const text = await paragraph.innerText();
      assert.ok([...text.replace(/…$/, "")].length <= 1024, "preview exceeds the code-point cap");
      const style = await paragraph.evaluate((el) => {
        const css = getComputedStyle(el);
        return { clamp: css.webkitLineClamp, wrap: css.overflowWrap };
      });
      assert.equal(style.clamp, "3");
      assert.equal(style.wrap, "anywhere");
    });

    await check("initial SSR causes no per-card comment GET or N+1 feed request", async () => {
      assert.equal(network.commentGets, 0, "SSR and hydration must not fetch comments per card");
      // The sentinel prefetches one page inside a 600px rootMargin, so on a tall
      // desktop viewport a single next-page fetch can legitimately fire during
      // the initial load. What must never happen is a request per rendered card.
      assert.ok(network.feedGets <= 1, `initial load made ${network.feedGets} lazy feed requests`);
      const initialFeedRequests = network.apiEvents.filter(
        (event) => event.event === "request" && event.url.includes("/api/forum/feed"),
      );
      for (const event of initialFeedRequests) {
        // A per-card variant would carry an article id instead of a page window.
        assert.match(event.url, /[?&]offset=\d+&limit=\d+/, "initial load may only prefetch a next page");
      }
    });

    await check("lazy feed is batched, private/no-store and carries one load ID", async () => {
      const before = await page.locator("[data-article-id]").count();
      const responsePromise = page.waitForResponse((r) => r.url().includes("/api/forum/feed") && r.status() === 200);
      // Playwright's stability wait can consume the response timeout while
      // images above the sentinel settle. Scroll the real element synchronously.
      await page.getByText(/上滑\/滚动加载更多|到底了，去经典普洱茶吧逛逛/)
        .evaluate((element) => element.scrollIntoView({ block: "center" }));
      const response = await responsePromise;
      const body = await response.json();
      assert.ok(body.articles.length > 0);
      assert.match(response.headers()["cache-control"] ?? "", /private, no-store/);
      assert.match(response.headers().vary ?? "", /Cookie/);
      const loadId = response.headers()["x-comment-load-id"];
      assert.ok(loadId);
      for (const article of body.articles) {
        assert.equal(article.commentLoadId, loadId);
        assert.ok("commentPreview" in article && "visibleReplyCount" in article);
      }
      await page.waitForFunction((n) => document.querySelectorAll("[data-article-id]").length > n, before);
    });

    await check("Traditional Chinese SSR owns preview labels and comment content", async () => {
      await openForum(page, "tw");
      const section = preview(page, ARTICLE.main);
      assert.equal(await section.getAttribute("aria-label"), "討論預覽");
      assert.match(await section.innerText(), /查看全部 4 條回覆/);
      assert.equal(await commentText(page, ARTICLE.main, "第一條真人回覆").count(), 1);
      await shot(page, "on-anonymous-tw");
    });

    await check("anonymous feed-surface POST is a typed 401, not an HTML error", async () => {
      const { status, json } = await postProblem(page.request, {
        articleId: ARTICLE.main, parentId: "qa-feed-comment-main-2",
        content: "anonymous write probe", images: [], surface: "feed",
      });
      assert.equal(status, 401);
      assert.equal(json.code, "comment.unauthenticated");
      assert.equal(json.recovery, "login");
    });
    await context.close();

    // ── Authenticated write matrix ────────────────────────────────────────
    const authed = await newPage(browser);
    const p = authed.page;
    await check("credentials login works against the isolated database", async () => {
      await login(p);
      await openForum(p);
      assert.equal(await commentText(p, ARTICLE.main, "本人待审评论").count(), 1);
      assert.match(await preview(p, ARTICLE.main).innerText(), /审核中，仅你可见/);
      await shot(p, "on-authenticated-desktop");
    });

    await check("reply editor focuses textarea, isolates drafts and Escape restores focus", async () => {
      const section = preview(p, ARTICLE.main);
      const replies = section.getByRole("button", { name: "回复", exact: true });
      await replies.nth(0).click();
      const first = section.locator("textarea");
      await first.fill("第一份草稿，切换父评论后必须还在");
      await replies.nth(1).click();
      const second = section.locator("textarea");
      assert.notEqual(await second.inputValue(), "第一份草稿，切换父评论后必须还在");
      await second.fill("第二份草稿不会覆盖第一份");
      await replies.nth(0).click();
      assert.equal(await section.locator("textarea").inputValue(), "第一份草稿，切换父评论后必须还在");
      await section.locator("textarea").press("Escape");
      await section.locator("textarea").waitFor({ state: "detached" });
      assert.equal(await section.locator("textarea").count(), 0);
      assert.equal(await replies.nth(0).evaluate((el) => el === document.activeElement), true);
    });

    await check("too-short text is blocked client-side with an explicit counter", async () => {
      const section = preview(p, ARTICLE.main);
      await section.getByRole("button", { name: "回复", exact: true }).first().click();
      await section.locator("textarea").fill("短");
      assert.equal(await section.getByRole("button", { name: "发布回复" }).isDisabled(), true);
      assert.match(await section.innerText(), /评论至少 5 个字/);
      await section.getByRole("button", { name: "取消", exact: true }).click();
    });

    await check("Cmd/Ctrl+Enter publishes a real child and increments the count once", async () => {
      const section = preview(p, ARTICLE.main);
      const before = await section.innerText();
      assert.match(before, /查看全部 5 条回复/);
      const content = `真实发布回复 ${Date.now()}：这条应该作为子评论出现。`;
      await section.getByRole("button", { name: "回复", exact: true }).nth(1).click();
      await section.locator("textarea").fill(content);
      await section.locator("textarea").press("Control+Enter");
      await section.getByRole("status").filter({ hasText: "已发布到该评论下" }).waitFor();
      assert.equal(await commentText(p, ARTICLE.main, content).count(), 1);
      assert.match(await section.innerText(), /查看全部 6 条回复/);
      const child = section.locator("article", { hasText: content });
      assert.equal(await child.getByRole("button", { name: "回复", exact: true }).count(), 1,
        "a locally created descendant must itself be replyable");
      await shot(p, "on-published-reply");
      await cardShot(p, ARTICLE.main, "on-published-main-card");
    });

    await check("moderation double can produce a visible own-pending child", async () => {
      const section = preview(p, ARTICLE.main);
      const content = `[qa:pending] 待审回复 ${Date.now()}，只应本人可见。`;
      await section.getByRole("button", { name: "回复", exact: true }).first().click();
      await section.locator("textarea").fill(content);
      await section.getByRole("button", { name: "发布回复" }).click();
      await section.getByRole("status").filter({ hasText: "审核中，仅你可见。" }).waitFor();
      const child = section.locator("article", { hasText: content });
      assert.match(await child.innerText(), /审核中，仅你可见/);
    });

    await check("definite moderation rejection preserves the draft and never auto-retries", async () => {
      const section = preview(p, ARTICLE.main);
      const content = `[qa:reject] 拒绝回复 ${Date.now()}，草稿必须保留。`;
      let posts = 0;
      const listener = (request) => {
        if (request.method() === "POST" && new URL(request.url()).pathname === "/api/comments") posts++;
      };
      p.on("request", listener);
      await section.getByRole("button", { name: "回复", exact: true }).first().click();
      await section.locator("textarea").fill(content);
      const rejectionResponse = p.waitForResponse((response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/comments" &&
        response.status() === 400
      );
      await section.getByRole("button", { name: "发布回复" }).click();
      const rejected = await rejectionResponse;
      const problem = await rejected.json();
      assert.equal(problem.code, "comment.moderation_rejected");
      await section.getByRole("alert").waitFor();
      assert.match(await section.getByRole("alert").innerText(), /内容含违规信息/);
      assert.equal(await section.locator("textarea").inputValue(), content);
      await p.waitForTimeout(700);
      p.off("request", listener);
      assert.equal(posts, 1, "definite failures must not retry automatically");
      await shot(p, "on-definite-rejection");
      await section.getByRole("button", { name: "取消", exact: true }).click();
    });

    await check("delayed double click owns one attempt and sends one POST", async () => {
      const section = preview(p, ARTICLE.main);
      let posts = 0;
      const listener = (request) => {
        if (request.method() === "POST" && new URL(request.url()).pathname === "/api/comments") posts++;
      };
      p.on("request", listener);
      await p.route("**/api/comments", async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        network.intercepted.push("delayed-success");
        await new Promise((resolve) => setTimeout(resolve, 700));
        await route.continue();
      });
      await section.getByRole("button", { name: "回复", exact: true }).first().click();
      await section.locator("textarea").fill(`重复点击探针 ${Date.now()}，只能生成一条。`);
      const submit = section.getByRole("button", { name: "发布回复" });
      await submit.click();
      await submit.click({ force: true }).catch(() => {});
      await section.getByRole("status").filter({ hasText: "已发布到该评论下" }).waitFor();
      p.off("request", listener);
      await p.unroute("**/api/comments");
      assert.equal(posts, 1);
    });

    await check("unknown outcome keeps the draft, offers detail reconciliation and no auto-retry", async () => {
      const section = preview(p, ARTICLE.main);
      const content = `未知结果探针 ${Date.now()}，不能擅自重发。`;
      let posts = 0;
      const listener = (request) => {
        if (request.method() === "POST" && new URL(request.url()).pathname === "/api/comments") posts++;
      };
      p.on("request", listener);
      await p.route("**/api/comments", async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        network.intercepted.push("unknown-outcome");
        const requestId = route.request().headers()["x-request-id"];
        await route.fulfill({
          status: 500,
          contentType: "application/problem+json",
          headers: { "X-Request-ID": requestId },
          body: JSON.stringify({
            type: "urn:puer:comment:outcome_unknown", title: "unknown", detail: "synthetic unknown",
            status: 500, code: "comment.outcome_unknown", requestId,
            retryable: false, recovery: "detail", sideEffects: "unknown", manualRetryLimit: 1,
          }),
        });
      });
      await section.getByRole("button", { name: "回复", exact: true }).first().click();
      await section.locator("textarea").fill(content);
      await section.getByRole("button", { name: "发布回复" }).click();
      await section.getByRole("alert").waitFor();
      assert.match(await section.getByRole("alert").innerText(), /结果未知，可能已发布/);
      assert.equal(await section.locator("textarea").inputValue(), content);
      const detail = section.getByRole("link", { name: /在新标签页打开详情核对/ });
      assert.equal(await detail.getAttribute("target"), "_blank");
      assert.match(await detail.getAttribute("href"), /#comments$/);
      await p.waitForTimeout(700);
      assert.equal(posts, 1);
      await shot(p, "on-unknown-outcome");
      await section.getByRole("button", { name: "确认未发布，允许手动重试" }).click();
      assert.match(await section.innerText(), /已确认未发布，请手动点击发布/);
      await p.unroute("**/api/comments");
      await section.getByRole("button", { name: "发布回复" }).click();
      await section.getByRole("status").filter({ hasText: "已发布到该评论下" }).waitFor();
      p.off("request", listener);
      assert.equal(posts, 2, "only the explicit manual retry may send the second request");
    });

    await check("401 recovery links to a new login tab and preserves the draft", async () => {
      const section = preview(p, ARTICLE.main);
      const content = `登录失效探针 ${Date.now()}，回来后手动发布。`;
      await p.route("**/api/comments", async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        network.intercepted.push("unauthenticated");
        const requestId = route.request().headers()["x-request-id"];
        await route.fulfill({
          status: 401, contentType: "application/problem+json",
          headers: { "X-Request-ID": requestId },
          body: JSON.stringify({
            type: "urn:puer:comment:unauthenticated", title: "unauthenticated", detail: "synthetic 401",
            status: 401, code: "comment.unauthenticated", requestId,
            retryable: false, recovery: "login", sideEffects: "none", manualRetryLimit: 0,
          }),
        });
      });
      await section.getByRole("button", { name: "回复", exact: true }).first().click();
      await section.locator("textarea").fill(content);
      await section.getByRole("button", { name: "发布回复" }).click();
      await section.getByRole("alert").waitFor();
      const loginLink = section.getByRole("link", { name: /在新标签页登录/ });
      assert.equal(await loginLink.getAttribute("target"), "_blank");
      assert.match(await loginLink.getAttribute("href"), /^\/login\?next=/);
      assert.equal(await section.locator("textarea").inputValue(), content);
      await p.unroute("**/api/comments");
      await section.getByRole("button", { name: "取消", exact: true }).click();
    });
    await authed.context.close();

    // ── Mobile / touch / accessibility geometry ───────────────────────────
    const mobile = await newPage(browser, { mobile: true });
    await check("mobile reply and disclosure targets are at least 44 CSS px", async () => {
      await login(mobile.page);
      await openForum(mobile.page);
      const section = preview(mobile.page, ARTICLE.main);
      const targets = [
        section.getByRole("button", { name: "收起 ▲" }),
        section.getByRole("button", { name: "回复", exact: true }).first(),
        section.getByRole("link", { name: /查看全部 \d+ 条回复/ }),
      ];
      for (const target of targets) {
        const box = await target.boundingBox();
        assert.ok(box && box.height >= 44, `touch target height was ${box?.height}`);
      }
      await section.getByRole("button", { name: "回复", exact: true }).first().click();
      const submit = section.getByRole("button", { name: "发布回复" });
      assert.ok((await submit.boundingBox()).height >= 44);
      await shot(mobile.page, "on-mobile-editor");
      await cardShot(mobile.page, ARTICLE.main, "on-mobile-main-card");
    });
    await check("mobile viewport has no horizontal overflow in the inline preview", async () => {
      const overflow = await mobile.page.evaluate(() =>
        document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(overflow <= 1, `horizontal overflow: ${overflow}px`);
    });
    await mobile.context.close();

    await check("browser made no non-loopback request and no uncaught page error", async () => {
      assert.deepEqual(network.abortedExternal, []);
      assert.deepEqual(network.pageErrors, []);
    });
  }
} finally {
  await browser.close();
  fs.writeFileSync(path.join(OUT, `browser-${MODE}-results.json`), JSON.stringify({
    mode: MODE,
    pass: results.filter((r) => r.ok).length,
    fail: results.filter((r) => !r.ok).length,
    results,
    network,
  }, null, 2));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${MODE}: ${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exitCode = 1;

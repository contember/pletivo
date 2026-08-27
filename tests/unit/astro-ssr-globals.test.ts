import { describe, test, expect } from "bun:test";
import {
  AstroCookies,
  createComponent,
  redirectPageHtml,
  renderAstroPage,
  renderComponent,
  type AstroGlobal,
  type AstroResponse,
} from "@pletivo/runtime/astro-shim";
import { createHtml } from "@pletivo/runtime/html-string";

/**
 * Astro's SSR-shaped globals — `response`, `locals`, `cookies`, `redirect`,
 * `clientAddress` — exist so pages written for SSR (typically
 * `export const prerender = false` with `Astro.response.headers.set(...)` for
 * edge caching) render under pletivo instead of throwing. They are honoured
 * for real in dev; a static build discards what a file can't carry.
 */
describe("Astro.response / Astro.locals", () => {
  function makeCapture(name = "test-component") {
    const holder: { captured?: AstroGlobal } = {};
    const factory = createComponent((result, props, slots) => {
      holder.captured = result.createAstro(props, slots);
      return createHtml("");
    }, name);
    return { holder, factory };
  }

  test("response defaults to a 200 with empty headers", async () => {
    const { holder, factory } = makeCapture();
    await renderAstroPage(factory, {}, {});
    expect(holder.captured?.response.status).toBe(200);
    expect(holder.captured?.response.statusText).toBe("OK");
    expect(holder.captured?.response.headers).toBeInstanceOf(Headers);
  });

  test("locals defaults to an empty object", async () => {
    const { holder, factory } = makeCapture();
    await renderAstroPage(factory, {}, {});
    expect(holder.captured?.locals).toEqual({});
  });

  test("headers written by the page land on the pageContext response", async () => {
    const response: AstroResponse = {
      status: 200,
      statusText: "OK",
      headers: new Headers(),
    };
    const page = createComponent((result, props, slots) => {
      const Astro = result.createAstro(props, slots);
      Astro.response.headers.set("cache-control", "s-maxage=60");
      Astro.response.status = 201;
      return createHtml("ok");
    }, "page");

    expect(await renderAstroPage(page, {}, { response })).toBe("ok");
    expect(response.headers.get("cache-control")).toBe("s-maxage=60");
    expect(response.status).toBe(201);
  });

  test("page and child components share one response object", async () => {
    const response: AstroResponse = {
      status: 200,
      statusText: "OK",
      headers: new Headers(),
    };
    const child = createComponent((result, props, slots) => {
      const Astro = result.createAstro(props, slots);
      Astro.response.headers.set("x-from-child", "1");
      return createHtml("");
    }, "child");
    const page = createComponent(async (result, props, slots) => {
      const Astro = result.createAstro(props, slots);
      Astro.response.headers.set("x-from-page", "1");
      await renderComponent(result, "Child", child, {}, {});
      return createHtml("");
    }, "page");

    await renderAstroPage(page, {}, { response });
    expect(response.headers.get("x-from-page")).toBe("1");
    expect(response.headers.get("x-from-child")).toBe("1");
  });
});

describe("Astro.cookies", () => {
  test("reads cookies off the request", () => {
    const cookies = new AstroCookies(
      new Request("http://x/", { headers: { cookie: "sid=abc; n=42; flag=true" } }),
    );
    expect(cookies.has("sid")).toBe(true);
    expect(cookies.get("sid")?.value).toBe("abc");
    expect(cookies.get("n")?.number()).toBe(42);
    expect(cookies.get("flag")?.boolean()).toBe(true);
    expect(cookies.get("nope")).toBeUndefined();
    expect(cookies.has("nope")).toBe(false);
  });

  test("url-decodes request values and parses JSON", () => {
    const cookies = new AstroCookies(
      new Request("http://x/", {
        headers: { cookie: `u=${encodeURIComponent('{"a":1}')}` },
      }),
    );
    expect(cookies.get("u")?.json()).toEqual({ a: 1 });
  });

  test("empty when there is no request (static build)", () => {
    const cookies = new AstroCookies();
    expect(cookies.has("sid")).toBe(false);
    expect([...cookies.headers()]).toEqual([]);
  });

  test("writes are readable back and serialized as Set-Cookie", () => {
    const cookies = new AstroCookies();
    cookies.set("sid", "a b", {
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: 60,
    });
    expect(cookies.get("sid")?.value).toBe("a b");
    expect(cookies.has("sid")).toBe(true);
    const [header] = [...cookies.headers()];
    expect(header).toBe("sid=a%20b; Max-Age=60; Path=/; HttpOnly; Secure; SameSite=Lax");
  });

  test("object values are JSON-stringified", () => {
    const cookies = new AstroCookies();
    cookies.set("u", { a: 1 });
    expect(cookies.get("u")?.json()).toEqual({ a: 1 });
  });

  test("delete masks a request cookie and emits an expiry", () => {
    const cookies = new AstroCookies(
      new Request("http://x/", { headers: { cookie: "sid=abc" } }),
    );
    cookies.delete("sid", { path: "/" });
    expect(cookies.get("sid")).toBeUndefined();
    expect(cookies.has("sid")).toBe(false);
    const [header] = [...cookies.headers()];
    expect(header).toContain("Max-Age=0");
    expect(header).toContain("Expires=Thu, 01 Jan 1970");
  });

  test("merge copies another jar's writes", () => {
    const a = new AstroCookies();
    const b = new AstroCookies();
    b.set("sid", "abc");
    a.merge(b);
    expect(a.get("sid")?.value).toBe("abc");
    expect([...a.headers()]).toEqual(["sid=abc"]);
  });

  test("page and child components share one jar", async () => {
    const cookies = new AstroCookies();
    const child = createComponent((result, props, slots) => {
      result.createAstro(props, slots).cookies.set("from-child", "1");
      return createHtml("");
    }, "child");
    const page = createComponent(async (result, props, slots) => {
      const Astro = result.createAstro(props, slots);
      Astro.cookies.set("from-page", "1");
      await renderComponent(result, "Child", child, {}, {});
      return createHtml("");
    }, "page");

    await renderAstroPage(page, {}, { cookies });
    expect([...cookies.headers()]).toEqual(["from-page=1", "from-child=1"]);
  });

  test("defaults to a jar seeded from pageContext.request", async () => {
    const { holder, factory } = (() => {
      const holder: { captured?: AstroGlobal } = {};
      const factory = createComponent((result, props, slots) => {
        holder.captured = result.createAstro(props, slots);
        return createHtml("");
      }, "page");
      return { holder, factory };
    })();
    await renderAstroPage(factory, {}, {
      request: new Request("http://x/", { headers: { cookie: "sid=abc" } }),
    });
    expect(holder.captured?.cookies.get("sid")?.value).toBe("abc");
  });
});

describe("Astro.redirect", () => {
  test("returns a 302 Response carrying response headers and cookies", async () => {
    let redirect: Response | undefined;
    const page = createComponent((result, props, slots) => {
      const Astro = result.createAstro(props, slots);
      Astro.response.headers.set("x-kept", "1");
      Astro.cookies.set("sid", "abc", { path: "/" });
      redirect = Astro.redirect("/kontakty");
      return createHtml("");
    }, "page");

    await renderAstroPage(page, {}, {});
    expect(redirect?.status).toBe(302);
    expect(redirect?.headers.get("location")).toBe("/kontakty");
    expect(redirect?.headers.get("x-kept")).toBe("1");
    expect(redirect?.headers.get("set-cookie")).toBe("sid=abc; Path=/");
  });

  test("honours an explicit status", async () => {
    let redirect: Response | undefined;
    const page = createComponent((result, props, slots) => {
      redirect = result.createAstro(props, slots).redirect("/x", 301);
      return createHtml("");
    }, "page");
    await renderAstroPage(page, {}, {});
    expect(redirect?.status).toBe(301);
  });

  test("a returned redirect renders as a meta-refresh page (static output)", async () => {
    const page = createComponent((result, props, slots) => {
      return result.createAstro(props, slots).redirect("/kontakty") as never;
    }, "page");

    const html = await renderAstroPage(page, {}, {});
    expect(html).toContain('<meta http-equiv="refresh" content="0;url=/kontakty">');
    expect(html).toContain('<meta name="robots" content="noindex">');
    expect(html).toContain('<link rel="canonical" href="/kontakty">');
  });

  test("redirectPageHtml escapes the location and skips non-redirects", () => {
    const html = redirectPageHtml(
      new Response(null, { status: 302, headers: { location: '/a"b&c' } }),
    );
    expect(html).toContain('content="0;url=/a&quot;b&amp;c"');
    expect(html).not.toContain('"b&c"');
    expect(redirectPageHtml(new Response("body", { status: 200 }))).toBe("");
  });
});

describe("Astro.clientAddress", () => {
  function capture() {
    const holder: { captured?: AstroGlobal } = {};
    const factory = createComponent((result, props, slots) => {
      holder.captured = result.createAstro(props, slots);
      return createHtml("");
    }, "page");
    return { holder, factory };
  }

  test("resolves when the host supplied one (dev)", async () => {
    const { holder, factory } = capture();
    await renderAstroPage(factory, {}, { clientAddress: "203.0.113.7" });
    expect(holder.captured?.clientAddress).toBe("203.0.113.7");
  });

  test("throws when read without one, as Astro does in static output", async () => {
    const { holder, factory } = capture();
    await renderAstroPage(factory, {}, {});
    expect(() => holder.captured?.clientAddress).toThrow(
      "`Astro.clientAddress` is not available in a static build",
    );
  });

  test("is a getter — a page that never reads it still renders", async () => {
    const page = createComponent(() => createHtml("ok"), "page");
    expect(await renderAstroPage(page, {}, {})).toBe("ok");
  });
});

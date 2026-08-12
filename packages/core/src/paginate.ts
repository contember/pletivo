/**
 * `paginate()` helper passed to `getStaticPaths({ paginate })` in Astro
 * routes. Slices an array into pages and emits a StaticPath per page,
 * each carrying a `page` prop with data + metadata + navigation URLs.
 *
 * Mirrors Astro's paginate semantics: the route must declare a `page`
 * param, either as `[page]` (first page URL includes `1`) or `[...page]`
 * (first page URL omits the segment entirely). See
 * `astro/src/core/render/paginate.ts` for the reference implementation.
 */

import type { Route, StaticPath, RouteParams } from "./router";

export interface PaginatePageUrls {
  current: string;
  next?: string;
  prev?: string;
  first?: string;
  last?: string;
}

export interface PaginatePage<T = unknown> {
  data: T[];
  start: number;
  end: number;
  size: number;
  total: number;
  currentPage: number;
  lastPage: number;
  url: PaginatePageUrls;
}

export interface PaginateOptions {
  pageSize?: number;
  params?: Record<string, string | undefined>;
  props?: Record<string, unknown>;
}

export type PaginateFunction = <T>(
  data: readonly T[],
  options?: PaginateOptions,
) => StaticPath[];

const PAGE_PARAM = "page";

/**
 * Build a paginate function bound to a specific route + base. Called
 * once per dynamic route before evaluating its `getStaticPaths`.
 */
export function createPaginate(route: Route, base: string): PaginateFunction {
  // The param-kind check is deferred to the first call — getStaticPaths
  // receives `{ paginate }` on every dynamic route regardless of whether
  // that specific route paginates, so eager validation would break
  // non-paginated routes like `[slug].astro`.
  return function paginate<T>(
    data: readonly T[],
    options: PaginateOptions = {},
  ): StaticPath[] {
    const pageSeg = route.segments.find(
      (s) => (s.type === "param" || s.type === "rest") && s.value === PAGE_PARAM,
    );
    if (!pageSeg) {
      throw new Error(
        `paginate() used in "${route.file}" but the route has no "[page]" or "[...page]" parameter.`,
      );
    }
    const includesFirstPageNumber = pageSeg.type === "param";
    const pageSize = options.pageSize ?? 10;
    const additionalParams = options.params ?? {};
    const additionalProps = options.props ?? {};
    const total = data.length;
    const lastPage = Math.max(1, Math.ceil(total / pageSize));

    const result: StaticPath[] = [];
    for (let i = 0; i < lastPage; i++) {
      const pageNum = i + 1;
      const start = pageSize === Infinity ? 0 : (pageNum - 1) * pageSize;
      const end = Math.min(start + pageSize, total);

      const baseParams: Record<string, string | undefined> = { ...additionalParams };
      const pageParamValue =
        includesFirstPageNumber || pageNum > 1 ? String(pageNum) : undefined;
      baseParams[PAGE_PARAM] = pageParamValue;

      const current = buildUrl(route, baseParams, base);
      const next =
        pageNum === lastPage
          ? undefined
          : buildUrl(
              route,
              { ...baseParams, [PAGE_PARAM]: String(pageNum + 1) },
              base,
            );
      const prev =
        pageNum === 1
          ? undefined
          : buildUrl(
              route,
              {
                ...baseParams,
                [PAGE_PARAM]:
                  !includesFirstPageNumber && pageNum - 1 === 1
                    ? undefined
                    : String(pageNum - 1),
              },
              base,
            );
      const first =
        pageNum === 1
          ? undefined
          : buildUrl(
              route,
              {
                ...baseParams,
                [PAGE_PARAM]: includesFirstPageNumber ? "1" : undefined,
              },
              base,
            );
      const last =
        pageNum === lastPage
          ? undefined
          : buildUrl(
              route,
              { ...baseParams, [PAGE_PARAM]: String(lastPage) },
              base,
            );

      const page: PaginatePage<T> = {
        data: data.slice(start, end) as T[],
        start,
        end: end - 1,
        size: pageSize,
        total,
        currentPage: pageNum,
        lastPage,
        url: { current, next, prev, first, last },
      };

      result.push({
        params: baseParams as RouteParams,
        props: { ...additionalProps, page },
      });
    }
    return result;
  };
}

/**
 * Build an absolute URL path (with trailing slash) for the given route
 * and params. Omits `undefined` rest/param segments so `[...page]` with
 * `page: undefined` yields the unprefixed first-page URL.
 */
function buildUrl(
  route: Route,
  params: Record<string, string | undefined>,
  base: string,
): string {
  const parts: string[] = [];
  for (const seg of route.segments) {
    if (seg.type === "static") {
      parts.push(seg.value);
    } else if (seg.type === "param") {
      const v = params[seg.value];
      if (v !== undefined && v !== "") parts.push(String(v));
    } else if (seg.type === "rest") {
      const v = params[seg.value];
      if (v !== undefined && v !== "") parts.push(...String(v).split("/"));
    }
  }
  const cleanedBase = base.replace(/^\/+|\/+$/g, "");
  const joined = [cleanedBase, ...parts].filter(Boolean).join("/");
  return "/" + (joined ? joined + "/" : "");
}

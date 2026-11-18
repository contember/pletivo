/** What the host and the MDX isolate exchange. The project's plugins are in the isolate's program. */

export interface MdxIsolateRequest {
  /** Project path; `pagesDir` in the program is in the same terms. */
  file: string;
  source: string;
}

export interface MdxIsolateCompiled {
  status: "compiled";
  /** The module the render isolate loads. */
  code: string;
  /** Each `client:component-path` the island metadata wrote, as the import spells it. */
  componentPaths: string[];
}

export interface MdxIsolateFailed {
  status: "error";
  message: string;
  stack?: string;
}

export type MdxIsolateReply = MdxIsolateCompiled | MdxIsolateFailed;

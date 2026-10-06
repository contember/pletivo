declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./entry.ts");
    durableNamespaces: "QualificationDO";
  }
}

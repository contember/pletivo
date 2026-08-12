/** Image metadata needed by compilation and generated asset URLs. */
export interface ProjectAssetInfo {
  width: number;
  height: number;
  format: string;
  hash: string;
}

/** One output asset resolved without scanning every project asset. */
export interface ServedProjectAsset {
  path: string;
  contentType: string;
  source: string;
  /** Null lets an outer host serve metadata-backed bytes from its own store. */
  bytes: Uint8Array | null;
}

/** Demand-driven project asset access owned by the outer host. */
export interface ProjectAssetsView {
  info(source: string): ProjectAssetInfo | null | Promise<ProjectAssetInfo | null>;
  resolveOutput(pathname: string): ServedProjectAsset | null | Promise<ServedProjectAsset | null>;
}

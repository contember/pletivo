// Imported by a hoisted <script> in src/pages/index.astro.
// Pletivo must bundle the importer with this file's directory as the
// resolution root, otherwise the browser tries to fetch
// `/scripts/external.js` and 404s.
import "../../vendor/hoisted-transitive.css";
import "../styles/local.css";

export const EXTERNAL_MARKER = "external-marker-from-disk";

document.documentElement.dataset.externalLoaded = EXTERNAL_MARKER;

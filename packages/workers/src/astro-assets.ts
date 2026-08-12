/**
 * `astro:assets`, for a host that cannot open a file or run sharp.
 *
 * The Bun host answers this specifier with a virtual module that re-exports
 * `getImage()` and Astro's own `Image.astro` / `Picture.astro` out of `node_modules`
 * (`astro-plugin.ts`). An isolate has no `node_modules`, so the same three modules are
 * *sources* the host worker compiles like project files — which is what `.astro` has
 * to be here anyway: the compiler runs in the host worker, not in the isolate.
 *
 * They are written out rather than vendored off disk on purpose. Astro's `Image.astro`
 * pulls in `astro/dist/core/errors/index.js` for one `AstroError`, and that graph is
 * most of Astro; the two components below carry the same template text — copied
 * verbatim, because the rendered attribute order is the thing being compared — and
 * throw a plain `Error` instead. What they call is shared, not re-implemented:
 * `getImage()` is `@pletivo/core/image`, the same function the Bun host calls.
 *
 * ## The one deliberate divergence
 *
 * `setImageService("cloudflare")`. The Bun host defaults to sharp, which resizes and
 * re-encodes and writes `_astro/<name>.<hash>.webp`. **No isolate can do that.** A
 * host that emitted sharp's URL anyway would name a file nothing ever wrote — a 404
 * where an image should be. The Cloudflare service emits `/cdn-cgi/image/<options>/`
 * in front of the *original* file, so the URL always resolves to bytes that exist and
 * the transform is named rather than faked. It is also the only service that produces
 * a `srcset`, which sharp's silently drops (`docs/todos/017 §3`).
 *
 * A Bun build run with `PLETIVO_IMAGE_SERVICE=cloudflare` therefore emits byte-identical
 * HTML, which is how `test/fixture-images` is compared.
 */

import { IMAGE_MODULE_NAME } from "./generated/runtime-modules.ts";

/** The specifier a project writes. Astro's own, so nothing has to be rewritten. */
export const ASSETS_SPECIFIER = "astro:assets";

/**
 * The specifier the generated sources use for the image runtime.
 *
 * Not `astro:assets` itself: that would make `index.ts` import itself, and the
 * components would resolve through the barrel for no reason. `compileProject` answers
 * it with the generated module, the same way it answers the content API.
 */
export const IMAGE_RUNTIME_SPECIFIER = "pletivo:image";

/**
 * Where the generated sources sit in the file map.
 *
 * Under `node_modules/` because that is what they are — a package the project does not
 * have — and because a project file can then never collide with one.
 */
export const ASSETS_DIR = "node_modules/.pletivo/astro-assets";

/**
 * Every import and re-export comes first, and the two calls last.
 *
 * Not style: `rewriteImports` only rewrites the statements a module *opens* with, so
 * a specifier below the first ordinary statement is left pointing at `pletivo:image`
 * and the Loader refuses the bundle.
 */
const INDEX = `import { setImageMode, setImageService } from "${IMAGE_RUNTIME_SPECIFIER}";
export { getImage, imageConfig } from "${IMAGE_RUNTIME_SPECIFIER}";
export { default as Image } from "./Image.astro";
export { default as Picture } from "./Picture.astro";

// A render isolate cannot resize or re-encode anything, so it names the transform in
// the URL and lets the origin perform it. See the note in astro-assets.ts.
setImageMode("build");
setImageService("cloudflare");
`;

/**
 * `astro/components/Image.astro`, with the same template and without Astro's error
 * machinery. The `import.meta.env.DEV` branch that adds `data-image-component` is
 * dropped: this host only ever builds.
 */
const IMAGE = `---
import { getImage } from "${IMAGE_RUNTIME_SPECIFIER}";

const props = Astro.props;

if (props.alt === undefined || props.alt === null) {
	throw new Error("Image requires an \`alt\` attribute, which may be an empty string for a decorative image.");
}

// As a convenience, allow width and height to be string with a number in them, to match HTML's native \`img\`.
if (typeof props.width === 'string') {
	props.width = parseInt(props.width);
}

if (typeof props.height === 'string') {
	props.height = parseInt(props.height);
}

const image = await getImage(props);

const additionalAttributes = {};
if (image.srcSet.values.length > 0) {
	additionalAttributes.srcset = image.srcSet.attribute;
}
---

<img src={image.src} {...additionalAttributes} {...image.attributes} />
`;

/**
 * `astro/components/Picture.astro`, same treatment.
 *
 * `isESMImportedImage` and `resolveSrc` are Astro's, copied because they are four
 * lines each; `lookup` is the `mrmime` shim the Bun host installs, copied for the
 * same reason and because *that* is what the comparison is against — real mrmime
 * answers \`lookup("jpg")\` and the shim does not, and the fallback below covers it
 * identically on both.
 */
const PICTURE = `---
import { getImage } from "${IMAGE_RUNTIME_SPECIFIER}";
import * as mime from "./mime.js";

const defaultFormats = ['webp'];
const defaultFallbackFormat = 'png';

// Certain formats don't want PNG fallbacks:
// - GIF will typically want to stay as a gif, either for animation or for the lower amount of colors
// - SVGs can't be converted to raster formats in most cases
// - JPEGs compress photographs and high-noise images better than PNG in most cases
// For those, we'll use the original format as the fallback instead.
const specialFormatsFallback = ['gif', 'svg', 'jpg', 'jpeg'];

const isESMImportedImage = (src) => typeof src === 'object';
const resolveSrc = async (src) =>
	typeof src === 'object' && src !== null && 'then' in src ? ((await src).default ?? (await src)) : src;

const { formats = defaultFormats, pictureAttributes = {}, fallbackFormat, ...props } = Astro.props;

if (props.alt === undefined || props.alt === null) {
	throw new Error("Picture requires an \`alt\` attribute, which may be an empty string for a decorative image.");
}

// Picture attribute inherit scoped styles from class and attributes
const scopedStyleClass = props.class?.match(/\\bastro-\\w{8}\\b/)?.[0];
if (scopedStyleClass) {
	if (pictureAttributes.class) {
		pictureAttributes.class = \`\${pictureAttributes.class} \${scopedStyleClass}\`;
	} else {
		pictureAttributes.class = scopedStyleClass;
	}
}
for (const key in props) {
	if (key.startsWith('data-astro-cid')) {
		pictureAttributes[key] = props[key];
	}
}

const originalSrc = await resolveSrc(props.src);
const optimizedImages = await Promise.all(
	formats.map(
		async (format) =>
			await getImage({
				...props,
				src: originalSrc,
				format: format,
				widths: props.widths,
				densities: props.densities,
			}),
	),
);

let resultFallbackFormat = fallbackFormat ?? defaultFallbackFormat;
if (
	!fallbackFormat &&
	isESMImportedImage(originalSrc) &&
	specialFormatsFallback.includes(originalSrc.format)
) {
	resultFallbackFormat = originalSrc.format;
}

const fallbackImage = await getImage({
	...props,
	format: resultFallbackFormat,
	widths: props.widths,
	densities: props.densities,
});

const imgAdditionalAttributes = {};
const sourceAdditionalAttributes = {};

// Propagate the \`sizes\` attribute to the \`source\` elements
if (props.sizes) {
	sourceAdditionalAttributes.sizes = props.sizes;
}

if (fallbackImage.srcSet.values.length > 0) {
	imgAdditionalAttributes.srcset = fallbackImage.srcSet.attribute;
}
---

<picture {...pictureAttributes}>
	{
		Object.entries(optimizedImages).map(([_, image]) => {
			const srcsetAttribute =
				props.densities || (!props.densities && !props.widths)
					? \`\${image.src}\${image.srcSet.values.length > 0 ? ', ' + image.srcSet.attribute : ''}\`
					: image.srcSet.attribute;
			return (
				<source
					srcset={srcsetAttribute}
					type={mime.lookup(image.options.format ?? image.src) ?? \`image/\${image.options.format}\`}
					{...sourceAdditionalAttributes}
				/>
			);
		})
	}
	<img src={fallbackImage.src} {...imgAdditionalAttributes} {...fallbackImage.attributes} />
</picture>
`;

/** The `mrmime` shim, byte for byte what `astro-plugin.ts` gives the Bun host. */
const MIME = `const types = {
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.tiff': 'image/tiff',
  '.webp': 'image/webp',
};

export function lookup(path) {
  if (!path) return undefined;
  const dot = path.lastIndexOf('.');
  if (dot === -1) return undefined;
  return types[path.slice(dot).toLowerCase()];
}
`;

/**
 * The sources `astro:assets` becomes, keyed by the path they are compiled at.
 *
 * Added to the file map only for a project that reaches for the specifier — three
 * modules is little, but a bundle that carried them anyway would be a different
 * content address than the same project prepared without them.
 */
export const ASSETS_SOURCES: Readonly<Record<string, string>> = {
  [`${ASSETS_DIR}/index.ts`]: INDEX,
  [`${ASSETS_DIR}/Image.astro`]: IMAGE,
  [`${ASSETS_DIR}/Picture.astro`]: PICTURE,
  [`${ASSETS_DIR}/mime.js`]: MIME,
};

/** What the isolate's image runtime is called in the bundle. */
export { IMAGE_MODULE_NAME };

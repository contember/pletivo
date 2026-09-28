/**
 * `astro:assets` as sources the host compiles like project files. The components copy
 * Astro's template text verbatim (attribute order is compared) but throw a plain `Error`,
 * because Astro's `AstroError` pulls in most of Astro.
 *
 * Deliberate divergence: the image service is `cloudflare`, not sharp. An isolate cannot
 * re-encode, so it emits `/cdn-cgi/image/<options>/` over the original file instead of
 * naming an output nothing wrote. `PLETIVO_IMAGE_SERVICE=cloudflare` matches it on Bun.
 */

import { IMAGE_MODULE_NAME } from "./generated/runtime-modules.ts";

/** The specifier a project writes. Astro's own, so nothing has to be rewritten. */
export const ASSETS_SPECIFIER = "astro:assets";

/**
 * The specifier the generated sources use for the image runtime. Not `astro:assets`
 * itself, which would make `index.ts` import itself.
 */
export const IMAGE_RUNTIME_SPECIFIER = "pletivo:image";

/** Where the generated sources sit in the file map; under `node_modules/` so no project file collides. */
export const ASSETS_DIR = "node_modules/.pletivo/astro-assets";

/**
 * Imports and re-exports must come before the two calls: `rewriteImports` only rewrites
 * the statements a module opens with.
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
 * `astro/components/Picture.astro`, same treatment. `lookup` is the Bun host's `mrmime`
 * shim rather than real mrmime, because the shim is what the comparison runs against.
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
 * The sources `astro:assets` becomes, keyed by the path they are compiled at. Added only
 * for a project that imports the specifier, so other bundles keep their content address.
 */
export const ASSETS_SOURCES: Readonly<Record<string, string>> = {
  [`${ASSETS_DIR}/index.ts`]: INDEX,
  [`${ASSETS_DIR}/Image.astro`]: IMAGE,
  [`${ASSETS_DIR}/Picture.astro`]: PICTURE,
  [`${ASSETS_DIR}/mime.js`]: MIME,
};

/** What the isolate's image runtime is called in the bundle. */
export { IMAGE_MODULE_NAME };

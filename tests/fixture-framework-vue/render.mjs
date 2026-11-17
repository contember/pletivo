// Renders a component as @astrojs/vue 5.1.4's server.js does: slots are static HTML in <astro-slot>.
import { createSSRApp, defineComponent, h } from "vue";
import { renderToString } from "vue/server-renderer";
import Counter from "./src/components/Counter.vue";
import VueCounter from "./src/components/VueCounter.vue";
import ScopedLabel from "./src/components/ScopedLabel.vue";
import ThemedLabel from "./src/components/ThemedLabel.vue";
import TypedExpression from "./src/components/TypedExpression.vue";
import AssetImage from "./src/components/AssetImage.vue";

export const components = { Counter, VueCounter, ScopedLabel, ThemedLabel, TypedExpression, AssetImage };

const StaticHtml = defineComponent({
	props: { value: String, name: String, hydrate: { type: Boolean, default: true } },
	setup({ name, value, hydrate }) {
		if (!value) return () => null;
		const tagName = hydrate ? "astro-slot" : "astro-static-slot";
		return () => h(tagName, { name, innerHTML: value });
	},
});

export async function render(Component, props, slotted) {
	const slots = {};
	for (const [key, value] of Object.entries(slotted)) {
		slots[key] = () => h(StaticHtml, { value, name: key === "default" ? undefined : key, hydrate: true });
	}
	const app = createSSRApp({ render: () => h(Component, props, slots) });
	app.config.idPrefix = "s0";
	return renderToString(app);
}

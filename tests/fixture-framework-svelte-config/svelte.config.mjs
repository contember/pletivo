export default {
	preprocess: {
		name: "fail-on-marker",
		markup({ content }) {
			if (content.includes("<!-- fail -->")) throw new Error("preprocessor refused the marker");
		},
	},
	compilerOptions: {
		cssHash: () => "custom-hash",
		dev: true,
		format: "esm",
		generate: "client",
		hmr: true,
	},
};

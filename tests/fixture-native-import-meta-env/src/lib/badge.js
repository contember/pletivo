// JSX in a plain `.js` file, which Bun's own loader accepts.
export const Badge = () => <span id="badge">{import.meta.env.MODE}</span>;

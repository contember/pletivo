/**
 * Interactive counter island.
 * Default export renders SSR HTML.
 * mount() runs on the client for hydration.
 */

// Server-side render (used by JSX runtime for SSR)
export default function Counter(props: { initial: number }) {
  return <button>Count: {props.initial}</button>;
}

// Client-side hydration
export function mount(el: HTMLElement, props: { initial: number }) {
  let count = props.initial;
  const btn = el.querySelector("button")!;
  btn.addEventListener("click", () => {
    count++;
    btn.textContent = `Count: ${count}`;
  });
}

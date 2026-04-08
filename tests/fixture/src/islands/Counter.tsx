export default function Counter(props: { initial: number }) {
  return <button>Count: {props.initial}</button>;
}

export function mount(el: HTMLElement, props: { initial: number }) {
  let count = props.initial;
  const btn = el.querySelector("button")!;
  btn.addEventListener("click", () => {
    count++;
    btn.textContent = `Count: ${count}`;
  });
}

/** @jsxImportSource preact */
export default function Counter(props: { count: number }) {
  return (
    <div class="counter">
      <pre>{props.count}</pre>
    </div>
  );
}

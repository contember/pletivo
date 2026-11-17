<script>
  import { createCount } from "./count.svelte.js";
  let { start, children } = $props();
  const count = createCount(start);
</script>

<div class="svelte-counter">
  <button onclick={count.increment}>svelte {count.value}</button>
  <div class="message">{@render children?.()}</div>
</div>

<style>
  @import "../../styles/imported.css";
  .svelte-counter { color: rgb(10, 11, 12); background: url(./bg.svg); }
</style>

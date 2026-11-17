<template>
  <div class="parent">{{ label }} <Child /></div>
</template>

<script setup>
import Child from "./Child.vue";
import { label } from "./label.ts";
</script>

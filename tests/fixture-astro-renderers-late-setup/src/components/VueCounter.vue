<template>
  <div class="vue-counter">
    <button @click="count++">vue {{ count }}</button>
  </div>
</template>

<script setup>
import { ref } from "vue";
const props = defineProps({ start: Number });
const count = ref(props.start);
</script>

<style scoped>
.vue-counter { color: rgb(13, 14, 15); }
</style>

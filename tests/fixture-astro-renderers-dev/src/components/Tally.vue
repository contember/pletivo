<template>
  <button @click="count++">tally {{ count }}</button>
</template>

<script setup>
import { ref } from "vue";
const props = defineProps({ start: Number });
const count = ref(props.start);
</script>

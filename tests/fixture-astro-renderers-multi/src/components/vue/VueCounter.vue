<template>
  <button @click="count++">vue {{ count }}</button>
</template>

<script setup>
import { ref } from "vue";
const count = ref(0);
</script>

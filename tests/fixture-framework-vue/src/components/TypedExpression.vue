<script setup lang="ts">
defineProps<{ value: unknown }>();
</script>

<template>
	<p>{{ (value as number).toFixed(1) }}</p>
</template>

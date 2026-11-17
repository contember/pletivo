<script setup lang="ts">
defineProps<{ color: string }>();
</script>

<template>
	<p class="themed">{{ color }}</p>
</template>

<style scoped>
.themed {
	color: v-bind(color);
}
</style>

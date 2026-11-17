<script setup lang="ts">
defineProps<{ label: string }>();
</script>

<template>
	<p class="label"><span>{{ label }}</span><slot /></p>
</template>

<style scoped>
.label {
	font-weight: bold;
}

.label span {
	color: rebeccapurple;
}
</style>

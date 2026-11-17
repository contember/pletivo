/// <reference types="svelte" />

interface Count {
  readonly value: number;
  increment(): void;
}

export function createCount(start: number): Count {
  let count = $state<number>(start);
  return {
    get value(): number {
      return count;
    },
    increment(): void {
      count += 1;
    },
  };
}

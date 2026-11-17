export function createCount(start) {
  let count = $state(start);
  return {
    get value() {
      return count;
    },
    increment() {
      count += 1;
    },
  };
}

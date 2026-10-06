declare module "parent-a" {
  export const fromA: string;
}

declare module "parent-b" {
  export const fromB: string;
}

declare module "virtual:a" {
  const value: string;
  export default value;
}

declare module "virtual:a/b" {
  const value: string;
  export default value;
}

declare module "virtual:a?b" {
  const value: string;
  export default value;
}

declare module "virtual:absolute" {
  const value: string;
  export default value;
}

declare module "worker-conditions" {
  const value: string;
  export default value;
}

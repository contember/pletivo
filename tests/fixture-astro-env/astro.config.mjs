export default {
  env: {
    schema: {
      GREETING: { type: "string", context: "client", access: "public", optional: true, default: "hello" },
      RETRIES: { type: "number", context: "server", access: "public", default: 3 },
    },
  },
};

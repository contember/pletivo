export default {
  redirects: {
    "/old": "/",
    "/moved": { status: 302, destination: "/about" },
    "/elsewhere": { status: 302, destination: "https://example.com/x" },
    "/replaced": "/about",
    "/blog/[slug]": "/",
  },
};

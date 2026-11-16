/** A script page with a default export still renders HTML, even next to a GET(). */
export default function Plain() {
  return { __html: "<!DOCTYPE html><html><head><title>Plain</title></head><body><h1>Plain page</h1></body></html>" };
}

export function GET() {
  return new Response("not used");
}

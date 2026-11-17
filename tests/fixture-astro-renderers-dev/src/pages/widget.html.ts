import { experimental_AstroContainer } from "astro/container";
import Widget from "../components/Widget.astro";

// Its islands render outside any page, through the container API.
export async function GET() {
  const container = await experimental_AstroContainer.create();
  return new Response(await container.renderToString(Widget));
}

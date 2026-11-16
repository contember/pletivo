import { experimental_AstroContainer } from "astro/container";
import Widget from "../components/Widget.astro";

export async function GET() {
  const container = await experimental_AstroContainer.create();
  return new Response(await container.renderToString(Widget));
}

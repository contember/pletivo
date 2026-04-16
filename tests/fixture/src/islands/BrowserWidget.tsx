/**
 * Test island that accesses browser APIs — would crash during SSR.
 * Used to verify client:only skips SSR.
 */
export default function BrowserWidget(props: { label: string }) {
  // In a real scenario this would use window/document/canvas
  const width = window.innerWidth;
  return <div class="widget">{props.label}: {width}px</div>;
}

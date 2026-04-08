export const hmrClientScript = `
<script>
(function() {
  const ws = new WebSocket("ws://" + location.host + "/__hmr");
  ws.onmessage = function(e) {
    if (e.data === "reload") {
      location.reload();
    }
  };
  ws.onclose = function() {
    console.log("[pavouk] Connection lost. Reconnecting...");
    setTimeout(function() { location.reload(); }, 1000);
  };
})();
</script>`;

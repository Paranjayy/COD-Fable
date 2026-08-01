const params = new URLSearchParams(location.search);

// Keep first paint independent from Three.js. The entire game graph is a
// dynamic import, so a visitor can inspect/select a session without creating a
// renderer, shader, procedural texture, world, or AI agent.
if (params.has('play')) {
  import('./main.js');
} else {
  import('./landing.js');
}

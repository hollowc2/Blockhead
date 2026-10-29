/** Injected into the pinned viewer bundle. Only enum lifecycle events cross the frame boundary. */
export function installViewerLifecycle(socket, win) {
  const token = new URLSearchParams(win.location.search).get('visit');
  let online = false, chunk = false, version = false, ready = false;
  const send = state => {
    if (/^[a-f0-9-]{36}$/.test(token || '') && win.parent !== win) win.parent.postMessage({ type: 'bob-viewer', version: 1, token, state }, win.location.origin);
  };
  socket.on('connect', () => { online = true; chunk = version = ready = false; send('socket-connected'); });
  socket.on('version', () => { version = true; });
  socket.on('loadChunk', () => { chunk = true; });
  socket.on('disconnect', () => { online = ready = false; send('disconnected'); });
  socket.on('connect_error', error => {
    let capacity = false;
    const body = error?.context?.responseText;
    if (typeof body === 'string' && body.length < 1024) { try { capacity = JSON.parse(body).message === 'capacity'; } catch {} }
    online = ready = false; send(capacity || error?.message === 'capacity' ? 'capacity' : 'unavailable');
    socket.disconnect();
  });
  win.addEventListener('pagehide', () => socket.disconnect(), { once: true });
  send('connecting');
  return {
    webgl() { socket.disconnect(); send('webgl-failed'); },
    attach(renderer) { renderer.domElement.addEventListener('webglcontextlost', () => { socket.disconnect(); send('webgl-failed'); }, { once: true }); },
    // Called after a frame was rendered, and only after worker geometry is present.
    frame(viewer) {
      if (!ready && online && chunk && version && !win.document.hidden && Object.values(viewer.world.sectionMeshs).some(mesh => mesh.geometry?.attributes?.position?.count > 0)) { ready = true; send('ready'); }
    },
  };
}

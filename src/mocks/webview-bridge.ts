export const WEBVIEW_BRIDGE_INIT_SCRIPT = `
(() => {
  if (window.__RN_BRIDGE__) return;
  window.__RN_BRIDGE__ = {
    request: async (action, payload) => {
      console.log('[mock-bridge] request', action, payload);
      return { ok: true, action, payload };
    },
    emit: (event, payload) => {
      console.log('[mock-bridge] emit', event, payload);
    },
  };
})();
`;

export const getWebViewBridgeScript = () => WEBVIEW_BRIDGE_INIT_SCRIPT;

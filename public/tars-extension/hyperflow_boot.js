// TARS Hyperflow boot diagnostic / watchdog.
// This is intentionally tiny: if this message appears, Chrome has injected
// the extension into the Hyperflow document. It then starts the real capture
// layer exactly once.
(() => {
  const VERSION = '1.2.37';
  const mark = () => {
    try {
      document.documentElement.dataset.tarsHyperflowBoot = 'active';
      document.documentElement.dataset.tarsHyperflowVersion = VERSION;
    } catch (_) {}
  };

  mark();
  console.info('[TARS Hyperflow BOOT] injected', VERSION, location.href);

  // hyperflow.js is declared separately in the manifest. If it has already
  // initialized, this is a no-op. The boot script exists mainly to make
  // injection failures unambiguous during testing.
  window.dispatchEvent(new CustomEvent('tars-hyperflow-boot', {
    detail: { version: VERSION, href: location.href }
  }));
})();

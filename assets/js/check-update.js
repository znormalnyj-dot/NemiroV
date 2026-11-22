(async () => {
  if (!/^https?:$/.test(location.protocol)) return;
  const initialUrl = location.href;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const timeout = setTimeout(cancel, 5000);
  window.addEventListener('pointerdown', cancel, true);
  window.addEventListener('keydown', cancel, true);
  try {
    const currentBuild = document.documentElement.dataset.build;
    const url = new URL(initialUrl);
    const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
    if (!response.ok) return;
    const html = new DOMParser().parseFromString(await response.text(), 'text/html');
    const latest = html.documentElement.dataset.build;
    if (!latest) return;
    if (currentBuild === latest || url.searchParams.get('_build') === latest || controller.signal.aborted) return;
    const current = new URL(location.href);
    current.searchParams.set('_build', latest);
    location.replace(current);
  } catch (_) { /* Offline startup can use the already loaded build. */ }
  finally {
    clearTimeout(timeout);
    window.removeEventListener('pointerdown', cancel, true);
    window.removeEventListener('keydown', cancel, true);
  }
})();

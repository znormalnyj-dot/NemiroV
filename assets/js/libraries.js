async function loadLibrary(urls, available) {
  for (const url of urls) {
    if (available()) return;
    await new Promise(resolve => {
      const script = document.createElement('script');
      script.onload = script.onerror = resolve;
      script.src = url;
      document.head.appendChild(script);
    });
  }
}

function loadFirebaseModule(name, available) {
  const file = 'firebase-' + name + '-compat.js';
  return loadLibrary([
    'https://www.gstatic.com/firebasejs/10.12.2/' + file,
    'https://cdn.jsdelivr.net/npm/firebase@10.12.2/' + file,
    'https://unpkg.com/firebase@10.12.2/' + file
  ], available);
}

const sdkReady = loadFirebaseModule('app', () => !!window.firebase).then(() =>
  Promise.all([
    loadFirebaseModule('database', () => !!window.firebase?.database)
  ])
);
const iconsReady = loadLibrary([
  'https://cdn.jsdelivr.net/npm/lucide@0.460.0/dist/umd/lucide.min.js',
  'https://unpkg.com/lucide@0.460.0/dist/umd/lucide.min.js'
], () => !!window.lucide);
iconsReady.then(() => window.lucide?.createIcons());
const fabricReady = loadLibrary([
  'https://cdn.jsdelivr.net/npm/fabric@5.3.0/dist/fabric.min.js',
  'https://unpkg.com/fabric@5.3.0/dist/fabric.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/fabric.js/5.3.0/fabric.min.js'
], () => !!window.fabric);

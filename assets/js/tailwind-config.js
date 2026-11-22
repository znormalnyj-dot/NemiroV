function configureTailwind() {
  document.getElementById('tailwindFallback').disabled = true;
  window.tailwind.config = {
    theme: {
      extend: {
        fontFamily: { sans: ['Inter', 'system-ui', 'sans-serif'] },
        colors: { ink: '#050038', accent: '#4262ff' }
      }
    }
  };
}

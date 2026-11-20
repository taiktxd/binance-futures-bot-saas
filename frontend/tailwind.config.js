/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        terminal: {
          bg: '#0A0B0D',
          surface: '#121418',
          border: '#22262E',
          bull: '#16C784',
          bear: '#EA3943',
          gold: '#D4AF37',
          btc: '#F7931A',
          eth: '#3B82F6',
        },
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [],
};

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: { mono: ['"IBM Plex Mono"', 'monospace'] },
      colors: {
        bg: '#0a0e14',
        panel: '#0f1419',
        border: '#1b2028',
        text: '#c5c8c6',
        muted: '#5c6370',
        accent: '#61afef',
        success: '#98c379',
        warn: '#e5c07b',
        danger: '#e06c75',
        human: '#d19a66',
      },
    },
  },
  plugins: [],
}

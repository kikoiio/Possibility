/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // 纸墨暖调：背景为纸，卡片为页，正文为墨
        paper: { DEFAULT: '#f5f1e8', deep: '#ece4d4', light: '#faf7f2' },
        sheet: { DEFAULT: '#fffdf7', glass: 'rgba(255, 253, 247, 0.88)', dark: 'rgba(23, 38, 32, 0.85)' },
        ink: { DEFAULT: '#2c2822', soft: '#6d6457', faint: '#a79c8c', line: '#ddd3c0' },
        // 朱：主人干预 / 世界事件等强调
        cinnabar: { DEFAULT: '#b5472e', deep: '#963824', soft: '#f4e6df' },
        // 靛：对话与分叉
        woad: { DEFAULT: '#46618c', deep: '#38507a', soft: '#e9edf5' },
        // 自然绿阶：融合 3D 画布与户外空间，消除散落硬编码
        sage: {
          50: '#f4f6f3',
          100: '#e5eae3',
          200: '#cbd6c7',
          300: '#a8baa5',
          500: '#5c7866',
          600: '#466453',
          700: '#385443',
          800: '#274739',
          900: '#1a3026',
        },
      },
      zIndex: {
        stage: '10',
        popover: '20',
        drawer: '30',
        modal: '50',
      },
      fontFamily: {
        // 叙事内容（事件描述、对话、想法）用衬线；界面控件保持默认无衬线
        story: ['"Noto Serif SC"', '"Source Han Serif SC"', '"Songti SC"', 'STSong', 'SimSun', 'serif'],
      },
      keyframes: {
        'fade-in-up': {
          '0%': { opacity: '0', transform: 'translateY(6px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'fade-in': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        'slide-in-right': {
          '0%': { opacity: '0', transform: 'translateX(100%)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        },
        'pulse-soft': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.3' },
        },
      },
      animation: {
        'fade-in-up': 'fade-in-up 0.35s ease-out both',
        'fade-in': 'fade-in 0.2s ease-out both',
        'slide-in-right': 'slide-in-right 0.28s cubic-bezier(0.16, 1, 0.3, 1) both',
        'pulse-soft': 'pulse-soft 1.6s ease-in-out infinite',
      },
    },
  },
  plugins: [],
}

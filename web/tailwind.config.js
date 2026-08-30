/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // 纸墨暖调：背景为纸，卡片为页，正文为墨
        paper: { DEFAULT: '#f5f1e8', deep: '#ece4d4' },
        sheet: '#fffdf7',
        ink: { DEFAULT: '#2c2822', soft: '#6d6457', faint: '#a79c8c', line: '#ddd3c0' },
        // 朱：主人干预 / 世界事件等强调
        cinnabar: { DEFAULT: '#b5472e', deep: '#963824', soft: '#f4e6df' },
        // 靛：对话与分叉
        woad: { DEFAULT: '#46618c', deep: '#38507a', soft: '#e9edf5' },
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
        'slide-in-right': {
          '0%': { opacity: '0', transform: 'translateX(24px)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        },
        'pulse-soft': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.3' },
        },
      },
      animation: {
        'fade-in-up': 'fade-in-up 0.35s ease-out both',
        'slide-in-right': 'slide-in-right 0.28s ease-out both',
        'pulse-soft': 'pulse-soft 1.6s ease-in-out infinite',
      },
    },
  },
  plugins: [],
}

import type { Metadata } from 'next';
import { Noto_Sans_KR, Noto_Serif_KR } from 'next/font/google';
import './globals.css';

const sans = Noto_Sans_KR({
  subsets: ['latin'],
  weight: ['300', '400', '500', '700'],
  variable: '--font-kyn-sans',
});

const serif = Noto_Serif_KR({
  subsets: ['latin'],
  weight: ['300', '400', '500', '600'],
  variable: '--font-kyn-serif',
});

export const metadata: Metadata = {
  title: 'KYN — 부의 이전, 설계하는 가족',
  description: '가족 자산 이전 설계 엔진 — 상속·증여 전략 최적화',
  icons: {
    icon: [
      { url: '/icon.svg', type: 'image/svg+xml' },
      { url: '/icon.png', sizes: '32x32', type: 'image/png' },
    ],
    shortcut: '/favicon.ico',
    apple: '/apple-icon.png',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body className={`${sans.variable} ${serif.variable}`}>{children}</body>
    </html>
  );
}

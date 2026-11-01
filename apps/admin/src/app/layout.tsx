import type { ReactNode } from 'react';
import { Inter } from 'next/font/google';
import { SkipLink } from '@gt-sales/ui';

import { StaffSessionProvider } from '../components/staff-session-provider';
import './globals.css';

// Feeds the shared `--font-sans-inter` token (see @gt-sales/ui tokens.css)
// per shadcn preset b4gfJS2z4 (font: inter). next/font self-hosts the files.
const inter = Inter({
  subsets: ['latin'],
  variable: '--font-sans-inter',
  display: 'swap',
});

export const metadata = {
  title: 'GT Sales CRM',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`crm-ui ${inter.variable}`} suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html:
              "try{var t=localStorage.getItem('gt-sales-theme');document.documentElement.classList.toggle('dark',t==='dark');document.documentElement.style.colorScheme=t==='dark'?'dark':'light'}catch(e){}",
          }}
        />
      </head>
      <body>
        <SkipLink />
        <StaffSessionProvider>{children}</StaffSessionProvider>
      </body>
    </html>
  );
}

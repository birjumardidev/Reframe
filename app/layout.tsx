import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Reframe — Reference-led photo edits',
  description: 'Transfer only the visual choices you want from a reference image.'
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}

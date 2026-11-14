import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ServerPresence } from "@/components/server-presence";
import { serverBootId } from "@/lib/server-presence/boot-id";
import { SessionProvider } from "@/components/session-provider";
import { UiTextProvider } from "@/components/ui-text-provider";
import { translate } from "@/lib/ui-text";
import { requestUiLanguage } from "@/lib/ui-text/server";
import { SERVER_BOOT_META } from "@/components/startup-progress";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export async function generateMetadata(): Promise<Metadata> {
  const { language } = await requestUiLanguage();
  return {
    title: "YouTube Operations Manager",
    description: translate(language, "app.description"),
    // BL-254: the phone's home-screen icon and full-screen launch (manifest.ts); desktop browsers ignore these.
    icons: { apple: "/icons/ytm-180.png" },
    appleWebApp: { capable: true, title: "YTM", statusBarStyle: "black-translucent" },
  };
}

// BL-254: the notch / home-indicator insets are usable (env(safe-area-inset-*)), and the browser bar takes the app's colour.
export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover", themeColor: "#09090b" };

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // BL-152: the interface language (a chosen one, else the browser's, else English) -- known before the first paint.
  const { language, source, systemLanguage } = await requestUiLanguage();
  return (
    <html
      lang={language}
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased dark`}
    >
      <body className="min-h-full bg-zinc-950 text-zinc-100">
        {/* BL-196: this server run's id, read by the (app) layout to show the startup window once per tab per run. */}
        <meta name={SERVER_BOOT_META} content={serverBootId()} />
        <UiTextProvider language={language} source={source} systemLanguage={systemLanguage}>
          <SessionProvider>{children}</SessionProvider>
          <ServerPresence />
        </UiTextProvider>
      </body>
    </html>
  );
}

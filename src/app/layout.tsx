import type { Metadata } from "next";
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
  return { title: "YouTube Operations Manager", description: translate(language, "app.description") };
}

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

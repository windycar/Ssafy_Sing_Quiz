import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

const title = "Drop the Beat — 온라인 노래 맞히기";
const description = "최대 20명이 동시에 즐기는 실시간 PC 온라인 음악 퀴즈";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const image = `${protocol}://${host}/og.png`;

  return {
    title,
    description,
    openGraph: { title, description, type: "website", images: [{ url: image, width: 1728, height: 909, alt: "Drop the Beat 온라인 음악 퀴즈" }] },
    twitter: { card: "summary_large_image", title, description, images: [image] },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}

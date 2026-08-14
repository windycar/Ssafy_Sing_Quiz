import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

const title = "SSAFY DAY — 우리 반 정답왕을 찾아라";
const description = "최대 20명이 함께 즐기는 노래 · 속담 · 사자성어 실시간 싸피데이 퀴즈";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const image = `${protocol}://${host}/og.png`;

  return {
    title,
    description,
    openGraph: { title, description, type: "website", images: [{ url: image, width: 1728, height: 909, alt: "SSAFY DAY 실시간 퀴즈" }] },
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

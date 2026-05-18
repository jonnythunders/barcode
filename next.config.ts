import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Playwright runs server-side only; mark its native modules as external
  // so Next doesn't try to bundle them for the client.
  serverExternalPackages: ["playwright", "playwright-core"],
  // Allow Amazon, TikTok, Instagram avatar images when we eventually render them
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "**.amazon.com" },
      { protocol: "https", hostname: "**.media-amazon.com" },
      { protocol: "https", hostname: "**.cdninstagram.com" },
      { protocol: "https", hostname: "**.tiktokcdn.com" },
      { protocol: "https", hostname: "**.tiktokcdn-us.com" },
    ],
  },
};

export default nextConfig;

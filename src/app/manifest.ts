import type { MetadataRoute } from "next";

// BL-254 (docs/roadmap/plans/MOBILE_UI_PLAN.md): «На экран „Домой“» on a phone opens YT Manager full screen with its own icon.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "YouTube Operations Manager",
    short_name: "YTM",
    start_url: "/home",
    display: "standalone",
    background_color: "#09090b",
    theme_color: "#09090b",
    icons: [
      { src: "/icons/ytm-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/ytm-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}

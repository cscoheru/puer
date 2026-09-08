import { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/api/", "/admin/", "/login", "/register", "/settings", "/forum/search", "/forum?page="],
      },
    ],
    sitemap: "https://puer.im/sitemap.xml",
  };
}

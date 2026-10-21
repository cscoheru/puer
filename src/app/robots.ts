import { MetadataRoute } from "next";
import { buildRobotsRules } from "@/lib/ai-crawler-policy";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: buildRobotsRules(),
    sitemap: "https://puer.im/sitemap.xml",
  };
}

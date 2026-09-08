const SITE = "https://puer.im";

export async function pingSearchEngines() {
  try {
    await fetch(`http://www.google.com/ping?sitemap=${SITE}/sitemap.xml`, {
      method: "GET",
      signal: AbortSignal.timeout(5000),
    });
  } catch { /* non-blocking */ }
}

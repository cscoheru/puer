const CHUNK_SIZE = 1024 * 1024; // 1MB per chunk
const MAX_RETRIES_PER_CHUNK = 5;
const IMAGE_MAX_WIDTH = 1200;
const IMAGE_QUALITY = 0.75;
const IMAGE_MAX_SIZE = 512 * 1024; // 512KB — images larger than this get compressed

interface UploadResult {
  url: string;
  type: "image" | "video";
}

function generateUploadId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Compress an image file client-side before upload */
export async function compressImage(file: File): Promise<File> {
  if (!file.type.startsWith("image/")) return file;

  // Skip non-standard formats (HEIC, HEIF, etc.)
  if (file.type === "image/gif" || file.type === "image/svg+xml") return file;

  // If already small enough, skip
  if (file.size <= IMAGE_MAX_SIZE) return file;

  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    let settled = false;

    const finish = (result: File) => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      resolve(result);
    };

    // Timeout fallback for browsers where canvas.toBlob never fires
    const timer = setTimeout(() => finish(file), 10000);

    img.onload = () => {
      let w = img.width;
      let h = img.height;

      // Resize if wider than max
      if (w > IMAGE_MAX_WIDTH) {
        h = Math.round(h * IMAGE_MAX_WIDTH / w);
        w = IMAGE_MAX_WIDTH;
      }

      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) { clearTimeout(timer); finish(file); return; }

      ctx.drawImage(img, 0, 0, w, h);

      const outputType = file.type === "image/png" ? "image/jpeg" : file.type;
      canvas.toBlob(
        (blob) => {
          clearTimeout(timer);
          if (!blob || blob.size >= file.size) {
            finish(file);
            return;
          }
          const ext = outputType === "image/jpeg" ? ".jpg" : `.${outputType.split("/")[1]}`;
          const name = file.name.replace(/\.[^.]+$/, ext);
          finish(new File([blob], name, { type: outputType, lastModified: Date.now() }));
        },
        outputType,
        IMAGE_QUALITY,
      );
    };

    img.onerror = () => {
      clearTimeout(timer);
      finish(file);
    };

    img.src = url;
  });
}

async function fetchWithSignal(
  url: string,
  init: RequestInit & { signal?: AbortSignal },
): Promise<Response> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let msg: string;
    try {
      msg = JSON.parse(text).error || `上传失败 (${res.status})`;
    } catch {
      msg = text || `上传失败 (${res.status})`;
    }
    throw new Error(msg);
  }
  return res;
}

async function checkExistingChunks(uploadId: string): Promise<number[]> {
  try {
    const res = await fetch(`/api/upload?uploadId=${uploadId}`);
    if (res.ok) {
      const data = await res.json();
      return data.chunks || [];
    }
  } catch {}
  return [];
}

async function uploadChunk(
  uploadId: string,
  chunkIndex: number,
  totalChunks: number,
  blob: Blob,
  fileType: string,
  totalBytes: number,
  category: string,
  signal?: AbortSignal,
): Promise<void> {
  await fetchWithSignal("/api/upload", {
    method: "POST",
    headers: {
      "X-Upload-Id": uploadId,
      "X-Chunk-Index": String(chunkIndex),
      "X-Total-Chunks": String(totalChunks),
      "X-File-Type": fileType,
      // Sent on every chunk so the server can (re)create the immutable
      // manifest if it is missing — whichever chunk lands first writes it.
      "X-Total-Bytes": String(totalBytes),
      "X-Category": category,
      "Content-Type": "application/octet-stream",
    },
    body: blob,
    signal,
  });
}

async function completeUpload(
  uploadId: string,
  fileType: string,
  category?: string,
): Promise<UploadResult> {
  const res = await fetchWithSignal("/api/upload", {
    method: "POST",
    headers: {
      "X-Upload-Id": uploadId,
      "X-Upload-Complete": "true",
      "X-File-Type": fileType,
      "X-Category": category || "",
    },
  });
  return res.json();
}

export async function uploadFile(
  file: File,
  onProgress?: (percent: number) => void,
  signal?: AbortSignal,
  category?: string,
  opts?: { raw?: boolean }
): Promise<UploadResult> {
  // Compress images before upload — unless the caller needs full resolution
  // (OCR on wrapper fine print dies at the 1200px/q0.75 default).
  const processed = !opts?.raw && file.type.startsWith("image/")
    ? await compressImage(file)
    : file;

  // Small files: single-shot FormData upload
  if (processed.size <= CHUNK_SIZE) {
    return singleShotUpload(processed, onProgress, signal, category);
  }

  // ── Chunked upload for files > 1MB ──────────────
  const uploadId = generateUploadId();
  const totalChunks = Math.ceil(processed.size / CHUNK_SIZE);

  const existingChunks = await checkExistingChunks(uploadId);
  const uploadedSet = new Set(existingChunks);

  for (let i = 0; i < totalChunks; i++) {
    if (uploadedSet.has(i)) {
      if (onProgress) onProgress(Math.round(((i + 1) / totalChunks) * 100));
      continue;
    }

    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, processed.size);
    const blob = processed.slice(start, end);

    if (signal?.aborted) throw new Error("上传已取消");

    let chunkSuccess = false;
    for (let retry = 0; retry < MAX_RETRIES_PER_CHUNK; retry++) {
      try {
        if (retry > 0) {
          await new Promise((r) => setTimeout(r, Math.min(1000 * Math.pow(2, retry), 15000)));
        }
        await uploadChunk(uploadId, i, totalChunks, blob, processed.type, processed.size, category || "", signal);
        chunkSuccess = true;
        break;
      } catch {
        if (signal?.aborted) throw new Error("上传已取消");
      }
    }

    if (!chunkSuccess) {
      throw new Error(`分片 ${i + 1}/${totalChunks} 上传失败`);
    }

    if (onProgress) onProgress(Math.round(((i + 1) / totalChunks) * 100));
  }

  return completeUpload(uploadId, processed.type, category);
}

/** Single-shot XHR upload for small files */
function singleShotUpload(
  file: File,
  onProgress?: (percent: number) => void,
  signal?: AbortSignal,
  category?: string,
): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const fd = new FormData();
    fd.append("file", file);
    if (category) fd.append("category", category);

    xhr.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    });
    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText));
        } catch {
          reject(new Error("解析响应失败"));
        }
      } else {
        try {
          const err = JSON.parse(xhr.responseText);
          reject(new Error(err.error || `上传失败 (${xhr.status})`));
        } catch {
          reject(new Error(`上传失败 (${xhr.status})`));
        }
      }
    });
    xhr.addEventListener("error", () => reject(new Error("网络错误")));
    xhr.addEventListener("abort", () => reject(new Error("上传已取消")));

    if (signal) {
      signal.addEventListener("abort", () => xhr.abort());
    }

    xhr.withCredentials = true;
    xhr.open("POST", "/api/upload");
    xhr.send(fd);
  });
}

export async function uploadWithRetry(
  file: File,
  onProgress?: (percent: number) => void,
  retries = 3,
  category?: string,
): Promise<UploadResult> {
  for (let i = 0; i < retries; i++) {
    try {
      return await uploadFile(file, onProgress, undefined, category);
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw new Error("上传失败");
}
